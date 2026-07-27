// IN-APP BROWSER — an honest, deliberately narrow reading surface.
//
// A normal tap on an HTTP(S) link opens a right-hand pane without navigating the
// app, so desktop keeps the conversation visible and usable. Below the 768px
// layout gate that pane becomes a sheet: a portrait phone cannot fit two useful
// columns, but the transcript, its scroll position, and a half-written composer
// draft still stay mounted behind it. Most public sites refuse to be framed
// (X-Frame-Options or CSP frame-ancestors), and the parent page cannot reliably
// detect that refusal. The UI therefore makes no loading/error claim: the
// current URL and an external escape hatch are permanently visible.
//
// The production app is reached from a phone through an HTTPS tunnel. On that
// phone, localhost/127.0.0.1 names the PHONE, not the machine running kteam. We
// identify that case up front rather than displaying a blank frame that could
// never reach the agent's dev server. A safe loopback-only proxy would be a
// separate daemon feature with an explicit port allowlist and admin auth; this
// client component intentionally does not invent one.

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Globe2, ShieldAlert, Smartphone, X } from 'lucide-react';
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';

export type BrowserScope = 'same-origin' | 'cross-origin' | 'device-loopback';

export interface BrowserDestination {
  href: string;
  hostname: string;
  scope: BrowserScope;
}

/** Hosts that name the current device rather than the machine behind a tunnel. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

/** Resolve and classify a link without ever widening beyond HTTP(S). */
export function browserDestination(href: string | undefined, baseHref?: string): BrowserDestination | null {
  if (!href?.trim()) return null;
  let target: URL;
  try {
    target = baseHref ? new URL(href, baseHref) : new URL(href);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;

  let base: URL | null = null;
  if (baseHref) {
    try {
      base = new URL(baseHref);
    } catch {
      // An absolute HTTP(S) target is still safe to offer when the caller's
      // optional base is malformed; it simply cannot be same-origin.
    }
  }

  const scope: BrowserScope =
    base?.origin === target.origin
      ? 'same-origin'
      : isLoopbackHostname(target.hostname) && !isLoopbackHostname(base?.hostname ?? '')
        ? 'device-loopback'
        : 'cross-origin';
  return { href: target.href, hostname: target.hostname, scope };
}

export interface BrowserActivation {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Modified and non-primary clicks keep ordinary browser/new-tab semantics. */
export function shouldOpenInApp(
  event: BrowserActivation,
  destination: BrowserDestination | null,
  download: AnchorHTMLAttributes<HTMLAnchorElement>['download'],
): boolean {
  return Boolean(
    destination &&
    download === undefined &&
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey,
  );
}

interface InAppBrowserSurfaceProps {
  destination: BrowserDestination;
  onClose: () => void;
  presentation: 'pane' | 'sheet';
  titleId: string;
}

function InAppBrowserSurface({ destination, onClose, presentation, titleId }: InAppBrowserSurfaceProps) {
  const frameAllowed = destination.scope !== 'device-loopback';
  const Heading = presentation === 'pane' ? 'h2' : 'h1';

  return (
    <>
      <header className="shrink-0 border-b border-border-soft px-panel pb-3">
        <div className="flex items-center gap-sm">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent"
            aria-hidden="true"
          >
            <Globe2 size={17} />
          </span>
          <div className="min-w-0">
            <span className="kt-label block">In-app reader</span>
            <Heading id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
              Link preview
            </Heading>
          </div>
          {presentation === 'pane' && (
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="ml-auto min-h-[44px] min-w-[44px] justify-center p-0"
              aria-label="Close browser pane"
              title="Close browser pane"
            >
              <X size={17} aria-hidden="true" />
            </Button>
          )}
        </div>

        <div
          role="group"
          className="mt-2 flex min-h-[44px] items-center gap-sm rounded-control border border-strong bg-surface-2 px-3"
          aria-label="URL being viewed"
        >
          <span className="kt-label shrink-0 text-faint">URL</span>
          <span
            className="scroll-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-meta text-fg-soft"
            dir="ltr"
            title={destination.href}
          >
            {destination.href}
          </span>
        </div>

        {frameAllowed && (
          <p className="mb-0 mt-2 flex items-start gap-sm text-meta leading-base text-muted">
            <ShieldAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
            <span>Most public sites block embedded viewing. A blank or refusal page is normal; open externally.</span>
          </p>
        )}
      </header>

      {frameAllowed ? (
        <div className="min-h-0 flex-1 bg-surface-2">
          <iframe
            src={destination.href}
            title={`Embedded view of ${destination.hostname}`}
            className="block h-full min-h-[240px] w-full border-0 bg-surface-2"
            loading="eager"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-2 px-panel py-8 text-center">
          <div className="max-w-sm">
            <Smartphone size={30} aria-hidden="true" className="mx-auto text-accent" />
            <h2 className="mb-0 mt-3 font-display text-title font-semibold tracking-display text-fg">
              This address is on your phone
            </h2>
            <p className="mb-0 mt-2 text-ui leading-base text-muted">
              Through the app's tunnel, localhost and loopback addresses point to this phone—not the agent's machine.
              This preview cannot reach that dev server.
            </p>
          </div>
        </div>
      )}

      <footer className="shrink-0 border-t border-border-soft bg-surface px-panel py-2">
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-sm">
          <a
            href={destination.href}
            target="_blank"
            rel="noreferrer"
            className="kt-btn min-h-[44px] min-w-0 justify-center gap-sm"
          >
            <ExternalLink size={16} aria-hidden="true" className="shrink-0" />
            <span>Open externally</span>
          </a>
          <Button
            type="button"
            variant="primary"
            onClick={onClose}
            className="min-h-[44px] min-w-0 justify-center gap-sm"
          >
            <X size={16} aria-hidden="true" className="shrink-0" />
            Done
          </Button>
        </div>
      </footer>
    </>
  );
}

interface InAppBrowserSheetProps {
  destination: BrowserDestination;
  open: boolean;
  onClose: () => void;
}

export function InAppBrowserSheet({ destination, open, onClose }: InAppBrowserSheetProps) {
  const instanceId = useId();
  const titleId = `in-app-browser-title-${instanceId}`;

  return (
    <BottomSheet
      id={`in-app-browser-${instanceId}`}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel="Close in-app browser"
      panelClassName="h-full overflow-hidden bg-surface"
      maxHeight="calc(var(--app-h, 100dvh) - var(--gap-xs))"
      zIndexClass="z-[70]"
    >
      <InAppBrowserSurface destination={destination} onClose={onClose} presentation="sheet" titleId={titleId} />
    </BottomSheet>
  );
}

interface InAppBrowserPaneProps {
  id: string;
  destination: BrowserDestination;
  onClose: () => void;
}

/** Desktop's non-modal half of the workspace: chat remains visible and usable. */
export function InAppBrowserPane({ id, destination, onClose }: InAppBrowserPaneProps) {
  const instanceId = useId();
  const titleId = `in-app-browser-pane-title-${instanceId}`;
  return (
    <aside
      id={id}
      role="complementary"
      aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
      className="mb-2 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
      style={{ width: 'clamp(320px, 44%, 680px)' }}
    >
      <InAppBrowserSurface destination={destination} onClose={onClose} presentation="pane" titleId={titleId} />
    </aside>
  );
}

interface InAppBrowserHost {
  paneId: string;
  presentation: 'pane' | 'sheet';
  openDestination: (destination: BrowserDestination, opener: HTMLElement) => void;
}

const InAppBrowserContext = createContext<InAppBrowserHost | null>(null);

/**
 * Session-local browser host. Session panes are retained across app navigation,
 * so its selected URL is retained alongside that session's draft and scroll.
 */
export function InAppBrowserWorkspace({ compact, children }: { compact: boolean; children: ReactNode }) {
  const generatedId = useId();
  const paneId = `in-app-browser-pane-${generatedId}`;
  const openerRef = useRef<HTMLElement | null>(null);
  const [destination, setDestination] = useState<BrowserDestination | null>(null);
  const [open, setOpen] = useState(false);

  const openDestination = useCallback((next: BrowserDestination, opener: HTMLElement) => {
    openerRef.current = opener;
    setDestination(next);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && typeof window !== 'undefined' && document.contains(opener)) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }, []);

  // Stable while the preview opens/closes, so hundreds of transcript links do
  // not all re-render just because the sibling browser surface changed URL.
  const host = useMemo<InAppBrowserHost>(
    () => ({ paneId, presentation: compact ? 'sheet' : 'pane', openDestination }),
    [compact, openDestination, paneId],
  );

  return (
    <InAppBrowserContext.Provider value={host}>
      <div className="flex h-full min-h-0 min-w-0 w-full gap-2">
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        {!compact && open && destination && <InAppBrowserPane id={paneId} destination={destination} onClose={close} />}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {open && destination
          ? `${compact ? 'Opened link preview' : 'Opened link preview beside the conversation'}: ${destination.href}`
          : ''}
      </div>
      {compact && destination && <InAppBrowserSheet destination={destination} open={open} onClose={close} />}
    </InAppBrowserContext.Provider>
  );
}

type InAppBrowserLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href?: string };

/** Markdown link renderer: only an explicit, unmodified primary tap opens the browser surface. */
export function InAppBrowserLink({ href, onClick, download, children, ...rest }: InAppBrowserLinkProps) {
  const host = useContext(InAppBrowserContext);
  const baseHref = typeof document === 'undefined' ? undefined : document.baseURI;
  const renderDestination = browserDestination(href, baseHref);
  const [destination, setDestination] = useState<BrowserDestination | null>(null);
  const [open, setOpen] = useState(false);

  function activate(event: ReactMouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    const next = browserDestination(href, event.currentTarget.ownerDocument.baseURI);
    if (!next || !shouldOpenInApp(event, next, download)) return;
    event.preventDefault();
    if (host) host.openDestination(next, event.currentTarget);
    else {
      setDestination(next);
      setOpen(true);
    }
  }

  return (
    <>
      <a
        {...rest}
        href={href}
        download={download}
        target="_blank"
        rel="noreferrer"
        aria-haspopup={renderDestination && (!host || host.presentation === 'sheet') ? 'dialog' : rest['aria-haspopup']}
        aria-controls={renderDestination && host?.presentation === 'pane' ? host.paneId : rest['aria-controls']}
        onClick={activate}
      >
        {children}
      </a>
      {!host &&
        destination &&
        typeof document !== 'undefined' &&
        createPortal(
          <InAppBrowserSheet destination={destination} open={open} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}
