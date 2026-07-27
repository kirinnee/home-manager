/**
 * Hardened, read-only `git` helpers for the session filesystem viewer.
 *
 * Every invocation here is reachable from an HTTP endpoint whose bearer token
 * must be assumed to be in a visitor's hands (the UI is served through a
 * Cloudflare tunnel whose loopback proxy makes requests look local, so the
 * admin token embedding at api-server.ts:239-244 hands it out). The rules that
 * follow are therefore not stylistic:
 *
 * - argv arrays only, never a shell.
 * - `GIT_LITERAL_PATHSPECS=1` on every path-bearing command. `--` alone does
 *   NOT disable pathspec magic: a working-tree file named `:(top)foo` would
 *   otherwise let a session whose cwd is a repo SUBDIRECTORY diff its siblings.
 *   (`check-ignore` is the one exception — it rejects `literal` magic outright —
 *   so it gets `./`-prefixed paths, which defuse magic the same way.)
 * - No external diff drivers, textconv filters, pagers, color, or hooks, and
 *   system/global config is neutered, so a checked-in `.gitattributes` or a
 *   repo-local config cannot turn a read endpoint into code execution.
 * - `diff.renames=false` plus `--no-renames`: rename detection on a path inside
 *   the session cwd would otherwise print the CONTENT of an out-of-cwd source.
 * - Output byte cap and a wall-clock timeout on every spawn.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const GIT_TIMEOUT_MS = 10_000;
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

/** `-c` overrides applied to every invocation. `-c` beats repo-local config. */
const HARDENED_CONFIG = [
  '--no-optional-locks',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.external=',
  '-c',
  'status.relativePaths=false',
  '-c',
  'status.showUntrackedFiles=all',
] as const;

/**
 * Flags and config for every diff-producing command.
 *
 * `--no-renames` (with `diff.renames=false` so a repo-local setting cannot
 * re-enable it) is load-bearing security, not cosmetics: on a path inside the
 * session cwd, rename detection prints the out-of-cwd SOURCE path in the diff
 * header and its full content in the body. An in-cwd destination must render as
 * a plain add instead.
 *
 * Note this is deliberately NOT in HARDENED_CONFIG: `status` derives its own
 * rename detection from `diff.renames`, and the Changes list needs renames
 * (they are reported as `R` with a `from`, filtered to the cwd separately).
 */
const DIFF_SAFETY = [
  '-c',
  'diff.renames=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
] as const;

export type GitErrorCode = 'git_failed' | 'git_timeout' | 'not_a_repo' | 'not_in_head';

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly stderr: string;

  constructor(code: GitErrorCode, message: string, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitRunOptions {
  /**
   * Working directory for the child.
   *
   * Callers reached from HTTP MUST pass a PINNED path (`PinnedRoot.dirPath`, the
   * procfs alias for an open descriptor) rather than the configured pathname.
   * A pathname is only a claim about the past: renamed away and replaced with a
   * symlink between validation and spawn, it makes git operate on a different
   * tree than the one whose paths passed containment and the secrets gates.
   * `fs.ts` is the enforcement point; this is the contract it relies on.
   */
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Bytes piped to stdin (used by `check-ignore --stdin`). */
  stdin?: Uint8Array;
  /** Off only for `check-ignore`, which refuses `literal` pathspec magic. */
  literalPathspecs?: boolean;
}

export interface GitResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
  /** stdout hit `maxOutputBytes` and was cut. */
  truncated: boolean;
  timedOut: boolean;
}

function gitEnv(literalPathspecs: boolean): Record<string, string | undefined> {
  // Drop EVERY inherited GIT_* variable before setting our own. The daemon's
  // environment is not ours to trust: an inherited GIT_DIR, GIT_WORK_TREE,
  // GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES or
  // GIT_CONFIG_PARAMETERS would silently redirect these reads outside the
  // session cwd, or re-enable exactly the behaviour the flags above disable.
  // Ordinary environment (PATH, HOME, locale) is preserved.
  const inherited: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) inherited[key] = value;
  }

  return {
    ...inherited,
    // Pin the locale. Every parser here matches git's own English output
    // ("No commits yet on ", the `<oid> <type> <size>` cat-file reply), and a
    // daemon started under a translating locale would silently break the
    // branch/blob parsing — and with it the gates that depend on it.
    LC_ALL: 'C',
    LANG: 'C',
    // Ignore the user's ~/.gitconfig and /etc/gitconfig entirely: either could
    // configure an external diff driver, a textconv filter, or an attributes
    // file that this endpoint would then execute.
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    ...(literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
  };
}

/** stderr is diagnostics only; a runaway one must not become a memory cost. */
const MAX_GIT_STDERR_BYTES = 64 * 1024;

/**
 * Read a pipe into memory, keeping at most `maxBytes` but continuing to drain.
 *
 * Buffering the whole stream and slicing afterwards would make the cap
 * decorative: `git diff` on a multi-gigabyte blob would be fully resident
 * before the first byte was discarded. Draining past the cap (rather than
 * cancelling) is deliberate — it lets git exit on its own instead of dying on
 * EPIPE, so a truncated-but-successful read stays distinguishable from a crash.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const room = maxBytes - kept;
      if (room <= 0) {
        truncated = true;
        continue; // keep draining so the child can exit cleanly
      }
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        kept += room;
        truncated = true;
        continue;
      }
      chunks.push(value);
      kept += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** Spawn `git` with the hardened argv/env and a capped, timed read of stdout. */
export async function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
  const child = Bun.spawn(['git', ...HARDENED_CONFIG, ...args], {
    cwd: options.cwd,
    env: gitEnv(options.literalPathspecs ?? true),
    stdin: options.stdin ? new Blob([options.stdin as unknown as BlobPart]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
  });

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    readCapped(child.stdout, maxOutputBytes),
    readCapped(child.stderr, MAX_GIT_STDERR_BYTES),
  ]);

  return {
    code,
    stdout: stdout.bytes,
    stderr: new TextDecoder().decode(stderr.bytes),
    truncated: stdout.truncated,
    timedOut: child.signalCode === 'SIGTERM' || child.signalCode === 'SIGKILL',
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function runGitText(args: string[], options: GitRunOptions): Promise<{ result: GitResult; stdout: string }> {
  const result = await runGit(args, options);
  if (result.timedOut) {
    throw new GitError('git_timeout', `git ${args[0] ?? ''} timed out`, result.stderr);
  }
  return { result, stdout: text(result.stdout) };
}

export interface GitRepoInfo {
  repo: boolean;
  /** Absolute repository root (worktree toplevel). */
  root?: string;
  /** Path of the session cwd relative to the repo root, `''` at the root,
   *  otherwise slash-terminated as git reports it (`"sub/"`). */
  prefix: string;
  /** Current branch, or undefined when detached. */
  branch?: string;
  /** False in a freshly-initialised repo with no commits. */
  hasHead: boolean;
}

/** Ask git where we are. Never throws for "not a repo" — that is a valid state
 *  the viewer reports as `repo: false` so the UI hides diff affordances. */
export async function gitRepoInfo(cwd: string): Promise<GitRepoInfo> {
  const { result, stdout } = await runGitText(
    ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--show-prefix'],
    {
      cwd,
    },
  );
  if (result.code !== 0) return { repo: false, prefix: '', hasHead: false };
  const lines = stdout.split('\n');
  if (lines[0]?.trim() !== 'true') return { repo: false, prefix: '', hasHead: false };

  const head = await runGitText(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  return {
    repo: true,
    root: lines[1]?.trim() || undefined,
    prefix: lines[2] ?? '',
    hasHead: head.result.code === 0,
  };
}

export interface GitChange {
  /** Path relative to the SESSION cwd, never to the repo root. */
  path: string;
  /** Two-character porcelain XY code, e.g. `" M"`, `"A "`, `"??"`. */
  status: string;
  /** Rename/copy source, relative to the session cwd. Omitted when the source
   *  sits outside the cwd — reporting it would leak a sibling path. */
  from?: string;
}

export interface GitChangesView {
  repo: boolean;
  branch?: string;
  changes: GitChange[];
  /** git's own output hit the byte cap, so the list may be incomplete. */
  truncated?: boolean;
}

/** `## main`, `## HEAD (no branch)`, `## No commits yet on main`, `## a...b [ahead 1]`. */
function parseBranchHeader(header: string): string | undefined {
  const value = header.trim();
  const noCommits = 'No commits yet on ';
  if (value.startsWith(noCommits)) return value.slice(noCommits.length).split(/\s/)[0] || undefined;
  if (value.startsWith('HEAD (no branch)')) return undefined;
  return value.split('...')[0]!.split(/\s/)[0] || undefined;
}

function underPrefix(repoPath: string, prefix: string): string | undefined {
  if (!prefix) return repoPath;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined;
}

/**
 * `git status --porcelain=v1 -z -b -uall`, filtered to the session cwd.
 *
 * Porcelain paths are repo-root-relative, so a session started in a repo
 * SUBDIRECTORY must not be shown its siblings — hence the prefix filter, and
 * `status.relativePaths=false` pinned in HARDENED_CONFIG so a repo-local
 * `status.relativePaths=true` cannot change the shape we parse. `-uall` is
 * explicit because a repo (or global) `status.showUntrackedFiles=no` would
 * otherwise hide every untracked file from the Changes list.
 */
export async function gitChanges(cwd: string): Promise<GitChangesView> {
  const info = await gitRepoInfo(cwd);
  if (!info.repo) return { repo: false, changes: [] };

  const { result, stdout } = await runGitText(['status', '--porcelain=v1', '-z', '-b', '-uall'], { cwd });
  if (result.code !== 0) {
    throw new GitError(
      'git_failed',
      `git status failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      result.stderr,
    );
  }

  const records = stdout.split('\0');
  // A capped byte stream can end in the middle of a pathname. `split()` then
  // presents that fragment as an ordinary final record, and the parser below
  // would surface it as a change that never existed. Keep every complete
  // NUL-terminated record and discard only the unterminated tail.
  if (result.truncated && !stdout.endsWith('\0')) records.pop();
  const changes: GitChange[] = [];
  let branch: string | undefined;
  let index = 0;
  if (records[0]?.startsWith('## ')) {
    branch = parseBranchHeader(records[0].slice(3));
    index = 1;
  }

  for (; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const repoPath = record.slice(3);
    // Rename/copy records are two NUL-separated fields: destination then source.
    const isRenameOrCopy = /[RC]/.test(status);
    const source = isRenameOrCopy ? records[(index += 1)] : undefined;
    // Rename/copy records are atomic pairs. If the cap landed after the
    // destination terminator but before the source record completed, neither
    // half is honest enough to emit.
    if (isRenameOrCopy && !source) break;

    const rel = underPrefix(repoPath, info.prefix);
    if (rel === undefined || rel === '') continue;
    const from = source === undefined ? undefined : underPrefix(source, info.prefix);
    changes.push({ path: rel, status, ...(from ? { from } : {}) });
  }

  return {
    repo: true,
    ...(branch ? { branch } : {}),
    changes,
    ...(result.truncated ? { truncated: true } : {}),
  };
}

/**
 * Is this cwd-relative path itself a tracked FILE (incl. staged additions)?
 *
 * The exit code alone is not the answer. A pathspec naming a directory matches
 * every record beneath it, so a *deleted* directory `sub/` exits 0 here — and
 * the caller (readDiff) would then admit `sub` as if it were one deleted file
 * and diff everything under it. So compare the records: exactly one, equal to
 * the requested path.
 */
export async function gitIsTracked(cwd: string, rel: string): Promise<boolean> {
  const { result, stdout } = await runGitText(['ls-files', '--error-unmatch', '-z', '--', rel], { cwd });
  if (result.code !== 0) return false;
  const records = stdout.split('\0').filter(record => record.length > 0);
  return records.length === 1 && records[0] === rel;
}

export interface GitDiffView {
  /** Unified diff text. Empty when there is nothing to show. */
  diff: string;
  kind: 'tracked' | 'untracked' | 'none';
  truncated?: boolean;
}

/** One side of a diff, as bytes the caller already holds. */
export interface DiffSide {
  bytes: Uint8Array;
  /**
   * Git file mode: 0o100644, 0o100755, or 0o120000 for a symlink (whose `bytes`
   * are the link TEXT, not the target's content).
   */
  mode: number;
}

/**
 * The HEAD entry for one path: its recorded mode plus its bytes.
 *
 * Distinct from {@link gitReadHeadBlob} in returning the mode, which the diff
 * formatter needs so a mode change or a symlink→file type change still renders.
 */
export interface GitHeadEntry {
  mode: number;
  bytes: Uint8Array;
  truncated: boolean;
}

/** `ls-tree` reports `<mode> <type> <oid>\t<path>`; we want mode+oid for a blob. */
export async function gitHeadEntry(cwd: string, rel: string, maxBytes: number): Promise<GitHeadEntry | undefined> {
  const info = await gitRepoInfo(cwd);
  if (!info.repo || !info.hasHead) return undefined;

  const { result, stdout } = await runGitText(['ls-tree', '-z', 'HEAD', '--', rel], { cwd });
  if (result.code !== 0) return undefined;
  const record = stdout.split('\0').find(entry => entry.length > 0);
  if (!record) return undefined;
  const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)\t(.*)$/s.exec(record);
  if (!match) return undefined;
  const [, modeText, type, oid, recordedPath] = match;
  // A gitlink has no blob to read, and a pathspec naming a DIRECTORY would
  // report the first entry beneath it — neither is this path's content.
  if (type !== 'blob' || recordedPath !== rel) return undefined;

  const blob = await runGit(['cat-file', 'blob', oid], { cwd, maxOutputBytes: maxBytes });
  if (blob.timedOut) throw new GitError('git_timeout', 'git cat-file timed out', blob.stderr);
  if (blob.code !== 0) return undefined;
  return { mode: Number.parseInt(modeText, 8), bytes: blob.stdout, truncated: blob.truncated };
}

/**
 * Stage one side of the diff inside the scratch directory and return the path
 * git should be given, relative to that directory.
 *
 * The `a/` and `b/` prefixes are not cosmetic: paired with `--src-prefix=` and
 * `--dst-prefix=` they make git print `--- a/<rel>` and `+++ b/<rel>` ITSELF.
 * That is what lets this function avoid rewriting those lines afterwards — and
 * rewriting them would be a real hazard, because a body line `-- a/x` renders as
 * `--- a/x`, indistinguishable from a header by prefix alone.
 */
async function stageSide(scratch: string, rel: string, prefix: 'a' | 'b', side: DiffSide): Promise<string> {
  const relative = `${prefix}/${rel}`;
  const absolute = path.join(scratch, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  if (side.mode === 0o120000) {
    // Recreate it as a symlink so git reports the type natively. git reads this
    // with readlink and never opens it, so the target is never followed —
    // whether or not it still exists, or ever did.
    await symlink(new TextDecoder().decode(side.bytes), absolute);
    return relative;
  }
  await writeFile(absolute, side.bytes, { mode: side.mode & 0o777 });
  // writeFile's mode is subject to umask; chmod is not.
  await chmod(absolute, side.mode & 0o777);
  return relative;
}

/**
 * Render a unified diff between two byte snapshots the CALLER obtained, using
 * git purely as a formatter.
 *
 * This exists for containment, not convenience. `git diff HEAD -- <rel>` reads
 * the worktree side by NAME from the repository top level, so it re-resolves
 * every component at spawn time: with `sub` renamed away and replaced by a
 * symlink mid-request, git pairs the pinned repo's index entry with bytes from
 * the other tree and emits a diff that mixes both (observed: `index 82676f9..`
 * — the validated blob — above `+OUTSIDE` content). Passing a pinned parent as
 * cwd does not help, because git converts the pathspec to a top-level-relative
 * path first. Neither side here is a name git resolves: both are bytes already
 * read through the pinned descriptor chain, staged into a private scratch
 * directory. `--no-index` then diffs those two files and nothing else.
 *
 * Verified byte-identical to `git diff HEAD -- <rel>` across: modified, staged,
 * mode-change-only, binary, no-newline-at-EOF, CRLF, deleted, added, identical,
 * symlink→file type change, and paths with spaces and non-ASCII characters.
 */
export async function gitDiffSnapshots(
  rel: string,
  oldSide: DiffSide | undefined,
  newSide: DiffSide | undefined,
): Promise<{ diff: string; truncated: boolean }> {
  if (!oldSide && !newSide) return { diff: '', truncated: false };

  const scratch = await mkdtemp(path.join(tmpdir(), 'kteam-diff-'));
  try {
    const left = oldSide ? await stageSide(scratch, rel, 'a', oldSide) : '/dev/null';
    const right = newSide ? await stageSide(scratch, rel, 'b', newSide) : '/dev/null';
    const { result, stdout } = await runGitText(
      [...DIFF_SAFETY, '--no-index', '--src-prefix=', '--dst-prefix=', '--', left, right],
      { cwd: scratch },
    );
    // `--no-index` exits 1 for "they differ", which is the normal case here.
    if (result.code > 1) {
      throw new GitError(
        'git_failed',
        `git diff failed: ${result.stderr.trim() || `exit ${result.code}`}`,
        result.stderr,
      );
    }
    return { diff: relabelDiffHeaders(stdout, rel), truncated: result.truncated };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Fix up the `diff --git` lines, which are the one place git does not honour
 * `--src-prefix`/`--dst-prefix`: it derives BOTH names from whichever side
 * exists, so a deleted file prints `diff --git a/x a/x` and an added one
 * `diff --git b/x b/x`.
 *
 * Rewriting these lines cannot be spoofed by file content, which is why only
 * these are touched. Every body line in unified output carries a ` `, `+`, `-`
 * or `\` prefix, so a line beginning at column 0 with `diff --git ` is always a
 * header — verified against a file whose committed AND working content consists
 * of nothing but forged header lines. (A type change legitimately emits two such
 * headers, so this is not restricted to the first line.)
 */
function relabelDiffHeaders(diff: string, rel: string): string {
  if (diff === '') return diff;
  return diff
    .split('\n')
    .map(line => (line.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` : line))
    .join('\n');
}

export interface GitBlob {
  size: number;
  /** Absent when the blob is larger than the caller's cap. */
  bytes?: Uint8Array;
}

/**
 * Read `HEAD:<rel>` for the "rendered before" view. `rel` is validated by the
 * caller to contain no `..`, which matters: `HEAD:./../x` DOES resolve outside
 * a subdirectory cwd, so the syntactic gate is what contains this read.
 * Returns undefined when the path is absent from HEAD or is not a blob.
 */
export async function gitReadHeadBlob(cwd: string, rel: string, maxBytes: number): Promise<GitBlob | undefined> {
  const info = await gitRepoInfo(cwd);
  if (!info.repo || !info.hasHead) return undefined;

  const spec = `HEAD:./${rel}`;
  const check = await runGitText(['cat-file', '--batch-check', '-z'], {
    cwd,
    stdin: new TextEncoder().encode(`${spec}\0`),
  });
  // `--batch-check -z` NUL-terminates its INPUT records; the reply line is
  // "<oid> <type> <size>" with a trailing newline. Strip both terminators
  // before Number() so a stray NUL can never make the size NaN.
  const fields = check.stdout.replaceAll('\0', '').trim().split(/\s+/);
  const [oid, type, size] = fields;
  if (check.result.code !== 0 || type !== 'blob' || !oid || !size) return undefined;

  const byteLength = Number(size);
  if (!Number.isSafeInteger(byteLength)) return undefined;
  if (byteLength > maxBytes) return { size: byteLength };

  const blob = await runGit(['cat-file', 'blob', oid], { cwd, maxOutputBytes: maxBytes });
  if (blob.timedOut) throw new GitError('git_timeout', 'git cat-file timed out', blob.stderr);
  if (blob.code !== 0) return undefined;
  return { size: byteLength, bytes: blob.stdout };
}

/**
 * Which of these cwd-relative paths does gitignore cover?
 *
 * Paths go in `./`-prefixed for two reasons: it defuses pathspec magic in a
 * command that cannot accept `GIT_LITERAL_PATHSPECS` (it errors on `literal`
 * magic), and it keeps a real file named `:(top)x` from aborting the batch with
 * `fatal: oops in prep_exclude`. Returned paths are un-prefixed again.
 */
export async function gitIgnoredPaths(cwd: string, rels: readonly string[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  const candidates = rels.filter(rel => rel.length > 0);
  if (candidates.length === 0) return ignored;

  const info = await gitRepoInfo(cwd);
  if (!info.repo) return ignored; // gate 2 is vacuous outside a git tree

  const stdin = new TextEncoder().encode(`${candidates.map(rel => `./${rel}`).join('\0')}\0`);
  const { result, stdout } = await runGitText(['check-ignore', '-z', '--stdin'], {
    cwd,
    stdin,
    literalPathspecs: false,
  });
  // 0 = some ignored, 1 = none ignored; anything else means we could not tell,
  // and a viewer that cannot tell must not claim a file is safe to serve.
  if (result.code === 1) return ignored;
  if (result.code !== 0) {
    throw new GitError(
      'git_failed',
      `git check-ignore failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      result.stderr,
    );
  }

  for (const record of stdout.split('\0')) {
    if (!record) continue;
    ignored.add(record.startsWith('./') ? record.slice(2) : record);
  }
  return ignored;
}

/** Convenience single-path form of {@link gitIgnoredPaths}. */
export async function gitIsIgnored(cwd: string, rel: string): Promise<boolean> {
  return (await gitIgnoredPaths(cwd, [rel])).has(rel);
}
