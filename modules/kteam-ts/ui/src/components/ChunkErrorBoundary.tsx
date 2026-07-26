// A DEAD LAZY CHUNK MUST NOT BE ABLE TO BLANK THE WHOLE APP.
//
// WHAT WENT WRONG WITHOUT THIS (Stage E drill, `drill-nocache.json`, 62/65).
// A tab held open across four deploys has its generation's cache pruned. It
// navigates to a session, the chat chunk's URL is gone from cache AND server,
// and the dynamic import rejects. Everything the update hook does then works
// exactly as designed — `vite:preloadError` fires, `preventDefault()` stops the
// unhandled rejection, the chip is raised in RECOVERY wording — and the reader
// still ends up on a permanently blank document, because React unmounts the
// whole root and takes the chip down with it. Measured at the failure point:
// `#root.children.length === 0`, `document.body.innerText === ""`, `chip: null`.
//
// The mechanism is that `preventDefault()` only suppresses the GLOBAL
// unhandled-rejection surface. The rejected `import()` still rejects the
// `React.lazy` promise, React rethrows it during render, and — with no error
// boundary anywhere in the tree — React's documented response to an uncaught
// render error is to unmount the entire root. So the one UI element that exists
// to rescue this exact situation was being destroyed by the event that raises
// it. This boundary is the missing half: `startPreloadErrorWatch` handles the
// preload-path failure, this handles the render-time rethrow. They are a pair,
// not alternatives.
//
// WHY IT CATCHES EVERYTHING RATHER THAN SNIFFING FOR CHUNK ERRORS.
// The obvious refinement — only swallow errors whose message matches Vite's
// "Failed to fetch dynamically imported module" — would MISS the very failure
// this exists for. Because the watch calls `preventDefault()`, Vite's preload
// helper resolves the import with `undefined` instead of rethrowing, so the
// error that actually reaches the boundary is the TypeError thrown one line
// later by the lazy factory reading a property off `undefined`. The drill
// recorded it verbatim: `Cannot read properties of undefined (reading
// 'SessionChatPage')`. Nothing in that message says "chunk". So: catch-all, and
// a broken pane carrying an honest reload offer beats a blank root in every
// case, including a genuine render bug. `componentDidCatch` still reports the
// error and the component stack to the console, so dev surfaces keep it.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

export interface ChunkErrorBoundaryProps {
  /** Raised once, when an error is caught. Wired to the update hook's
   *  never-downgrade recovery raise, so the AppBar chip (and, on a phone with
   *  the bar suppressed, the compact recovery band) comes up through the same
   *  tested path a `vite:preloadError` uses. */
  onChunkError: (error: unknown) => void;
  /** The chip's own action — `useServiceWorkerUpdate`'s `applyUpdate`. Passed
   *  in rather than reimplemented here so the fallback button takes the SAME
   *  guarded no-waiter branch: one reload per press, no `SKIP_WAITING` posted
   *  to a registration that has no waiter, no reload loop. */
  onReload: () => void;
  children: ReactNode;
}

interface ChunkErrorBoundaryState {
  failed: boolean;
}

export class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, ChunkErrorBoundaryState> {
  state: ChunkErrorBoundaryState = { failed: false };

  /** React's state-only half of the catch: it runs during the re-render that
   *  follows the throw, so it must be pure. The error itself is handled in
   *  `componentDidCatch`, which is allowed side effects. */
  static getDerivedStateFromError(): ChunkErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Reported, not swallowed: a genuine render bug lands here too, and a
    // boundary that hides it is worse than the crash it prevents.
    console.warn('kteam: a pane failed to render', error, info?.componentStack);
    this.props.onChunkError(error);
  }

  render(): ReactNode {
    // NOTHING WRAPS A HEALTHY CHILD. The boundary is mounted around every pane
    // for the app's life, so on the overwhelmingly common path it must be
    // exactly transparent — no extra element, no layout box, no styling.
    if (!this.state.failed) return this.props.children;

    // Fills the pane the way `ChatChunkFallback` does, so the shell does not
    // shift, and announces itself: `role="alert"` is the assertive counterpart
    // of the loading fallback's `role="status"` — this is not progress, it is a
    // dead end with one way out.
    return (
      <div
        role="alert"
        className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 px-panel text-center"
      >
        {/* NEUTRAL ABOUT THE CAUSE, ON PURPOSE. This boundary catches every
            render error, not only a pruned chunk (see the header), so naming a
            cause here — "removed by a newer deploy" — would be a confident lie
            in the cases where it is a plain render bug. What IS true of every
            error that reaches this point: this page did not load, and a reload
            is the only thing the reader can do about it. */}
        <p className="text-[13px] text-muted">This page failed to load — reload to recover.</p>
        <button
          type="button"
          onClick={this.props.onReload}
          className="kt-badge items-center gap-xs hover:text-fg"
          data-tone="warn"
        >
          <RefreshCw size={11} aria-hidden="true" />
          Reload to recover
        </button>
      </div>
    );
  }
}
