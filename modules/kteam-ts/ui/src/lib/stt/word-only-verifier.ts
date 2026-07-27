// THE VERIFIER — the hard, independent gate that decides whether a proposed
// "enhanced" transcript is allowed to reach the reader's draft.
//
// WHY THIS IS A SEPARATE MODULE FROM `enhancement.ts`, and why it deliberately
// duplicates that file's tokenizer instead of importing it:
//
//   A verifier that shares its notion of "what a word is" with the thing it is
//   verifying cannot catch a bug in that notion. If the enhancer's regex ever
//   grows a character class, a shared tokenizer would silently widen what the
//   verifier considers legal at exactly the same moment. So this file imports
//   NOTHING. It takes two strings — `before` and `after` — and decides, with no
//   knowledge of who produced `after` or why. Today that is a dictionary
//   substituter; tomorrow it could be an LLM, and the safety property does not
//   move.
//
// THE PROPERTY IT ENFORCES, stated exactly:
//
//   1. The SEPARATOR BYTES are identical. Every run of non-word characters —
//      spaces, newlines, commas, periods, quotes, emoji — must appear at the
//      same position with the same bytes. This single rule kills every
//      "helpful" rewrite in one move: an inserted comma, a changed period, a
//      collapsed double space, a smart-quote swap, a trailing newline, a
//      sentence reflow. None of them survive.
//   2. The WORD COUNT is identical. No insertion, no deletion, no joining two
//      words into one, no splitting one into two.
//   3. The PUNCTUATION INSIDE a changed word is identical, in order. A word
//      token here holds its own inner punctuation (`don't`, `sherpa-onnx`,
//      `tool_use`) so that those read as one term rather than three, which
//      would otherwise leave that punctuation OUTSIDE the byte-identical
//      separator stream and therefore unguarded. So it is guarded here
//      instead: `dont → don't`, `don't → don’t` and `sherpa-onnx →
//      sherpaonnx` are all refused, while `kteeem-ts → kteam-ts` — letters
//      changed, the hyphen untouched — is allowed. Between (1) and (3) every
//      non-alphanumeric byte in the text survives, in order.
//   4. Every word that DID change is a whole word on both sides — guaranteed
//      structurally by (1) and (2), and re-asserted so a future refactor that
//      loosens segmentation trips a test rather than a reader.
//   5. No change is case-only. A rewrite whose only effect is capitalisation is
//      churn the reader did not ask for and cannot see coming, so it is
//      refused rather than applied.
//
// A failed verification is NOT an error: the caller keeps the raw transcript.
// The reader never loses their words to a rejection.

/** Maximum input this will inspect. Beyond it the answer is a refusal, not a
 *  slow scan: dictation utterances are seconds long, and a 100k-character
 *  "transcript" is a bug somewhere upstream, not something to enhance. */
export const MAX_VERIFY_CHARS = 100_000;

/** What a word is, for this module and this module only.
 *
 *  Letters, digits, both apostrophes, underscore and hyphen — so `sherpa-onnx`,
 *  `don't`, `don’t` and `tool_use` are each ONE token and their inner
 *  punctuation is protected as part of the word rather than as a separator. */
const WORD_PATTERN = "[\\p{L}\\p{N}'’_-]+";

export type WordOnlyRejection =
  /** The two texts do not have the same number of word tokens. */
  | 'token-count-changed'
  /** A run of non-word characters was added, removed or altered. */
  | 'separator-changed'
  /** Punctuation inside a changed word token was added, removed or altered. */
  | 'punctuation-changed'
  /** A changed token is not a whole word on both sides. */
  | 'word-shape-changed'
  /** A change that only alters capitalisation. */
  | 'case-only-change'
  /** Input beyond `MAX_VERIFY_CHARS`. */
  | 'input-too-large';

/** One accepted whole-word substitution, by word-token index. */
export interface WordChange {
  /** Index into the word-token sequence (NOT a character offset). */
  index: number;
  from: string;
  to: string;
}

export interface VerifyOutcome {
  ok: boolean;
  reason?: WordOnlyRejection;
  /** Populated only when `ok` — the substitutions that were allowed through.
   *  Empty for an identity pair, which is a legal (if pointless) result. */
  changes: WordChange[];
  /** Set when `ok === false` and the failure is localised, for logging. */
  at?: number;
}

export interface Segmentation {
  /** The word tokens, in order. */
  words: string[];
  /** The runs of non-word characters BETWEEN/around them.
   *  Invariant: `separators.length === words.length + 1`. Both the leading and
   *  the trailing separator are present and may be empty strings. */
  separators: string[];
}

/** Split a string into a strictly alternating separator/word/separator/… form.
 *
 *  Exported because it is the whole basis of the decision below and a test that
 *  cannot see the segmentation can only assert the verdict, not the reason. */
export function segmentWords(text: string): Segmentation {
  const words: string[] = [];
  const separators: string[] = [];
  const re = new RegExp(WORD_PATTERN, 'gu');
  let last = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    separators.push(text.slice(last, match.index));
    words.push(match[0]);
    last = match.index + match[0].length;
  }
  separators.push(text.slice(last));
  return { words, separators };
}

/** True when `value` is a single, complete word token end to end. */
export function isWholeWord(value: string): boolean {
  return new RegExp(`^${WORD_PATTERN}$`, 'u').test(value);
}

/** The non-alphanumeric characters inside a word token, in order.
 *
 *  `"don't"` → `"'"`, `"sherpa-onnx"` → `"-"`, `"kteam"` → `""`. Comparing this
 *  between a changed pair is what stops a substitution from smuggling a
 *  punctuation edit inside a token, where the separator check cannot see it.
 *  Positions are deliberately NOT compared: `kteeem-ts → kteam-ts` moves the
 *  hyphen's index by one while changing nothing about the punctuation itself,
 *  and refusing that would refuse the enhancer's actual job. */
export function innerPunctuation(word: string): string {
  return [...word].filter(character => !/[\p{L}\p{N}]/u.test(character)).join('');
}

/** Decide whether `after` is a legal whole-word-substitution-only rewrite of
 *  `before`. Never throws; never mutates; pure. */
export function verifyWordOnly(before: string, after: string): VerifyOutcome {
  if (before.length > MAX_VERIFY_CHARS || after.length > MAX_VERIFY_CHARS) {
    return { ok: false, reason: 'input-too-large', changes: [] };
  }

  const a = segmentWords(before);
  const b = segmentWords(after);

  // Token count first: it produces the more useful reason when both this and
  // the separator sequence differ (they always do together).
  if (a.words.length !== b.words.length) {
    return { ok: false, reason: 'token-count-changed', changes: [] };
  }

  for (let i = 0; i < a.separators.length; i += 1) {
    if (a.separators[i] !== b.separators[i]) {
      return { ok: false, reason: 'separator-changed', changes: [], at: i };
    }
  }

  const changes: WordChange[] = [];
  for (let i = 0; i < a.words.length; i += 1) {
    const from = a.words[i] as string;
    const to = b.words[i] as string;
    if (from === to) continue;
    // Structurally guaranteed by the segmentation above; asserted anyway so a
    // future change to `segmentWords` fails loudly here instead of quietly
    // widening what counts as a word.
    if (!isWholeWord(from) || !isWholeWord(to)) {
      return { ok: false, reason: 'word-shape-changed', changes: [], at: i };
    }
    if (innerPunctuation(from) !== innerPunctuation(to)) {
      return { ok: false, reason: 'punctuation-changed', changes: [], at: i };
    }
    if (from.toLowerCase() === to.toLowerCase()) {
      return { ok: false, reason: 'case-only-change', changes: [], at: i };
    }
    changes.push({ index: i, from, to });
  }

  return { ok: true, changes };
}
