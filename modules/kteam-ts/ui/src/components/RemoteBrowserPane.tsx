import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  ArrowLeft,
  Bot,
  ClipboardPaste,
  Expand,
  Globe2,
  Monitor,
  Power,
  PowerOff,
  Scan,
  UserRound,
} from 'lucide-react';
import { Badge, Button } from './Primitives';
import {
  remoteBrowserApi,
  remoteBrowserStreamUrl,
  remoteViewportForContainer,
  type RemoteBrowserStatus,
  type RemoteViewportMode,
} from '../lib/remote-browser';

export interface RemoteBrowserPaneProps {
  sessionId: string;
  /** Hidden/unmounted viewers detach only; the daemon-side browser survives. */
  isActive?: boolean;
  /** The unified two-engine browser surface owns the shared address bar. */
  showNavigation?: boolean;
  /** Transient page identity for a shared address/history UI; never persisted. */
  onLocationChange?: (location: { url: string; title: string }) => void;
  /** Narrow test seam; production always uses the same-origin defaults. */
  dependencies?: RemoteBrowserDependencies;
}

export interface RemoteBrowserDependencies {
  api: typeof remoteBrowserApi;
  streamUrl: typeof remoteBrowserStreamUrl;
  viewportForContainer: typeof remoteViewportForContainer;
}

const DEFAULT_DEPENDENCIES: RemoteBrowserDependencies = {
  api: remoteBrowserApi,
  streamUrl: remoteBrowserStreamUrl,
  viewportForContainer: remoteViewportForContainer,
};

type ViewerConnection = 'detached' | 'connecting' | 'connected' | 'disconnected';
type StreamInput = Record<string, unknown> & { kind: 'mouse' | 'key' | 'insertText' };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const pointerButton = (button: number): 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward' =>
  button === 0
    ? 'left'
    : button === 1
      ? 'middle'
      : button === 2
        ? 'right'
        : button === 3
          ? 'back'
          : button === 4
            ? 'forward'
            : 'none';
const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

/** Cross-platform CDP screencast surface for SidePaneWorkspace. */
export function RemoteBrowserPane({
  sessionId,
  isActive = true,
  showNavigation = true,
  onLocationChange,
  dependencies = DEFAULT_DEPENDENCIES,
}: RemoteBrowserPaneProps) {
  const { api, streamUrl, viewportForContainer } = dependencies;
  const screenRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<StreamInput | null>(null);
  const statusRequestGenerationRef = useRef(0);
  const statusMutationsRef = useRef(0);
  const busyMutationsRef = useRef(0);
  const pressedKeysRef = useRef(new Map<string, StreamInput>());
  const composingTextRef = useRef(false);
  const lastViewportRef = useRef('');
  const lastLocationNotificationRef = useRef('');
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  const [status, setStatus] = useState<RemoteBrowserStatus | null>(null);
  const [connection, setConnection] = useState<ViewerConnection>('detached');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fit, setFit] = useState(true);
  const [viewportMode, setViewportMode] = useState<RemoteViewportMode>('responsive');
  const [reconnectKey, setReconnectKey] = useState(0);
  const [address, setAddress] = useState('');

  const sendInput = useCallback((input: StreamInput) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // A click/key/paste can change location. Invalidate any status snapshot
    // already in flight so it cannot publish the pre-input URL afterward.
    if (input.kind !== 'mouse' || input.type !== 'mouseMoved') statusRequestGenerationRef.current += 1;
    socket.send(JSON.stringify(input));
  }, []);

  const releasePressedKeys = useCallback(() => {
    const releases = [...pressedKeysRef.current.values()].reverse();
    pressedKeysRef.current.clear();
    for (const input of releases) {
      const { text: _text, unmodifiedText: _unmodifiedText, ...rest } = input;
      sendInput({ ...rest, type: 'keyUp', modifiers: 0, autoRepeat: false });
    }
  }, [sendInput]);

  const commitStatus = useCallback((request: number, next: RemoteBrowserStatus): boolean => {
    if (request !== statusRequestGenerationRef.current) return false;
    setStatus(next);
    if (next.error) setError(next.error);
    return true;
  }, []);

  const refreshStatus = useCallback(async () => {
    // A mutation result is the authoritative newer snapshot. Polling resumes
    // after it settles instead of racing a pre-mutation status read against it.
    if (statusMutationsRef.current > 0) return;
    const request = ++statusRequestGenerationRef.current;
    try {
      const next = await api.status(sessionId);
      commitStatus(request, next);
    } catch (caught) {
      if (request === statusRequestGenerationRef.current) setError(errorMessage(caught));
    }
  }, [api, commitStatus, sessionId]);

  const runStatusMutation = useCallback(
    async (operation: () => Promise<{ status: RemoteBrowserStatus }>, showBusy = false) => {
      const request = ++statusRequestGenerationRef.current;
      statusMutationsRef.current += 1;
      if (showBusy) {
        busyMutationsRef.current += 1;
        setBusy(true);
        setError(null);
      }
      try {
        const result = await operation();
        commitStatus(request, result.status);
      } catch (caught) {
        if (request === statusRequestGenerationRef.current) setError(errorMessage(caught));
      } finally {
        statusMutationsRef.current = Math.max(0, statusMutationsRef.current - 1);
        if (showBusy) {
          busyMutationsRef.current = Math.max(0, busyMutationsRef.current - 1);
          if (busyMutationsRef.current === 0) setBusy(false);
        }
      }
    },
    [commitStatus],
  );

  const mutate = useCallback(
    async (operation: () => Promise<{ status: RemoteBrowserStatus }>) => {
      await runStatusMutation(operation, true);
    },
    [runStatusMutation],
  );

  useEffect(() => {
    if (!isActive) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2_500);
    return () => {
      window.clearInterval(timer);
      // Hidden/unmounted retained panes must not publish a response that was
      // sampled while they were active.
      statusRequestGenerationRef.current += 1;
    };
  }, [isActive, refreshStatus]);

  useEffect(() => {
    if (!status?.url) return;
    const title = status.title ?? '';
    const key = `${status.url}\n${title}`;
    const notify = onLocationChangeRef.current;
    if (!notify) return;
    if (lastLocationNotificationRef.current === key) return;
    lastLocationNotificationRef.current = key;
    notify({ url: status.url, title });
  }, [status?.title, status?.url]);

  useEffect(() => {
    if (!showNavigation || !status?.url || document.activeElement === addressInputRef.current) return;
    setAddress(status.url);
  }, [showNavigation, status?.url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isActive || status?.state !== 'running') {
      setConnection('detached');
      return;
    }
    let disposed = false;
    let decoding = false;
    let pending: ArrayBuffer | null = null;
    const draw = async (bytes: ArrayBuffer) => {
      pending = bytes;
      if (decoding) return;
      decoding = true;
      while (!disposed && pending) {
        const next = pending;
        pending = null;
        try {
          const bitmap = await createImageBitmap(new Blob([next], { type: 'image/jpeg' }));
          if (!disposed) {
            if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
            if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
            canvas.getContext('2d', { alpha: false })?.drawImage(bitmap, 0, 0);
          }
          bitmap.close();
        } catch {
          if (!disposed) setError('A remote browser frame could not be decoded.');
        }
      }
      decoding = false;
    };

    setConnection('connecting');
    setError(null);
    const socket = new WebSocket(streamUrl(sessionId));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      if (!disposed) {
        // A transport loss may have happened between a remote key-down and
        // key-up. Release retained keys as soon as the replacement socket is
        // usable so Chrome cannot remain stuck in a modifier state.
        releasePressedKeys();
        setConnection('connected');
      }
    });
    socket.addEventListener('message', event => {
      if (!disposed && event.data instanceof ArrayBuffer) void draw(event.data);
    });
    socket.addEventListener('close', event => {
      if (disposed) return;
      setConnection('disconnected');
      if (event.code !== 1000) setError('Remote display disconnected; reconnecting…');
      void refreshStatus();
      reconnectTimerRef.current = window.setTimeout(() => setReconnectKey(value => value + 1), 1_200);
    });
    socket.addEventListener('error', () => {
      if (!disposed) setError('The authenticated remote display connection failed.');
    });
    return () => {
      disposed = true;
      pending = null;
      if (socket.readyState === WebSocket.OPEN) releasePressedKeys();
      if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (socketRef.current === socket) socketRef.current = null;
      socket.close(1000, 'viewer detached');
      setConnection('detached');
    };
  }, [isActive, reconnectKey, refreshStatus, releasePressedKeys, sessionId, status?.state, streamUrl]);

  useEffect(() => {
    const releaseOnBlur = () => releasePressedKeys();
    const releaseWhenHidden = () => {
      if (document.visibilityState !== 'visible') releasePressedKeys();
    };
    window.addEventListener('blur', releaseOnBlur);
    document.addEventListener('visibilitychange', releaseWhenHidden);
    return () => {
      window.removeEventListener('blur', releaseOnBlur);
      document.removeEventListener('visibilitychange', releaseWhenHidden);
    };
  }, [releasePressedKeys]);

  useEffect(
    () => () => {
      if (moveFrameRef.current != null) window.cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
      pendingMoveRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || !isActive || status?.state !== 'running' || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const viewport = viewportForContainer(box.width, box.height, viewportMode);
      if (!viewport) return;
      const key = `${viewport.width}x${viewport.height}`;
      if (lastViewportRef.current === key) return;
      if (resizeTimerRef.current != null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        lastViewportRef.current = key;
        void runStatusMutation(() => api.resize(sessionId, viewport.width, viewport.height));
      }, 250);
    });
    observer.observe(screen);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current != null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    };
  }, [api, isActive, runStatusMutation, sessionId, status?.state, viewportForContainer, viewportMode]);

  const canvasPoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) * canvas.width) / Math.max(1, box.width),
      y: ((event.clientY - box.top) * canvas.height) / Math.max(1, box.height),
    };
  };

  const sendPointer = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  ) => {
    const point = canvasPoint(event);
    const input: StreamInput = {
      kind: 'mouse',
      type,
      ...point,
      button: type === 'mouseMoved' ? 'none' : pointerButton(event.button),
      buttons: event.buttons,
      clickCount: event.detail || (type === 'mousePressed' ? 1 : 0),
      modifiers: modifiers(event),
    };
    if (type === 'mouseMoved') {
      pendingMoveRef.current = input;
      if (moveFrameRef.current == null) {
        moveFrameRef.current = window.requestAnimationFrame(() => {
          moveFrameRef.current = null;
          if (pendingMoveRef.current) sendInput(pendingMoveRef.current);
          pendingMoveRef.current = null;
        });
      }
      return;
    }
    sendInput(input);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.pointerType === 'touch') textInputRef.current?.focus({ preventScroll: true });
    else event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    sendPointer(event, 'mousePressed');
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    sendPointer(event, 'mouseReleased');
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    sendInput({
      kind: 'mouse',
      type: 'mouseWheel',
      ...canvasPoint(event),
      button: 'none',
      buttons: 0,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiers(event),
    });
  };

  const onKey = (event: ReactKeyboardEvent<HTMLElement>, type: 'keyDown' | 'keyUp') => {
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    const printable = type === 'keyDown' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const input: StreamInput = {
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
      ...(printable ? { text: event.key, unmodifiedText: event.key } : {}),
      windowsVirtualKeyCode: event.keyCode,
      nativeVirtualKeyCode: event.keyCode,
      modifiers: modifiers(event),
      autoRepeat: event.repeat,
      isKeypad: event.location === 3,
    };
    const id = event.code || event.key;
    if (type === 'keyDown') pressedKeysRef.current.set(id, input);
    else pressedKeysRef.current.delete(id);
    sendInput(input);
  };

  const insertText = useCallback(
    (text: string) => {
      if (text) sendInput({ kind: 'insertText', text });
    },
    [sendInput],
  );

  const onPaste = (event: ReactClipboardEvent<HTMLCanvasElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    insertText(text);
  };

  const onTextInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    if (composingTextRef.current || native.isComposing) return;
    const text = event.currentTarget.value;
    if (!text) return;
    event.currentTarget.value = '';
    insertText(text);
  };

  const onTextCompositionEnd = (event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingTextRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    const text = event.data || event.currentTarget.value;
    event.currentTarget.value = '';
    insertText(text);
  };

  const onTextKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>, type: 'keyDown' | 'keyUp') => {
    if (event.nativeEvent.isComposing) return;
    // Printable text is committed by the input/composition path, which is what
    // virtual keyboards and IMEs reliably expose. Keep key events for editing,
    // navigation, modifiers, and hardware shortcuts.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    onKey(event, type);
  };

  const onTextPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.value = '';
    insertText(text);
  };

  const pasteFromClipboard = async () => {
    try {
      insertText(await navigator.clipboard.readText());
    } catch {
      setError('Clipboard access was blocked. Focus the remote browser and use the system paste gesture.');
    }
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) void mutate(() => api.navigate(sessionId, address));
  };

  const lastActor = status?.lastActor;
  const actorLabel = lastActor
    ? `${lastActor.kind === 'human' ? 'You' : 'Agent'} · ${lastActor.action}`
    : 'No input yet';
  const actorIcon = lastActor?.kind === 'human' ? <UserRound size={13} /> : <Bot size={13} />;
  const running = status?.state === 'running';
  // A failed start leaves the last status snapshot at `stopped` until the next
  // poll returns the daemon's durable `error` state. Treat the preserved API
  // error as authoritative during that interval so the empty canvas never
  // contradicts the red alert by claiming the browser is merely idle.
  const unavailable = !running && (status?.state === 'error' || error !== null);
  const unavailableReason = status?.error ?? error ?? 'The remote browser could not start.';

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Shared remote browser">
      <div className="flex shrink-0 flex-wrap items-center gap-xs border-b border-border-soft px-2 py-2">
        <Badge tone={running ? 'ok' : status?.state === 'error' ? 'err' : 'pend'}>{status?.state ?? 'checking'}</Badge>
        <Badge tone={lastActor?.kind === 'human' ? 'accent' : 'pend'} className="inline-flex items-center gap-1">
          {actorIcon}
          {actorLabel}
        </Badge>
        <span className="ml-auto text-meta text-muted">
          {connection === 'connected' ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Display idle'}
        </span>
      </div>

      {showNavigation && (
        <form onSubmit={navigate} className="flex shrink-0 items-center gap-xs border-b border-border-soft px-2 py-2">
          <Button
            type="button"
            size="sm"
            disabled={!running || busy}
            onClick={() => void mutate(() => api.back(sessionId))}
            aria-label="Back"
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </Button>
          <label className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-surface px-2">
            <Globe2 size={14} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="sr-only">Navigate remote browser</span>
            <input
              ref={addressInputRef}
              value={address}
              onChange={event => setAddress(event.target.value)}
              onBlur={() => {
                if (status?.url) setAddress(status.url);
              }}
              disabled={!running}
              placeholder="URL or hostname"
              className="h-9 min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-muted"
            />
          </label>
          <Button type="submit" size="sm" disabled={!running || busy || !address.trim()}>
            Go
          </Button>
        </form>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-xs border-b border-border-soft px-2 py-2">
        {!running ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy || status?.state === 'starting'}
            onClick={() => void mutate(() => api.start(sessionId))}
            className="min-h-[44px] gap-xs"
          >
            <Power size={14} aria-hidden="true" /> Start browser
          </Button>
        ) : (
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => void mutate(() => api.stop(sessionId))}
            className="min-h-[44px] gap-xs"
          >
            <PowerOff size={14} aria-hidden="true" /> Stop
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={!running || connection !== 'connected'}
          onClick={() => void pasteFromClipboard()}
          className="min-h-[44px] gap-xs"
        >
          <ClipboardPaste size={14} aria-hidden="true" /> Paste
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!running}
          onClick={() => setFit(value => !value)}
          aria-pressed={fit}
          className="min-h-[44px] gap-xs"
        >
          <Expand size={14} aria-hidden="true" /> {fit ? 'Fit' : '1:1'}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!running}
          onClick={() => {
            lastViewportRef.current = '';
            setViewportMode(value => (value === 'responsive' ? 'desktop' : 'responsive'));
          }}
          aria-pressed={viewportMode === 'desktop'}
          className="min-h-[44px] gap-xs"
          title="On a phone, desktop fit keeps a 1280×800 viewport and scales it to width"
        >
          {viewportMode === 'desktop' ? (
            <Monitor size={14} aria-hidden="true" />
          ) : (
            <Scan size={14} aria-hidden="true" />
          )}
          {viewportMode === 'desktop' ? 'Desktop fit' : 'Responsive'}
        </Button>
        <textarea
          ref={textInputRef}
          rows={1}
          disabled={!running || connection !== 'connected'}
          aria-label="Type into remote browser"
          placeholder="Type into page…"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-h-[44px] min-w-[10rem] flex-1 resize-none rounded-md border border-border bg-surface px-2 py-2 text-ui text-fg outline-none placeholder:text-muted md:hidden"
          onInput={onTextInput}
          onCompositionStart={() => {
            composingTextRef.current = true;
          }}
          onCompositionEnd={onTextCompositionEnd}
          onKeyDown={event => onTextKey(event, 'keyDown')}
          onKeyUp={event => onTextKey(event, 'keyUp')}
          onPaste={onTextPaste}
          onBlur={releasePressedKeys}
        />
      </div>

      {error && (
        <div role="alert" className="shrink-0 border-b border-err/30 bg-err-soft px-3 py-2 text-meta text-err">
          {error}
        </div>
      )}

      <div
        ref={screenRef}
        className={`relative min-h-[240px] flex-1 bg-[#09090b] ${fit ? 'flex items-center justify-center overflow-hidden' : 'overflow-auto'}`}
      >
        <canvas
          ref={canvasRef}
          tabIndex={running ? 0 : -1}
          aria-label="Live Chrome page; click to send keyboard and pointer input"
          className="block touch-none bg-black outline-none focus:ring-2 focus:ring-inset focus:ring-accent"
          style={fit ? { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={event => sendPointer(event, 'mouseMoved')}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onKeyDown={event => onKey(event, 'keyDown')}
          onKeyUp={event => onKey(event, 'keyUp')}
          onBlur={releasePressedKeys}
          onPaste={onPaste}
          onContextMenu={event => event.preventDefault()}
        />
        {!running && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-panel text-center">
            <div className="max-w-xs">
              <Monitor size={30} aria-hidden="true" className={`mx-auto ${unavailable ? 'text-err' : 'text-muted'}`} />
              {unavailable ? (
                <>
                  <p className="mb-0 mt-3 text-ui font-medium text-err">Browser unavailable</p>
                  <p className="mb-0 mt-1 break-words text-meta leading-base text-err">{unavailableReason}</p>
                </>
              ) : (
                <>
                  <p className="mb-0 mt-3 text-ui font-medium text-fg">Browser is stopped</p>
                  <p className="mb-0 mt-1 text-meta leading-base text-muted">
                    Start it here or run <code>kteam browser open</code>. Login state remains in the persistent profile.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border-soft px-3 py-1.5 text-meta text-muted">
        {status
          ? `${status.viewport.width}×${status.viewport.height} · ${status.viewers} viewer${status.viewers === 1 ? '' : 's'} · ${Math.round(status.idleTimeoutSeconds / 60)}m idle stop`
          : 'Checking browser lifecycle…'}
      </div>
    </section>
  );
}
