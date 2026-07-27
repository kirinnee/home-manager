import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BINARY_SNIFF_BYTES,
  FsError,
  type FsDiffView,
  type FsFileView,
  isDeniedPath,
  listDirectory,
  looksBinary,
  MAX_LISTING_ENTRIES,
  normalizeRelativePath,
  pinRoot,
  readChanges,
  readDiff,
  readFileView,
  resolveInRoot,
} from './fs';
import { runGit } from './git';

function errorCode(error: unknown): string | undefined {
  return error instanceof FsError ? error.code : undefined;
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A committed repo so the gitignore gate and the diff paths are live. */
async function initRepo(root: string): Promise<void> {
  await runGit(['init', '-q', '.'], { cwd: root });
  await runGit(['config', 'user.email', 'kteam@example.test'], { cwd: root });
  await runGit(['config', 'user.name', 'kteam test'], { cwd: root });
}

async function commitAll(root: string, message: string): Promise<void> {
  await runGit(['add', '-A', '.'], { cwd: root });
  await runGit(['commit', '-q', '-m', message], { cwd: root });
}

describe('normalizeRelativePath', () => {
  test('accepts plain relative paths and the empty root', () => {
    expect(normalizeRelativePath(undefined)).toBe('');
    expect(normalizeRelativePath('')).toBe('');
    expect(normalizeRelativePath('.')).toBe('');
    expect(normalizeRelativePath('./')).toBe('');
    expect(normalizeRelativePath('src/fs.ts')).toBe('src/fs.ts');
    expect(normalizeRelativePath('src/')).toBe('src');
  });

  test('rejects every syntactic escape before touching the filesystem', () => {
    const rejected = [
      '/etc/passwd',
      '../secrets',
      'src/../../etc/passwd',
      'src/..',
      'a//b',
      './a',
      'a/./b',
      'src\\windows',
      'a\0b',
      'a\u0001b',
    ];
    for (const input of rejected) {
      expect(() => normalizeRelativePath(input)).toThrow(FsError);
    }
    // ".." must be rejected as a SEGMENT, but is legal inside a filename.
    expect(normalizeRelativePath('..hidden')).toBe('..hidden');
    expect(normalizeRelativePath('a..b/c')).toBe('a..b/c');
  });
});

describe('isDeniedPath', () => {
  test('denies secret-shaped names at any depth', () => {
    for (const denied of [
      '.env',
      '.env.local',
      'secrets.yaml',
      'secrets.enc.yaml',
      'deploy/server.pem',
      'tls.key',
      '.ssh/id_rsa',
      'keys/id_ed25519.pub',
      'age/key.age',
      'gcp-credentials.json',
      'vault.kdbx',
      '.netrc',
      '.npmrc',
      'store.p12',
      'a/b/.env',
    ]) {
      expect(isDeniedPath(denied)).toBe(true);
    }
  });

  test('denies .git and node_modules wholesale, case-insensitively', () => {
    expect(isDeniedPath('.git')).toBe(true);
    expect(isDeniedPath('.git/config')).toBe(true);
    expect(isDeniedPath('sub/.git/objects/ab/cdef')).toBe(true);
    expect(isDeniedPath('node_modules')).toBe(true);
    expect(isDeniedPath('node_modules/pkg/index.js')).toBe(true);
    expect(isDeniedPath('ui/node_modules/pkg/index.js')).toBe(true);
    // A case-insensitive checkout (macOS) opens the same bytes via .GIT/config.
    expect(isDeniedPath('.GIT/config')).toBe(true);
    expect(isDeniedPath('.Git/config')).toBe(true);
    expect(isDeniedPath('Node_Modules/pkg/index.js')).toBe(true);
  });

  test('allows ordinary source paths', () => {
    for (const allowed of ['src/fs.ts', 'README.md', '.gitignore', 'keychain.ts', 'env.ts', 'my.env.example.md']) {
      expect(isDeniedPath(allowed)).toBe(false);
    }
    expect(isDeniedPath('')).toBe(false);
  });
});

describe('looksBinary', () => {
  test('flags a NUL inside the sniff window and ignores one beyond it', () => {
    expect(looksBinary(new TextEncoder().encode('plain text\n'))).toBe(false);
    expect(looksBinary(Uint8Array.from([0x61, 0x00, 0x62]))).toBe(true);

    const late = new Uint8Array(BINARY_SNIFF_BYTES + 16).fill(0x61);
    late[BINARY_SNIFF_BYTES + 4] = 0x00;
    expect(looksBinary(late)).toBe(false);
  });
});

describe('containment', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'kteam-fs-'));
    root = path.join(base, 'tree');
    outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await write(outside, 'stolen.txt', 'SECRET-OUTSIDE-THE-ROOT\n');
    await write(root, 'inside.txt', 'inside\n');
  });

  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  test('refuses a symlink that resolves outside the root', async () => {
    await symlink(path.join(outside, 'stolen.txt'), path.join(root, 'escape.txt'));

    expect(errorCode(await resolveInRoot(root, 'escape.txt').catch(error => error))).toBe('escapes_root');
    expect(errorCode(await readFileView(root, 'escape.txt').catch(error => error))).toBe('escapes_root');

    const listing = await listDirectory(root);
    const escape = listing.entries.find(entry => entry.name === 'escape.txt');
    expect(escape).toMatchObject({ type: 'symlink', escapes: true });
    // Metadata only — never the size or mtime of the out-of-tree target.
    expect(escape?.size).toBeUndefined();
  });

  test('refuses a symlinked directory that resolves outside the root', async () => {
    await symlink(outside, path.join(root, 'link-dir'));
    expect(errorCode(await listDirectory(root, 'link-dir').catch(error => error))).toBe('escapes_root');
    expect(errorCode(await readFileView(root, 'link-dir/stolen.txt').catch(error => error))).toBe('escapes_root');
  });

  test('refuses symlink content even when the target is inside the root', async () => {
    // The attachments standard: lstat the lexical path and require a regular
    // file. Serving the link's target would also reopen a TOCTOU window — the
    // link can be repointed out of the tree after containment was checked.
    await symlink(path.join(root, 'inside.txt'), path.join(root, 'alias.txt'));
    expect(errorCode(await readFileView(root, 'alias.txt').catch(error => error))).toBe('not_a_file');

    // It still LISTS, with metadata, as an in-tree symlink.
    const entry = (await listDirectory(root)).entries.find(item => item.name === 'alias.txt');
    expect(entry).toMatchObject({ type: 'symlink' });
    expect(entry?.escapes).toBeUndefined();
  });

  test('refuses a leaf swapped to a symlink between the check and the read', async () => {
    // The lstat→read window: the leaf is a regular file when checked and a
    // symlink when read. O_NOFOLLOW makes the open itself fail (ELOOP) instead
    // of following it, so the swap cannot be turned into an out-of-tree read.
    // Simulated by pointing readFileView at a path that is already a symlink,
    // which is the same syscall outcome the race produces.
    await symlink(path.join(outside, 'stolen.txt'), path.join(root, 'raced.txt'));
    const error = await readFileView(root, 'raced.txt').catch(problem => problem);
    // Either gate may fire first — containment or the refusal to follow — and
    // both must deny. What must never happen is the out-of-tree content.
    expect(['escapes_root', 'not_a_file']).toContain(errorCode(error) ?? 'served-it');
  });

  test('refuses to traverse an in-tree symlinked DIRECTORY, and serves the real path', async () => {
    // Deliberate narrowing, and the core of the component-TOCTOU fix: every
    // component is opened O_NOFOLLOW from its already-open parent, so an interior
    // symlink is refused instead of resolved-and-contained. Resolving it would
    // mean validating one walk and performing another, which is the race.
    await mkdir(path.join(root, 'real'), { recursive: true });
    await write(root, 'real/file.txt', 'through a link\n');
    await symlink(path.join(root, 'real'), path.join(root, 'link'));

    expect(errorCode(await readFileView(root, 'link/file.txt').catch(error => error))).toBe('not_a_file');
    expect(errorCode(await listDirectory(root, 'link').catch(error => error))).toBe('not_a_file');

    // The cost is only the alias: the file is still served under its real path,
    // and the link is still LISTED so the UI can show it exists.
    expect((await readFileView(root, 'real/file.txt')).content).toBe('through a link\n');
    const entry = (await listDirectory(root)).entries.find(item => item.name === 'link');
    expect(entry).toMatchObject({ type: 'symlink' });
  });

  test('omits non-regular files from listings rather than inventing a type', async () => {
    const fifo = await Bun.spawn(['mkfifo', path.join(root, 'pipe')]).exited;
    if (fifo !== 0) return; // mkfifo unavailable — nothing to assert
    const names = (await listDirectory(root)).entries.map(entry => entry.name);
    expect(names).not.toContain('pipe');
    expect(names).toContain('inside.txt');
  });

  test('rejects traversal and absolute paths without hitting the filesystem', async () => {
    expect(errorCode(await readFileView(root, '../outside/stolen.txt').catch(error => error))).toBe('invalid_path');
    expect(errorCode(await readFileView(root, '/etc/passwd').catch(error => error))).toBe('invalid_path');
    expect(errorCode(await readFileView(root, 'sub/../../outside/stolen.txt').catch(error => error))).toBe(
      'invalid_path',
    );
  });

  test('reports a missing path and a deleted session cwd distinctly', async () => {
    expect(errorCode(await readFileView(root, 'nope.txt').catch(error => error))).toBe('not_found');
    await rm(root, { recursive: true, force: true });
    expect(errorCode(await listDirectory(root).catch(error => error))).toBe('not_found');
  });

  test('serves only regular files', async () => {
    await mkdir(path.join(root, 'dir'), { recursive: true });
    expect(errorCode(await readFileView(root, 'dir').catch(error => error))).toBe('not_a_file');
    expect(errorCode(await listDirectory(root, 'inside.txt').catch(error => error))).toBe('not_a_directory');
  });
});

describe('gates and caps', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-fs-gate-'));
    await initRepo(root);
    await write(root, '.gitignore', 'secrets.yaml\nbuild/\n*.log\n');
    await write(root, 'README.md', '# hello\n');
    await write(root, 'secrets.yaml', 'password: hunter2\n');
    await write(root, '.env', 'TOKEN=abc123\n');
    await write(root, 'build/out.js', 'console.log(1)\n');
    await write(root, 'app.log', 'noise\n');
    await commitAll(root, 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('refuses denylisted content without leaking bytes', async () => {
    const view = await readFileView(root, '.env');
    expect(view).toMatchObject({ path: '.env', denied: true, reason: 'denylist' });
    expect(view.content).toBeUndefined();
  });

  test('refuses gitignored content — the decrypted-secrets case', async () => {
    // secrets.yaml is on the hard denylist too, so it reports as denied.
    const view = await readFileView(root, 'secrets.yaml');
    expect(view).toMatchObject({ denied: true, reason: 'denylist' });
    expect(view.content).toBeUndefined();

    // These two are ONLY gitignored: distinct flag, distinct UI badge.
    const ignoredOnly = await readFileView(root, 'app.log');
    expect(ignoredOnly).toMatchObject({ ignored: true, reason: 'ignored' });
    expect(ignoredOnly.denied).toBeUndefined();
    expect(ignoredOnly.content).toBeUndefined();

    const inIgnoredDir = await readFileView(root, 'build/out.js');
    expect(inIgnoredDir).toMatchObject({ ignored: true, reason: 'ignored' });
    expect(inIgnoredDir.denied).toBeUndefined();
    expect(inIgnoredDir.content).toBeUndefined();
  });

  test('serves ordinary tracked content', async () => {
    const view = await readFileView(root, 'README.md');
    expect(view.content).toBe('# hello\n');
    expect(view.denied).toBeUndefined();
    expect(view.size).toBe(8);
    expect(view.mtime).toBeString();
  });

  test('marks ignored and denied entries in a listing but still lists them', async () => {
    const listing = await listDirectory(root);
    const byName = new Map(listing.entries.map(entry => [entry.name, entry]));

    expect(byName.get('app.log')).toMatchObject({ ignored: true });
    expect(byName.get('.env')).toMatchObject({ denied: true });
    expect(byName.get('secrets.yaml')).toMatchObject({ denied: true, ignored: true });
    expect(byName.get('README.md')?.ignored).toBeUndefined();
    // .git is present on disk but must never be offered as a browsable dir.
    expect(byName.get('.git')).toMatchObject({ denied: true });
    expect(listing.entries[0]?.type).toBe('dir'); // dirs first
  });

  test('refuses to descend into .git or node_modules', async () => {
    await write(root, 'node_modules/pkg/index.js', 'module.exports = 1\n');
    expect(errorCode(await listDirectory(root, '.git').catch(error => error))).toBe('denied');
    expect(errorCode(await listDirectory(root, 'node_modules').catch(error => error))).toBe('denied');
    expect((await readFileView(root, '.git/config')).denied).toBe(true);
    expect((await readFileView(root, 'node_modules/pkg/index.js')).denied).toBe(true);
  });

  test('refuses files over the size cap after a stat, without reading them', async () => {
    await write(root, 'big.txt', 'x'.repeat(4096));
    const view = await readFileView(root, 'big.txt', { maxBytes: 1024 });
    expect(view).toMatchObject({ tooLarge: true, size: 4096 });
    expect(view.content).toBeUndefined();
  });

  test('flags binary files and serves no content', async () => {
    await writeFile(path.join(root, 'blob.bin'), Uint8Array.from([0x89, 0x00, 0x01, 0x02]));
    const view = await readFileView(root, 'blob.bin');
    expect(view).toMatchObject({ binary: true, size: 4 });
    expect(view.content).toBeUndefined();
  });

  test('caps a listing and says so', async () => {
    const many = await mkdtemp(path.join(tmpdir(), 'kteam-fs-many-'));
    try {
      await Promise.all(
        Array.from({ length: MAX_LISTING_ENTRIES + 25 }, (_unused, index) =>
          writeFile(path.join(many, `f${String(index).padStart(5, '0')}.txt`), 'x'),
        ),
      );
      const listing = await listDirectory(many);
      expect(listing.truncated).toBe(true);
      expect(listing.entries).toHaveLength(MAX_LISTING_ENTRIES);
    } finally {
      await rm(many, { recursive: true, force: true });
    }
  });

  test('refuses a session root that is itself inside a denied directory', async () => {
    // `kteam start --cwd` takes any existing directory, so the root can BE the
    // object store — and then every relative path is innocent (`config` has no
    // denied segment). The gate has to sit on the root, not only on `rel`.
    for (const denied of ['.git', path.join('.git', 'objects'), 'node_modules', '.env.project']) {
      const inside = path.join(root, denied);
      await mkdir(inside, { recursive: true });
      expect(errorCode(await listDirectory(inside).catch(error => error))).toBe('denied');
      expect(errorCode(await readFileView(inside, 'config').catch(error => error))).toBe('denied');
      expect(errorCode(await readDiff(inside, 'config').catch(error => error))).toBe('denied');
      expect(errorCode(await readChanges(inside).catch(error => error))).toBe('denied');
    }

    // A symlink to the object store is not a way around it: the root is gated
    // after realpath.
    await symlink(path.join(root, '.git'), path.join(root, 'root-alias'));
    expect(errorCode(await listDirectory(path.join(root, 'root-alias')).catch(error => error))).toBe('denied');
  });

  test('an in-root symlinked directory cannot launder a denied target', async () => {
    // The bypass: `alias -> .git` is contained (its target IS in the root),
    // `alias/config` has a regular-file leaf, and the LEXICAL path matches no
    // denylist entry. Two independent gates now stop it — the no-follow walk
    // refuses to traverse `alias` at all, and the canonical path is gated even
    // if that ever loosened.
    await symlink(path.join(root, '.git'), path.join(root, 'alias'));

    for (const attempt of [
      () => listDirectory(root, 'alias'),
      () => readFileView(root, 'alias/config'),
      () => readDiff(root, 'alias/config'),
    ]) {
      const outcome = await attempt().catch(error => error);
      // Whichever gate fires, the object store must never be rendered.
      expect(errorCode(outcome) ?? (outcome as { reason?: string }).reason).toMatch(/not_a_file|denied|denylist/);
      expect(JSON.stringify(outcome)).not.toContain('[core]');
    }

    // The link itself is badged in the listing, even though its NAME is clean.
    const entry = (await listDirectory(root)).entries.find(item => item.name === 'alias');
    expect(entry).toMatchObject({ type: 'symlink', denied: true });
  });

  test('refuses to enumerate a gitignored directory, lexically or via a symlink', async () => {
    // The UI greys ignored dirs out, but a token holder calls /fs?path=build
    // directly — and the FILENAMES inside an ignored tree are themselves the
    // leak. Refusing content but allowing enumeration is not a gate.
    await write(root, 'build/prod-credentials.json', '{"token":"leak"}\n');
    expect(errorCode(await listDirectory(root, 'build').catch(error => error))).toBe('ignored');

    // Via an alias the walk refuses the symlinked component first; either way
    // the ignored tree is not enumerated.
    await symlink(path.join(root, 'build'), path.join(root, 'out'));
    expect(['ignored', 'not_a_file']).toContain(
      errorCode(await listDirectory(root, 'out').catch(error => error)) ?? 'enumerated-it',
    );

    // The PARENT still lists it, badged — that is how the UI knows it exists.
    const entry = (await listDirectory(root)).entries.find(item => item.name === 'build');
    expect(entry).toMatchObject({ name: 'build', type: 'dir', ignored: true });
  });

  test('fails closed when Git cannot prove a requested directory is unignored', async () => {
    await write(root, 'safe-dir/file.txt', 'ordinary\n');
    // A corrupt index makes check-ignore fail instead of returning either of
    // its normal verdicts (0 = ignored, 1 = not ignored). That uncertainty may
    // not turn into permission to enumerate the directory.
    await writeFile(path.join(root, '.git', 'index'), 'not a git index');
    expect(errorCode(await listDirectory(root, 'safe-dir').catch(error => error))).toBe('ignored');
  });

  test('an in-root symlinked directory cannot launder a gitignored target', async () => {
    // `build/` is gitignored; `dist/out.js` is lexically innocent. The walk
    // refuses the symlinked component, and the canonical-path ignore gate stands
    // behind it.
    await symlink(path.join(root, 'build'), path.join(root, 'dist'));

    const view = await readFileView(root, 'dist/out.js').catch(error => error);
    expect(errorCode(view) ?? (view as FsFileView).reason).toMatch(/not_a_file|ignored/);
    expect((view as FsFileView).content).toBeUndefined();

    const diff = await readDiff(root, 'dist/out.js').catch(error => error);
    expect(errorCode(diff) ?? (diff as FsDiffView).reason).toMatch(/not_a_file|ignored/);
    expect((diff as FsDiffView).diff ?? '').not.toContain('console.log');

    const entry = (await listDirectory(root)).entries.find(item => item.name === 'dist');
    expect(entry).toMatchObject({ type: 'symlink', ignored: true });
  });

  test('a non-git tree keeps the denylist and drops the ignore gate', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'kteam-fs-plain-'));
    try {
      await write(plain, 'notes.md', 'hello\n');
      await write(plain, '.env', 'TOKEN=xyz\n');
      expect((await readFileView(plain, 'notes.md')).content).toBe('hello\n');
      expect((await readFileView(plain, '.env')).denied).toBe(true);
      expect(await readChanges(plain)).toMatchObject({ repo: false, changes: [] });
      expect(await readDiff(plain, 'notes.md')).toMatchObject({ kind: 'none', diff: '' });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('HEAD reads', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-fs-head-'));
    await initRepo(root);
    await write(root, '.gitignore', 'secret.txt\n');
    await write(root, 'doc.md', 'version one\n');
    await write(root, 'secret.txt', 'do not serve\n');
    await commitAll(root, 'init');
    await write(root, 'doc.md', 'version two\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('serves the committed version, not the working tree', async () => {
    expect((await readFileView(root, 'doc.md')).content).toBe('version two\n');
    const head = await readFileView(root, 'doc.md', { rev: 'head' });
    expect(head).toMatchObject({ rev: 'head', content: 'version one\n' });
  });

  test('applies the same gates to HEAD as to the working tree', async () => {
    // secret.txt is gitignored (not denylisted), so HEAD refuses it the same
    // way the working tree does — the gate is "these bytes never leave", not
    // "the working copy is special".
    const view = await readFileView(root, 'secret.txt', { rev: 'head' });
    expect(view).toMatchObject({ ignored: true, reason: 'ignored', rev: 'head' });
    expect(view.content).toBeUndefined();

    // A denylisted path refuses through the HEAD path too.
    await write(root, '.env', 'TOKEN=abc\n');
    const denied = await readFileView(root, '.env', { rev: 'head' });
    expect(denied).toMatchObject({ denied: true, reason: 'denylist', rev: 'head' });
    expect(denied.content).toBeUndefined();
  });

  test('404s a path absent from HEAD and refuses traversal in the rev spec', async () => {
    await write(root, 'new.txt', 'untracked\n');
    expect(errorCode(await readFileView(root, 'new.txt', { rev: 'head' }).catch(error => error))).toBe('not_found');
    // `HEAD:./../x` really does resolve out of a subdir cwd, so the syntactic
    // gate is what contains this read.
    expect(errorCode(await readFileView(root, '../doc.md', { rev: 'head' }).catch(error => error))).toBe(
      'invalid_path',
    );
  });
});

/**
 * The component-TOCTOU regressions.
 *
 * Every test here swaps a directory the request depends on — an intermediate
 * parent, or the configured session cwd itself — for a symlink to an outside tree
 * holding a marker string, and asserts that marker cannot come back. They are
 * written to FAIL against the previous implementation, which validated a path
 * string and then re-walked it: with `realpath` + `open(pathname)` and git spawned
 * on the mutable `cwd`, the outside content was served.
 *
 * Two flavours, deliberately:
 *  - deterministic — the swap is already in place when the request is made, which
 *    is the same syscall sequence the winning race produces, minus the timing;
 *  - stress — the swap flips in a loop against concurrent requests, so a window
 *    that only opens under real interleaving is still caught.
 */
describe('path-component TOCTOU (parent and cwd swaps)', () => {
  const MARKER = 'OUTSIDE-MARKER-SHOULD-NEVER-APPEAR';
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'kteam-fs-toctou-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });

    await initRepo(root);
    await write(root, 'sub/file.txt', 'COMMITTED\n');
    await write(root, '.gitignore', 'ignored-out/\n');
    await commitAll(root, 'init');
    // Leave the file DIRTY. This is load-bearing, not incidental setup: a clean
    // file has an empty diff, so a diff test over one proves nothing about where
    // the bytes came from. The leak these tests exist to catch was only reachable
    // because a tracked-and-modified file makes git read the working copy.
    await write(root, 'sub/file.txt', 'INSIDE\n');

    // The outside tree mirrors the in-root layout, so a redirected read finds a
    // file exactly where it expects one and the marker really can surface.
    //
    // Crucially the marker files are GITIGNORED in the outside tree but not in
    // the root. That turns "did the marker come back?" into a precise detector of
    // GATE/BYTE MIXING: serving it means the ignore gate was evaluated against
    // one tree while the bytes were read from the other. A coherent answer from
    // either tree alone can never contain it.
    await write(outside, 'file.txt', `${MARKER}\n`);
    await write(outside, 'sub/file.txt', `${MARKER}\n`);
    await write(outside, 'secret.txt', `${MARKER}\n`);
    await write(outside, '.gitignore', 'file.txt\nsub/\nsecret.txt\n');
    await initRepo(outside);
    await commitAll(outside, 'outside');
    // Dirty on this side too, so the outside repo can produce a marker-bearing
    // tracked diff — the exact shape that leaked before the fix.
    await write(outside, 'sub/file.txt', `${MARKER}\n`);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Replace an in-root directory with a symlink to the outside tree. */
  async function swapParent(): Promise<void> {
    await rename(path.join(root, 'sub'), path.join(root, 'sub.moved'));
    await symlink(outside, path.join(root, 'sub'));
  }

  /** Replace the configured session cwd itself with a symlink to the outside tree. */
  async function swapCwd(): Promise<void> {
    await rename(root, path.join(base, 'root.moved'));
    await symlink(outside, root);
  }

  function serialize(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return JSON.stringify(value) ?? '';
  }

  test('an intermediate directory swapped for a symlink cannot redirect a file read', async () => {
    await swapParent();
    // Refused outright is the expected outcome; what is forbidden is content.
    const outcome = await readFileView(root, 'sub/file.txt').catch(error => error);
    expect(serialize(outcome)).not.toContain(MARKER);
    expect((outcome as FsFileView).content).not.toBe(`${MARKER}\n`);
  });

  test('an intermediate swap cannot redirect a diff, a listing, or the ignore gate', async () => {
    await swapParent();

    for (const outcome of await Promise.all([
      readDiff(root, 'sub/file.txt').catch(error => error),
      listDirectory(root, 'sub').catch(error => error),
      readFileView(root, 'sub/file.txt', { rev: 'head' }).catch(error => error),
      readChanges(root).catch(error => error),
    ])) {
      expect(serialize(outcome)).not.toContain(MARKER);
    }
  });

  test('the session cwd swapped for a symlink is answered coherently, gates included', async () => {
    // The nastiest variant: the ROOT is the thing replaced. Note what is and is
    // not being claimed. A swap that lands BEFORE the request starts is not an
    // escape — the configured cwd honestly names the other tree at that instant,
    // and a viewer is supposed to show the tree its cwd names. What must never
    // happen is MIXING: gates from the old tree deciding to serve bytes from the
    // new one. The outside marker files are gitignored there, so serving one is
    // exactly that mixing, and refusing is the coherent answer.
    await swapCwd();

    for (const outcome of await Promise.all([
      readFileView(root, 'sub/file.txt').catch(error => error),
      readDiff(root, 'sub/file.txt').catch(error => error),
      readChanges(root).catch(error => error),
      listDirectory(root).catch(error => error),
      readFileView(root, 'secret.txt').catch(error => error),
    ])) {
      // Names may legitimately appear (the tree is what the cwd now names);
      // CONTENT past the swapped tree's own ignore gate may not.
      expect((outcome as FsFileView).content ?? '').not.toContain(MARKER);
      expect((outcome as FsDiffView).diff ?? '').not.toContain(MARKER);
    }
  });

  test('a root pinned BEFORE the swap keeps answering from the validated tree', async () => {
    // Positive proof that the mechanism is a pin and not merely a refusal: the
    // descriptor is taken first, the root is then replaced, and the pinned tree
    // still answers. A name-based implementation returns the marker here.
    const pinned = await pinRoot(root);
    try {
      await swapCwd();
      const bytes = await readFileView(pinned.dirPath, 'sub/file.txt');
      expect(bytes.content).toBe('INSIDE\n');

      const changes = await readChanges(pinned.dirPath);
      expect(serialize(changes)).not.toContain(MARKER);
    } finally {
      await pinned.close();
    }
  });

  // These are the load-bearing regressions. The stress tests below hunt the same
  // races by luck — measured at ~0.5% of calls against a name-reopening
  // implementation, so they pass green on vulnerable code most of the time.
  // Here the swap is forced into the window itself, after the path has been
  // validated and its descriptor taken but before a single byte is read. Any
  // future refactor that reopens a path by name after validation fails these
  // every run, not one run in two hundred.
  describe('the swap forced INTO the validated-but-not-yet-read window', () => {
    /** Fire `swap` the first time the window opens, then stay out of the way. */
    function once(swap: () => Promise<void>): () => Promise<void> {
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await swap();
      };
    }

    /** Replace the leaf itself with a symlink to a marker file outside the root. */
    async function swapLeaf(): Promise<void> {
      await write(outside, 'target.txt', `${MARKER}\n`);
      const leaf = path.join(root, 'sub/file.txt');
      await rename(leaf, path.join(root, 'sub/file.moved'));
      await symlink(path.join(outside, 'target.txt'), leaf);
    }

    /**
     * Replace the parent with a different REAL DIRECTORY of the same name.
     *
     * Deliberately not a symlink. Git refuses a pathspec that is `beyond a
     * symbolic link`, so a symlinked parent makes the ignore gate throw and
     * `refusalFor` fail closed — safe, but it decides the request before the
     * bytes are ever reached, and a name-reopening implementation would be
     * refused in exactly the same way. Swapping in a real directory removes
     * that refusal, so the gate passes and only the descriptor decides. That is
     * what makes the assertions below discriminate: against reopen-by-name this
     * swap serves the marker and renders `index e20be6b..f8d6e18` with
     * `+OUTSIDE…`, the precise mixing this fix exists for.
     */
    async function swapParentForRealDir(): Promise<void> {
      const replacement = path.join(base, 'replacement');
      await write(replacement, 'file.txt', `${MARKER}\n`);
      await rename(path.join(root, 'sub'), path.join(root, 'sub.moved'));
      await rename(replacement, path.join(root, 'sub'));
    }

    test('a parent swapped inside the window fails the post-policy identity proof', async () => {
      const outcome = await readFileView(root, 'sub/file.txt', {
        afterValidation: once(swapParentForRealDir),
      }).catch(error => error);
      expect(errorCode(outcome)).toBe('not_found');
      expect(serialize(outcome)).not.toContain(MARKER);
    });

    test('a parent swapped inside the window fails closed before diffing', async () => {
      // Both sides must come from the pinned tree or neither: the pinned repo's
      // index paired with the other directory's bytes is the failure shape.
      const outcome = await readDiff(root, 'sub/file.txt', {
        afterValidation: once(swapParentForRealDir),
      }).catch(error => error);
      expect(errorCode(outcome)).toBe('not_found');
      expect(serialize(outcome)).not.toContain(MARKER);
    });

    test('a parent swap cannot separate a local gitignore decision from pinned bytes', async () => {
      // The ignored rule lives IN the directory being moved. If the gate is
      // evaluated only after the swap, Git sees the replacement `sub/` (which
      // has no local .gitignore) while the retained file descriptor still
      // points at the ignored bytes in `sub.moved/`.
      await write(root, 'sub/.gitignore', 'private.txt\n');
      await write(root, 'sub/private.txt', 'IGNORED-PRIVATE-MARKER\n');

      const swap = async () => {
        const replacement = path.join(base, 'ignore-replacement');
        await write(replacement, 'file.txt', 'replacement\n');
        await write(replacement, 'private.txt', 'replacement\n');
        await rename(path.join(root, 'sub'), path.join(root, 'sub.moved'));
        await rename(replacement, path.join(root, 'sub'));
      };

      const file = await readFileView(root, 'sub/private.txt', { afterValidation: once(swap) });
      expect(file.content).toBeUndefined();
      expect(file.ignored).toBe(true);

      // Restore the original name and repeat independently for the diff path.
      await rm(path.join(root, 'sub'), { recursive: true, force: true });
      await rename(path.join(root, 'sub.moved'), path.join(root, 'sub'));
      const diff = await readDiff(root, 'sub/private.txt', { afterValidation: once(swap) });
      expect(diff.diff).toBe('');
      expect(diff.ignored).toBe(true);
    });

    test('a parent swap cannot enumerate an originally ignored directory', async () => {
      await write(root, 'container/.gitignore', 'private/\n');
      await write(root, 'container/private/OLD-IGNORED-NAME', 'secret\n');

      const swap = async () => {
        const replacement = path.join(base, 'listing-replacement');
        await write(replacement, 'private/replacement.txt', 'safe\n');
        await rename(path.join(root, 'container'), path.join(root, 'container.moved'));
        await rename(replacement, path.join(root, 'container'));
      };

      const outcome = await listDirectory(root, 'container/private', {
        afterValidation: once(swap),
      }).catch(error => error);
      expect(errorCode(outcome)).toBe('ignored');
      expect(serialize(outcome)).not.toContain('OLD-IGNORED-NAME');
    });

    test('a parent SYMLINKED inside the window is refused, not answered', async () => {
      // The other half of the parent case. Here git's own "beyond a symbolic
      // link" refusal makes the ignore gate fail closed first, so no bytes are
      // reached at all. Asserted separately from the tests above so that a
      // refusal can never be mistaken for proof that the pin held.
      // One shared one-shot: whichever request opens the window first performs
      // the swap, and the other must be just as unable to profit from it.
      const swap = once(swapParent);
      for (const outcome of await Promise.all([
        readFileView(root, 'sub/file.txt', { afterValidation: swap }).catch(e => e),
        readDiff(root, 'sub/file.txt', { afterValidation: swap }).catch(e => e),
      ])) {
        expect(serialize(outcome)).not.toContain(MARKER);
        expect((outcome as FsFileView).content).toBeUndefined();
      }
    });

    test('a leaf swapped inside the window fails the post-policy identity proof', async () => {
      const outcome = await readFileView(root, 'sub/file.txt', { afterValidation: once(swapLeaf) }).catch(
        error => error,
      );
      expect(errorCode(outcome)).toBe('not_found');
      expect(serialize(outcome)).not.toContain(MARKER);
    });

    test('a leaf swapped inside the window fails closed before diffing', async () => {
      const outcome = await readDiff(root, 'sub/file.txt', { afterValidation: once(swapLeaf) }).catch(error => error);
      expect(errorCode(outcome)).toBe('not_found');
      expect(serialize(outcome)).not.toContain(MARKER);
    });

    test('the root swapped inside the window fails the post-policy identity proof', async () => {
      const outcome = await readFileView(root, 'sub/file.txt', { afterValidation: once(swapCwd) }).catch(
        error => error,
      );
      expect(errorCode(outcome)).toBe('not_found');
      expect(serialize(outcome)).not.toContain(MARKER);
    });

    test('the root swapped inside the window fails closed before diffing', async () => {
      const outcome = await readDiff(root, 'sub/file.txt', { afterValidation: once(swapCwd) }).catch(error => error);
      expect(errorCode(outcome)).toBe('not_found');
      expect(serialize(outcome)).not.toContain(MARKER);
    });

    test('the hook is per-request state, not shared across concurrent reads', async () => {
      // Why this matters beyond tidiness: as module state the hook fires for
      // whichever request is in flight, so a barrier armed by one test lands in
      // another's window and the suite reports races the code does not have.
      //
      // Locality is asserted with a counter, NOT a swap. A swap would be
      // scheduling-dependent here — the plain request may legitimately begin
      // validation after it lands, in which case replacement bytes are the
      // honest answer for that request and the test would flake. The swap
      // tests above pin the ordering explicitly and cover the security claim;
      // this one covers only the plumbing.
      let fired = 0;
      const [hooked, plain] = await Promise.all([
        readFileView(root, 'sub/file.txt', {
          afterValidation: async () => {
            fired += 1;
          },
        }),
        readFileView(root, 'sub/file.txt'),
      ]);
      expect(fired).toBe(1);
      expect(hooked.content).toBe('INSIDE\n');
      expect(plain.content).toBe('INSIDE\n');
    });
  });

  test('a leaf swapped for a symlink to an outside file cannot be served', async () => {
    // The leaf is its own TOCTOU target, distinct from the parent and root
    // cases: validated as a regular file, then replaced by a symlink pointing
    // out of the tree. Verified against a validate-then-reopen implementation,
    // which serves the marker here; reading from the descriptor that was
    // validated cannot, and O_NOFOLLOW refuses the link if the swap lands first.
    await write(outside, 'target.txt', `${MARKER}\n`);
    await rename(path.join(root, 'sub/file.txt'), path.join(root, 'sub/file.moved'));
    await symlink(path.join(outside, 'target.txt'), path.join(root, 'sub/file.txt'));

    for (const attempt of [
      () => readFileView(root, 'sub/file.txt'),
      () => readFileView(root, 'sub/file.txt', { rev: 'head' }),
      () => readDiff(root, 'sub/file.txt'),
      () => listDirectory(root, 'sub'),
      () => readChanges(root),
    ]) {
      const outcome = await attempt().catch(error => error);
      expect(serialize(outcome)).not.toContain(MARKER);
    }
  });

  test('stress: swapping a LEAF under concurrent requests never leaks the marker', async () => {
    // Same target, hunted under real interleaving rather than a fixed order.
    await write(outside, 'target.txt', `${MARKER}\n`);
    const leaf = path.join(root, 'sub/file.txt');
    const moved = path.join(root, 'sub/file.moved');

    let stop = false;
    const flip = (async () => {
      while (!stop) {
        try {
          await rename(leaf, moved);
          await symlink(path.join(outside, 'target.txt'), leaf);
          await rm(leaf, { force: true });
          await rename(moved, leaf);
        } catch {
          // A losing swap is not a finding; only the reader's answer matters.
        }
      }
    })();

    try {
      for (let round = 0; round < 40; round += 1) {
        for (const outcome of await Promise.all([
          readFileView(root, 'sub/file.txt').catch(error => error),
          readDiff(root, 'sub/file.txt').catch(error => error),
          listDirectory(root, 'sub').catch(error => error),
          readChanges(root).catch(error => error),
        ])) {
          expect(serialize(outcome)).not.toContain(MARKER);
        }
      }
    } finally {
      stop = true;
      await flip;
    }
  }, 30_000);

  test('stress: swapping a parent under concurrent requests never leaks the marker', async () => {
    // The deterministic tests fix the interleaving; this one hunts for a window
    // that only opens when the swap lands mid-request.
    let stop = false;
    const flip = (async () => {
      while (!stop) {
        try {
          await rename(path.join(root, 'sub'), path.join(root, 'sub.moved'));
          await symlink(outside, path.join(root, 'sub'));
          await rm(path.join(root, 'sub'), { force: true });
          await rename(path.join(root, 'sub.moved'), path.join(root, 'sub'));
        } catch {
          // The swap racing itself is fine; only the reader's answer matters.
        }
      }
    })();

    try {
      for (let round = 0; round < 40; round += 1) {
        const outcomes = await Promise.all([
          readFileView(root, 'sub/file.txt').catch(error => error),
          readDiff(root, 'sub/file.txt').catch(error => error),
          listDirectory(root, 'sub').catch(error => error),
          readChanges(root).catch(error => error),
        ]);
        for (const outcome of outcomes) {
          expect(serialize(outcome)).not.toContain(MARKER);
        }
      }
    } finally {
      stop = true;
      await flip;
    }
  }, 30_000);

  test('stress: swapping the session cwd under concurrent requests stays coherent', async () => {
    // Same property as the deterministic cwd test, hunted under real
    // interleaving: content that only the OTHER tree's gitignore covers can only
    // be returned if gates and bytes came from different trees.
    const moved = path.join(base, 'root.moved');
    let stop = false;
    const flip = (async () => {
      while (!stop) {
        try {
          await rename(root, moved);
          await symlink(outside, root);
          await rm(root, { force: true });
          await rename(moved, root);
        } catch {
          // Same: a losing swap is not a finding.
        }
      }
    })();

    try {
      for (let round = 0; round < 40; round += 1) {
        const outcomes = await Promise.all([
          readFileView(root, 'sub/file.txt').catch(error => error),
          readDiff(root, 'sub/file.txt').catch(error => error),
          readChanges(root).catch(error => error),
          listDirectory(root).catch(error => error),
        ]);
        for (const outcome of outcomes) {
          expect((outcome as FsFileView).content ?? '').not.toContain(MARKER);
          expect((outcome as FsDiffView).diff ?? '').not.toContain(MARKER);
        }
      }
    } finally {
      stop = true;
      await flip;
    }
  }, 30_000);
});
