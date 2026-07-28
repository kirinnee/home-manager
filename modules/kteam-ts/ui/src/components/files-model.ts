// Pure model for the read-only session file viewer: relative-path arithmetic,
// git status classification, unified-diff parsing and the small formatters the
// panes share.
//
// EVERYTHING HERE IS PURE. The viewer's own security posture is thin by design
// — containment, the secrets denylist, the gitignore gate and the size caps all
// live in the daemon (see the phase-1 `fs.ts`) because a client-side gate is
// worth nothing against a leaked token. What this module owns is the *display*
// contract: never build a path the daemon would have to reject, never claim a
// status the porcelain did not say, and never render a diff the parser did not
// understand.
//
// Kept separate from FilesTab.tsx so it is testable without a DOM: the tab is
// props-in/markup-out around these functions.

/** Status tones map onto the existing `.kt-badge[data-tone]` treatments, so the
 *  chips inherit every theme's palette instead of introducing colours. */
export type StatusTone = 'ok' | 'warn' | 'err' | 'accent' | 'neutral';

export interface StatusChip {
  /** Short glyph for the chip itself (never the only carrier of meaning). */
  code: string;
  /** The word. Goes into each row's accessible name and its title. */
  label: string;
  tone: StatusTone;
  /** Staged/unstaged detail when the porcelain XY pair says something about it. */
  detail?: string;
}

/* ---- relative paths ------------------------------------------------------
   The daemon rejects absolute paths, `..` segments, backslashes and empty
   segments outright. The browser must therefore never *send* one: every path
   the UI holds is already normalised, so a `..` row is a plain "go to the
   parent" computation rather than a segment appended to a string. */

/** Collapse a user/served path into the daemon's accepted relative form.
 *  Leading/trailing slashes, `.`, empty segments and backslashes are dropped;
 *  `..` pops (and can never climb above the root, which is the whole point). */
export function normalizeRel(input: string | null | undefined): string {
  if (!input) return '';
  const out: string[] = [];
  for (const seg of String(input).split(/[/\\]/)) {
    // SEGMENT BYTES ARE PRESERVED. `  spaced name .txt` is a legal filename on
    // every filesystem this runs on, and `git status` will happily report one;
    // trimming here would open — and label — a DIFFERENT file than the daemon
    // listed. Only the exactly-empty, `.` and `..` segments are structural.
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** Join then normalise ONCE, so a `..` in the leaf resolves against the
 *  directory (and still cannot climb past the root) rather than being dropped
 *  from the leaf and silently re-appended. */
export function joinRel(dir: string, name: string): string {
  const base = normalizeRel(dir);
  const raw = String(name ?? '');
  if (raw === '') return base;
  return normalizeRel(base ? `${base}/${raw}` : raw);
}

/* ---- addressability ------------------------------------------------------
   NORMALISING IS NOT VALIDATING, and for a name the daemon refuses the two
   disagree. `opendir` happily returns POSIX filenames containing a backslash or
   a control byte; the daemon's route grammar (`normalizeRelativePath` in
   `src/fs.ts`) refuses both outright. Feeding such a name to `joinRel` would
   turn `a\b` into `a/b` — a DIFFERENT file, which may well exist — so the row
   would open something other than the thing it is labelled with.

   The gate is therefore applied before a name is ever joined or requested: an
   unaddressable entry is listed (never silently dropped — it exists, and the
   list has to be honest about that) but rendered inert with the reason. */

/** Bytes the daemon refuses ANYWHERE in a path: NUL and the rest of the C0 set,
 *  DEL, and the backslash it treats as a smuggled separator. */
const UNSUPPORTED_NAME_CHARS = /[\\\u0000-\u001f\u007f]/;

/** The one sentence both panes use, so the two surfaces cannot drift apart. */
export const UNOPENABLE_NAME_REASON =
  'name cannot be opened by this viewer — it uses a character the daemon’s path grammar refuses';

/** Is this a SINGLE entry name the daemon would accept as one path segment?
 *  Nonempty, not `.`/`..`, and free of `/`, `\`, NUL and control bytes. */
export function isOpenableName(name: string | null | undefined): boolean {
  const value = name ?? '';
  if (value === '' || value === '.' || value === '..') return false;
  if (value.includes('/')) return false;
  return !UNSUPPORTED_NAME_CHARS.test(value);
}

/** The same rule for a whole relative path: every segment must stand on its
 *  own. This is what a Changes row is checked against, since git hands the UI a
 *  path rather than a name — and an empty segment (`a//b`, a leading slash) is
 *  refused for exactly the reason the daemon refuses it. */
export function isOpenablePath(rel: string | null | undefined): boolean {
  const value = rel ?? '';
  if (value === '') return false;
  return value.split('/').every(isOpenableName);
}

export function parentRel(rel: string): string {
  const norm = normalizeRel(rel);
  const cut = norm.lastIndexOf('/');
  return cut < 0 ? '' : norm.slice(0, cut);
}

export function baseName(rel: string): string {
  const norm = normalizeRel(rel);
  const cut = norm.lastIndexOf('/');
  return cut < 0 ? norm : norm.slice(cut + 1);
}

/** The directory part, WITH its trailing slash, so a row can print a dimmed
 *  `src/lib/` before a strong `api.ts` without re-joining strings. */
export function dirPrefix(rel: string): string {
  const parent = parentRel(rel);
  return parent ? `${parent}/` : '';
}

export interface Crumb {
  label: string;
  path: string;
}

/** Breadcrumbs for the browse list, root first. The root crumb is always
 *  present so there is a one-tap way home from any depth. */
export function crumbs(rel: string, rootLabel = 'root'): Crumb[] {
  const list: Crumb[] = [{ label: rootLabel, path: '' }];
  const norm = normalizeRel(rel);
  if (!norm) return list;
  let acc = '';
  for (const seg of norm.split('/')) {
    acc = acc ? `${acc}/${seg}` : seg;
    list.push({ label: seg, path: acc });
  }
  return list;
}

const MARKDOWN_EXT = new Set(['md', 'mdx', 'markdown']);

export function isMarkdownPath(rel: string): boolean {
  const name = baseName(rel).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return MARKDOWN_EXT.has(ext);
}

/* ---- highlighted source lines -------------------------------------------
   Highlight.js returns one safe HTML string and may keep a token span open
   across several newlines (block comments and template strings do this). A
   naive `.split('\n')` would create invalid fragments and lose colouring after
   the first line. Close every live span at a line break, then reopen the same
   stack on the next line so each row is independently renderable. */

const HIGHLIGHT_TAG_OR_NEWLINE = /<span\b[^>]*>|<\/span>|\r?\n/giu;

export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  let cursor = 0;
  for (const match of html.matchAll(HIGHLIGHT_TAG_OR_NEWLINE)) {
    const index = match.index;
    if (index === undefined) continue;
    line += html.slice(cursor, index);
    const token = match[0];
    cursor = index + token.length;
    if (token === '\n' || token === '\r\n') {
      line += '</span>'.repeat(open.length);
      lines.push(line);
      line = open.join('');
      continue;
    }
    line += token;
    if (/^<span\b/iu.test(token)) open.push(token);
    else if (open.length > 0) open.pop();
  }
  line += html.slice(cursor);
  lines.push(line);
  return lines;
}

/* ---- git status ----------------------------------------------------------
   `fs/changes` reports whatever `git status --porcelain=v1` said. That is an XY
   pair ('` M`', '`??`', '`R `', '`AA`'), but a daemon is free to normalise it to
   a word — so both are accepted rather than assuming one and rendering a blank
   chip if the other arrives. An unrecognised value still gets a chip: it prints
   the raw token and reads as "changed", which is honest, instead of vanishing. */

const WORD_STATUS: Record<string, StatusChip> = {
  modified: { code: 'M', label: 'Modified', tone: 'warn' },
  added: { code: 'A', label: 'Added', tone: 'ok' },
  new: { code: 'A', label: 'Added', tone: 'ok' },
  deleted: { code: 'D', label: 'Deleted', tone: 'err' },
  removed: { code: 'D', label: 'Deleted', tone: 'err' },
  renamed: { code: 'R', label: 'Renamed', tone: 'accent' },
  copied: { code: 'C', label: 'Copied', tone: 'accent' },
  untracked: { code: '?', label: 'Untracked', tone: 'accent' },
  ignored: { code: '!', label: 'Ignored', tone: 'neutral' },
  conflicted: { code: 'U', label: 'Conflicted', tone: 'err' },
  unmerged: { code: 'U', label: 'Conflicted', tone: 'err' },
  typechange: { code: 'T', label: 'Type changed', tone: 'warn' },
};

const LETTER_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  M: { label: 'Modified', tone: 'warn' },
  A: { label: 'Added', tone: 'ok' },
  D: { label: 'Deleted', tone: 'err' },
  R: { label: 'Renamed', tone: 'accent' },
  C: { label: 'Copied', tone: 'accent' },
  T: { label: 'Type changed', tone: 'warn' },
  U: { label: 'Conflicted', tone: 'err' },
};

export function statusChip(raw: string | undefined | null): StatusChip {
  const value = (raw ?? '').trim();
  if (!value) return { code: '•', label: 'Changed', tone: 'neutral' };

  const word = WORD_STATUS[value.toLowerCase()];
  if (word) return word;

  // Porcelain v1: X = index, Y = worktree. `.padEnd` recovers the space git
  // prints for "clean on this side" after a caller trimmed the line.
  const xy = (raw ?? '').length >= 2 ? (raw as string).slice(0, 2) : value.padEnd(2, ' ');
  const x = xy[0]!;
  const y = xy[1]!;

  if (xy === '??') return { code: '?', label: 'Untracked', tone: 'accent' };
  if (xy === '!!') return { code: '!', label: 'Ignored', tone: 'neutral' };
  // Any 'U', plus the AA/DD pairs, are the unmerged set — always a conflict.
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD')
    return { code: 'U', label: 'Conflicted', tone: 'err', detail: 'unmerged' };

  const staged = x !== ' ' && x !== '?';
  const unstaged = y !== ' ' && y !== '?';
  const primary = LETTER_STATUS[unstaged ? y : x] ?? LETTER_STATUS[x];
  const detail = staged && unstaged ? 'staged and unstaged' : staged ? 'staged' : unstaged ? 'unstaged' : undefined;
  if (!primary) return { code: value.replace(/\s+/g, '') || '•', label: 'Changed', tone: 'neutral', detail };
  return { code: unstaged ? y : x, label: primary.label, tone: primary.tone, detail };
}

/** The full accessible sentence for one change row — the chip is a glyph, so
 *  the row's name has to carry the word, the path and the rename origin. */
export function changeRowLabel(path: string, chip: StatusChip, from?: string): string {
  const origin = from ? ` from ${from}` : '';
  const detail = chip.detail ? ` (${chip.detail})` : '';
  return `${chip.label}${detail}: ${path}${origin}. Open diff`;
}

/* ---- unified diff --------------------------------------------------------
   A hand-rolled hunk parser, per the design's bundle budget: line classes plus
   old/new gutters, ~zero bytes over what is already shipped. `diff` IS in the
   shared highlight registry, but token colouring inside a line is not what a
   reviewer reads — whole-line tint plus the +/- glyph is, and that also keeps
   the meaning off colour alone. */

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'nonl';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content WITHOUT the leading +/-/space marker (meta/hunk keep theirs). */
  text: string;
  /** 1-based line number in the pre-image, when this line exists there. */
  oldNo?: number;
  /** 1-based line number in the post-image, when this line exists there. */
  newNo?: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when `lines` was capped: a 200k-line diff must not become 200k DOM rows. */
  truncated: boolean;
  /** Total parsed lines before the cap. */
  total: number;
  /** git said the pair is binary; there is nothing textual to show. */
  binary: boolean;
}

/** Rendered-row cap. Above this the pane shows the head of the diff and says so
 *  — the daemon already caps its own output at 1 MB, this caps the DOM. */
export const MAX_DIFF_LINES = 4000;

const META_PREFIXES = [
  'diff --git',
  'diff --no-index',
  'index ',
  'old mode',
  'new mode',
  'new file mode',
  'deleted file mode',
  'similarity index',
  'dissimilarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'GIT binary patch',
];

export function parseUnifiedDiff(text: string, maxLines = MAX_DIFF_LINES): ParsedDiff {
  const source = text.replace(/\n$/, '');
  const raw = source.length ? source.split('\n') : [];
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let binary = false;
  let oldNo = 0;
  let newNo = 0;
  // `---`/`+++` MEAN TWO DIFFERENT THINGS depending on where they appear. Before
  // a hunk they are the file-header pair; INSIDE one they are ordinary content
  // carrying a `-`/`+` marker — deleting the line `--` prints `---`, and a
  // markdown fence or a `+++` TOML header prints exactly the other. Treating
  // those as headers hid real removals and skewed the +/− counts, so the parser
  // tracks whether it is inside a hunk and how much of that hunk is left.
  let inHunk = false;
  // Pre/post-image lines the current hunk still owes. `Infinity` means "a header
  // we could not parse": stay in the hunk until the next file section rather
  // than guess an end.
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of raw) {
    let entry: DiffLine;
    if (line.startsWith('@@')) {
      // `@@ -12,7 +12,9 @@ optional section heading`
      const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[3]) : 0;
      // An omitted count is git's shorthand for exactly one line.
      oldLeft = match ? (match[2] === undefined ? 1 : Number(match[2])) : Infinity;
      newLeft = match ? (match[4] === undefined ? 1 : Number(match[4])) : Infinity;
      inHunk = true;
      entry = { kind: 'hunk', text: line };
    } else if (META_PREFIXES.some(p => line.startsWith(p))) {
      // A new file section ends whatever hunk was open, which is what makes the
      // NEXT `---`/`+++` pair readable as headers again in a multi-file diff.
      if (line.startsWith('diff ')) inHunk = false;
      if (line.startsWith('GIT binary patch')) binary = true;
      entry = { kind: 'meta', text: line };
    } else if (!inHunk && (line.startsWith('---') || line.startsWith('+++'))) {
      entry = { kind: 'meta', text: line };
    } else if (line.startsWith('Binary files') || line.startsWith('Binary file')) {
      binary = true;
      entry = { kind: 'meta', text: line };
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the previous line, numbers it none.
      entry = { kind: 'nonl', text: line };
    } else if (line.startsWith('+')) {
      added += 1;
      newLeft -= 1;
      entry = { kind: 'add', text: line.slice(1), newNo: newNo || undefined };
      if (newNo) newNo += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
      oldLeft -= 1;
      entry = { kind: 'del', text: line.slice(1), oldNo: oldNo || undefined };
      if (oldNo) oldNo += 1;
    } else {
      oldLeft -= 1;
      newLeft -= 1;
      entry = {
        kind: 'ctx',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldNo: oldNo || undefined,
        newNo: newNo || undefined,
      };
      if (oldNo) oldNo += 1;
      if (newNo) newNo += 1;
    }
    // The hunk is spent once both sides are accounted for. Closing it here (and
    // not only at the next `diff --git`) is what keeps a plain `diff -u` of two
    // files — no `diff --git` line anywhere — from reading the second file's
    // `--- a/…` header as a deleted line.
    if (inHunk && oldLeft <= 0 && newLeft <= 0) inHunk = false;
    lines.push(entry);
  }

  const truncated = lines.length > maxLines;
  return {
    lines: truncated ? lines.slice(0, maxLines) : lines,
    added,
    removed,
    truncated,
    total: lines.length,
    binary,
  };
}

/* Plumbing headers git prints for its own consumers: the `diff --git` line, the
   blob `index` line and the `---`/`+++` pair. Every one of them repeats a path
   the pane's own title already states, and on a 360px phone the four of them
   push the first hunk off the first screen. They are parsed (so the counts and
   the structure stay honest) and simply not RENDERED.

   Everything else that arrives as meta is kept, because it is the only place
   that fact appears: `rename from/to`, `new file mode`, `deleted file mode`,
   `old mode`/`new mode`, `similarity index`, and the `Binary files … differ`
   line. */
const PLUMBING_META = /^(?:diff --git |diff --no-index |index [0-9a-f]{4,}|--- |\+\+\+ )/;

export function isPlumbingMeta(line: DiffLine): boolean {
  return line.kind === 'meta' && PLUMBING_META.test(line.text);
}

/** The lines a reader should actually see. Also the emptiness test: a diff whose
 *  every line is plumbing has nothing to show. */
export function renderableDiffLines(parsed: ParsedDiff): DiffLine[] {
  return parsed.lines.filter(line => !isPlumbingMeta(line));
}

/* ---- formatters ---------------------------------------------------------- */

export function formatBytes(size: number | undefined | null): string {
  if (size == null || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Plural-safe count phrase — used in the section footers and the empty states. */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
