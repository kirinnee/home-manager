// Where a finished transcript goes: into the editable draft, at the caret, and
// NOWHERE ELSE.
//
// This module is the entire commit path for dictation. It is pure, it returns a
// new string plus a caret offset, and it has no idea that a send button exists.
// That is deliberate and it is the feature's central safety property: there is
// no code path from "the model produced text" to "a message was sent", because
// the only function that touches the transcript returns a string to its caller.
//
// The whitespace rules are the whole of the remaining subtlety. Speech has no
// spaces in it, so the inserter has to decide — and it decides conservatively:
// one space where two words would otherwise collide, none anywhere else, and it
// never trims or reflows text the reader typed themselves.

export interface DraftInsertion {
  /** The complete next draft value. */
  text: string;
  /** Where the caret should sit afterwards: immediately after what was
   *  inserted, so the reader can keep dictating or keep typing. */
  caret: number;
}

/** Characters that already provide the separation a space would, so inserting
 *  one before them would produce " ." or "( word". */
const CLOSERS = new Set([')', ']', '}', '>', ',', '.', ';', ':', '!', '?', '”', '’', '"', "'"]);
const OPENERS = new Set(['(', '[', '{', '<', '“', '‘']);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Insert `transcript` into `draft`, replacing `[selectionStart, selectionEnd)`.
 *
 *  A selection is REPLACED rather than appended to: if the reader highlighted a
 *  word and dictated, they meant to say that word again, differently.
 *
 *  Out-of-range or reversed selections are normalised rather than rejected —
 *  a stale caret from a re-render must not lose an utterance. When the caller
 *  has no selection at all it should pass `draft.length` for both, which
 *  appends. */
export function insertTranscript(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): DraftInsertion {
  const base = typeof draft === 'string' ? draft : '';
  // Speech models emit no leading/trailing whitespace worth keeping, and a
  // stray one would defeat the collision rules below.
  const spoken = (transcript ?? '').trim();
  if (spoken.length === 0) {
    const caret = clamp(selectionEnd, 0, base.length);
    return { text: base, caret };
  }

  const rawStart = clamp(selectionStart, 0, base.length);
  const rawEnd = clamp(selectionEnd, 0, base.length);
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);

  const before = base.slice(0, start);
  const after = base.slice(end);

  const prevChar = before.slice(-1);
  const nextChar = after.slice(0, 1);

  const needsLeadingSpace =
    prevChar.length > 0 && !/\s/u.test(prevChar) && !OPENERS.has(prevChar) && !CLOSERS.has(spoken.charAt(0));
  const needsTrailingSpace = nextChar.length > 0 && !/\s/u.test(nextChar) && !CLOSERS.has(nextChar);

  const inserted = `${needsLeadingSpace ? ' ' : ''}${spoken}${needsTrailingSpace ? ' ' : ''}`;
  const text = `${before}${inserted}${after}`;
  // The caret lands after the WORDS, not after a trailing space we added for
  // the text that follows — otherwise the reader's next keystroke starts a
  // double space.
  const caret = before.length + (needsLeadingSpace ? 1 : 0) + spoken.length;
  return { text, caret };
}

/** Read a live selection off a textarea, degrading to "append at the end" when
 *  the element is gone, unfocused or reports nothing usable.
 *
 *  Kept here rather than in the component so the fallback rule is testable
 *  without a DOM. */
export interface SelectionLike {
  selectionStart: number | null;
  selectionEnd: number | null;
  value?: string;
}

export function readSelection(element: SelectionLike | null | undefined, draft: string): [number, number] {
  const fallback = draft.length;
  if (!element) return [fallback, fallback];
  const start = element.selectionStart;
  const end = element.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number') return [fallback, fallback];
  return [start, end];
}
