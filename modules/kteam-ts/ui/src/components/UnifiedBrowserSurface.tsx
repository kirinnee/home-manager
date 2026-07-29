// ONE BROWSER SURFACE, TWO EXPLICIT ENGINES.
//
// `preview` is the deployed, process-free iframe reader. `remote` is the
// session's persistent Chrome. The toolbar is deliberately engine-agnostic:
// its address and navigation controls operate on whichever history the reader
// selected, while switching engines never discards the other one's position.
// Preview history can only cover app-driven opens: cross-origin iframe-internal
// navigation is opaque to its parent, so that limitation is stated in the UI.
//
// Frame refusal cannot be detected reliably across origins, so this component
// never waits for a fake timeout or silently changes engines. The selector is
// stable, the preview warning is honest, and "Open in real browser" is always
// one tap away.
//
// There is exactly ONE tab strip in this surface and it lives inside the REAL
// engine, driven by the daemon's real Chrome pages. Preview keeps its own
// independent linear history and invents no tabs of its own.

import { useCallback, useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, Monitor, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { Button } from './Primitives';
import { browserDestination, InAppBrowserFrame, isLoopbackHostname, type BrowserDestination } from './InAppBrowser';
import { RemoteBrowserPane, type RemoteBrowserPaneProps } from './RemoteBrowserPane';
import { remoteBrowserApi, type RemoteBrowserActionResult, type RemoteBrowserStatus } from '../lib/remote-browser';
import { actOnBrowserLogin } from '../lib/browser-login';

export type BrowserEngine = 'preview' | 'remote';

interface BrowserSessionMemory {
  engine: BrowserEngine;
  /** Object identity distinguishes a fresh explicit tap of the same URL from
   *  reopening the same stored SidePane destination. */
  lastIncoming: BrowserDestination | null;
}

const browserSessions = new Map<string, BrowserSessionMemory>();

/** Session-scoped even on mobile, where closing the sheet unmounts its body. */
export function browserEngineForSession(sessionId: string): BrowserEngine {
  return browserSessions.get(sessionId)?.engine ?? 'preview';
}

/** Test seam and the surface's single write path for the remembered engine. */
export function rememberBrowserEngine(sessionId: string, engine: BrowserEngine): void {
  const current = browserSessions.get(sessionId);
  browserSessions.set(sessionId, {
    engine,
    lastIncoming: current?.lastIncoming ?? null,
  });
}

export function resetBrowserSurfaceSessions(): void {
  browserSessions.clear();
}

export type BrowserAddressResolution =
  | { kind: 'url' | 'search'; destination: BrowserDestination }
  | { kind: 'error'; message: string };

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const HOST_WITH_PORT = /^(?:localhost|[^\s/:]+\.[^\s/:]+|\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):\d+(?:[/?#]|$)/i;
/** `https:`, `https:/`, `https://` — a scheme the human has not finished typing. */
const SCHEME_ONLY = /^(https?):\/{0,2}$/i;

function looksLikeBareHost(value: string): boolean {
  if (/\s/.test(value)) return false;
  const authority = value.split(/[/?#]/, 1)[0] ?? '';
  const hostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.replace(/:\d+$/, '');
  return (
    isLoopbackHostname(hostname) ||
    hostname.includes('.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^\[[0-9a-f:]+\]$/i.test(hostname)
  );
}

/** Address-bar policy: relative paths stay on the current site, bare hosts get
 *  a scheme, and everything else becomes an explicit DuckDuckGo search. */
export function resolveBrowserAddress(input: string, baseHref?: string): BrowserAddressResolution {
  const value = input.trim();
  if (!value) return { kind: 'error', message: 'Enter a URL or search terms.' };

  // A half-typed scheme is an unfinished thought, not a mistake. Say what is
  // missing instead of scolding, and never turn it into a search.
  const schemeOnly = value.match(SCHEME_ONLY);
  if (schemeOnly) {
    return { kind: 'error', message: `Keep typing—add a site after ${schemeOnly[1]!.toLowerCase()}://` };
  }

  const relative = /^(?:\/|\.\.?\/|[?#])/.test(value);
  const hostWithPort = HOST_WITH_PORT.test(value);
  if (EXPLICIT_SCHEME.test(value) && !hostWithPort && !/^https?:/i.test(value)) {
    return { kind: 'error', message: 'Only HTTP and HTTPS addresses can be opened.' };
  }

  let candidate: string | undefined;
  if (/^https?:/i.test(value)) candidate = value;
  else if (relative && baseHref) {
    try {
      candidate = new URL(value, baseHref).href;
    } catch {
      return { kind: 'error', message: 'That relative address is not valid.' };
    }
  } else if (hostWithPort || looksLikeBareHost(value)) {
    const authority = value.split(/[/?#]/, 1)[0] ?? '';
    const rawHostname = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : authority.replace(/:\d+$/, '');
    candidate = `${isLoopbackHostname(rawHostname) ? 'http' : 'https'}://${value}`;
  }

  if (candidate) {
    const destination = browserDestination(candidate, baseHref);
    return destination
      ? { kind: 'url', destination }
      : { kind: 'error', message: 'Enter a complete HTTP or HTTPS address.' };
  }

  const search = new URL('https://duckduckgo.com/');
  search.searchParams.set('q', value);
  return { kind: 'search', destination: browserDestination(search.href, baseHref)! };
}

export interface PreviewHistory {
  entries: readonly BrowserDestination[];
  index: number;
  revision: number;
}

export function createPreviewHistory(destination?: BrowserDestination | null): PreviewHistory {
  return destination ? { entries: [destination], index: 0, revision: 0 } : { entries: [], index: -1, revision: 0 };
}

export function pushPreviewHistory(history: PreviewHistory, destination: BrowserDestination): PreviewHistory {
  if (history.entries[history.index]?.href === destination.href) return { ...history, revision: history.revision + 1 };
  return {
    entries: [...history.entries.slice(0, history.index + 1), destination],
    index: history.index + 1,
    revision: 0,
  };
}

export function movePreviewHistory(history: PreviewHistory, offset: -1 | 1): PreviewHistory {
  if (history.entries.length === 0) return history;
  const index = Math.max(0, Math.min(history.entries.length - 1, history.index + offset));
  return index === history.index ? history : { ...history, index, revision: 0 };
}

type SharedRemoteApi = Pick<typeof remoteBrowserApi, 'open' | 'navigate' | 'back' | 'forward' | 'reload'>;

export interface UnifiedBrowserDependencies {
  remoteApi: SharedRemoteApi;
  RemotePane: ComponentType<RemoteBrowserPaneProps>;
}

const DEFAULT_DEPENDENCIES: UnifiedBrowserDependencies = {
  remoteApi: remoteBrowserApi,
  RemotePane: RemoteBrowserPane,
};

export interface UnifiedBrowserSurfaceProps {
  sessionId: string;
  /** Null when the Browser tab is opened directly before any transcript link. */
  destination?: BrowserDestination | null;
  presentation: 'pane' | 'sheet';
  titleId: string;
  onClose: () => void;
  /** False for a retained-but-hidden Browser surface: Chrome persists, but its
   *  viewer socket detaches until the surface is visible again. */
  isActive?: boolean;
  dependencies?: UnifiedBrowserDependencies;
}

interface RemoteLocation {
  url: string;
  title: string;
}

function locationFromResult(result: RemoteBrowserActionResult): RemoteLocation | null {
  const url = result.result?.url ?? result.status.url;
  if (!url) return null;
  return { url, title: result.result?.title ?? result.status.title ?? '' };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function UnifiedBrowserSurface({
  sessionId,
  destination,
  presentation,
  titleId,
  onClose,
  isActive = true,
  dependencies = DEFAULT_DEPENDENCIES,
}: UnifiedBrowserSurfaceProps) {
  const { remoteApi, RemotePane } = dependencies;
  const initialMemoryRef = useRef(browserSessions.get(sessionId));
  const initialMemory = initialMemoryRef.current;
  const initialEngine = initialMemory?.engine ?? 'preview';
  const incomingChangedWhileUnmounted = Boolean(
    destination && initialMemory && initialMemory.lastIncoming !== destination,
  );

  const [engine, setEngine] = useState<BrowserEngine>(initialEngine);
  const [previewHistory, setPreviewHistory] = useState<PreviewHistory>(() => createPreviewHistory(destination));
  const [remoteLocation, setRemoteLocation] = useState<RemoteLocation | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteBrowserStatus | null>(null);
  const [address, setAddress] = useState(destination?.href ?? '');
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef(engine);
  const incomingDestinationRef = useRef(destination);
  const mountedRef = useRef(true);
  const remoteRequestRef = useRef(0);
  const initialRemoteOpenRef = useRef(initialEngine === 'remote');
  engineRef.current = engine;

  const previewDestination = previewHistory.entries[previewHistory.index] ?? destination ?? null;
  const currentUrl =
    engine === 'preview' ? (previewDestination?.href ?? '') : (remoteLocation?.url ?? previewDestination?.href ?? '');

  const applyRemoteResult = useCallback((result: RemoteBrowserActionResult) => {
    const location = locationFromResult(result);
    if (location) setRemoteLocation(location);
    if (result.status) setRemoteStatus(result.status);
  }, []);

  const runRemote = useCallback(
    async (operation: () => Promise<RemoteBrowserActionResult>) => {
      const request = ++remoteRequestRef.current;
      setBusy(true);
      setError(null);
      try {
        const result = await operation();
        if (mountedRef.current && request === remoteRequestRef.current) applyRemoteResult(result);
      } catch (caught) {
        if (mountedRef.current && request === remoteRequestRef.current) setError(errorMessage(caught));
      } finally {
        if (mountedRef.current && request === remoteRequestRef.current) setBusy(false);
      }
    },
    [applyRemoteResult],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    browserSessions.set(sessionId, { engine: engineRef.current, lastIncoming: destination ?? null });
  }, [destination, sessionId]);

  // A remembered remote engine survives a mobile sheet unmount. Reattach to
  // its existing page; only copy the incoming link when that link changed
  // while the surface was absent.
  useEffect(() => {
    if (!initialRemoteOpenRef.current) return;
    initialRemoteOpenRef.current = false;
    void runRemote(() =>
      remoteApi.open(sessionId, incomingChangedWhileUnmounted && destination ? destination.href : undefined),
    );
  }, [destination, incomingChangedWhileUnmounted, remoteApi, runRemote, sessionId]);

  // Transcript link taps feed a new destination into the already-mounted
  // surface. The selected engine receives it; the other engine keeps its own
  // history untouched.
  useEffect(() => {
    if (incomingDestinationRef.current === destination) return;
    incomingDestinationRef.current = destination;
    if (!destination) return;
    if (engineRef.current === 'preview') setPreviewHistory(history => pushPreviewHistory(history, destination));
    else void runRemote(() => remoteApi.open(sessionId, destination.href));
  }, [destination, remoteApi, runRemote, sessionId]);

  useEffect(() => {
    if (typeof document === 'undefined' || document.activeElement !== addressRef.current) setAddress(currentUrl);
  }, [currentUrl]);

  const chooseEngine = (next: BrowserEngine) => {
    if (next === engineRef.current) return;
    engineRef.current = next;
    setEngine(next);
    rememberBrowserEngine(sessionId, next);
    if (next === 'preview') {
      setAddress(previewDestination?.href ?? '');
      return;
    }
    // The selector resumes Chrome's independent history. Copying the preview
    // URL is a separate, explicit action: "Open in real browser" below.
    setAddress(remoteLocation?.url ?? previewDestination?.href ?? '');
    void runRemote(() => remoteApi.open(sessionId));
  };

  const navigate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resolution = resolveBrowserAddress(address, currentUrl || undefined);
    if (resolution.kind === 'error') {
      setError(resolution.message);
      return;
    }
    setError(null);
    setAddress(resolution.destination.href);
    if (engineRef.current === 'preview') {
      setPreviewHistory(history => pushPreviewHistory(history, resolution.destination));
      return;
    }
    void runRemote(() => remoteApi.navigate(sessionId, resolution.destination.href));
  };

  const goBack = () => {
    if (engineRef.current === 'preview') setPreviewHistory(history => movePreviewHistory(history, -1));
    else void runRemote(() => remoteApi.back(sessionId));
  };

  const goForward = () => {
    if (engineRef.current === 'preview') setPreviewHistory(history => movePreviewHistory(history, 1));
    else void runRemote(() => remoteApi.forward(sessionId));
  };

  const reload = () => {
    if (engineRef.current === 'preview') setPreviewHistory(history => ({ ...history, revision: history.revision + 1 }));
    else void runRemote(() => remoteApi.reload(sessionId));
  };

  const openInRealBrowser = () => {
    const target = browserDestination(currentUrl) ?? previewDestination;
    if (engineRef.current !== 'remote') {
      engineRef.current = 'remote';
      setEngine('remote');
      rememberBrowserEngine(sessionId, 'remote');
    }
    if (target) setAddress(target.href);
    void runRemote(() => remoteApi.open(sessionId, target?.href));
  };

  const openBrowserLogin = async () => {
    setLoginBusy(true);
    setError(null);
    const status = await actOnBrowserLogin('start');
    if (status.state === 'unknown' || status.state === 'error')
      setError(status.error ?? 'Could not open the browser login window.');
    setLoginBusy(false);
  };

  const remoteChanged = useCallback((location: RemoteLocation) => {
    setRemoteLocation(location);
    if (
      engineRef.current === 'remote' &&
      (typeof document === 'undefined' || document.activeElement !== addressRef.current)
    )
      setAddress(location.url);
  }, []);

  const remoteStatusChanged = useCallback((next: RemoteBrowserStatus) => setRemoteStatus(next), []);

  const externalDestination = browserDestination(currentUrl);
  const previewBackDisabled =
    engine === 'preview' && (previewHistory.entries.length === 0 || previewHistory.index <= 0);
  const previewForwardDisabled =
    engine === 'preview' &&
    (previewHistory.entries.length === 0 || previewHistory.index >= previewHistory.entries.length - 1);
  // A daemon that has not reported history capability yet must not disable the
  // controls: `undefined` means unknown, only an explicit `false` means "cannot".
  const backDisabled = engine === 'preview' ? previewBackDisabled : remoteStatus?.canGoBack === false;
  const forwardDisabled = engine === 'preview' ? previewForwardDisabled : remoteStatus?.canGoForward === false;
  const remotePageState = engine === 'remote' ? remoteStatus?.pageState : undefined;
  const remotePageError = engine === 'remote' ? remoteStatus?.pageError : undefined;
  const Heading = presentation === 'pane' ? 'h2' : 'h1';

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Browser">
      <header className="shrink-0 border-b border-border-soft px-2 pb-2">
        <div className="flex min-h-[44px] items-center gap-xs">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent"
            aria-hidden="true"
          >
            <Globe2 size={17} />
          </span>
          <Heading
            id={titleId}
            className="m-0 min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg"
          >
            Browser
          </Heading>
          <div
            role="group"
            aria-label="Browser engine"
            className="flex shrink-0 items-center rounded-control border border-strong bg-surface-2 p-0.5"
          >
            <Button
              type="button"
              variant={engine === 'preview' ? 'primary' : 'ghost'}
              size="sm"
              aria-pressed={engine === 'preview'}
              onClick={() => chooseEngine('preview')}
              className="min-h-[44px] min-w-[44px] px-2"
            >
              Preview
            </Button>
            <Button
              type="button"
              variant={engine === 'remote' ? 'primary' : 'ghost'}
              size="sm"
              aria-pressed={engine === 'remote'}
              onClick={() => chooseEngine('remote')}
              className="min-h-[44px] min-w-[44px] px-2"
            >
              Real
            </Button>
          </div>
          {presentation === 'pane' && (
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] justify-center p-0"
              aria-label="Close browser pane"
              title="Close browser pane"
            >
              <X size={17} aria-hidden="true" />
            </Button>
          )}
        </div>

        <form
          onSubmit={navigate}
          className="mt-1 grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-center gap-xs"
        >
          <Button
            type="button"
            variant="ghost"
            disabled={busy || backDisabled}
            onClick={goBack}
            className="min-h-[44px] min-w-[44px] justify-center p-0"
            aria-label={`Back in ${engine === 'preview' ? 'preview' : 'real browser'}`}
            title="Back"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || forwardDisabled}
            onClick={goForward}
            className="min-h-[44px] min-w-[44px] justify-center p-0"
            aria-label={`Forward in ${engine === 'preview' ? 'preview' : 'real browser'}`}
            title="Forward"
          >
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={reload}
            className="min-h-[44px] min-w-[44px] justify-center p-0"
            aria-label={`Reload ${engine === 'preview' ? 'preview' : 'real browser'}`}
            title="Reload"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
          <label className="flex min-h-[44px] min-w-0 items-center gap-xs rounded-control border border-strong bg-surface-2 px-2">
            <span className="sr-only">URL or DuckDuckGo search</span>
            <Globe2 size={14} aria-hidden="true" className="shrink-0 text-muted" />
            {/* No onBlur reset: tapping Go blurs this input first, and restoring
                the previous URL there submitted the OLD address. */}
            <input
              ref={addressRef}
              value={address}
              onChange={event => setAddress(event.target.value)}
              placeholder="URL or DuckDuckGo search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 bg-transparent font-mono text-meta text-fg placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !address.trim()}
            className="min-h-[44px] min-w-[44px] justify-center px-2"
          >
            Go
          </Button>
        </form>

        <div
          className="mt-1 flex min-h-[44px] items-center gap-xs text-meta leading-base text-muted"
          aria-live="polite"
        >
          {engine === 'preview' ? (
            <>
              <ShieldAlert size={14} aria-hidden="true" className="shrink-0 text-warn" />
              <span>
                Preview accepts the address, but a site can refuse to load in an embedded reader and this reader cannot
                tell when it does. Real is the full interactive browser.
              </span>
            </>
          ) : (
            <>
              <Monitor size={14} aria-hidden="true" className="shrink-0 text-accent" />
              <span className="min-w-0 truncate" title={remoteLocation?.title || currentUrl}>
                {busy
                  ? 'Working…'
                  : remotePageState === 'loading'
                    ? 'Loading page…'
                    : remoteLocation?.title || 'Shared Chrome · persistent session'}
              </span>
            </>
          )}
        </div>

        {remotePageError && (
          <div role="alert" className="rounded-control border border-err/30 bg-err-soft px-2 py-1.5 text-meta text-err">
            {remotePageError}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-control border border-err/30 bg-err-soft px-2 py-1.5 text-meta text-err">
            {error}
          </div>
        )}
      </header>

      {engine === 'preview' && previewDestination ? (
        <InAppBrowserFrame
          key={`${previewDestination.href}:${previewHistory.revision}`}
          destination={previewDestination}
        />
      ) : engine === 'preview' ? (
        <div
          className="flex min-h-[240px] flex-1 items-center justify-center bg-surface-2 px-panel py-8 text-center"
          aria-label="Browser home"
        >
          <div className="max-w-xs">
            <Globe2 size={32} aria-hidden="true" className="mx-auto text-accent" />
            <h3 className="mb-0 mt-3 font-display text-title font-semibold tracking-display text-fg">Where to?</h3>
            <p className="mb-0 mt-2 text-ui leading-base text-muted">
              Enter a URL or search terms above. Nothing opens until you choose where to go.
            </p>
            <div className="mt-4 border-t border-border-soft pt-3 text-left">
              <p className="m-0 text-meta leading-base text-muted">Need to sign in to the shared browser?</p>
              <Button
                type="button"
                variant="outline"
                disabled={loginBusy}
                onClick={() => void openBrowserLogin()}
                className="mt-2 min-h-[44px] w-full justify-center"
              >
                {loginBusy ? 'Opening login window…' : 'Open browser login window'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <RemotePane
          sessionId={sessionId}
          isActive={isActive && engine === 'remote'}
          showNavigation={false}
          onLocationChange={remoteChanged}
          onStatusChange={remoteStatusChanged}
        />
      )}

      <footer className="grid shrink-0 grid-cols-[minmax(0,1fr)_44px_44px] gap-xs border-t border-border-soft bg-surface px-2 py-2">
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={openInRealBrowser}
          className="min-h-[44px] min-w-0 justify-center gap-xs px-2"
          aria-label="Open in real browser"
          title="Open this address in the persistent real browser"
        >
          <Monitor size={16} aria-hidden="true" className="shrink-0" />
          <span className="truncate">Open in real browser</span>
        </Button>
        {externalDestination ? (
          <a
            href={externalDestination.href}
            target="_blank"
            rel="noreferrer"
            className="kt-btn min-h-[44px] min-w-[44px] justify-center p-0"
            aria-label="Open externally in a new tab"
            title="Open externally"
          >
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        ) : (
          <span
            className="kt-btn min-h-[44px] min-w-[44px] cursor-not-allowed justify-center p-0 opacity-50"
            aria-disabled="true"
            aria-label="This browser address cannot be opened externally"
          >
            <ExternalLink size={16} aria-hidden="true" />
          </span>
        )}
        <Button
          type="button"
          onClick={onClose}
          className="min-h-[44px] min-w-[44px] justify-center p-0"
          aria-label="Done browsing"
          title="Done"
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </footer>
    </section>
  );
}
