import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, Clipboard, Pencil, Plus, RefreshCw, SquareTerminal, Trash2, X } from 'lucide-react';
import { Button } from './Primitives';
import {
  terminalLimitLabel,
  webTerminalApi,
  webTerminalStreamUrl,
  type WebTerminal,
  type WebTerminalList,
} from '../lib/web-terminals';
import './web-terminals.css';

type XtermModules = {
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
};

export interface WebTerminalsDependencies {
  api: typeof webTerminalApi;
  streamUrl: typeof webTerminalStreamUrl;
  loadXterm(): Promise<XtermModules>;
}

const DEFAULT_DEPENDENCIES: WebTerminalsDependencies = {
  api: webTerminalApi,
  streamUrl: webTerminalStreamUrl,
  loadXterm: async () => {
    const [xterm, fit] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  },
};

export interface WebTerminalsProps {
  sessionId: string;
  /** Display-only. The daemon derives and enforces cwd from session config. */
  cwd?: string;
  dependencies?: WebTerminalsDependencies;
}

type ConnectionState = 'idle' | 'connecting' | 'live' | 'offline';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function terminalTheme(): import('@xterm/xterm').ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--code-bg', '#111'),
    foreground: token('--code-fg', '#eee'),
    cursor: token('--accent', '#fff'),
    cursorAccent: token('--code-bg', '#111'),
    selectionBackground: token('--accent-soft', '#555'),
    selectionForeground: token('--fg', '#fff'),
    black: token('--fg', '#111'),
    brightBlack: token('--muted', '#777'),
    white: token('--surface-3', '#ddd'),
    brightWhite: token('--fg', '#fff'),
  };
}

function bytesFromBinaryString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function TerminalCanvas({
  sessionId,
  terminal,
  active,
  scrollback,
  dependencies,
  onConnection,
  onSelection,
}: {
  sessionId: string;
  terminal: WebTerminal;
  active: boolean;
  scrollback: number;
  dependencies: WebTerminalsDependencies;
  onConnection: (state: ConnectionState) => void;
  onSelection: (selection: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onConnectionRef = useRef(onConnection);
  const onSelectionRef = useRef(onSelection);
  onConnectionRef.current = onConnection;
  onSelectionRef.current = onSelection;
  const [readyVersion, setReadyVersion] = useState(0);
  const [reconnectVersion, setReconnectVersion] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let selectionDisposable: { dispose(): void } | undefined;
    let dataDisposable: { dispose(): void } | undefined;
    let binaryDisposable: { dispose(): void } | undefined;

    void dependencies
      .loadXterm()
      .then(({ Terminal, FitAddon }) => {
        if (disposed) return;
        const xterm = new Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: 'bar',
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
          fontSize: 12.5,
          lineHeight: 1.14,
          scrollback,
          theme: terminalTheme(),
        });
        const fit = new FitAddon();
        xterm.loadAddon(fit);
        xterm.open(host);
        terminalRef.current = xterm;
        fitRef.current = fit;

        // Let the browser own copy/paste shortcuts when there is a selection;
        // every other key remains terminal input. No focus() call: opening the
        // side pane must never steal the composer.
        xterm.attachCustomKeyEventHandler(event => {
          const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey;
          if (shortcut && event.code === 'KeyC' && xterm.hasSelection()) return false;
          if (shortcut && event.code === 'KeyV') return false;
          return true;
        });
        const send = (bytes: Uint8Array) => {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) socket.send(bytes);
        };
        dataDisposable = xterm.onData(value => send(new TextEncoder().encode(value)));
        binaryDisposable = xterm.onBinary(value => send(bytesFromBinaryString(value)));
        selectionDisposable = xterm.onSelectionChange(() => onSelectionRef.current(xterm.getSelection()));

        const fitAndResize = () => {
          if (!activeRef.current || host.clientWidth < 1 || host.clientHeight < 1) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
          }
        };
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => fitAndResize());
          observer.observe(host);
        }
        if (typeof MutationObserver !== 'undefined') {
          themeObserver = new MutationObserver(() => {
            xterm.options.theme = terminalTheme();
          });
          themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme', 'class'],
          });
        }
        window.requestAnimationFrame(fitAndResize);
        setReadyVersion(version => version + 1);
      })
      .catch(() => {
        if (!disposed) onConnectionRef.current('offline');
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      themeObserver?.disconnect();
      dataDisposable?.dispose();
      binaryDisposable?.dispose();
      selectionDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [dependencies, scrollback]);

  useEffect(() => {
    const xterm = terminalRef.current;
    const fit = fitRef.current;
    if (!active || !xterm || !fit) {
      onConnectionRef.current('idle');
      return;
    }
    let disposed = false;
    let reconnectTimer: number | undefined;
    onConnectionRef.current('connecting');
    const socket = new WebSocket(dependencies.streamUrl(sessionId, terminal.id));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      if (disposed) return;
      onConnectionRef.current('live');
      window.requestAnimationFrame(() => {
        if (disposed) return;
        try {
          fit.fit();
          socket.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
        } catch {
          // A zero-sized retained pane will be fitted by ResizeObserver later.
        }
      });
    });
    socket.addEventListener('message', event => {
      if (!disposed && event.data instanceof ArrayBuffer) xterm.write(new Uint8Array(event.data));
    });
    socket.addEventListener('close', event => {
      if (disposed) return;
      onConnectionRef.current('offline');
      if (event.code !== 1000) {
        reconnectTimer = window.setTimeout(() => setReconnectVersion(version => version + 1), 1_200);
      }
    });
    socket.addEventListener('error', () => {
      if (!disposed) onConnectionRef.current('offline');
    });
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (socketRef.current === socket) socketRef.current = null;
      socket.close(1000, 'terminal tab detached');
      onConnectionRef.current('idle');
    };
  }, [active, dependencies, readyVersion, reconnectVersion, sessionId, terminal.id]);

  return (
    <div
      ref={hostRef}
      className="kt-webterm__xterm"
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => event.stopPropagation()}
      aria-label={`${terminal.title} shell`}
    />
  );
}

export function WebTerminals({ sessionId, cwd, dependencies = DEFAULT_DEPENDENCIES }: WebTerminalsProps) {
  const [list, setList] = useState<WebTerminalList | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connection, setConnection] = useState<Record<string, ConnectionState>>({});
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await dependencies.api.list(sessionId);
      setList(next);
      setActiveId(current =>
        current && next.terminals.some(terminal => terminal.id === current) ? current : (next.terminals[0]?.id ?? null),
      );
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [dependencies, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const terminals = list?.terminals ?? [];
  const active = terminals.find(terminal => terminal.id === activeId) ?? null;
  const atSessionCap = list ? terminals.length >= list.limits.perSession : false;
  const atGlobalCap = list ? list.limits.runningGlobal >= list.limits.global : false;

  const createTerminal = async () => {
    if (busy || atSessionCap || atGlobalCap) return;
    setBusy(true);
    setError(null);
    try {
      const terminal = await dependencies.api.create(sessionId);
      setList(current =>
        current
          ? {
              ...current,
              terminals: [...current.terminals, terminal],
              limits: { ...current.limits, runningGlobal: current.limits.runningGlobal + 1 },
            }
          : current,
      );
      setActiveId(terminal.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const beginRename = () => {
    if (!active) return;
    setRenameValue(active.title);
    setRenaming(true);
  };

  const saveRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!active || !renameValue.trim() || busy) return;
    setBusy(true);
    try {
      const updated = await dependencies.api.rename(sessionId, active.id, renameValue.trim());
      setList(current =>
        current
          ? { ...current, terminals: current.terminals.map(item => (item.id === updated.id ? updated : item)) }
          : current,
      );
      setRenaming(false);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const closeTerminal = async () => {
    if (!active || busy) return;
    const confirmed = window.confirm(`Close “${active.title}”? This ends its shell process.`);
    if (!confirmed) return;
    const activeIndex = terminals.findIndex(item => item.id === active.id);
    const fallbackId = terminals[activeIndex + 1]?.id ?? terminals[activeIndex - 1]?.id ?? null;
    setBusy(true);
    try {
      await dependencies.api.close(sessionId, active.id);
      setList(current =>
        current
          ? {
              ...current,
              terminals: current.terminals.filter(item => item.id !== active.id),
              limits: { ...current.limits, runningGlobal: Math.max(0, current.limits.runningGlobal - 1) },
            }
          : current,
      );
      setActiveId(current => (current === active.id ? fallbackId : current));
      setRenaming(false);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const copySelection = async () => {
    const text = active ? selection[active.id] : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError('Clipboard access was denied. Use Ctrl/Cmd+C while the selection is active.');
    }
  };

  const activeConnection = active ? (connection[active.id] ?? 'idle') : 'idle';

  return (
    <section className="kt-webterm" aria-label="Shell terminals">
      <div className="kt-webterm__deck">
        <div className="kt-webterm__tabs" role="tablist" aria-label="Open shell terminals">
          {terminals.map(terminal => (
            <button
              key={terminal.id}
              type="button"
              role="tab"
              id={`web-terminal-tab-${terminal.id}`}
              aria-selected={terminal.id === activeId}
              aria-controls={`web-terminal-panel-${terminal.id}`}
              onClick={() => {
                setActiveId(terminal.id);
                setRenaming(false);
              }}
              className="kt-webterm__tab"
              data-active={terminal.id === activeId ? true : undefined}
              title={terminal.title}
            >
              <span className="kt-webterm__lamp" data-state={connection[terminal.id] ?? 'idle'} aria-hidden="true" />
              <span>{terminal.title}</span>
            </button>
          ))}
          <button
            type="button"
            className="kt-webterm__new"
            onClick={() => void createTerminal()}
            disabled={busy || atSessionCap || atGlobalCap}
            aria-label="Create terminal"
            title={atSessionCap || atGlobalCap ? 'Terminal capacity reached' : 'Create terminal'}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="kt-webterm__ledger">
          <span className="kt-webterm__cwd" title={cwd ?? 'Session working directory'}>
            {cwd ?? 'session cwd'}
          </span>
          <span>{list ? terminalLimitLabel(list) : 'loading terminals…'}</span>
        </div>
      </div>

      {error && (
        <div className="kt-webterm__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()} aria-label="Retry loading terminals">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {active ? (
        <>
          <div className="kt-webterm__toolbar">
            {renaming ? (
              <form className="kt-webterm__rename" onSubmit={event => void saveRename(event)}>
                <input
                  value={renameValue}
                  onChange={event => setRenameValue(event.target.value)}
                  maxLength={64}
                  aria-label="Terminal name"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="ghost"
                  disabled={busy || !renameValue.trim()}
                  aria-label="Save name"
                >
                  <Check size={14} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming(false)}
                  aria-label="Cancel rename"
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </form>
            ) : (
              <div className="kt-webterm__identity">
                <SquareTerminal size={15} aria-hidden="true" />
                <strong>{active.title}</strong>
                <span className="kt-webterm__connection" data-state={activeConnection}>
                  {activeConnection === 'live'
                    ? 'live'
                    : activeConnection === 'connecting'
                      ? 'connecting'
                      : activeConnection === 'offline'
                        ? 'reconnecting'
                        : 'detached'}
                </span>
              </div>
            )}
            <div className="kt-webterm__actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void copySelection()}
                disabled={!selection[active.id]}
                aria-label="Copy selection"
                title="Copy selection"
              >
                <Clipboard size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={beginRename}
                disabled={busy || renaming}
                aria-label="Rename terminal"
                title="Rename terminal"
              >
                <Pencil size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void closeTerminal()}
                disabled={busy}
                aria-label="Close terminal process"
                title="Close terminal process"
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="kt-webterm__stage">
            {terminals.map(terminal => (
              <div
                key={terminal.id}
                id={`web-terminal-panel-${terminal.id}`}
                role="tabpanel"
                aria-labelledby={`web-terminal-tab-${terminal.id}`}
                hidden={terminal.id !== activeId}
                className="kt-webterm__panel"
              >
                <TerminalCanvas
                  sessionId={sessionId}
                  terminal={terminal}
                  active={terminal.id === activeId}
                  scrollback={list?.limits.scrollbackLines ?? 5_000}
                  dependencies={dependencies}
                  onConnection={state =>
                    setConnection(current =>
                      current[terminal.id] === state ? current : { ...current, [terminal.id]: state },
                    )
                  }
                  onSelection={value =>
                    setSelection(current =>
                      current[terminal.id] === value ? current : { ...current, [terminal.id]: value },
                    )
                  }
                />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="kt-webterm__empty">
          <span className="kt-webterm__empty-icon" aria-hidden="true">
            <SquareTerminal size={24} />
          </span>
          <div>
            <strong>No shell terminals open</strong>
            <p>Start one here; it opens in this session’s working directory and survives page reloads.</p>
          </div>
          <Button
            type="button"
            variant="primary"
            onClick={() => void createTerminal()}
            disabled={busy || atSessionCap || atGlobalCap}
          >
            <Plus size={15} aria-hidden="true" />
            New terminal
          </Button>
        </div>
      )}
    </section>
  );
}
