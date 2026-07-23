// SSE helpers for `kloop serve`. /api/events emits the literal text "reload" when
// the store changes; /api/kloop/stream tails a log file as {full}|{append} frames.

/** Subscribe to the global store-changed stream. Calls `onReload` on each change. */
export function openReloadStream(onReload: () => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    if (e.data === 'reload') onReload();
  };
  return () => es.close();
}

/** Tail a log file; `onData` receives incremental text (full replace resets first). */
export function openLogStream(rel: string, onData: (text: string, reset: boolean) => void): () => void {
  const es = new EventSource(`/api/kloop/stream?path=${encodeURIComponent(rel)}`);
  es.onmessage = e => {
    try {
      const msg = JSON.parse(e.data) as { full?: string; append?: string };
      if (msg.full !== undefined) onData(msg.full, true);
      else if (msg.append !== undefined) onData(msg.append, false);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => es.close();
}
