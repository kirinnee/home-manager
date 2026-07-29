// WHO IS ALLOWED TO REPLACE THE BROWSER'S CONTEXT MENU — the one decision, in
// one place, so a phone can select text again.
//
// THE BUG THIS EXISTS TO KILL.
//   On a phone, long-pressing transcript prose was supposed to give the reader
//   the NATIVE selection: two draggable handles and the OS copy bar. Instead the
//   app's own menu opened over it. Our menu paints a full-screen dismissal
//   surface (ContextMenu.tsx, `fixed inset-0 z-50`), so the handles ended up
//   UNDER an invisible button that closes on the first touch — "the context menu
//   that appears blocks everything". Selecting text was effectively impossible.
//
// WHY THE EARLIER ROUND MISSED IT.
//   The transcript's `contextmenu` handler is commented as the DESKTOP path, and
//   it is genuinely never attached to `pointerdown`/`touchstart` — from which the
//   previous pass concluded that it could not fire on touch. That conclusion is
//   wrong. Chrome on Android and Safari on iOS both SYNTHESISE a `contextmenu`
//   event from a long press, and they dispatch it AFTER the browser has already
//   selected the word under the finger. So the handler ran, saw a perfectly real
//   selection, called `preventDefault()` (killing the native copy bar) and
//   mounted our menu on top of the handles. The previous fix (cba582a) moved the
//   touch Quote/Pin bar out of the handles' way, which was a different, real bug
//   — it never touched this handler, so the menu kept blocking everything.
//
// THE RULE.
//   A long press IS the selection gesture. Anything that arrives from a touch or
//   pen pointer therefore keeps the browser's own behaviour, always. Only an
//   unambiguous MOUSE right-click over text we own may be replaced by our menu.
//   Non-text targets are unaffected: a session row is a nav `<a>`, not prose, and
//   its long-press menu is deliberate — this policy is only consulted where a
//   selection is what the press was probably for.

/** Normalised pointer provenance for a `contextmenu` event. `unknown` is a real
 *  answer, not a default: some engines dispatch `contextmenu` as a plain
 *  MouseEvent with no `pointerType` at all, and pretending that is a mouse is
 *  exactly how the phone lost its selection handles. */
export type PointerKind = 'mouse' | 'touch' | 'pen' | 'unknown';

const KNOWN_KINDS = new Set<string>(['mouse', 'touch', 'pen']);

/**
 * Resolve where a `contextmenu` came from.
 *
 * `eventPointerType` is the event's own `pointerType` when the engine dispatched
 * a PointerEvent (Chrome does; it reads `touch` for an Android long press).
 * `lastPointerType` is the pointer type of the most recent press on the surface,
 * which is what covers the engines that dispatch a bare MouseEvent — the press
 * that STARTED the long press still announced itself.
 *
 * The event wins when it says something; the remembered press is the fallback;
 * `unknown` when neither knows. An empty string is "no answer", not a device.
 */
export function resolvePointerKind(
  eventPointerType: string | null | undefined,
  lastPointerType: string | null | undefined,
): PointerKind {
  const fromEvent = typeof eventPointerType === 'string' ? eventPointerType : '';
  if (KNOWN_KINDS.has(fromEvent)) return fromEvent as PointerKind;
  const fromPress = typeof lastPointerType === 'string' ? lastPointerType : '';
  if (KNOWN_KINDS.has(fromPress)) return fromPress as PointerKind;
  return 'unknown';
}

export interface TextContextMenuInput {
  /** Where the `contextmenu` event came from (resolvePointerKind). */
  pointerKind: PointerKind;
  /** Is this a touch-capable/touch-recent environment? Only consulted to break
   *  an `unknown` tie, where it decides conservatively AGAINST us. */
  touchAffected: boolean;
  /** Does a non-empty selection inside our own subtree exist right now? */
  hasSelection: boolean;
}

/**
 * May the app replace the browser's context menu for this text press?
 *
 * `true` means the caller should `preventDefault()` and open its own menu.
 * `false` means hands off entirely — no `preventDefault`, no menu, so the
 * browser keeps the native selection handles and its own copy bar.
 *
 * - No selection → false. There is nothing to quote, and the browser's menu for
 *   a link or an image is none of our business.
 * - Touch or pen → false, unconditionally. The press that produced this event is
 *   the selection gesture itself; replacing its menu is the bug.
 * - Unknown provenance on a touch-affected device → false. An unattributable
 *   `contextmenu` on a phone is a long press until proven otherwise; the cost of
 *   being wrong here (a laptop loses a menu it can reach elsewhere) is far
 *   smaller than the cost of being wrong the other way (a phone cannot select).
 * - Unknown provenance with no touch capability at all → true. A pointer-less
 *   environment (a keyboard "menu" key, an automated event) is a desktop.
 */
export function textContextMenuAllowed({ pointerKind, touchAffected, hasSelection }: TextContextMenuInput): boolean {
  if (!hasSelection) return false;
  if (pointerKind === 'touch' || pointerKind === 'pen') return false;
  if (pointerKind === 'unknown') return !touchAffected;
  return true;
}

/** The shape a `contextmenu` event arrives in, reduced to the one field that
 *  varies by engine. Both a PointerEvent (Chrome) and a bare MouseEvent (some
 *  WebKit paths, synthetic events) satisfy it. */
export interface ContextMenuEventLike {
  pointerType?: string | null;
}

/** The whole decision, in the exact composition the handler uses — resolve the
 *  provenance from the event plus the remembered press, then apply the policy.
 *  Callers own only "did I find a selection"; everything else is here, so the
 *  handler cannot drift away from what the tests assert. */
export function textContextMenuEventAllowed(
  event: ContextMenuEventLike | null | undefined,
  context: { lastPointerType: string | null; touchAffected: boolean; hasSelection: boolean },
): boolean {
  return textContextMenuAllowed({
    pointerKind: resolvePointerKind(event?.pointerType, context.lastPointerType),
    touchAffected: context.touchAffected,
    hasSelection: context.hasSelection,
  });
}
