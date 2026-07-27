/**
 * First-class Git worktree discovery and lifecycle primitives.
 *
 * This module deliberately has no dependency on SessionManager.  A session
 * stores the returned checkout snapshot/managed-worktree record, while the
 * manager decides when to refresh it and whether a session is terminal.  That
 * separation keeps the safety gates testable in a temporary repository and
 * lets list rendering use cached metadata without spawning 1,700 `git`
 * processes.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit, type GitResult } from './git';

export type GitCheckoutKind = 'main_checkout' | 'linked_worktree' | 'not_git' | 'missing';

/** A point-in-time, display-safe description of a session cwd. */
export interface GitCheckoutSnapshot {
  repo: boolean;
  kind: GitCheckoutKind;
  /** Root of the checkout containing the session cwd. */
  worktreeRoot?: string;
  /** Primary checkout for the repository (the first `git worktree list` entry). */
  repositoryRoot?: string;
  /** Git's per-checkout directory. Useful for cache identity, not required by UI. */
  gitDir?: string;
  /** Shared Git directory identifying the repository across all worktrees. */
  commonDir?: string;
  /** Short local branch, absent only for detached HEAD. */
  branch?: string;
  detached?: boolean;
  head?: string;
  /** Git worktree registry state; cleanup refuses a locked checkout. */
  locked?: string;
  prunable?: string;
  observedAt: string;
}

/** Durable ownership record written only for a worktree kteam created. */
export interface ManagedWorktree {
  version: 1;
  path: string;
  branch: string;
  repositoryRoot: string;
  commonDir: string;
  createdAt: string;
  /** HEAD immediately after creation; useful evidence when auditing cleanup. */
  initialHead: string;
  /** Whether the local branch predated this worktree. kteam never deletes it. */
  branchPreexisted: boolean;
  /** Set after explicit guarded removal; the ownership record stays auditable. */
  removedAt?: string;
}

export interface WorktreeListEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
}

export type WorktreeErrorCode =
  | 'not_git_repository'
  | 'invalid_branch'
  | 'branch_in_use'
  | 'ambiguous_remote_branch'
  | 'destination_exists'
  | 'git_failed'
  | 'unsafe_remove';

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    readonly blockers: WorktreeRemovalBlocker[] = [],
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function gitFailure(action: string, result: GitResult): WorktreeError {
  const detail = result.stderr.trim() || `exit ${result.code}`;
  return new WorktreeError('git_failed', `${action} failed: ${detail}`);
}

async function gitText(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ result: GitResult; stdout: string }> {
  const result = await runGit(args, { cwd, ...options });
  if (result.timedOut) throw new WorktreeError('git_failed', `git ${args[0] ?? ''} timed out`);
  return { result, stdout: decode(result.stdout) };
}

/** Parse `git worktree list --porcelain -z` without path/whitespace ambiguity. */
export function parseWorktreeList(raw: string): WorktreeListEntry[] {
  return raw
    .split('\0\0')
    .filter(Boolean)
    .flatMap(record => {
      const fields = new Map<string, string>();
      const flags = new Set<string>();
      for (const field of record.split('\0').filter(Boolean)) {
        const separator = field.indexOf(' ');
        if (separator < 0) flags.add(field);
        else fields.set(field.slice(0, separator), field.slice(separator + 1));
      }
      const worktreePath = fields.get('worktree');
      if (!worktreePath) return [];
      const branchRef = fields.get('branch');
      return [
        {
          path: worktreePath,
          head: fields.get('HEAD'),
          branch: branchRef?.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : branchRef,
          detached: flags.has('detached'),
          bare: flags.has('bare'),
          locked: fields.get('locked') ?? (flags.has('locked') ? '' : undefined),
          prunable: fields.get('prunable') ?? (flags.has('prunable') ? '' : undefined),
        },
      ];
    });
}

async function worktreeList(cwd: string): Promise<WorktreeListEntry[]> {
  const { result, stdout } = await gitText(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (result.code !== 0) throw gitFailure('git worktree list', result);
  if (result.truncated) throw new WorktreeError('git_failed', 'git worktree list exceeded the output limit');
  return parseWorktreeList(stdout);
}

async function canonical(pathname: string): Promise<string> {
  return await realpath(pathname).catch(() => path.resolve(pathname));
}

async function checkoutRecord(records: WorktreeListEntry[], root: string): Promise<WorktreeListEntry | undefined> {
  const wanted = await canonical(root);
  for (const record of records) {
    if ((await canonical(record.path)) === wanted) return record;
  }
  return undefined;
}

/**
 * Inspect once, then cache the result.  The caller must not invoke this from a
 * fleet list render; see GitCheckoutCache below.
 */
export async function inspectGitCheckout(cwd: string): Promise<GitCheckoutSnapshot> {
  const observedAt = new Date().toISOString();
  const canonicalCwd = await realpath(cwd).catch(() => undefined);
  if (!canonicalCwd) return { repo: false, kind: 'missing', observedAt };

  const info = await gitText(canonicalCwd, [
    'rev-parse',
    '--is-inside-work-tree',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ]);
  if (info.result.code !== 0 || info.stdout.split('\n')[0]?.trim() !== 'true') {
    return { repo: false, kind: 'not_git', observedAt };
  }
  const lines = info.stdout.split('\n');
  const worktreeRoot = await canonical(lines[1]?.trim() || canonicalCwd);
  const gitDir = await canonical(path.resolve(canonicalCwd, lines[2]?.trim() || '.git'));
  const commonDir = await canonical(path.resolve(canonicalCwd, lines[3]?.trim() || lines[2]?.trim() || '.git'));
  const records = await worktreeList(canonicalCwd);
  const current = await checkoutRecord(records, worktreeRoot);
  const main = records[0];
  return {
    repo: true,
    kind: gitDir === commonDir ? 'main_checkout' : 'linked_worktree',
    worktreeRoot,
    repositoryRoot: main ? await canonical(main.path) : worktreeRoot,
    gitDir,
    commonDir,
    branch: current?.branch,
    detached: current?.detached === true || current?.branch === undefined,
    head: current?.head,
    locked: current?.locked,
    prunable: current?.prunable,
    observedAt,
  };
}

interface CacheEntry {
  value?: GitCheckoutSnapshot;
  expiresAt: number;
  pending?: Promise<GitCheckoutSnapshot>;
}

export interface GitCheckoutCacheOptions {
  /** Refresh cadence for callers that explicitly call get(). */
  ttlMs?: number;
  maxEntries?: number;
  inspect?: (cwd: string) => Promise<GitCheckoutSnapshot>;
  now?: () => number;
}

/**
 * Bounded daemon cache. `peek()` never performs I/O and is the fleet-list API;
 * `get()` is for session creation, an active-session monitor tick, a detail
 * refresh, or a kteam worktree mutation. Concurrent refreshes coalesce.
 */
export class GitCheckoutCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly inspector: (cwd: string) => Promise<GitCheckoutSnapshot>;
  private readonly clock: () => number;

  constructor(options: GitCheckoutCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 4_096;
    this.inspector = options.inspect ?? inspectGitCheckout;
    this.clock = options.now ?? Date.now;
  }

  peek(cwd: string): GitCheckoutSnapshot | undefined {
    return this.entries.get(path.resolve(cwd))?.value;
  }

  prime(cwd: string, value: GitCheckoutSnapshot): void {
    const key = path.resolve(cwd);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    this.trim();
  }

  invalidate(cwd: string): void {
    this.entries.delete(path.resolve(cwd));
  }

  async get(cwd: string, refresh = false): Promise<GitCheckoutSnapshot> {
    const key = path.resolve(cwd);
    const existing = this.entries.get(key);
    if (!refresh && existing?.value && existing.expiresAt > this.clock()) return existing.value;
    if (existing?.pending) return await existing.pending;

    const pending = this.inspector(cwd).then(
      value => {
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
        this.trim();
        return value;
      },
      error => {
        this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, { value: existing?.value, expiresAt: existing?.expiresAt ?? 0, pending });
    return await pending;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

function stableHash(value: string, length = 10): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function pathSlug(value: string, maxLength: number): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return slug || 'repo';
}

async function validateBranch(cwd: string, requested: string): Promise<string> {
  const branch = requested.trim();
  if (!branch || branch.startsWith('-') || branch.includes('\0')) {
    throw new WorktreeError('invalid_branch', `invalid worktree branch ${JSON.stringify(requested)}`);
  }
  const checked = await gitText(cwd, ['check-ref-format', '--branch', branch]);
  const normalized = checked.stdout.trim();
  // Reject reflog shorthand such as @{-1}: check-ref-format expands it, which
  // would make a command create a different branch than the UI claims.
  if (checked.result.code !== 0 || normalized !== branch) {
    throw new WorktreeError('invalid_branch', `invalid or non-literal worktree branch ${JSON.stringify(requested)}`);
  }
  return branch;
}

async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  const checked = await gitText(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return checked.result.code === 0;
}

async function remoteBranchCandidates(cwd: string, branch: string): Promise<string[]> {
  const refs = await gitText(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
  if (refs.result.code !== 0) throw gitFailure('git for-each-ref', refs.result);
  return refs.stdout
    .split('\n')
    .map(ref => ref.trim())
    .filter(Boolean)
    .filter(ref => {
      const withoutPrefix = ref.replace(/^refs\/remotes\/[^/]+\//, '');
      return withoutPrefix === branch && !ref.endsWith('/HEAD');
    });
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const resolved = await gitText(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const oid = resolved.stdout.trim();
  if (resolved.result.code !== 0 || !/^[0-9a-fA-F]{40,64}$/.test(oid)) {
    throw new WorktreeError('git_failed', `worktree base ${JSON.stringify(ref)} does not resolve to a commit`);
  }
  return oid;
}

function branchConflict(branch: string, entries: WorktreeListEntry[]): WorktreeListEntry | undefined {
  return entries.find(entry => entry.branch === branch);
}

function conflictError(branch: string, conflict: WorktreeListEntry): WorktreeError {
  const stale = conflict.prunable !== undefined ? ' (registered as prunable; prune it explicitly first)' : '';
  return new WorktreeError(
    'branch_in_use',
    `branch ${JSON.stringify(branch)} is already checked out at ${conflict.path}${stale}; ` +
      'kteam refuses to share a worktree between sessions',
  );
}

export interface CreateManagedWorktreeInput {
  /** Existing checkout selected by `--cwd`; also supplies the default HEAD base. */
  sourceCwd: string;
  branch: string;
  sessionId: string;
  /** Normally the sibling returned by defaultManagedWorktreeRoot(). */
  managedRoot: string;
  /** Optional explicit commit-ish for a new local branch. */
  startPoint?: string;
  /** Called after the exact destination is known but before Git mutates it. */
  onPlanned?: (plan: ManagedWorktreePlan) => Promise<void>;
  /** Keep comfortably below the start client's whole-request deadline. */
  timeoutMs?: number;
}

/**
 * Keep agent-writable trees OUTSIDE kteam's private home (tokens, transcripts,
 * daemon state). For the normal `~/.kteam` home this is `~/.kteam-worktrees`;
 * a custom `/srv/kteam-state` gets `/srv/kteam-state-worktrees` beside it.
 *
 * The sibling layout also stays outside EventStore's session-directory scan,
 * so it needs no reserved-name exception. The root remains configurable for a
 * user who prefers (for example) `~/Workspace/.kteam-worktrees`.
 */
export function defaultManagedWorktreeRoot(kteamHome: string): string {
  const home = path.resolve(kteamHome);
  const name = path.basename(home);
  if (!name) throw new WorktreeError('destination_exists', 'kteam home cannot be a filesystem root');
  return path.join(path.dirname(home), `${name}-worktrees`);
}

export interface ManagedWorktreePlan {
  sourceCwd: string;
  path: string;
  /** Effective session cwd; preserves a source cwd below the repository root. */
  sessionCwd: string;
  branch: string;
  repositoryRoot: string;
  commonDir: string;
  branchPreexisted: boolean;
  startOid?: string;
}

export interface CreatedManagedWorktree {
  /** Directory the harness should run in (which may be below the worktree root). */
  cwd: string;
  checkout: GitCheckoutSnapshot;
  managed: ManagedWorktree;
}

/** Create an isolated worktree. Never reuses another worktree's directory. */
export async function createManagedWorktree(input: CreateManagedWorktreeInput): Promise<CreatedManagedWorktree> {
  const source = await inspectGitCheckout(input.sourceCwd);
  if (!source.repo || !source.commonDir || !source.repositoryRoot || !source.head) {
    throw new WorktreeError('not_git_repository', `${input.sourceCwd} is not a Git checkout with a commit`);
  }
  const branch = await validateBranch(input.sourceCwd, input.branch);
  const before = await worktreeList(input.sourceCwd);
  const conflict = branchConflict(branch, before);
  if (conflict) throw conflictError(branch, conflict);

  const branchPreexisted = await localBranchExists(input.sourceCwd, branch);
  if (branchPreexisted && input.startPoint) {
    throw new WorktreeError(
      'invalid_branch',
      `--worktree-base cannot be used because local branch ${JSON.stringify(branch)} already exists`,
    );
  }

  let startOid: string | undefined;
  if (!branchPreexisted) {
    let startPoint = input.startPoint?.trim();
    if (!startPoint) {
      const remotes = await remoteBranchCandidates(input.sourceCwd, branch);
      if (remotes.length > 1) {
        throw new WorktreeError(
          'ambiguous_remote_branch',
          `branch ${JSON.stringify(branch)} exists on multiple remotes (${remotes.join(', ')}); ` +
            'pass --worktree-base explicitly',
        );
      }
      startPoint = remotes[0] ?? 'HEAD';
    }
    startOid = await resolveCommit(input.sourceCwd, startPoint);
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(input.sessionId)) {
    throw new WorktreeError('destination_exists', 'session id is not safe for a managed worktree path');
  }
  await mkdir(input.managedRoot, { recursive: true, mode: 0o700 });
  const managedRoot = await realpath(input.managedRoot);
  const repoName = path.basename(source.repositoryRoot);
  const repoDirectory = path.join(managedRoot, `${pathSlug(repoName, 32)}-${stableHash(source.commonDir)}`);
  await mkdir(repoDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(repoDirectory, `${pathSlug(branch, 48)}-${stableHash(branch, 8)}-${input.sessionId}`);
  if (await lstat(destination).catch(() => undefined)) {
    throw new WorktreeError('destination_exists', `managed worktree destination already exists: ${destination}`);
  }

  const sourceCwd = await realpath(input.sourceCwd);
  const relativeCwd = path.relative(source.worktreeRoot!, sourceCwd);
  if (relativeCwd === '..' || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
    throw new WorktreeError('not_git_repository', `${input.sourceCwd} is outside the detected checkout root`);
  }
  const sessionCwd = path.join(destination, relativeCwd);
  const plan: ManagedWorktreePlan = {
    sourceCwd,
    path: destination,
    sessionCwd,
    branch,
    repositoryRoot: source.repositoryRoot,
    commonDir: source.commonDir,
    branchPreexisted,
    ...(startOid ? { startOid } : {}),
  };
  // SessionManager uses this hook to persist the session + creation intent
  // BEFORE a potentially slow checkout. A lost HTTP response can then recover
  // the session instead of orphaning an invisible worktree.
  await input.onPlanned?.(plan);

  const args = branchPreexisted
    ? ['worktree', 'add', destination, branch]
    : ['worktree', 'add', '-b', branch, destination, startOid!];
  let added: Awaited<ReturnType<typeof gitText>>;
  try {
    added = await gitText(input.sourceCwd, args, { timeoutMs: input.timeoutMs ?? 30_000 });
  } catch (error) {
    throw new WorktreeError(
      'git_failed',
      `${error instanceof Error ? error.message : String(error)}; inspect ${destination} before retrying — ` +
        'kteam deliberately did not delete an unverifiable checkout',
    );
  }
  if (added.result.code !== 0) {
    // Close the preflight race with a purpose-built error instead of exposing
    // whichever Git version's raw "already checked out" wording happened.
    const raced = branchConflict(branch, await worktreeList(input.sourceCwd).catch(() => []));
    if (raced && path.resolve(raced.path) !== path.resolve(destination)) throw conflictError(branch, raced);
    if (raced) {
      throw new WorktreeError(
        'git_failed',
        `Git registered ${destination} but worktree creation failed; inspect it manually before retrying`,
      );
    }
    throw gitFailure('git worktree add', added.result);
  }

  if (!(await lstat(sessionCwd).catch(() => undefined))?.isDirectory()) {
    throw new WorktreeError(
      'git_failed',
      `Git created ${destination}, but the requested relative cwd does not exist in this branch: ${sessionCwd}; ` +
        'kteam preserved the worktree for inspection',
    );
  }
  const checkout = await inspectGitCheckout(sessionCwd);
  if (
    !checkout.repo ||
    checkout.kind !== 'linked_worktree' ||
    checkout.branch !== branch ||
    !checkout.commonDir ||
    !checkout.repositoryRoot ||
    !checkout.head
  ) {
    // Do not guess at rollback here. The checkout now exists, and preserving a
    // surprising tree is safer than recursively deleting something Git made.
    throw new WorktreeError(
      'git_failed',
      `Git created ${destination}, but kteam could not verify it as branch ${JSON.stringify(branch)}; inspect it manually`,
    );
  }
  return {
    cwd: sessionCwd,
    checkout,
    managed: {
      version: 1,
      path: checkout.worktreeRoot!,
      branch,
      repositoryRoot: checkout.repositoryRoot,
      commonDir: checkout.commonDir,
      createdAt: new Date().toISOString(),
      initialHead: checkout.head,
      branchPreexisted,
    },
  };
}

export type WorktreeRemovalBlockerCode =
  | 'active_session'
  | 'outside_managed_root'
  | 'missing_worktree'
  | 'repository_mismatch'
  | 'branch_mismatch'
  | 'locked_worktree'
  | 'other_session'
  | 'live_terminal'
  | 'dirty_worktree'
  | 'unpushed_commits'
  | 'git_error';

export interface WorktreeRemovalBlocker {
  code: WorktreeRemovalBlockerCode;
  message: string;
}

export interface WorktreeRemovalCheck {
  removable: boolean;
  path: string;
  branch: string;
  head?: string;
  upstream?: string;
  blockers: WorktreeRemovalBlocker[];
}

export interface CheckManagedWorktreeRemovalInput {
  managed: ManagedWorktree;
  managedRoot: string;
  /** The session manager supplies this from its terminal-status set. */
  sessionActive: boolean;
  /** Every other retained session whose canonical cwd is this tree or below it. */
  otherSessions?: Array<{ id: string; cwd: string }>;
  /** Web terminals outlive an agent pane and separately hold this cwd. */
  liveWebTerminals?: number;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function pushedState(cwd: string): Promise<{
  pushed: boolean;
  upstream?: string;
  reason?: string;
}> {
  const upstreamResult = await gitText(cwd, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  const upstream = upstreamResult.result.code === 0 ? upstreamResult.stdout.trim() : undefined;
  if (upstream?.startsWith('refs/remotes/')) {
    const ahead = await gitText(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
    if (ahead.result.code !== 0) throw gitFailure('git rev-list', ahead.result);
    const count = Number(ahead.stdout.trim());
    if (!Number.isSafeInteger(count)) throw new WorktreeError('git_failed', 'git returned an invalid ahead count');
    return {
      pushed: count === 0,
      upstream,
      ...(count > 0 ? { reason: `${count} commit${count === 1 ? '' : 's'} ahead of ${upstream}` } : {}),
    };
  }

  // No remote upstream (or a local-branch upstream): accept only if a fetched
  // remote-tracking ref contains the exact current HEAD. Stale refs may cause a
  // conservative refusal, never a false claim that local commits are pushed.
  const containing = await gitText(cwd, ['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes']);
  if (containing.result.code !== 0) throw gitFailure('git for-each-ref', containing.result);
  const remoteRefs = containing.stdout
    .split('\n')
    .map(ref => ref.trim())
    .filter(Boolean);
  return {
    pushed: remoteRefs.length > 0,
    upstream,
    ...(remoteRefs.length === 0
      ? { reason: 'HEAD is not contained in any fetched remote-tracking ref; kteam cannot prove it was pushed' }
      : {}),
  };
}

/** Read-only cleanup gate. Every uncertainty becomes a refusal. */
export async function checkManagedWorktreeRemoval(
  input: CheckManagedWorktreeRemovalInput,
): Promise<WorktreeRemovalCheck> {
  const blockers: WorktreeRemovalBlocker[] = [];
  const configuredPath = path.resolve(input.managed.path);
  const root = await canonical(input.managedRoot);
  if (input.sessionActive) {
    blockers.push({ code: 'active_session', message: 'the owning session is still active' });
  }
  if (!inside(root, configuredPath)) {
    blockers.push({
      code: 'outside_managed_root',
      message: `${configuredPath} is outside kteam's managed worktree root`,
    });
  }
  const livePath = await realpath(configuredPath).catch(() => undefined);
  if (!livePath) {
    blockers.push({ code: 'missing_worktree', message: 'the recorded worktree path no longer exists' });
    return { removable: false, path: configuredPath, branch: input.managed.branch, blockers };
  }
  if (!inside(root, livePath) || livePath !== configuredPath) {
    blockers.push({
      code: 'outside_managed_root',
      message: `the recorded worktree resolves to an unexpected path (${livePath})`,
    });
  }
  const sharing = (input.otherSessions ?? []).filter(session => inside(livePath, path.resolve(session.cwd)));
  if (sharing.length > 0) {
    blockers.push({
      code: 'other_session',
      message: `the worktree is still referenced by session${sharing.length === 1 ? '' : 's'} ${sharing
        .map(session => session.id)
        .join(', ')}`,
    });
  }
  if ((input.liveWebTerminals ?? 0) > 0) {
    blockers.push({
      code: 'live_terminal',
      message: `${input.liveWebTerminals} live web terminal${input.liveWebTerminals === 1 ? '' : 's'} still use this worktree`,
    });
  }

  let checkout: GitCheckoutSnapshot;
  try {
    checkout = await inspectGitCheckout(livePath);
  } catch (error) {
    blockers.push({ code: 'git_error', message: error instanceof Error ? error.message : String(error) });
    return { removable: false, path: configuredPath, branch: input.managed.branch, blockers };
  }
  if (!checkout.repo || checkout.kind !== 'linked_worktree' || checkout.commonDir !== input.managed.commonDir) {
    blockers.push({
      code: 'repository_mismatch',
      message: 'the path is no longer the linked worktree kteam created for this repository',
    });
  }
  if (checkout.detached || checkout.branch !== input.managed.branch) {
    blockers.push({
      code: 'branch_mismatch',
      message: checkout.detached
        ? `the worktree is detached; expected branch ${input.managed.branch}`
        : `the worktree is on ${checkout.branch ?? 'an unknown branch'}; expected ${input.managed.branch}`,
    });
  }
  if (checkout.locked !== undefined) {
    blockers.push({
      code: 'locked_worktree',
      message: `Git has locked this worktree${checkout.locked ? `: ${checkout.locked}` : ''}`,
    });
  }

  try {
    // `git worktree remove` silently deletes IGNORED files while ordinary
    // porcelain calls the tree clean. Those may be credentials or generated
    // artifacts the user still cares about, so one byte of any tracked,
    // untracked, submodule, OR ignored state is a refusal. The output reader
    // still drains Git after the cap; memory stays constant on huge build trees.
    const status = await gitText(
      livePath,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--ignore-submodules=none'],
      { maxOutputBytes: 1 },
    );
    if (status.result.code !== 0) throw gitFailure('git status', status.result);
    if (status.stdout.length > 0) {
      blockers.push({
        code: 'dirty_worktree',
        message: 'the worktree has staged, unstaged, untracked, ignored, or dirty-submodule content',
      });
    }
    const pushed = await pushedState(livePath);
    if (!pushed.pushed) {
      blockers.push({ code: 'unpushed_commits', message: pushed.reason ?? 'the worktree has unpushed commits' });
    }
    return {
      removable: blockers.length === 0,
      path: configuredPath,
      branch: input.managed.branch,
      head: checkout.head,
      upstream: pushed.upstream,
      blockers,
    };
  } catch (error) {
    blockers.push({ code: 'git_error', message: error instanceof Error ? error.message : String(error) });
    return {
      removable: false,
      path: configuredPath,
      branch: input.managed.branch,
      head: checkout.head,
      blockers,
    };
  }
}

export interface RemovedManagedWorktree {
  path: string;
  branch: string;
  /** Removal never deletes the local branch. */
  branchRetained: true;
  removedAt: string;
}

/**
 * Cross-session serialization keyed by canonical Git common-dir. Git already
 * locks its own metadata, but this keeps kteam's preflight + purpose-built
 * conflict diagnostics together instead of racing two independent sessions.
 */
export class WorktreeOperationQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  async run<T>(commonDir: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(commonDir);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}

/** Explicit, guarded removal. There is intentionally no force parameter. */
export async function removeManagedWorktree(input: CheckManagedWorktreeRemovalInput): Promise<RemovedManagedWorktree> {
  // Run the complete check immediately before mutation. `git worktree remove`
  // itself is called without --force, so a change racing this check is refused
  // by Git as a second dirty-tree gate.
  const check = await checkManagedWorktreeRemoval(input);
  if (!check.removable) {
    throw new WorktreeError(
      'unsafe_remove',
      `refusing to remove ${check.path}: ${check.blockers.map(blocker => blocker.message).join('; ')}`,
      check.blockers,
    );
  }
  // Do not make the child process's cwd the directory it is deleting. That
  // happened to work on the Linux test host but is an unnecessary macOS/filesystem
  // portability gamble. The already-verified common dir is stable and Git's
  // global --git-dir form performs the same registry-aware removal.
  const stableCwd = path.dirname(input.managed.commonDir);
  const removed = await gitText(stableCwd, [`--git-dir=${input.managed.commonDir}`, 'worktree', 'remove', check.path], {
    timeoutMs: 120_000,
  });
  if (removed.result.code !== 0) throw gitFailure('git worktree remove', removed.result);
  return {
    path: check.path,
    branch: input.managed.branch,
    branchRetained: true,
    removedAt: new Date().toISOString(),
  };
}
