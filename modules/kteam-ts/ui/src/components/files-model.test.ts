import { describe, expect, test } from 'bun:test';
import {
  baseName,
  changeRowLabel,
  countLabel,
  crumbs,
  dirPrefix,
  formatBytes,
  isMarkdownPath,
  isOpenableName,
  isOpenablePath,
  joinRel,
  normalizeRel,
  parentRel,
  parseUnifiedDiff,
  renderableDiffLines,
  statusChip,
} from './files-model';

/** Built at runtime so the bytes under test cannot be lost to an editor or a
 *  formatter — a literal control character in a source file is not durable. */
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe('relative paths never escape the session root', () => {
  test('normalisation drops the segments the daemon refuses', () => {
    expect(normalizeRel('/etc/passwd')).toBe('etc/passwd');
    expect(normalizeRel('src//lib/./api.ts')).toBe('src/lib/api.ts');
    expect(normalizeRel('src\\lib\\api.ts')).toBe('src/lib/api.ts');
    expect(normalizeRel('')).toBe('');
    expect(normalizeRel(undefined)).toBe('');
  });

  test('`..` pops and can never climb above the root', () => {
    expect(normalizeRel('src/lib/../api.ts')).toBe('src/api.ts');
    expect(normalizeRel('../../../../etc/shadow')).toBe('etc/shadow');
    expect(normalizeRel('..')).toBe('');
    expect(parentRel('')).toBe('');
    expect(parentRel('a')).toBe('');
    expect(parentRel('a/b/c')).toBe('a/b');
  });

  test('joining a listed entry name onto the current directory stays contained', () => {
    expect(joinRel('src', 'lib')).toBe('src/lib');
    expect(joinRel('', 'README.md')).toBe('README.md');
    // A hostile listing entry cannot walk the viewer out of the tree.
    // `..` resolves against the current directory (ordinary path semantics) and
    // the pops stop at the root — either way it cannot address anything outside.
    expect(joinRel('src', '../../etc')).toBe('etc');
    expect(joinRel('src/lib', '..')).toBe('src');
  });

  test('legal filenames keep their bytes — spaces are not structure', () => {
    expect(normalizeRel(' leading.txt')).toBe(' leading.txt');
    expect(normalizeRel('dir /file .txt')).toBe('dir /file .txt');
    expect(normalizeRel(' ')).toBe(' ');
    expect(joinRel('a', ' b ')).toBe('a/ b ');
    expect(baseName('a/ b ')).toBe(' b ');
  });

  test('a legal POSIX name the daemon refuses is not openable', () => {
    expect(isOpenableName('api.ts')).toBe(true);
    expect(isOpenableName(' spaced name .txt')).toBe(true);
    expect(isOpenableName('ünïcode ✅.md')).toBe(true);
    // The daemon's grammar (`normalizeRelativePath`, src/fs.ts) refuses these
    // anywhere in a path, so the viewer must not offer to open one.
    expect(isOpenableName(`a${BACKSLASH}b.ts`)).toBe(false);
    expect(isOpenableName(`line${NEWLINE}break.ts`)).toBe(false);
    expect(isOpenableName(`a${NUL}b`)).toBe(false);
    expect(isOpenableName(`a${DEL}b`)).toBe(false);
    // Structure is not a name: a segment is a segment.
    expect(isOpenableName('a/b')).toBe(false);
    expect(isOpenableName('')).toBe(false);
    expect(isOpenableName('.')).toBe(false);
    expect(isOpenableName('..')).toBe(false);
    expect(isOpenableName(undefined)).toBe(false);
  });

  test('a change path is openable only when every segment is', () => {
    expect(isOpenablePath('src/lib/api.ts')).toBe(true);
    expect(isOpenablePath(`src/a${BACKSLASH}b.ts`)).toBe(false);
    expect(isOpenablePath(`src/line${NEWLINE}break.ts`)).toBe(false);
    expect(isOpenablePath('a//b')).toBe(false);
    expect(isOpenablePath('/a')).toBe(false);
    expect(isOpenablePath('a/')).toBe(false);
    expect(isOpenablePath('../etc/passwd')).toBe(false);
    expect(isOpenablePath('')).toBe(false);
  });

  test('WHY the gate exists: normalising a refused name addresses another file', () => {
    // This is the bug the predicate prevents, stated as an invariant. A row
    // labelled `a\b.ts` must never be JOINED, because joining renames it to a
    // path that may well exist and is not the file the daemon listed.
    expect(joinRel('src', `a${BACKSLASH}b.ts`)).toBe('src/a/b.ts');
    expect(isOpenableName(`a${BACKSLASH}b.ts`)).toBe(false);
    // Same trap on the display side of a Changes row.
    expect(baseName(`a${BACKSLASH}b.ts`)).toBe('b.ts');
    expect(isOpenablePath(`a${BACKSLASH}b.ts`)).toBe(false);
  });

  test('names and breadcrumbs', () => {
    expect(baseName('src/lib/api.ts')).toBe('api.ts');
    expect(baseName('README.md')).toBe('README.md');
    expect(dirPrefix('src/lib/api.ts')).toBe('src/lib/');
    expect(dirPrefix('README.md')).toBe('');
    expect(crumbs('')).toEqual([{ label: 'root', path: '' }]);
    expect(crumbs('a/b')).toEqual([
      { label: 'root', path: '' },
      { label: 'a', path: 'a' },
      { label: 'b', path: 'a/b' },
    ]);
  });

  test('markdown detection drives the Rendered/Source affordance', () => {
    expect(isMarkdownPath('docs/DESIGN.md')).toBe(true);
    expect(isMarkdownPath('a/b/notes.MDX')).toBe(true);
    expect(isMarkdownPath('src/markdown.ts')).toBe(false);
    expect(isMarkdownPath('README')).toBe(false);
  });
});

describe('git status chips', () => {
  test('porcelain XY pairs classify, including the space git prints', () => {
    expect(statusChip(' M')).toMatchObject({ code: 'M', label: 'Modified', detail: 'unstaged' });
    expect(statusChip('M ')).toMatchObject({ code: 'M', label: 'Modified', detail: 'staged' });
    expect(statusChip('MM')).toMatchObject({ label: 'Modified', detail: 'staged and unstaged' });
    expect(statusChip('A ')).toMatchObject({ code: 'A', label: 'Added', tone: 'ok' });
    expect(statusChip(' D')).toMatchObject({ code: 'D', label: 'Deleted', tone: 'err' });
    expect(statusChip('R ')).toMatchObject({ code: 'R', label: 'Renamed', tone: 'accent' });
    expect(statusChip('??')).toMatchObject({ code: '?', label: 'Untracked' });
    expect(statusChip('!!')).toMatchObject({ label: 'Ignored' });
  });

  test('every unmerged shape reads as a conflict', () => {
    for (const raw of ['UU', 'AU', 'UD', 'AA', 'DD']) {
      expect(statusChip(raw).label).toBe('Conflicted');
      expect(statusChip(raw).tone).toBe('err');
    }
  });

  test('word forms are accepted so a normalising daemon still renders', () => {
    expect(statusChip('modified')).toMatchObject({ code: 'M', label: 'Modified' });
    expect(statusChip('untracked')).toMatchObject({ label: 'Untracked' });
    expect(statusChip('Deleted')).toMatchObject({ label: 'Deleted' });
  });

  test('an unknown token still gets an honest chip instead of vanishing', () => {
    const chip = statusChip('ZZ');
    expect(chip.label).toBe('Changed');
    expect(chip.code.length).toBeGreaterThan(0);
    expect(statusChip('').label).toBe('Changed');
  });

  test('the row label carries state, path and rename origin — the chip is a glyph', () => {
    const label = changeRowLabel('src/api.ts', statusChip('R '), 'src/old-api.ts');
    expect(label).toContain('Renamed');
    expect(label).toContain('src/api.ts');
    expect(label).toContain('from src/old-api.ts');
    expect(label).toContain('Open diff');
  });
});

describe('unified diff parsing', () => {
  const sample = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,4 +10,5 @@ export function main() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
    '\\ No newline at end of file',
  ].join('\n');

  test('classifies every line kind and counts the change', () => {
    const parsed = parseUnifiedDiff(sample);
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);
    expect(parsed.binary).toBe(false);
    expect(parsed.truncated).toBe(false);
    const kinds = parsed.lines.map(line => line.kind);
    expect(kinds.slice(0, 4)).toEqual(['meta', 'meta', 'meta', 'meta']);
    expect(kinds[4]).toBe('hunk');
    expect(kinds.slice(5)).toEqual(['ctx', 'del', 'add', 'add', 'ctx', 'nonl']);
  });

  test('`+++`/`---` headers are metadata, never an added or removed line', () => {
    const parsed = parseUnifiedDiff(sample);
    expect(parsed.lines[2]).toMatchObject({ kind: 'meta', text: '--- a/src/app.ts' });
    expect(parsed.lines[3]).toMatchObject({ kind: 'meta', text: '+++ b/src/app.ts' });
  });

  test('inside a hunk, `---`/`+++` are CONTENT — a removed fence is not a header', () => {
    // `---` as a diff line is the marker `-` plus the text `--`; a markdown
    // frontmatter fence (`---`) therefore arrives as `----`, and a TOML-ish
    // `++ …` addition arrives as `+++ …`. Both used to be swallowed as metadata,
    // which lost the line AND under-counted the change.
    const fences = [
      'diff --git a/notes.md b/notes.md',
      'index 1111111..2222222 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,2 @@',
      '----',
      ' title: notes',
      '+++ still fenced',
    ].join('\n');
    const parsed = parseUnifiedDiff(fences);
    expect(parsed.added).toBe(1);
    expect(parsed.removed).toBe(1);
    // The pre-hunk pair is still metadata; the two inside the hunk are not.
    expect(parsed.lines.slice(2, 4).map(line => line.kind)).toEqual(['meta', 'meta']);
    expect(parsed.lines[5]).toMatchObject({ kind: 'del', text: '---', oldNo: 1 });
    expect(parsed.lines[7]).toMatchObject({ kind: 'add', text: '++ still fenced', newNo: 2 });
    // And they reach the screen: only the header pair is plumbing.
    const shown = renderableDiffLines(parsed).map(line => line.text);
    expect(shown).toContain('---');
    expect(shown).toContain('++ still fenced');
    expect(shown).not.toContain('--- a/notes.md');
  });

  test('the NEXT file’s headers are headers again, in a multi-file diff', () => {
    const two = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const parsed = parseUnifiedDiff(two);
    // Four content lines, not eight: the second file's header pair is metadata.
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(2);
    expect(parsed.lines[7]).toMatchObject({ kind: 'meta', text: '--- a/b.ts' });
    expect(parsed.lines[8]).toMatchObject({ kind: 'meta', text: '+++ b/b.ts' });
    expect(renderableDiffLines(parsed).map(line => line.text)).toEqual([
      '@@ -1 +1 @@',
      'old',
      'new',
      '@@ -1 +1 @@',
      'x',
      'y',
    ]);
  });

  test('a hunk ends when its own counts are spent, without a `diff --git` to say so', () => {
    // `diff -u a b` prints no `diff --git` line at all, so only the hunk's line
    // counts can tell the parser that the second file's header has begun.
    const plain = ['--- a/one.txt', '+++ b/one.txt', '@@ -1 +1 @@', '-a', '+b', '--- a/two.txt', '+++ b/two.txt'].join(
      '\n',
    );
    const parsed = parseUnifiedDiff(plain);
    expect(parsed.added).toBe(1);
    expect(parsed.removed).toBe(1);
    expect(parsed.lines[5]).toMatchObject({ kind: 'meta', text: '--- a/two.txt' });
    expect(parsed.lines[6]).toMatchObject({ kind: 'meta', text: '+++ b/two.txt' });
  });

  test('gutters follow the hunk header on both sides', () => {
    const parsed = parseUnifiedDiff(sample);
    const [ctx1, del, add1, add2, ctx2] = parsed.lines.slice(5);
    expect(ctx1).toMatchObject({ oldNo: 10, newNo: 10 });
    // A removed line has no line in the post-image, and vice versa — an empty
    // gutter on that side is the point.
    expect(del).toMatchObject({ oldNo: 11 });
    expect(del!.newNo).toBeUndefined();
    expect(add1).toMatchObject({ newNo: 11 });
    expect(add1!.oldNo).toBeUndefined();
    expect(add2).toMatchObject({ newNo: 12 });
    // Context after the change resumes on BOTH counters.
    expect(ctx2).toMatchObject({ oldNo: 12, newNo: 13 });
  });

  test('markers are stripped from the rendered text', () => {
    const parsed = parseUnifiedDiff(sample);
    expect(parsed.lines[6]!.text).toBe('const b = 2;');
    expect(parsed.lines[7]!.text).toBe('const b = 3;');
    expect(parsed.lines[5]!.text).toBe('const a = 1;');
  });

  test('binary pairs are reported rather than rendered as text', () => {
    const parsed = parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ');
    expect(parsed.binary).toBe(true);
    expect(parsed.added).toBe(0);
  });

  test('a huge diff is capped so it cannot become a huge DOM', () => {
    const big = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
    const parsed = parseUnifiedDiff(big, 10);
    expect(parsed.lines).toHaveLength(10);
    expect(parsed.total).toBe(50);
    expect(parsed.truncated).toBe(true);
    // The counts describe the WHOLE diff, not the visible slice.
    expect(parsed.added).toBe(50);
  });

  test('plumbing headers are filtered for display, not for the parse', () => {
    const parsed = parseUnifiedDiff(sample);
    const shown = renderableDiffLines(parsed);
    // Parsed: 11 lines. Shown: without `diff --git`, `index`, `---`, `+++`.
    expect(parsed.lines).toHaveLength(11);
    expect(shown).toHaveLength(7);
    expect(shown.some(line => line.text.startsWith('diff --git'))).toBe(false);
    expect(shown[0]!.kind).toBe('hunk');
  });

  test('a rename-only diff still has something to show', () => {
    const parsed = parseUnifiedDiff('diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts');
    const shown = renderableDiffLines(parsed);
    expect(shown.map(line => line.text)).toEqual(['rename from a.ts', 'rename to b.ts']);
  });

  test('empty input is empty, not one blank line', () => {
    expect(parseUnifiedDiff('').lines).toHaveLength(0);
    expect(parseUnifiedDiff('\n').lines).toHaveLength(0);
  });
});

describe('formatters', () => {
  test('sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
    expect(formatBytes(undefined)).toBe('');
  });

  test('counts', () => {
    expect(countLabel(1, 'changed file')).toBe('1 changed file');
    expect(countLabel(3, 'changed file')).toBe('3 changed files');
  });
});
