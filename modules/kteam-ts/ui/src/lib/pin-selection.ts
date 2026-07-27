// PIN A TRANSCRIPT SELECTION — the sibling of quote.ts (QUOTE a selection into
// the composer). The reader highlights transcript text and picks "Pin"; the
// selected snippet is stored as a NOTE pin (lib/pins.ts) for the FOREGROUND
// session, so it sits in the Pins sheet at hand.
//
// WHY A NOTE, NOT A MESSAGE PIN. A message pin references a whole transcript
// block by id and re-derives its preview; a selection is a *snippet the reader
// chose* — arbitrary text, possibly spanning part of a block. So the snippet IS
// the pin's body (a note), exactly like a typed note. But it is cheap to also
// remember WHERE it came from — the transcript row already carries
// `data-block-id` — so a selection note keeps an optional `source.blockId` and
// the sheet offers a "Jump to source" back into the conversation, reusing the
// message-pin jump bridge. Block kind and timestamp are NOT stored: they are not
// exposed at capture time (no `data-block-kind` attribute), and blockId alone is
// enough for the exact-id, honest-not-found jump.
//
// TWO HALVES, like quote.ts, so the fiddly part is testable without a DOM (this
// package renders tests with react-dom/server and has no DOM impl):
//   PURE — truncateSelection: fit an arbitrary snippet to the note cap.
//   DOM  — blockIdOfSelection / pinSelection: read the selection's origin block
//          and write the note to the foreground session.

import { MAX_NOTE_LEN, pinsStore } from './pins';
import { getForegroundSession } from './pin-bridge';

/** Fit a selected snippet to the note cap. A note that is TYPED is refused over
 *  the cap (a link must never be silently shortened — pins.ts); a SELECTION is
 *  display data, not a link, so it is truncated-with-ellipsis instead of refused
 *  — the reader deliberately highlighted it, and the source jump gets them the
 *  full text. Ends are trimmed first; the ellipsis is counted so the result is
 *  always <= MAX_NOTE_LEN. Returns '' for an empty/whitespace-only selection so
 *  a caller can cheaply skip a no-op. */
export function truncateSelection(text: string, max = MAX_NOTE_LEN): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= max) return trimmed;
  // Reserve one char for the ellipsis and trim any whitespace the cut exposed,
  // so the snippet never ends on a half-space before the '…'.
  return `${trimmed.slice(0, max - 1).replace(/\s+$/, '')}…`;
}

/** The block id a selection sits in, or null. Walks up from either selection
 *  endpoint to the nearest `[data-block-id]` ancestor inside `root` (the
 *  transcript viewport). Either endpoint is accepted — a selection anchored in
 *  one block and extended into the next still "came from" the anchor block, and
 *  the anchor is the natural home. DOM-level (like quote.ts's textarea finder);
 *  the pure decision it feeds is truncateSelection above. */
export function blockIdOfSelection(
  anchorNode: Node | null,
  focusNode: Node | null,
  root: Element | null,
): string | null {
  const fromNode = (node: Node | null): string | null => {
    if (!node || !root) return null;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const holder = el?.closest('[data-block-id]');
    if (!holder || !root.contains(holder)) return null;
    return holder.getAttribute('data-block-id');
  };
  return fromNode(anchorNode) ?? fromNode(focusNode);
}

export type PinSelectionResult = { ok: true } | { ok: false; reason: 'empty' | 'no-session' };

/** Pin `selection` as a note for the FOREGROUND session, carrying an optional
 *  `source.blockId` for a jump back. Resolves the session itself (via the
 *  foreground bridge, exactly as insertQuoteIntoComposer resolves the composer)
 *  so the caller only passes the text it captured up front — reading the
 *  selection here is unsafe because the caller may already have collapsed it.
 *
 *  Returns a typed result so the caller can flash honest feedback: `empty` when
 *  there was nothing to pin, `no-session` when no transcript is in the
 *  foreground (e.g. on the Terminal tab), `ok` otherwise. */
export function pinSelection(selection: string, blockId?: string | null): PinSelectionResult {
  const text = truncateSelection(selection);
  if (!text) return { ok: false, reason: 'empty' };
  const sessionId = getForegroundSession();
  if (!sessionId) return { ok: false, reason: 'no-session' };
  // Pre-truncated, so addNote's over-cap refusal cannot fire; a session pin cap
  // or a quota failure is handled inside the store and never surfaces here.
  pinsStore.addNote(sessionId, text, Date.now(), blockId ? { blockId } : undefined);
  return { ok: true };
}
