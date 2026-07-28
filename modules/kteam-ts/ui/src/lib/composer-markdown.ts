// Markdown tokenizer for the composer's highlight overlay — and NOTHING else.
//
// This is not a markdown renderer. The overlay behind the composer textarea
// (ComposerHighlight.tsx) needs to paint the EXACT text the reader typed, byte
// for byte, with colour spans over the markdown syntax. Two hard rules follow:
//
//   1. LOSSLESS. Concatenating every token's `text` reproduces the input
//      exactly — every backtick, every space, every newline. A dropped or
//      normalised character would shift the overlay glyphs relative to the
//      real (transparent) textarea text and the caret would visibly drift.
//      The test suite asserts this property on every fixture.
//
//   2. BEST-EFFORT SEMANTICS. This colours syntax while the reader is MID-KEYSTROKE,
//      so "wrong" states are the common case: an unterminated ``` fence is a
//      code block to the end of the draft (that is what the reader is about to
//      have), a lone `*` is plain text, a half-typed link is plain text. It
//      never throws and never guesses beyond the current draft.
//
// Why not highlight.js's markdown grammar (already in the bundle)? It emits
// HTML with its own escaping and swallows/reorders nothing-in-theory, but its
// token boundaries are not guaranteed lossless across versions, and the
// overlay's correctness contract is exactly losslessness. ~120 lines of owned
// tokenizer is cheaper than auditing that contract on every hljs bump.

export type MdTokenType =
  /** Plain text, including all whitespace and newlines. */
  | 'text'
  /** A whole ``` / ~~~ fence line, info string included. */
  | 'fence'
  /** A line INSIDE a fenced code block. */
  | 'codeBlock'
  /** An inline `code` span, backticks included. */
  | 'inlineCode'
  /** Emphasis content, delimiters excluded (they are `mark` tokens). */
  | 'bold'
  | 'italic'
  | 'boldItalic'
  /** An emphasis delimiter run: `*`, `**`, `___`, … */
  | 'mark'
  /** A whole ATX heading line (`# …` through `###### …`). */
  | 'heading'
  /** `[label]` of an inline link, brackets included. */
  | 'linkText'
  /** `(url)` of an inline link, parens included. */
  | 'linkUrl'
  /** A list bullet/number and its indentation + trailing space. */
  | 'listMarker'
  /** Leading `>` run of a blockquote line, trailing space included. */
  | 'quoteMarker';

export interface MdToken {
  type: MdTokenType;
  text: string;
}

/** Fence opener: up to 3 spaces of indent, then a run of ≥3 backticks or
 *  tildes, then the info string. A backtick fence whose info string contains a
 *  backtick is not a fence (CommonMark), which keeps ```` `code` ```` lines
 *  from swallowing the rest of the draft. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const QUOTE_MARKER = /^ {0,3}(?:>[ \t]?)+/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
/** Backslash escapes exactly ASCII punctuation (CommonMark's set). */
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function push(out: MdToken[], type: MdTokenType, text: string): void {
  if (text.length > 0) out.push({ type, text });
}

/** Length of the run of `ch` starting at `i`. */
function runLength(s: string, i: number, ch: string): number {
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  return j - i;
}

/** A delimiter preceded by an odd run of backslashes is escaped. */
function isEscaped(s: string, i: number): boolean {
  let slashes = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) slashes++;
  return slashes % 2 === 1;
}

/** Letters/numbers/combining marks on BOTH sides make `_` intraword, not an
 * emphasis delimiter (`foo_bar_baz`, including non-ASCII identifiers). */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
function isIntrawordUnderscore(s: string, i: number, len: number): boolean {
  const before = s[i - 1];
  const after = s[i + len];
  return before !== undefined && after !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(after);
}

/** Index of the next run of `ch` with length EXACTLY `len` (CommonMark's code
 *  span rule: a 2-backtick span closes only on exactly 2 backticks), or -1. */
function findExactRun(s: string, from: number, ch: string, len: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== ch) continue;
    const run = runLength(s, i, ch);
    // Backslashes are literal inside code spans; they do NOT escape a closing
    // backtick run (CommonMark code-span rule).
    if (run === len) return i;
    i += run - 1;
  }
  return -1;
}

/** Closing emphasis delimiter: a run of ≥ `len` `ch` whose PRECEDING character
 *  is non-space (so `a * b * c` stays plain text), searched left to right. */
function findEmphasisClose(s: string, from: number, ch: string, len: number): number {
  for (let i = from; i + len <= s.length; i++) {
    if (s[i] !== ch) continue;
    const run = runLength(s, i, ch);
    if (
      run >= len &&
      i > from &&
      !isEscaped(s, i) &&
      !(ch === '_' && isIntrawordUnderscore(s, i, run)) &&
      !/\s/.test(s[i - 1]!)
    )
      return i;
    i += run - 1;
  }
  return -1;
}

/** Inline link at the START of `s`: `[label](target)`, single line, no nested
 *  brackets. Returns the label/target segment lengths or null. */
const INLINE_LINK = /^\[([^\][\n]*)\]\(([^()\n]*)\)/;

function tokenizeInline(s: string, out: MdToken[], plainType: MdTokenType = 'text'): void {
  let buf = '';
  let i = 0;
  const flush = () => {
    push(out, plainType, buf);
    buf = '';
  };

  while (i < s.length) {
    const ch = s[i]!;

    // A backslash escape is plain text and hides its target from every rule
    // below — `\*not emphasis\*` must not open a span.
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) {
      buf += s.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === '`') {
      const open = runLength(s, i, '`');
      const close = findExactRun(s, i + open, '`', open);
      if (close >= 0) {
        flush();
        push(out, 'inlineCode', s.slice(i, close + open));
        i = close + open;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      // Runs longer than 3 are decoration, not emphasis; treat as text.
      const run = runLength(s, i, ch);
      if (run <= 3 && !(ch === '_' && isIntrawordUnderscore(s, i, run))) {
        const after = s[i + run];
        if (after !== undefined && !/\s/.test(after)) {
          const close = findEmphasisClose(s, i + run, ch, run);
          if (close >= 0) {
            flush();
            const type: MdTokenType = run === 1 ? 'italic' : run === 2 ? 'bold' : 'boldItalic';
            push(out, 'mark', ch.repeat(run));
            // Re-tokenize the content so inline code and links keep precedence
            // inside emphasis. Plain fragments retain the emphasis colour.
            tokenizeInline(s.slice(i + run, close), out, type);
            push(out, 'mark', ch.repeat(run));
            i = close + run;
            continue;
          }
        }
      }
    }

    if (ch === '[') {
      const match = INLINE_LINK.exec(s.slice(i));
      if (match) {
        flush();
        push(out, 'linkText', `[${match[1]!}]`);
        push(out, 'linkUrl', `(${match[2]!})`);
        i += match[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

function tokenizeLine(line: string, out: MdToken[]): void {
  let rest = line;

  const quote = QUOTE_MARKER.exec(rest);
  if (quote) {
    push(out, 'quoteMarker', quote[0]);
    rest = rest.slice(quote[0].length);
  }

  // A heading is coloured as ONE token, `#`s included — cheap to read at a
  // glance and no metric games. Checked after the quote marker so `> # title`
  // colours both.
  if (HEADING.test(rest)) {
    push(out, 'heading', rest);
    return;
  }

  const list = LIST_MARKER.exec(rest);
  if (list) {
    push(out, 'listMarker', list[0]);
    rest = rest.slice(list[0].length);
  }

  tokenizeInline(rest, out);
}

/**
 * Tokenize a whole composer draft. Fence state carries across lines; an
 * unterminated fence (the reader is still typing inside it) runs to the end of
 * the draft as `codeBlock` — exactly the reading the finished document will
 * have once they close it.
 */
export function tokenizeMarkdown(text: string): MdToken[] {
  const out: MdToken[] = [];
  const lines = text.split('\n');
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) push(out, 'text', '\n');
    const line = lines[i]!;

    if (fenceChar) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fenceChar && close[1]!.length >= fenceLen) {
        push(out, 'fence', line);
        fenceChar = null;
        fenceLen = 0;
      } else {
        push(out, 'codeBlock', line);
      }
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      push(out, 'fence', line);
      fenceChar = open[1]![0]!;
      fenceLen = open[1]!.length;
      continue;
    }

    tokenizeLine(line, out);
  }

  return out;
}
