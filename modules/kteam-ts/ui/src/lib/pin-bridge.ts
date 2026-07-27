// The bridge between the Pins sheet (mounted in SessionHeader) and the
// transcript scroller (Transcript.tsx) — WITHOUT threading a session id through
// SessionChatPage, which another surface owns.
//
// WHY A MODULE-LEVEL BRIDGE AND NOT PROPS. The sheet lives in the header; the
// scroll machinery and the pinnable rows live in the transcript; they are
// SIBLINGS under the page, with no shared owner this feature is allowed to
// edit. Two facts make a small singleton the honest wiring:
//
//   1. Only the FOREGROUND pane is interactable. Retained background panes stay
//      mounted but `visibility:hidden` with an `aria-hidden` ancestor (App.tsx),
//      so exactly one transcript viewport in the document is not inside
//      `[aria-hidden="true"]`. A controller can prove it is the foreground one
//      from its own DOM, so the bridge never needs to be told which session a
//      transcript belongs to.
//   2. SessionHeader already receives BOTH the session id and `active`, so the
//      active header is the natural, unambiguous writer of "which session is in
//      front" — the id the sheet reads its pins for.
//
// This keeps the round-5 scroll invariant intact: the bridge never writes
// scrollTop itself. It hands a blockId to the foreground transcript's OWN jump
// executor, which detaches follow first and integrates with the pin guard.

/** What a jump can resolve to. `not-found` is the load-bearing honest outcome:
 *  the pinned block is not in the loaded (and locate-loaded) history, so the
 *  sheet says so rather than scrolling to a plausible-but-wrong message. */
export type JumpOutcome = 'jumped' | 'not-found' | 'no-transcript';

export interface JumpController {
  /** True when this controller's viewport is the foreground pane's (not inside
   *  an `aria-hidden` retained pane). */
  isForeground(): boolean;
  /** Locate the block (paging older history up to the controller's cap, calling
   *  `onProgress` with the number of older pages loaded so the sheet can show a
   *  "Locating…" state), then scroll+highlight it. Never scrolls to a different
   *  block: exact-id match only. */
  jumpTo(blockId: string, onProgress?: (olderPagesLoaded: number) => void): Promise<JumpOutcome>;
}

type Listener = () => void;

const controllers = new Set<JumpController>();

let foreground: string | null = null;
const fgListeners = new Set<Listener>();

/** SessionHeader calls this: set while active, clear (to its own id) when it
 *  stops being active. Last active header wins, which is correct — there is only
 *  ever one foreground pane. */
export function setForegroundSession(sessionId: string | null): void {
  if (foreground === sessionId) return;
  foreground = sessionId;
  for (const l of fgListeners) l();
}

/** Clear only if WE are still the foreground; avoids a just-unmounted background
 *  header wiping the newly-active one's id. */
export function clearForegroundSession(sessionId: string): void {
  if (foreground === sessionId) setForegroundSession(null);
}

export function getForegroundSession(): string | null {
  return foreground;
}

export function subscribeForegroundSession(listener: Listener): () => void {
  fgListeners.add(listener);
  return () => fgListeners.delete(listener);
}

/** The foreground transcript registers its jump executor here. */
export function registerJumpController(controller: JumpController): () => void {
  controllers.add(controller);
  return () => controllers.delete(controller);
}

/** Resolve the one controller whose viewport is currently in the foreground. */
export function foregroundController(): JumpController | null {
  for (const c of controllers) {
    try {
      if (c.isForeground()) return c;
    } catch {
      /* a controller mid-teardown just does not count */
    }
  }
  return null;
}

/** The sheet's jump entry point. Delegates to the foreground transcript, or
 *  reports `no-transcript` when none is mounted (e.g. the reader is on the
 *  Terminal tab, so the transcript is not rendered). */
export async function requestJump(
  blockId: string,
  onProgress?: (olderPagesLoaded: number) => void,
): Promise<JumpOutcome> {
  const controller = foregroundController();
  if (!controller) return 'no-transcript';
  return controller.jumpTo(blockId, onProgress);
}
