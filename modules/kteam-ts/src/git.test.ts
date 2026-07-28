import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gitChanges,
  gitDiffSnapshots,
  gitHeadEntry,
  gitIgnoredPaths,
  gitIsTracked,
  gitReadHeadBlob,
  gitRepoInfo,
  runGit,
} from './git';
import { MAX_DIFF_SIDE_BYTES, readChanges, readDiff } from './fs';

async function write(root: string, rel: string, content: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await runGit(args, { cwd: root });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

async function initRepo(root: string): Promise<void> {
  await git(root, 'init', '-q', '.');
  await git(root, 'config', 'user.email', 'kteam@example.test');
  await git(root, 'config', 'user.name', 'kteam test');
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, 'add', '-A', '.');
  await git(root, 'commit', '-q', '-m', message);
}

function statusOf(changes: { path: string; status: string }[], target: string): string | undefined {
  return changes.find(change => change.path === target)?.status;
}

function changeOf<T extends { path: string }>(changes: T[], target: string): T | undefined {
  return changes.find(change => change.path === target);
}

describe('gitRepoInfo', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-info-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('reports a non-repo without throwing', async () => {
    expect(await gitRepoInfo(root)).toMatchObject({ repo: false, prefix: '', hasHead: false });
  });

  test('reports the toplevel, prefix, branch and HEAD state', async () => {
    await initRepo(root);
    await write(root, 'sub/a.txt', 'a\n');

    const beforeCommit = await gitRepoInfo(root);
    expect(beforeCommit).toMatchObject({ repo: true, prefix: '', hasHead: false });

    await commitAll(root, 'init');
    const afterCommit = await gitRepoInfo(root);
    expect(afterCommit.repo).toBe(true);
    expect(afterCommit.hasHead).toBe(true);

    const fromSubdir = await gitRepoInfo(path.join(root, 'sub'));
    expect(fromSubdir.prefix).toBe('sub/');
    expect(fromSubdir.root).toBe(afterCommit.root);
  });
});

describe('gitChanges', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-status-'));
    await initRepo(root);
    await write(root, 'top.txt', 'top\n');
    await write(root, 'sub/kept.txt', 'kept\n');
    await write(root, 'sub/edited.txt', 'one\n');
    await write(root, 'other/sibling.txt', 'sibling\n');
    await commitAll(root, 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('lists staged, unstaged and untracked changes with the branch', async () => {
    await write(root, 'sub/edited.txt', 'two\n');
    await write(root, 'staged.txt', 'staged\n');
    await git(root, 'add', 'staged.txt');
    await write(root, 'fresh.txt', 'fresh\n');

    const view = await gitChanges(root);
    expect(view.repo).toBe(true);
    expect(view.branch).toBeString();
    expect(statusOf(view.changes, 'sub/edited.txt')).toBe(' M');
    expect(statusOf(view.changes, 'staged.txt')).toBe('A ');
    expect(statusOf(view.changes, 'fresh.txt')).toBe('??');
  });

  test('adds exact line counts with one cwd-wide stats pass', async () => {
    await write(root, 'sub/edited.txt', 'two\nthree\n');
    await write(root, 'staged.txt', 'alpha\nbeta\n');
    await git(root, 'add', 'staged.txt');
    await rm(path.join(root, 'top.txt'));
    await write(root, 'fresh.txt', 'untracked\nlines\n');

    const view = await gitChanges(root);
    expect(changeOf(view.changes, 'sub/edited.txt')).toMatchObject({ additions: 2, deletions: 1 });
    expect(changeOf(view.changes, 'staged.txt')).toMatchObject({ additions: 2, deletions: 0 });
    expect(changeOf(view.changes, 'top.txt')).toMatchObject({ additions: 0, deletions: 1 });
    // Git has no batched numstat for untracked files. The status/dot remains,
    // but the API does not invent a line count or read every untracked file.
    expect(changeOf(view.changes, 'fresh.txt')?.additions).toBeUndefined();
    expect(changeOf(view.changes, 'fresh.txt')?.deletions).toBeUndefined();
  });

  test('numstat keeps tabs and newlines inside a literal filename', async () => {
    const weird = 'sub/tab\tline\nname.txt';
    await write(root, weird, 'one\ntwo\n');
    await git(root, 'add', weird);

    const change = changeOf((await gitChanges(root)).changes, weird);
    expect(change).toMatchObject({ path: weird, status: 'A ', additions: 2, deletions: 0 });
  });

  test('forces untracked reporting even when the repo config hides it', async () => {
    // This checkout sets status.showUntrackedFiles=no; the argv must override it
    // or the Changes list silently omits every new file the agent wrote.
    await git(root, 'config', 'status.showUntrackedFiles', 'no');
    await write(root, 'fresh.txt', 'fresh\n');

    expect(statusOf((await gitChanges(root)).changes, 'fresh.txt')).toBe('??');
  });

  test('reports untracked files individually, not as a collapsed directory', async () => {
    await write(root, 'newdir/one.txt', '1\n');
    await write(root, 'newdir/two.txt', '2\n');

    const paths = (await gitChanges(root)).changes.map(change => change.path);
    expect(paths).toContain('newdir/one.txt');
    expect(paths).toContain('newdir/two.txt');
    expect(paths).not.toContain('newdir/');
  });

  test('filters to the session cwd and rewrites paths relative to it', async () => {
    await write(root, 'sub/edited.txt', 'two\n');
    await write(root, 'other/sibling.txt', 'changed\n');
    await write(root, 'top.txt', 'changed\n');

    const view = await gitChanges(path.join(root, 'sub'));
    expect(view.changes.map(change => change.path)).toEqual(['edited.txt']);
    // A subdir session must never learn that a sibling or the repo root changed.
    expect(JSON.stringify(view)).not.toContain('sibling');
    expect(JSON.stringify(view)).not.toContain('top.txt');
  });

  test('pins relativePaths so a repo-local setting cannot reshape the output', async () => {
    await git(root, 'config', 'status.relativePaths', 'true');
    await write(root, 'sub/edited.txt', 'two\n');

    const view = await gitChanges(path.join(root, 'sub'));
    expect(view.changes.map(change => change.path)).toEqual(['edited.txt']);
  });

  test('parses a rename into path + from', async () => {
    await git(root, 'mv', 'top.txt', 'renamed.txt');
    const change = (await gitChanges(root)).changes.find(entry => entry.path === 'renamed.txt');
    expect(change?.status).toBe('R ');
    expect(change?.from).toBe('top.txt');
    // The hardened stats pass disables rename detection, then folds its delete
    // and add halves back onto this single status row.
    expect(change).toMatchObject({ additions: 1, deletions: 1 });
  });

  test('parses a rename inside a subdir cwd relative to that cwd', async () => {
    await git(root, 'mv', 'sub/kept.txt', 'sub/moved.txt');
    const view = await gitChanges(path.join(root, 'sub'));
    const change = view.changes.find(entry => entry.path === 'moved.txt');
    expect(change).toMatchObject({ status: 'R ', from: 'kept.txt' });
  });

  test('omits a rename source that sits outside the session cwd', async () => {
    await git(root, 'mv', 'other/sibling.txt', 'sub/arrived.txt');
    const view = await gitChanges(path.join(root, 'sub'));
    const change = view.changes.find(entry => entry.path === 'arrived.txt');
    expect(change?.status).toBe('R ');
    // The destination is in-cwd, but naming the out-of-cwd source would leak it.
    expect(change?.from).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('sibling');
  });

  test('handles a repo with no commits yet', async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), 'kteam-git-empty-'));
    try {
      await initRepo(fresh);
      await write(fresh, 'a.txt', 'a\n');
      await git(fresh, 'add', 'a.txt');

      const view = await gitChanges(fresh);
      expect(view.repo).toBe(true);
      expect(statusOf(view.changes, 'a.txt')).toBe('A ');
      expect(changeOf(view.changes, 'a.txt')).toMatchObject({ additions: 1, deletions: 0 });
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test('reports repo: false outside a git tree', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'kteam-git-plain-'));
    try {
      expect(await gitChanges(plain)).toEqual({ repo: false, changes: [] });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

// These exercise the diff SURFACE through readDiff, which is the only caller and
// the place containment is enforced. They were written against the former
// `gitDiffPath` (which handed git a pathname) and are kept as-is in substance:
// the properties are about diff semantics and hardening, and must survive the
// switch to snapshot formatting unchanged.
describe('readDiff (diff surface)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-diff-'));
    await initRepo(root);
    await write(root, 'tracked.txt', 'one\n');
    await write(root, 'sub/nested.txt', 'nested one\n');
    await write(root, 'other/secret-source.txt', 'SIBLING-CONTENT-LINE\n');
    await commitAll(root, 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('diffs an unstaged edit against HEAD', async () => {
    await write(root, 'tracked.txt', 'two\n');
    const result = await readDiff(root, 'tracked.txt');
    expect(result.kind).toBe('tracked');
    expect(result.diff).toContain('-one');
    expect(result.diff).toContain('+two');
  });

  test('includes staged changes in the same diff', async () => {
    await write(root, 'tracked.txt', 'staged\n');
    await git(root, 'add', 'tracked.txt');
    const staged = await readDiff(root, 'tracked.txt');
    expect(staged.diff).toContain('+staged');

    // Staged + a further unstaged edit still shows as one diff versus HEAD.
    await write(root, 'tracked.txt', 'staged then edited\n');
    const both = await readDiff(root, 'tracked.txt');
    expect(both.diff).toContain('+staged then edited');
    expect(both.diff).not.toContain('+staged\n');
  });

  test('diffs an untracked file against /dev/null', async () => {
    await write(root, 'brand-new.txt', 'hello new\n');
    const result = await readDiff(root, 'brand-new.txt');
    expect(result.kind).toBe('untracked');
    expect(result.diff).toContain('new file');
    expect(result.diff).toContain('+hello new');
  });

  test('diffs a deleted tracked file', async () => {
    await rm(path.join(root, 'tracked.txt'));
    const result = await readDiff(root, 'tracked.txt');
    expect(result.kind).toBe('tracked');
    expect(result.diff).toContain('deleted file');
    expect(result.diff).toContain('-one');
  });

  test('diffs a staged deletion after git rm removes it from the index', async () => {
    await git(root, 'rm', '-q', '--', 'tracked.txt');
    // `ls-files --error-unmatch` is false now; HEAD, not the current index, is
    // what proves this is one deleted file the Changes surface may open.
    expect(await gitIsTracked(root, 'tracked.txt')).toBe(false);
    const result = await readDiff(root, 'tracked.txt');
    expect(result.kind).toBe('tracked');
    expect(result.diff).toContain('deleted file');
    expect(result.diff).toContain('-one');
  });

  test('accepts a cwd-relative path from a subdirectory session', async () => {
    await write(root, 'sub/nested.txt', 'nested two\n');
    const result = await readDiff(path.join(root, 'sub'), 'nested.txt');
    expect(result.diff).toContain('+nested two');
  });

  test('pathspec magic cannot reach outside a subdir cwd', async () => {
    await write(root, 'tracked.txt', 'changed at the root\n');
    // `:(top)` would resolve to the repo root and leak a sibling diff to a
    // session confined to sub/. Two independent things stop it now: the path
    // walk refuses the name outright, and no pathspec derived from user input
    // ever reaches git in the first place.
    const result = await readDiff(path.join(root, 'sub'), ':(top)tracked.txt').catch(error => error);
    expect(JSON.stringify(result) ?? '').not.toContain('changed at the root');
    expect(String((result as Error).message ?? '')).not.toContain('changed at the root');
  });

  test('renames crossing into the cwd render as an add, not a sibling leak', async () => {
    await git(root, 'mv', 'other/secret-source.txt', 'sub/arrived.txt');
    const result = await readDiff(path.join(root, 'sub'), 'arrived.txt');
    expect(result.diff).toContain('new file');
    // Rename detection would otherwise print the sibling path in the header.
    expect(result.diff).not.toContain('other/secret-source.txt');
    expect(result.diff).not.toContain('rename from');
  });

  test('a checked-in external diff driver cannot execute through this endpoint', async () => {
    await write(root, '.gitattributes', 'tracked.txt diff=evil\n');
    await git(root, 'config', 'diff.evil.command', 'false');
    await git(root, 'config', 'diff.external', 'false');
    await write(root, 'tracked.txt', 'two\n');

    const result = await readDiff(root, 'tracked.txt');
    expect(result.diff).toContain('+two');
    expect(result.diff).not.toContain('external diff died');
  });

  test('diffs a staged first commit when there are no commits yet', async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), 'kteam-git-diff-empty-'));
    try {
      await initRepo(fresh);
      await write(fresh, 'a.txt', 'first\n');
      await git(fresh, 'add', 'a.txt');

      const result = await readDiff(fresh, 'a.txt');
      expect(result.kind).toBe('tracked');
      expect(result.diff).toContain('+first');
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test('renders a mode change with no content change', async () => {
    await chmod(path.join(root, 'tracked.txt'), 0o755);
    const result = await readDiff(root, 'tracked.txt');
    expect(result.diff).toContain('old mode 100644');
    expect(result.diff).toContain('new mode 100755');
  });

  test('renders a binary change without spilling bytes', async () => {
    await writeFile(path.join(root, 'bin.dat'), new Uint8Array([0, 1, 2, 0]));
    await commitAll(root, 'bin');
    await writeFile(path.join(root, 'bin.dat'), new Uint8Array([0, 9, 9, 0]));
    const result = await readDiff(root, 'bin.dat');
    expect(result.diff).toContain('Binary files a/bin.dat and b/bin.dat differ');
  });

  test('preserves a missing trailing newline', async () => {
    await write(root, 'tracked.txt', 'no trailing newline');
    const result = await readDiff(root, 'tracked.txt');
    expect(result.diff).toContain('\\ No newline at end of file');
  });

  test('reports truncation instead of a partial diff when a side is too large', async () => {
    // A partial read would render the missing tail as spurious deletions.
    await write(root, 'big.txt', 'x\n');
    await commitAll(root, 'big');
    await writeFile(path.join(root, 'big.txt'), 'y'.repeat(MAX_DIFF_SIDE_BYTES + 1));
    const result = await readDiff(root, 'big.txt');
    expect(result.truncated).toBe(true);
    expect(result.diff).toBe('');
  });
});

describe('gitDiffSnapshots', () => {
  const enc = (text: string) => new TextEncoder().encode(text);

  test('labels both sides with the requested path, whichever side is absent', async () => {
    const modified = await gitDiffSnapshots(
      'sub/file.txt',
      { bytes: enc('a\n'), mode: 0o100644 },
      { bytes: enc('b\n'), mode: 0o100644 },
    );
    expect(modified.diff).toContain('diff --git a/sub/file.txt b/sub/file.txt');
    expect(modified.diff).toContain('--- a/sub/file.txt');
    expect(modified.diff).toContain('+++ b/sub/file.txt');

    // git derives BOTH names from the surviving side for one-sided diffs, so
    // these would otherwise read `a/x a/x` and `b/x b/x`.
    const deleted = await gitDiffSnapshots('sub/file.txt', { bytes: enc('a\n'), mode: 0o100644 }, undefined);
    expect(deleted.diff).toContain('diff --git a/sub/file.txt b/sub/file.txt');
    expect(deleted.diff).toContain('deleted file mode 100644');

    const added = await gitDiffSnapshots('sub/file.txt', undefined, { bytes: enc('a\n'), mode: 0o100644 });
    expect(added.diff).toContain('diff --git a/sub/file.txt b/sub/file.txt');
    expect(added.diff).toContain('new file mode 100644');
  });

  test('content that mimics diff headers survives verbatim', async () => {
    // Only `diff --git` lines are rewritten, and a body line can never start at
    // column 0 with that text — every body line carries a ' ', '+', '-' or '\'.
    // Rewriting `---`/`+++` instead WOULD be forgeable: a body line `-- a/x`
    // renders as `--- a/x`.
    const forged = ['diff --git a/spoof b/spoof', '--- a/spoof', '+++ b/spoof', '@@ -1 +1 @@'].join('\n');
    const result = await gitDiffSnapshots(
      'real.txt',
      { bytes: enc('start\n'), mode: 0o100644 },
      { bytes: enc(`start\n${forged}\n`), mode: 0o100644 },
    );
    for (const line of forged.split('\n')) {
      expect(result.diff).toContain(`+${line}`);
    }
    // Exactly one real header, naming the real path.
    const headers = result.diff.split('\n').filter(line => line.startsWith('diff --git '));
    expect(headers).toEqual(['diff --git a/real.txt b/real.txt']);
  });

  test('a symlink side is rendered as a link and never followed', async () => {
    // The bytes ARE the link text. Staging it as a real symlink is what makes
    // git report mode 120000; it uses readlink and never opens the target, so a
    // target like /etc/passwd is named but never read.
    const result = await gitDiffSnapshots(
      'link',
      { bytes: enc('/etc/passwd'), mode: 0o120000 },
      { bytes: enc('now a regular file\n'), mode: 0o100644 },
    );
    expect(result.diff).toContain('120000');
    expect(result.diff).toContain('-/etc/passwd');
    expect(result.diff).not.toContain('root:');
  });

  test('identical sides produce no diff, and two absent sides produce nothing', async () => {
    const same = await gitDiffSnapshots(
      'a.txt',
      { bytes: enc('x\n'), mode: 0o100644 },
      { bytes: enc('x\n'), mode: 0o100644 },
    );
    expect(same.diff).toBe('');
    const neither = await gitDiffSnapshots('a.txt', undefined, undefined);
    expect(neither.diff).toBe('');
  });
});

describe('gitHeadEntry', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-head-entry-'));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('reports the recorded mode and bytes, and refuses a directory pathspec', async () => {
    await write(root, 'sub/file.txt', 'committed\n');
    await write(root, 'run.sh', '#!/bin/sh\n');
    await chmod(path.join(root, 'run.sh'), 0o755);
    await commitAll(root, 'init');

    const file = await gitHeadEntry(root, 'sub/file.txt', 1024);
    expect(new TextDecoder().decode(file?.bytes)).toBe('committed\n');
    expect(file?.mode).toBe(0o100644);
    expect((await gitHeadEntry(root, 'run.sh', 1024))?.mode).toBe(0o100755);

    // A pathspec naming a directory matches the entries beneath it; reporting
    // the first of them as "this path's HEAD content" would be a leak.
    expect(await gitHeadEntry(root, 'sub', 1024)).toBeUndefined();
    expect(await gitHeadEntry(root, 'absent.txt', 1024)).toBeUndefined();
  });

  test('flags a blob past the cap rather than returning a partial one', async () => {
    await write(root, 'big.txt', 'y'.repeat(4096));
    await commitAll(root, 'big');
    const entry = await gitHeadEntry(root, 'big.txt', 128);
    expect(entry?.truncated).toBe(true);
  });

  test('is undefined outside a repo and before the first commit', async () => {
    await write(root, 'a.txt', 'x\n');
    await git(root, 'add', 'a.txt');
    expect(await gitHeadEntry(root, 'a.txt', 1024)).toBeUndefined();

    const plain = await mkdtemp(path.join(tmpdir(), 'kteam-head-plain-'));
    try {
      await writeFile(path.join(plain, 'a.txt'), 'x\n');
      expect(await gitHeadEntry(plain, 'a.txt', 1024)).toBeUndefined();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('gitIgnoredPaths', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-ignore-'));
    await initRepo(root);
    await write(root, '.gitignore', 'secrets.yaml\nbuild/\n*.log\n');
    await write(root, 'kept.txt', 'kept\n');
    await commitAll(root, 'init');
    await write(root, 'secrets.yaml', 'password: hunter2\n');
    await write(root, 'build/out.js', 'built\n');
    await write(root, 'app.log', 'noise\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('classifies a batch in one call', async () => {
    const ignored = await gitIgnoredPaths(root, ['kept.txt', 'secrets.yaml', 'build/out.js', 'app.log', '.gitignore']);
    expect([...ignored].sort()).toEqual(['app.log', 'build/out.js', 'secrets.yaml']);
  });

  test('survives a filename that looks like pathspec magic', async () => {
    // A literal `:(top)x` file used to abort the whole batch with
    // "fatal: oops in prep_exclude", which would have failed the listing open.
    await write(root, ':(top)weird.log', 'noise\n');
    const ignored = await gitIgnoredPaths(root, [':(top)weird.log', 'kept.txt']);
    expect(ignored.has(':(top)weird.log')).toBe(true);
    expect(ignored.has('kept.txt')).toBe(false);
  });

  test('is vacuous outside a git tree and for an empty batch', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'kteam-git-ignore-plain-'));
    try {
      expect((await gitIgnoredPaths(plain, ['anything.log'])).size).toBe(0);
      expect((await gitIgnoredPaths(root, [])).size).toBe(0);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('gitIsTracked and gitReadHeadBlob', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-head-'));
    await initRepo(root);
    await write(root, 'doc.md', 'version one\n');
    await write(root, 'sub/nested.md', 'nested one\n');
    await commitAll(root, 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('distinguishes tracked from untracked', async () => {
    await write(root, 'fresh.txt', 'fresh\n');
    expect(await gitIsTracked(root, 'doc.md')).toBe(true);
    expect(await gitIsTracked(root, 'fresh.txt')).toBe(false);
    expect(await gitIsTracked(path.join(root, 'sub'), 'nested.md')).toBe(true);
  });

  test('reads the committed bytes, relative to the session cwd', async () => {
    await write(root, 'doc.md', 'version two\n');
    const blob = await gitReadHeadBlob(root, 'doc.md', 1024);
    expect(new TextDecoder().decode(blob!.bytes!)).toBe('version one\n');
    expect(blob!.size).toBe(12);

    const nested = await gitReadHeadBlob(path.join(root, 'sub'), 'nested.md', 1024);
    expect(new TextDecoder().decode(nested!.bytes!)).toBe('nested one\n');
  });

  test('reports size without bytes past the cap, and undefined for non-blobs', async () => {
    const capped = await gitReadHeadBlob(root, 'doc.md', 4);
    expect(capped).toMatchObject({ size: 12 });
    expect(capped?.bytes).toBeUndefined();

    expect(await gitReadHeadBlob(root, 'sub', 1024)).toBeUndefined(); // a tree
    expect(await gitReadHeadBlob(root, 'missing.md', 1024)).toBeUndefined();
  });
});

describe('fs wrappers over git', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-fs-git-'));
    await initRepo(root);
    await write(root, '.gitignore', 'app.log\n');
    await write(root, 'tracked.txt', 'one\n');
    await commitAll(root, 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('readChanges surfaces the git view for a live cwd', async () => {
    await write(root, 'tracked.txt', 'two\n');
    const view = await readChanges(root);
    expect(view.repo).toBe(true);
    expect(statusOf(view.changes, 'tracked.txt')).toBe(' M');
  });

  test('readDiff refuses a diff of gitignored or denylisted content', async () => {
    await write(root, 'app.log', 'noise\n');
    await write(root, '.env', 'TOKEN=abc\n');

    const ignored = await readDiff(root, 'app.log');
    expect(ignored).toMatchObject({ ignored: true, reason: 'ignored', diff: '' });
    expect(ignored.denied).toBeUndefined();

    const denied = await readDiff(root, '.env');
    expect(denied).toMatchObject({ denied: true, reason: 'denylist', diff: '' });
    expect(denied.diff).not.toContain('TOKEN');
  });

  test('readDiff rejects a path outside the root before running git', async () => {
    await expect(readDiff(root, '../elsewhere.txt')).rejects.toThrow(/relative|\.\./i);
  });

  test('readDiff still diffs a DELETED tracked file, which no longer exists', async () => {
    // The Changes list shows a " D" row for this; requiring realpath to succeed
    // would 404 every deletion.
    await rm(path.join(root, 'tracked.txt'));
    const result = await readDiff(root, 'tracked.txt');
    expect(result.kind).toBe('tracked');
    expect(result.diff).toContain('deleted file');
    expect(result.diff).toContain('-one');
  });

  test('readDiff 404s a missing path that git does not track', async () => {
    await expect(readDiff(root, 'never-existed.txt')).rejects.toThrow(/no such path/i);
    await expect(readDiff(root, 'nope/deeper.txt')).rejects.toThrow(/no such path/i);
  });

  test('readDiff 404s a DELETED DIRECTORY rather than treating it as one file', async () => {
    // `ls-files --error-unmatch -- sub` exits 0 for a deleted directory: the
    // pathspec expands to every record beneath it. Exit code alone would admit
    // `sub` as a deleted file and diff the whole subtree under one path.
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await write(root, 'sub/a.txt', 'one\n');
    await write(root, 'sub/b.txt', 'two\n');
    await commitAll(root, 'add subdir');
    await rm(path.join(root, 'sub'), { recursive: true, force: true });

    expect(await gitIsTracked(root, 'sub')).toBe(false);
    expect(await gitIsTracked(root, 'sub/a.txt')).toBe(true);
    await expect(readDiff(root, 'sub')).rejects.toThrow(/no such path/i);
    // The individual deleted file still diffs.
    expect((await readDiff(root, 'sub/a.txt')).diff).toContain('deleted file');
  });

  test('readDiff refuses a directory and a symlink', async () => {
    await mkdir(path.join(root, 'adir'), { recursive: true });
    await expect(readDiff(root, 'adir')).rejects.toThrow(/not a regular file/i);

    await symlink(path.join(root, 'tracked.txt'), path.join(root, 'alias.txt'));
    await expect(readDiff(root, 'alias.txt')).rejects.toThrow(/symlink/i);
  });
});

describe('runGit output cap', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-cap-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('keeps at most maxOutputBytes and flags the truncation', async () => {
    // `cat` of a large file through the same capped reader: the cap must hold
    // regardless of how the bytes arrive, and the child must still exit 0
    // rather than dying on EPIPE.
    const big = path.join(root, 'big.txt');
    await writeFile(big, 'x'.repeat(512 * 1024));
    const child = Bun.spawn(['cat', big, big, big, big], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [code, bytes] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()]);
    expect(code).toBe(0);
    expect(bytes.byteLength).toBe(2 * 1024 * 1024); // the uncapped baseline

    const result = await runGit(['hash-object', '-t', 'blob', '--stdin'], {
      cwd: root,
      stdin: new TextEncoder().encode('x'.repeat(4096)),
      maxOutputBytes: 8,
    });
    expect(result.stdout.byteLength).toBe(8);
    expect(result.truncated).toBe(true);
  });

  test('reports the CHANGES list as truncated at the cap, with no malformed row', async () => {
    // The Changes list is the viewer's primary surface, so its cap needs the same
    // honesty as the diff's: a list silently cut at 1 MiB reads as "this is
    // everything the agent changed", which is exactly the wrong thing to believe
    // in a review UI. Deep, long path segments make each status record ~3 KB, so
    // the cap is reached with a few hundred files rather than a few hundred
    // thousand inodes.
    await initRepo(root);
    const segment = 'd'.repeat(200);
    const deep = Array.from({ length: 14 }, () => segment).join('/');
    await mkdir(path.join(root, deep), { recursive: true });
    const expected = new Set<string>();
    for (let index = 0; index < 400; index += 1) {
      const rel = `${deep}/${String(index).padStart(4, '0')}-${'n'.repeat(200)}.txt`;
      expected.add(rel);
      await writeFile(path.join(root, rel), 'x\n');
    }

    const view = await gitChanges(root);
    expect(view.truncated).toBe(true);
    expect(view.repo).toBe(true);
    expect(view.changes.length).toBeGreaterThan(0);
    // Parsing must survive the cut: the byte cap can land mid-record, and a
    // half-parsed row would surface as a bogus status code or an empty path.
    for (const change of view.changes) {
      expect(change.status).toHaveLength(2);
      expect(change.path.length).toBeGreaterThan(0);
      // A nonempty partial pathname still looks superficially well-formed.
      // Membership in the complete fixture set is what proves the capped tail
      // was dropped rather than exposed as a made-up change.
      expect(expected.has(change.path)).toBe(true);
    }
    // The wrapper propagates the flag rather than swallowing it.
    expect((await readChanges(root)).truncated).toBe(true);
  }, 30_000);

  test('reports a real diff as truncated once it exceeds the cap', async () => {
    await initRepo(root);
    await write(root, 'seed.txt', 'seed\n');
    await commitAll(root, 'init');
    await write(root, 'seed.txt', `${'line of text\n'.repeat(4000)}`);

    const result = await readDiff(root, 'seed.txt');
    expect(result.truncated).toBeUndefined(); // ~50 KB, well under 1 MiB

    const capped = await runGit(['diff', 'HEAD', '--no-ext-diff', '--no-color', '--', 'seed.txt'], {
      cwd: root,
      maxOutputBytes: 512,
    });
    expect(capped.stdout.byteLength).toBe(512);
    expect(capped.truncated).toBe(true);
    // The reader drains past the cap instead of cancelling, so git finishes
    // normally rather than dying on EPIPE — a truncated read stays
    // distinguishable from a crashed one.
    expect(capped.code).toBe(0);
    expect(capped.timedOut).toBe(false);
  });
});

describe('sanitized git environment', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-git-env-'));
    await initRepo(root);
    await write(root, 'file.txt', 'one\n');
    await commitAll(root, 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('pins LC_ALL/LANG=C so the output parsers stay on English git', async () => {
    const { stdout } = await runGit(['var', 'GIT_EDITOR'], { cwd: root }).then(result => ({
      stdout: new TextDecoder().decode(result.stdout),
    }));
    expect(stdout).toBeString(); // git ran at all

    const env = await runGit(['config', '--get', 'core.pager'], { cwd: root });
    expect(env.code).toBe(0);

    // The observable consequence: a translated locale in the parent must not
    // reach the child. `git status` headers are what parseBranchHeader reads.
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = 'de_DE.UTF-8';
    try {
      const view = await gitChanges(root);
      expect(view.branch).toBeString();
      expect(view.repo).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });

  test('drops inherited GIT_* controls that would redirect the read', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'kteam-git-other-'));
    try {
      await initRepo(elsewhere);
      await write(elsewhere, 'sibling-secret.txt', 'do not surface\n');
      await commitAll(elsewhere, 'other repo');

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(elsewhere, '.git');
      try {
        // With GIT_DIR honoured, this would report the OTHER repo's toplevel.
        const info = await gitRepoInfo(root);
        expect(info.repo).toBe(true);
        expect(await realpath(info.root!)).toBe(await realpath(root));

        const view = await gitChanges(root);
        expect(JSON.stringify(view)).not.toContain('sibling-secret');
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
