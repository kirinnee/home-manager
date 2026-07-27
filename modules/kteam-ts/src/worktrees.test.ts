import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from './git';
import {
  GitCheckoutCache,
  WorktreeOperationQueue,
  WorktreeError,
  checkManagedWorktreeRemoval,
  createManagedWorktree,
  defaultManagedWorktreeRoot,
  inspectGitCheckout,
  parseWorktreeList,
  removeManagedWorktree,
  type GitCheckoutSnapshot,
  type ManagedWorktree,
} from './worktrees';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, { cwd, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return new TextDecoder().decode(result.stdout).trim();
}

interface ScratchRepository {
  root: string;
  repo: string;
  managedRoot: string;
  branch: string;
}

async function scratchRepository(prefix: string): Promise<ScratchRepository> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  const managedRoot = path.join(root, 'managed');
  await mkdir(repo);
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'kteam@example.test');
  await git(repo, 'config', 'user.name', 'kteam test');
  await writeFile(path.join(repo, 'README.md'), 'base\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-q', '-m', 'initial');
  await git(repo, 'branch', '-M', 'main');
  return { root, repo, managedRoot, branch: 'main' };
}

describe('worktree porcelain parser', () => {
  test('preserves spaces/newlines in paths and reads flags/reasons', () => {
    const raw = [
      'worktree /repo with space',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo\nlinked',
      'HEAD def456',
      'detached',
      'locked maintenance window',
      '',
    ]
      .join('\0')
      .concat('\0');
    expect(parseWorktreeList(raw)).toEqual([
      {
        path: '/repo with space',
        head: 'abc123',
        branch: 'main',
        detached: false,
        bare: false,
        locked: undefined,
        prunable: undefined,
      },
      {
        path: '/repo\nlinked',
        head: 'def456',
        branch: undefined,
        detached: true,
        bare: false,
        locked: 'maintenance window',
        prunable: undefined,
      },
    ]);
  });
});

describe('managed worktree location', () => {
  test('uses a sibling of the private kteam home on Linux and macOS-shaped paths', () => {
    expect(defaultManagedWorktreeRoot('/home/kirin/.kteam')).toBe('/home/kirin/.kteam-worktrees');
    expect(defaultManagedWorktreeRoot('/Users/kirin/.kteam')).toBe('/Users/kirin/.kteam-worktrees');
    expect(defaultManagedWorktreeRoot('/srv/custom-kteam')).toBe('/srv/custom-kteam-worktrees');
  });

  test('never nests the managed root inside the private daemon home', () => {
    const daemonHome = '/home/kirin/.kteam';
    const managed = defaultManagedWorktreeRoot(daemonHome);
    expect(path.relative(daemonHome, managed).startsWith('..')).toBe(true);
  });
});

describe('Git checkout inspection', () => {
  let scratch: ScratchRepository;

  beforeEach(async () => {
    scratch = await scratchRepository('kteam-worktree-inspect-');
  });

  afterEach(async () => {
    await rm(scratch.root, { recursive: true, force: true });
  });

  test('distinguishes non-Git, main checkout, linked worktree, and missing cwd', async () => {
    const plain = path.join(scratch.root, 'plain');
    await mkdir(plain);
    expect(await inspectGitCheckout(plain)).toMatchObject({ repo: false, kind: 'not_git' });
    expect(await inspectGitCheckout(path.join(scratch.root, 'absent'))).toMatchObject({ repo: false, kind: 'missing' });

    const main = await inspectGitCheckout(scratch.repo);
    expect(main).toMatchObject({
      repo: true,
      kind: 'main_checkout',
      repositoryRoot: scratch.repo,
      worktreeRoot: scratch.repo,
      branch: 'main',
      detached: false,
    });

    const linked = path.join(scratch.root, 'manual linked');
    await git(scratch.repo, 'worktree', 'add', '-q', '-b', 'manual', linked, 'HEAD');
    expect(await inspectGitCheckout(path.join(linked))).toMatchObject({
      repo: true,
      kind: 'linked_worktree',
      repositoryRoot: scratch.repo,
      worktreeRoot: linked,
      branch: 'manual',
      detached: false,
    });
  });
});

describe('managed worktree creation', () => {
  let scratch: ScratchRepository;

  beforeEach(async () => {
    scratch = await scratchRepository('kteam-worktree-create-');
  });

  afterEach(async () => {
    await rm(scratch.root, { recursive: true, force: true });
  });

  test('creates a new branch under the managed root and leaves the source checkout alone', async () => {
    const created = await createManagedWorktree({
      sourceCwd: scratch.repo,
      branch: 'feature/isolated-agent',
      sessionId: 'session-1',
      managedRoot: scratch.managedRoot,
    });
    expect(created.checkout).toMatchObject({
      repo: true,
      kind: 'linked_worktree',
      repositoryRoot: scratch.repo,
      branch: 'feature/isolated-agent',
    });
    expect(created.managed).toMatchObject({
      version: 1,
      branch: 'feature/isolated-agent',
      branchPreexisted: false,
    });
    expect(created.cwd).toBe(created.managed.path);
    expect(path.relative(scratch.managedRoot, created.managed.path).startsWith('..')).toBe(false);
    expect(await readFile(path.join(created.managed.path, 'README.md'), 'utf8')).toBe('base\n');
    expect(await git(scratch.repo, 'branch', '--show-current')).toBe('main');
  });

  test('persists an exact pre-mutation plan and preserves a cwd below the repository root', async () => {
    await mkdir(path.join(scratch.repo, 'packages', 'app'), { recursive: true });
    await writeFile(path.join(scratch.repo, 'packages', 'app', 'app.ts'), 'export {};\n');
    await git(scratch.repo, 'add', 'packages/app/app.ts');
    await git(scratch.repo, 'commit', '-q', '-m', 'add package');
    let plannedPath = '';
    const created = await createManagedWorktree({
      sourceCwd: path.join(scratch.repo, 'packages', 'app'),
      branch: 'feature/subdirectory',
      sessionId: 'session-subdir',
      managedRoot: scratch.managedRoot,
      onPlanned: async plan => {
        plannedPath = plan.path;
        expect(plan.sessionCwd).toBe(path.join(plan.path, 'packages', 'app'));
        expect(await lstatResult(plan.path)).toBe(false);
      },
    });
    expect(created.managed.path).toBe(plannedPath);
    expect(created.cwd).toBe(path.join(created.managed.path, 'packages', 'app'));
    expect(await readFile(path.join(created.cwd, 'app.ts'), 'utf8')).toBe('export {};\n');
  });

  test('checks out an existing unoccupied local branch', async () => {
    await git(scratch.repo, 'branch', 'prepared', 'HEAD');
    const created = await createManagedWorktree({
      sourceCwd: scratch.repo,
      branch: 'prepared',
      sessionId: 'session-2',
      managedRoot: scratch.managedRoot,
    });
    expect(created.checkout.branch).toBe('prepared');
    expect(created.managed.branchPreexisted).toBe(true);
  });

  test('refuses to share a branch and names the conflicting checkout', async () => {
    const first = await createManagedWorktree({
      sourceCwd: scratch.repo,
      branch: 'feature/owned',
      sessionId: 'session-3',
      managedRoot: scratch.managedRoot,
    });
    const error = await createManagedWorktree({
      sourceCwd: scratch.repo,
      branch: 'feature/owned',
      sessionId: 'session-4',
      managedRoot: scratch.managedRoot,
    }).catch(value => value);
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).code).toBe('branch_in_use');
    expect((error as Error).message).toContain(first.managed.path);
    expect((error as Error).message).toContain('refuses to share');
  });

  test('rejects reflog shorthand instead of silently creating a differently named branch', async () => {
    const error = await createManagedWorktree({
      sourceCwd: scratch.repo,
      branch: '@{-1}',
      sessionId: 'session-5',
      managedRoot: scratch.managedRoot,
    }).catch(value => value);
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).code).toBe('invalid_branch');
  });
});

describe('managed worktree removal', () => {
  let scratch: ScratchRepository;
  let remote: string;
  let managed: ManagedWorktree;

  beforeEach(async () => {
    scratch = await scratchRepository('kteam-worktree-remove-');
    remote = path.join(scratch.root, 'remote.git');
    await git(scratch.root, 'init', '--bare', '-q', remote);
    await git(scratch.repo, 'remote', 'add', 'origin', remote);
    await git(scratch.repo, 'push', '-q', '-u', 'origin', 'main');
    managed = (
      await createManagedWorktree({
        sourceCwd: scratch.repo,
        branch: 'feature/cleanup',
        sessionId: 'session-cleanup',
        managedRoot: scratch.managedRoot,
      })
    ).managed;
  });

  afterEach(async () => {
    await rm(scratch.root, { recursive: true, force: true });
  });

  const check = (sessionActive = false) =>
    checkManagedWorktreeRemoval({ managed, managedRoot: scratch.managedRoot, sessionActive });

  test('refuses an active owning session', async () => {
    const result = await check(true);
    expect(result.removable).toBe(false);
    expect(result.blockers.map(blocker => blocker.code)).toContain('active_session');
  });

  test('refuses staged, unstaged, and untracked state', async () => {
    await writeFile(path.join(managed.path, 'untracked.txt'), 'mine\n');
    let result = await check();
    expect(result.blockers.map(blocker => blocker.code)).toContain('dirty_worktree');

    await rm(path.join(managed.path, 'untracked.txt'));
    await writeFile(path.join(managed.path, 'README.md'), 'changed\n');
    await git(managed.path, 'add', 'README.md');
    result = await check();
    expect(result.blockers.map(blocker => blocker.code)).toContain('dirty_worktree');
  });

  test('refuses ignored content that git worktree remove would otherwise delete silently', async () => {
    await writeFile(path.join(managed.path, '.gitignore'), 'private.env\n');
    await git(managed.path, 'add', '.gitignore');
    await git(managed.path, 'commit', '-q', '-m', 'ignore local secret');
    await git(managed.path, 'push', '-q', '-u', 'origin', 'feature/cleanup');
    await writeFile(path.join(managed.path, 'private.env'), 'do-not-delete\n');

    const result = await check();
    expect(result.removable).toBe(false);
    expect(result.blockers.map(blocker => blocker.code)).toContain('dirty_worktree');
  });

  test('refuses another retained session, a live web terminal, or a Git lock', async () => {
    let result = await checkManagedWorktreeRemoval({
      managed,
      managedRoot: scratch.managedRoot,
      sessionActive: false,
      otherSessions: [{ id: 'other-session', cwd: path.join(managed.path, 'subdir') }],
      liveWebTerminals: 1,
    });
    expect(result.blockers.map(blocker => blocker.code)).toContain('other_session');
    expect(result.blockers.map(blocker => blocker.code)).toContain('live_terminal');

    await git(scratch.repo, 'worktree', 'lock', '--reason', 'operator hold', managed.path);
    result = await check();
    expect(result.blockers.map(blocker => blocker.code)).toContain('locked_worktree');
  });

  test('refuses a clean commit not contained by any remote-tracking ref', async () => {
    await writeFile(path.join(managed.path, 'agent.txt'), 'work\n');
    await git(managed.path, 'add', 'agent.txt');
    await git(managed.path, 'commit', '-q', '-m', 'agent work');
    const result = await check();
    expect(result.removable).toBe(false);
    expect(result.blockers.map(blocker => blocker.code)).toContain('unpushed_commits');
  });

  test('removes only after work is clean and pushed, while retaining the branch', async () => {
    await writeFile(path.join(managed.path, 'agent.txt'), 'work\n');
    await git(managed.path, 'add', 'agent.txt');
    await git(managed.path, 'commit', '-q', '-m', 'agent work');
    await git(managed.path, 'push', '-q', '-u', 'origin', 'feature/cleanup');
    const ready = await check();
    expect(ready).toMatchObject({ removable: true, branch: 'feature/cleanup' });

    const removed = await removeManagedWorktree({
      managed,
      managedRoot: scratch.managedRoot,
      sessionActive: false,
    });
    expect(removed).toMatchObject({ branch: 'feature/cleanup', branchRetained: true });
    expect(await git(scratch.repo, 'rev-parse', 'refs/heads/feature/cleanup')).toBe(ready.head!);
    expect(await lstatResult(managed.path)).toBe(false);
  });

  test('refuses branch switching even when both branches point at a pushed commit', async () => {
    await git(managed.path, 'switch', '--detach', 'HEAD');
    const result = await check();
    expect(result.blockers.map(blocker => blocker.code)).toContain('branch_mismatch');
  });
});

async function lstatResult(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => undefined)) !== undefined;
}

describe('GitCheckoutCache', () => {
  const snapshot = (cwd: string, observedAt: string): GitCheckoutSnapshot => ({
    repo: true,
    kind: 'main_checkout',
    worktreeRoot: cwd,
    repositoryRoot: cwd,
    branch: 'main',
    detached: false,
    observedAt,
  });

  test('coalesces refreshes, expires by TTL, and invalidates explicitly', async () => {
    let clock = 1_000;
    let calls = 0;
    const cache = new GitCheckoutCache({
      ttlMs: 100,
      now: () => clock,
      inspect: async cwd => {
        calls += 1;
        await Bun.sleep(1);
        return snapshot(cwd, `call-${calls}`);
      },
    });
    const cwd = '/tmp/cache-checkout';
    const [first, same] = await Promise.all([cache.get(cwd), cache.get(cwd)]);
    expect(calls).toBe(1);
    expect(same).toEqual(first);
    expect(cache.peek(cwd)).toEqual(first);

    clock += 99;
    expect(await cache.get(cwd)).toEqual(first);
    expect(calls).toBe(1);
    clock += 2;
    expect((await cache.get(cwd)).observedAt).toBe('call-2');
    expect(calls).toBe(2);

    cache.invalidate(cwd);
    expect(cache.peek(cwd)).toBeUndefined();
    await cache.get(cwd);
    expect(calls).toBe(3);
  });

  test('peek and prime never inspect', () => {
    let calls = 0;
    const cache = new GitCheckoutCache({
      inspect: async cwd => {
        calls += 1;
        return snapshot(cwd, 'inspected');
      },
    });
    const seeded = snapshot('/tmp/seeded', 'persisted');
    cache.prime('/tmp/seeded', seeded);
    expect(cache.peek('/tmp/seeded')).toEqual(seeded);
    expect(cache.peek('/tmp/not-seeded')).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe('WorktreeOperationQueue', () => {
  test('serializes one repository while allowing different repositories to proceed', async () => {
    const queue = new WorktreeOperationQueue();
    const events: string[] = [];
    let releaseFirst = () => {};
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = queue.run('/repo/.git', async () => {
      events.push('first-start');
      await gate;
      events.push('first-end');
    });
    const second = queue.run('/repo/.git', async () => {
      events.push('second');
    });
    const other = queue.run('/other/.git', async () => {
      events.push('other');
    });
    await other;
    expect(events).toEqual(['first-start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'other', 'first-end', 'second']);
  });
});
