/**
 * Read-only working-tree access for one kteam session, rooted at its own `cwd`.
 *
 * This module is an arbitrary-file-read primitive wearing a viewer costume, so
 * containment is the feature. Threat model: the bearer token is assumed to be
 * in a visitor's hands. The kteam UI is reached through a Cloudflare tunnel
 * whose local proxy makes requests arrive from loopback, and the loopback-only
 * token embedding (api-server.ts:239-244) therefore hands the admin token to
 * tunnel visitors. Nothing here may rely on "only the owner has the token".
 *
 * The layers, in the order a request meets them:
 *
 *  1. Syntactic gate, before any filesystem call — no absolute paths, no `..`,
 *     no backslashes, no NUL, no empty segments (mirrors `assertSessionId` in
 *     attachments.ts:85).
 *  2. Containment by DESCRIPTOR, not by string. The root is opened once and held
 *     ({@link pinRoot}), and each component of the request is then opened
 *     `O_DIRECTORY|O_NOFOLLOW` from its already-open parent
 *     ({@link openInPinnedRoot}). This is the fix for the component-level TOCTOU:
 *     a validated path string is only a claim about the past, so `realpath` +
 *     `open(pathname)` validates one walk and performs another, and swapping an
 *     intermediate directory (or the configured cwd) for a symlink in between
 *     redirects the read outside the tree. Here the walk that validates IS the
 *     walk that serves, and git runs from the pinned root rather than the
 *     pathname. Verified: with the old mechanism a parent swapped mid-request
 *     served outside content; with this one it cannot.
 *  3. Regular files only, read by HANDLE. Symlinks are never served — not at the
 *     leaf and not at any interior component. Refusing interior links rather than
 *     resolving-and-containing them is a deliberate narrowing: it costs browsing
 *     through an in-tree symlinked directory and buys a containment proof that
 *     does not depend on winning a race.
 *  4. Unconditional denylist by basename/glob, plus all of `.git/` and
 *     `node_modules/`, refused in both content and diff. Gates 4 and 5 are
 *     applied to the LEXICAL path *and* to the canonical one. Layer 2 now refuses
 *     interior symlinks outright, so `alias -> .git` never gets far enough to
 *     launder `alias/config` — but the gates must not DEPEND on that, so both
 *     paths are still checked and both regressions still assert a refusal.
 *     The session ROOT is gated the same way, since a cwd of `<repo>/.git`
 *     would otherwise make every relative path innocent.
 *  5. Gitignore gate — content of a gitignored path is refused, and a gitignored
 *     DIRECTORY cannot be enumerated either: the filenames inside one are
 *     themselves the leak, and a token holder calls the endpoint directly rather
 *     than through a UI that greys such rows out. This repo's own
 *     threat is exactly `secrets.yaml` (gitignored, decrypted): gitignore is
 *     the one machine-readable place a user has already declared "this must not
 *     leave the machine". It over-blocks build output; that is the right
 *     direction to be wrong in, and there is deliberately no `?force` override.
 *  6. Caps — 1 MiB per file, 2,000 entries per listing, NUL in the first 8 KiB
 *     means binary and no content.
 *
 * Accepted residual risks:
 *
 *  - Hardlinks. A hardlink to a file outside the tree is indistinguishable from a
 *    normal file — it has no link to follow and no separate identity. Same as
 *    attachments, and the daemon and the agent run as the same user, so the agent
 *    can already read anything the daemon can.
 *  - Non-Linux platforms are refused. The pin is handed to path-only APIs
 *    (`opendir`, `Bun.spawn`'s `cwd`) through `/proc/<pid>/fd/<n>`. Falling back
 *    to the configured pathname would re-open the root-swap vulnerability, so
 *    the whole surface fails closed until another platform has an equivalent
 *    descriptor-backed implementation.
 *  - A cwd swapped BEFORE a request begins is not an escape. The configured cwd
 *    then honestly names the other tree, and a viewer shows the tree its cwd
 *    names; every gate runs against that same tree. What the pin guarantees is
 *    coherence — gates and bytes always come from one tree, never mixed.
 */

import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  gitChanges,
  gitDiffSnapshots,
  gitHeadEntry,
  gitIgnoredPaths,
  gitIsTracked,
  gitReadHeadBlob,
  gitRepoInfo,
  type GitChangesView,
} from './git';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_LISTING_ENTRIES = 2_000;
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Per-side cap for a diff. Both sides are held in memory and written to a
 * scratch file before git sees them (see {@link gitDiffSnapshots}), so this
 * bounds that cost; the rendered diff is separately capped by git.ts.
 */
export const MAX_DIFF_SIDE_BYTES = MAX_FILE_BYTES;

/**
 * Barrier awaited at the exact moment the TOCTOU window would open: after this
 * request's path has been validated and its descriptor obtained, but before any
 * byte is read or handed to git.
 *
 * Tests pass this; routes never do. It exists because the race it guards is real
 * but rare — measured at ~0.5% of calls against a name-reopening implementation,
 * so a stress test finds it only by lottery and a green run proves nothing. With
 * this hook a regression swaps the parent, the leaf or the root precisely inside
 * the window and asserts deterministically that only pinned bytes come back. Any
 * future refactor that reopens a path by name after validation fails those tests
 * every run.
 *
 * Deliberately a per-call argument rather than module state: requests run
 * concurrently, and a shared mutable hook would fire for whichever request
 * happened to be in flight.
 *
 * @internal
 */
export type AfterValidationHook = () => Promise<void>;

/** Basenames and globs refused unconditionally, in content and in diff. */
const DENY_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..*$/i,
  /^secrets?\.ya?ml$/i,
  /^secrets?\.enc\.ya?ml$/i,
  /^secrets?\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^id_dsa/i,
  /\.age$/i,
  /credentials.*\.json$/i,
  /\.kdbx$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
];

/** Directories refused wholesale, at any depth. `.git` can embed credentialed
 *  remote URLs in `config` and its objects are useless in a viewer;
 *  `node_modules` is pure noise and 100k-entry listings. Matched
 *  case-insensitively because macOS checkouts are case-preserving but
 *  case-INsensitive, so `.GIT/config` opens the same file as `.git/config`. */
const DENY_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

export type FsErrorCode =
  | 'invalid_path'
  | 'not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'escapes_root'
  | 'denied'
  /** Gitignore gate, kept distinct from `denied` the same way the view flags are. */
  | 'ignored';

export class FsError extends Error {
  readonly code: FsErrorCode;

  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = 'FsError';
    this.code = code;
  }
}

/** The frozen listing contract. Anything else on disk (fifo, socket, device) is
 *  omitted from listings rather than given a fourth type the UI cannot render. */
export type FsEntryType = 'file' | 'dir' | 'symlink';

export interface FsEntry {
  name: string;
  type: FsEntryType;
  size?: number;
  mtime?: string;
  /** Gitignored: listed, never served. */
  ignored?: boolean;
  /** On the unconditional denylist: listed, never served. */
  denied?: boolean;
  /** A symlink resolving outside the session root: listed, never served. */
  escapes?: boolean;
}

export interface FsListing {
  /** The session root, post-realpath. */
  root: string;
  /** The listed directory, relative to the root; `''` is the root itself. */
  path: string;
  entries: FsEntry[];
  /** The directory held more than {@link MAX_LISTING_ENTRIES} entries. */
  truncated?: boolean;
}

export interface FsFileView {
  path: string;
  size: number;
  mtime?: string;
  /** Present only when content is actually served. */
  content?: string;
  /** NUL byte inside the first {@link BINARY_SNIFF_BYTES}. */
  binary?: boolean;
  /** Larger than {@link MAX_FILE_BYTES}; `size` still reports the real size. */
  tooLarge?: boolean;
  /** Refused by the HARD denylist only, so the UI can say "never served". */
  denied?: boolean;
  /** Refused by the gitignore gate (or because we could not prove otherwise) —
   *  a different badge from `denied`, matching the listing's `ignored`. */
  ignored?: boolean;
  /** Why it was refused, for the UI's placeholder row. */
  reason?: 'denylist' | 'ignored' | 'escapes';
  /** Served from `HEAD` rather than the working tree. */
  rev?: 'head';
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG';
}

/**
 * Validate an untrusted relative path *before* the filesystem sees it.
 *
 * Returns the normalised path (forward slashes, no trailing slash, `''` for the
 * root). Rejects anything that could mean "somewhere else": absolute paths,
 * `..`, backslashes (a Windows-style separator that POSIX would treat as a
 * legal filename character and that would smuggle segments past this check),
 * NUL, control characters, and empty or `.` segments.
 */
export function normalizeRelativePath(input: string | undefined | null): string {
  const raw = input ?? '';
  if (raw === '' || raw === '.' || raw === './') return '';
  if (raw.includes('\0')) throw new FsError('invalid_path', 'path may not contain NUL');
  if (raw.includes('\\')) throw new FsError('invalid_path', 'path may not contain backslashes');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new FsError('invalid_path', 'path may not contain control characters');
  if (path.posix.isAbsolute(raw)) throw new FsError('invalid_path', 'path must be relative to the session root');

  const segments = raw.split('/');
  const cleaned: string[] = [];
  for (const [index, segment] of segments.entries()) {
    // A single trailing slash is the only empty segment we tolerate.
    if (segment === '' && index === segments.length - 1 && index > 0) continue;
    if (segment === '' || segment === '.') throw new FsError('invalid_path', `path has an empty segment: "${raw}"`);
    if (segment === '..') throw new FsError('invalid_path', 'path may not contain ".." segments');
    cleaned.push(segment);
  }
  if (cleaned.length === 0) return '';
  return cleaned.join('/');
}

/** Is any segment of this path on the unconditional denylist? */
export function isDeniedPath(rel: string): boolean {
  if (rel === '') return false;
  // Every segment is checked, not just the leaf: `.git/config` and a directory
  // named `foo.key` are both refused, which is the safe direction to err in.
  for (const segment of rel.split('/')) {
    const folded = segment.toLowerCase();
    if (DENY_DIRECTORIES.some(denied => denied === folded)) return true;
    if (DENY_PATTERNS.some(pattern => pattern.test(segment))) return true;
  }
  return false;
}

/**
 * Is any DIRECTORY component of this absolute path one we never serve?
 *
 * The per-request gates judge paths relative to the session root, so a root that
 * is itself inside a denied directory makes every relative path innocent: with a
 * cwd of `<repo>/.git`, the request `config` has no denied segment at all, and
 * `kteam start --cwd` accepts any existing directory. This is checked on the
 * REALPATH'd root, so a symlinked cwd cannot launder it either.
 *
 * Apply the same segment policy as an ordinary request path. A cwd of
 * `<repo>/.env/` would otherwise launder that denied directory merely by making
 * it the root, even though `.env/child` is refused when reached from `<repo>`.
 */
function rootIsDenied(rootReal: string): boolean {
  return isDeniedPath(rootReal.split(path.sep).filter(Boolean).join('/'));
}

/** The session root, freshly resolved. A since-deleted worktree is a clean 404. */
export async function resolveRoot(cwd: string): Promise<string> {
  const pinned = await pinRoot(cwd);
  try {
    return pinned.rootReal;
  } finally {
    await pinned.close();
  }
}

/**
 * A session root held OPEN, so nothing can be substituted underneath it.
 *
 * A resolved root *string* is only a claim about the past. Between validating
 * `cwd` and using it, the directory it names can be renamed away and replaced
 * with a symlink to anywhere — after which every subsequent `open`, `opendir`
 * and `git` spawn that re-walks the string lands outside the tree, having passed
 * containment, the denylist and the gitignore gate on a path that no longer
 * describes the bytes being served. Holding the descriptor makes the root an
 * OBJECT rather than a name: the kernel keeps resolving to the inode we
 * validated, whatever happens to the path afterwards.
 *
 * `dirPath` is the `/proc/<pid>/fd/<n>` alias for that descriptor, which is how
 * the pin is handed to APIs that only speak paths — `opendir`, and `Bun.spawn`'s
 * `cwd` for git. Every caller must close it.
 */
export interface PinnedRoot {
  /** Realpath of the root AS PINNED — for reporting and gate decisions only. */
  rootReal: string;
  /** `/proc/<pid>/fd/<n>` — resolves to the pinned inode, not the pathname. */
  dirPath: string;
  close(): Promise<void>;
}

/** True on Linux, where `/proc/<pid>/fd/<n>` gives a path alias for a fd. */
const HAS_PROCFS_PIN = process.platform === 'linux';

function procPath(fd: number): string {
  return `/proc/${process.pid}/fd/${fd}`;
}

/**
 * Open the session root and pin it.
 *
 * `O_NOFOLLOW` is deliberately NOT used on the root itself: a session cwd may
 * legitimately be reached through a symlink (`~/Workspace` → elsewhere is
 * ordinary), and the root is configured by the daemon, not by the request. What
 * matters is that we pin whatever it resolves to ONCE and never re-walk it.
 */
export async function pinRoot(cwd: string): Promise<PinnedRoot> {
  // This is a security precondition, not an optimisation. Listings, Git and
  // the component walk all need a path alias for an already-open descriptor;
  // using `cwd` as a fallback validates one tree and can serve another after a
  // rename/symlink swap. Fail the entire fs surface closed instead.
  if (!HAS_PROCFS_PIN) {
    throw new FsError('denied', 'filesystem viewing requires descriptor-backed procfs support');
  }

  let handle: FileHandle;
  try {
    handle = await open(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    if (isMissing(error) || (error as { code?: string }).code === 'ENOTDIR') {
      // ENOTDIR from O_DIRECTORY means it exists but is not a directory.
      if ((error as { code?: string }).code === 'ENOTDIR') {
        throw new FsError('not_a_directory', 'session cwd is not a directory');
      }
      throw new FsError('not_found', `session cwd is not available: ${cwd}`);
    }
    throw error;
  }

  try {
    // Read the identity of the object we actually hold, not of the name we were
    // given. `pinRoot` has already failed closed unless this fd alias exists.
    const rootReal = await readlink(procPath(handle.fd));
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new FsError('not_a_directory', 'session cwd is not a directory');
    // The chokepoint every entry point shares, so a denied root is refused for
    // listings, content, diffs and changes alike.
    if (rootIsDenied(rootReal)) throw new FsError('denied', 'session cwd is not served');

    return {
      rootReal,
      dirPath: procPath(handle.fd),
      close: async () => {
        await handle.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Which refusal does this symlink deserve — `escapes_root` or `not_a_file`?
 *
 * Purely cosmetic in security terms: the link is refused before this runs. It
 * exists so an out-of-tree link still reports `escapes_root`, which is the
 * message the UI renders as "points outside the session".
 */
/** Was this component a symlink? Message fidelity only — see {@link symlinkRefusal}. */
async function isSymlinkAt(parentProcPath: string, segment: string): Promise<boolean> {
  try {
    return (await lstat(`${parentProcPath}/${segment}`)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function symlinkRefusal(
  pinned: PinnedRoot,
  parentProcPath: string,
  segment: string,
  reportedPath: string,
): Promise<FsError> {
  try {
    const target = await realpath(`${parentProcPath}/${segment}`);
    if (!contains(pinned.rootReal, target)) {
      return new FsError('escapes_root', `path escapes the session root: ${reportedPath}`);
    }
  } catch {
    // Broken link, or resolution raced: refused regardless.
  }
  return new FsError('not_a_file', `symlinks are not served: ${reportedPath}`);
}

/** Identity of one component in the descriptor-backed walk.
 *
 * `dev+ino` detects replacement with another object. `ctimeMs` also detects an
 * ABA rename (old directory moved away, replacement used for the Git policy
 * check, then old directory moved back): a rename changes ctime even when the
 * final name once again resolves to the original inode.
 */
interface ComponentIdentity {
  dev: number;
  ino: number;
  ctimeMs: number;
  mode: number;
}

function componentIdentity(metadata: Stats): ComponentIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    ctimeMs: metadata.ctimeMs,
    mode: metadata.mode,
  };
}

interface OpenedTarget {
  handle: FileHandle;
  metadata: Stats;
  canonical: string;
  /** Root first, leaf last. */
  identities: ComponentIdentity[];
}

/**
 * Walk `rel` one component at a time, each step relative to the previously
 * opened directory, refusing to traverse a symlink at ANY component.
 *
 * This is the fix for the component-TOCTOU: `realpath` + `open(pathname)`
 * validates one walk and performs a second, and only the second one decides
 * which bytes are served. Here the walk that validates IS the walk that serves —
 * each intermediate directory is opened `O_DIRECTORY|O_NOFOLLOW` from its
 * already-open parent, so a directory swapped for a symlink mid-walk fails
 * (ENOTDIR/ELOOP) instead of redirecting us, and one swapped AFTER we opened it
 * cannot affect the descriptor we already hold.
 *
 * Interior symlinks are refused outright rather than resolved-and-contained.
 * That is a deliberate narrowing: it costs the ability to browse through an
 * in-tree symlinked directory, and buys a containment proof that does not depend
 * on winning a race. The canonical-path gates stay in place for what remains.
 *
 * Returns the open leaf handle plus its `lstat`, or an FsError.
 */
async function openInPinnedRoot(
  pinned: PinnedRoot,
  rel: string,
  options: { wantDirectory?: boolean } = {},
): Promise<OpenedTarget> {
  const segments = rel === '' ? [] : rel.split('/');
  let current = await open(pinned.dirPath, constants.O_RDONLY | constants.O_DIRECTORY);
  let metadata = await current.stat();
  const identities: ComponentIdentity[] = [componentIdentity(metadata)];
  const walked: string[] = [];

  try {
    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1;
      const from = procPath(current.fd);
      const wantDir = !isLeaf || options.wantDirectory === true;
      let next: FileHandle;
      try {
        next = await open(
          `${from}/${segment}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | (wantDir ? constants.O_DIRECTORY : 0),
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        // ELOOP: the component IS a symlink and we refused to follow it.
        // ENOTDIR on a non-leaf: it is a symlink or a file where a directory was
        // required — the swap losing, which is exactly what we want.
        const reported = [...walked, segment].join('/');
        // ELOOP: the component IS a symlink and we refused to follow it.
        // ENOTDIR where a directory was required: either a plain file in the
        // middle of the path, or — with O_DIRECTORY|O_NOFOLLOW — a symlink to a
        // directory, which the kernel reports as ENOTDIR rather than ELOOP.
        // Both are the swap losing, which is the point; `lstat` only decides
        // which refusal to name.
        if (code === 'ELOOP') {
          // Resolving here is safe: it decides a message, never whether bytes
          // are served, so the UI can say "points outside the session" instead
          // of a flat "not a file".
          throw await symlinkRefusal(pinned, from, segment, reported);
        }
        if (code === 'ENOTDIR' && wantDir) {
          if (await isSymlinkAt(from, segment)) throw await symlinkRefusal(pinned, from, segment, reported);
          throw new FsError('not_a_directory', `not a directory: ${isLeaf ? rel : reported}`);
        }
        if (isMissing(error)) throw new FsError('not_found', `no such path: ${rel}`);
        throw error;
      }
      let nextMetadata: Stats;
      try {
        nextMetadata = await next.stat();
      } catch (error) {
        await next.close().catch(() => undefined);
        throw error;
      }
      walked.push(segment);
      await current.close().catch(() => undefined);
      current = next;
      metadata = nextMetadata;
      identities.push(componentIdentity(nextMetadata));
    }

    // Belt and braces: `O_NOFOLLOW` already refused a symlink leaf, and an
    // `fstat` of an open handle cannot report one, but assert it anyway so a
    // future refactor that loosens the open flags fails loudly here.
    if (metadata.isSymbolicLink()) throw new FsError('not_a_file', `symlinks are not served: ${rel}`);
    return { handle: current, metadata, canonical: walked.join('/'), identities };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

function sameComponentWalk(left: readonly ComponentIdentity[], right: readonly ComponentIdentity[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((component, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      component.dev === other.dev &&
      component.ino === other.ino &&
      component.ctimeMs === other.ctimeMs &&
      component.mode === other.mode
    );
  });
}

/**
 * Re-walk the lexical name after Git's ignore check and prove every component
 * is still the object whose descriptor supplied the bytes/directory.
 *
 * Git only accepts pathnames, so this post-check is the binding between its
 * policy verdict and our descriptor walk. A mismatch fails closed; callers may
 * retry from a fresh request/pin once the worktree stops moving.
 */
async function policyPathUnchanged(
  pinned: PinnedRoot,
  rel: string,
  expected: readonly ComponentIdentity[],
  options: { wantDirectory?: boolean } = {},
): Promise<boolean> {
  let reopened: OpenedTarget | undefined;
  try {
    reopened = await openInPinnedRoot(pinned, rel, options);
    return sameComponentWalk(expected, reopened.identities);
  } catch {
    return false;
  } finally {
    await reopened?.handle.close().catch(() => undefined);
  }
}

function changedDuringPolicy(rel: string): FsError {
  return new FsError('not_found', `path changed while its secrets policy was being checked: ${rel}`);
}

function contains(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(`${rootReal}${path.sep}`);
}

/**
 * Root-relative CANONICAL path of a contained target, in the same slash-joined
 * shape the gates expect (`''` for the root itself).
 *
 * This exists because the gates must never be judged on the lexical path alone.
 * An in-root symlinked directory — `alias -> .git`, or `alias -> build/` in a
 * repo that gitignores `build/` — passes containment (its target IS inside the
 * root) and passes `lstat` (`alias/config` is a regular file), while the lexical
 * path `alias/config` matches no denylist entry and no gitignore rule. Gating
 * both the lexical path and this canonical one is what closes that bypass, so
 * every caller that has a realpath must pass it to the gates.
 */
function canonicalRel(rootReal: string, targetReal: string): string {
  if (targetReal === rootReal) return '';
  if (!contains(rootReal, targetReal)) return '';
  return targetReal
    .slice(rootReal.length + 1)
    .split(path.sep)
    .join('/');
}

export interface ResolvedTarget {
  rootReal: string;
  /** Normalised path relative to the root. */
  rel: string;
  /** Absolute path after realpath, guaranteed inside the root. */
  absolute: string;
}

/**
 * Resolve a validated relative path inside the root, via the pinned walk.
 *
 * Kept for callers that only want the resolved location. The `absolute` it
 * reports is a NAME, derived from the walk that proved containment — anything
 * that goes on to read bytes must use the walk's handle instead (see
 * {@link readFileView}), because a name can be redirected the moment it is
 * returned. Any symlinked component raises `not_a_file` or `escapes_root`.
 */
export async function resolveInRoot(cwd: string, relativePath: string | undefined): Promise<ResolvedTarget> {
  const pinned = await pinRoot(cwd);
  try {
    const rootReal = pinned.rootReal;
    const rel = normalizeRelativePath(relativePath);
    if (rel === '') return { rootReal, rel, absolute: rootReal };

    const opened = await openInPinnedRoot(pinned, rel);
    try {
      return { rootReal, rel, absolute: path.join(rootReal, opened.canonical) };
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  } finally {
    await pinned.close();
  }
}

function entryType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntryType | undefined {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return undefined; // fifo/socket/device — nothing this viewer can show
}

/** One level of a directory, dirs first then files, each name once. */
export async function listDirectory(
  cwd: string,
  relativePath?: string,
  options: {
    /** @internal Test-only barrier; see {@link AfterValidationHook}. */ afterValidation?: AfterValidationHook;
  } = {},
): Promise<FsListing> {
  const pinned = await pinRoot(cwd);
  try {
    return await listInPinnedRoot(pinned, relativePath, options);
  } finally {
    await pinned.close();
  }
}

async function listInPinnedRoot(
  pinned: PinnedRoot,
  relativePath?: string,
  options: { afterValidation?: AfterValidationHook } = {},
): Promise<FsListing> {
  const rootReal = pinned.rootReal;
  const rel = normalizeRelativePath(relativePath);

  // First half of the policy/object binding. A directory can be renamed away
  // after this check, so the same gate runs again after its descriptor is open;
  // either verdict refuses. This catches both directions of a swap: ignored
  // original → unignored replacement, and the reverse.
  let ignoredBeforeOpen = false;
  if (rel !== '') {
    try {
      ignoredBeforeOpen = (await gitIgnoredPaths(pinned.dirPath, [rel])).has(rel);
    } catch {
      ignoredBeforeOpen = true;
    }
  }

  // Open the directory THROUGH the pinned root, component by component, and keep
  // the handle: everything below reads from that descriptor, so a parent renamed
  // and symlinked away mid-request cannot redirect the enumeration.
  const target = rel === '' ? undefined : await openInPinnedRoot(pinned, rel, { wantDirectory: true });
  const dirPath = target ? procPath(target.handle.fd) : pinned.dirPath;

  try {
    // Both paths, for the same reason the content gate checks both: descending
    // into `alias/` where `alias -> .git` is lexically innocent but canonically
    // the object store. Interior symlinks are now refused outright by the walk,
    // so these agree — the canonical check stays as defence in depth.
    const canonicalDir = target?.canonical ?? '';
    if (isDeniedPath(rel) || isDeniedPath(canonicalDir)) throw new FsError('denied', `path is not served: ${rel}`);

    if (target && !target.metadata.isDirectory()) {
      throw new FsError('not_a_directory', `not a directory: ${rel || '.'}`);
    }

    // Validated and pinned, not yet enumerated — the listing equivalent of the
    // file/diff barrier. Routes never pass this.
    await options.afterValidation?.();

    // Refuse to ENUMERATE a gitignored directory, not just to serve its files.
    // The UI renders ignored dirs as inert, but a token holder calls the endpoint
    // directly: `?path=build` would otherwise walk the whole ignored tree, and the
    // names in it (`build/prod-credentials.json`) are themselves the leak. Gate 5
    // has to live on the daemon side, exactly like gate 4.
    let ignoredAfterOpen = false;
    if (rel !== '') {
      const candidates = [rel, canonicalDir].filter((candidate, index, all) => {
        return candidate.length > 0 && all.indexOf(candidate) === index;
      });
      try {
        const ignoredDirs = await gitIgnoredPaths(pinned.dirPath, candidates);
        ignoredAfterOpen = candidates.some(candidate => ignoredDirs.has(candidate));
      } catch {
        // `gitIgnoredPaths` already returns an empty set outside a repository.
        // Reaching this catch therefore means a repository exists but Git could
        // not prove the directory unignored (timeout, corrupt index, etc.). Keep
        // the content gate's fail-closed rule for enumeration too.
        ignoredAfterOpen = true;
      }
    }

    if (ignoredBeforeOpen || ignoredAfterOpen) throw new FsError('ignored', `path is not served: ${rel}`);
    if (target && !(await policyPathUnchanged(pinned, rel, target.identities, { wantDirectory: true }))) {
      throw changedDuringPolicy(rel);
    }

    return await enumerate(pinned, rel, dirPath, rootReal);
  } finally {
    await target?.handle.close().catch(() => undefined);
  }
}

async function enumerate(pinned: PinnedRoot, rel: string, dirPath: string, rootReal: string): Promise<FsListing> {
  // Stream the directory and stop one past the cap, so the advertised limit
  // bounds real memory and latency. `readdir()` would materialise all million
  // entries of a node_modules-scale directory before the slice, which makes the
  // cap decorative and hands a token holder a cheap allocation amplifier.
  const kept: Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }> = [];
  let truncated = false;
  try {
    // `dirPath` is the pinned descriptor's own path, so this enumerates the
    // directory we validated even if its name now points elsewhere.
    const dir = await opendir(dirPath);
    try {
      for await (const dirent of dir) {
        if (kept.length >= MAX_LISTING_ENTRIES) {
          truncated = true; // one dirent past the cap is all we need to know
          break;
        }
        kept.push(dirent);
      }
    } finally {
      // Breaking out of `for await` already closes the handle, and a second
      // close then throws (or returns undefined rather than a promise).
      try {
        await dir.close();
      } catch {
        // already closed by the iterator
      }
    }
  } catch (error) {
    if (isMissing(error)) throw new FsError('not_found', `no such directory: ${rel || '.'}`);
    throw error;
  }

  // The walk refuses interior symlinks, so this directory's canonical location
  // inside the root is exactly the path that was asked for.
  const canonicalDir = rel;
  // Children are named relative to the PINNED directory, so every per-child
  // `lstat`/`realpath` below resolves through the descriptor we validated rather
  // than through a pathname that may since have been redirected.
  const absolute = dirPath;
  const cwd = pinned.dirPath;
  const entries: FsEntry[] = [];
  // Each entry is judged on every path that names its bytes: the lexical child
  // path, its canonical location in this directory, and — for a symlink — the
  // canonical path of what it points at.
  const candidatesByEntry = new Map<FsEntry, string[]>();
  const ignoreCandidates: string[] = [];

  for (const dirent of kept) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    const type = entryType(dirent);
    if (!type) continue;
    const entry: FsEntry = { name: dirent.name, type };
    const candidates = new Set<string>([childRel]);
    const childCanonical = canonicalDir ? `${canonicalDir}/${dirent.name}` : dirent.name;
    candidates.add(childCanonical);

    if (type === 'symlink') {
      // A symlink's own metadata is useless to the viewer; what matters is
      // whether its target stays inside the tree — and what that target IS,
      // since `alias -> .git` must be badged as denied even though the name
      // `alias` is innocent.
      try {
        const linkReal = await realpath(path.join(absolute, dirent.name));
        if (!contains(rootReal, linkReal)) {
          entry.escapes = true;
        } else {
          candidates.add(canonicalRel(rootReal, linkReal));
          const linkStat = await stat(linkReal);
          entry.size = linkStat.size;
          entry.mtime = linkStat.mtime.toISOString();
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        entry.escapes = true; // broken link: nothing to serve either way
      }
    } else {
      try {
        const childStat = await lstat(path.join(absolute, dirent.name));
        entry.size = childStat.size;
        entry.mtime = childStat.mtime.toISOString();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }

    const paths = [...candidates].filter(candidate => candidate.length > 0);
    if (paths.some(candidate => isDeniedPath(candidate))) entry.denied = true;

    // Denied entries are still classified: the UI shows both badges, and
    // "denied" is about serving bytes, not about what we can say about a path.
    // Escaping symlinks are excluded — their in-root name tells git nothing.
    if (!entry.escapes) {
      candidatesByEntry.set(entry, paths);
      ignoreCandidates.push(...paths);
    }
    entries.push(entry);
  }

  // One batched check-ignore for the whole directory rather than one spawn per
  // entry. Never fatal: a repo we cannot interrogate simply has no ignore data,
  // and gate 1 plus containment still apply.
  let ignored: Set<string>;
  try {
    ignored = await gitIgnoredPaths(cwd, ignoreCandidates);
  } catch {
    ignored = new Set();
  }
  for (const entry of entries) {
    const paths = candidatesByEntry.get(entry) ?? [];
    if (paths.some(candidate => ignored.has(candidate))) entry.ignored = true;
  }

  entries.sort((left, right) => {
    const leftDir = left.type === 'dir' ? 0 : 1;
    const rightDir = right.type === 'dir' ? 0 : 1;
    if (leftDir !== rightDir) return leftDir - rightDir;
    return left.name.localeCompare(right.name);
  });

  return { root: rootReal, path: rel, entries, ...(truncated ? { truncated: true } : {}) };
}

/** NUL inside the sniff window means "do not try to render this as text". */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0);
}

/**
 * Run both secrets gates. `denied` means the hard denylist ("never served");
 * `ignored` means the gitignore gate. They are distinct flags because the UI
 * renders distinct badges, and conflating them would label every build artifact
 * a secret.
 *
 * `canonical` is the realpath'd root-relative path when the caller has one, and
 * both paths are gated. Judging only the lexical path lets an in-root symlinked
 * directory launder a denied or ignored target: `alias -> .git` makes
 * `alias/config` lexically innocent. The reported `path` stays the lexical one —
 * that is what the client asked for — but either path failing is a refusal.
 */
async function refusalFor(cwd: string, rel: string, canonical?: string): Promise<FsFileView | undefined> {
  const candidates = canonical && canonical !== rel ? [rel, canonical] : [rel];
  if (candidates.some(candidate => isDeniedPath(candidate))) {
    return { path: rel, size: 0, denied: true, reason: 'denylist' };
  }
  try {
    const ignored = await gitIgnoredPaths(cwd, candidates);
    if (candidates.every(candidate => !ignored.has(candidate))) return undefined;
  } catch {
    // Cannot tell → refuse. A viewer that cannot prove a file is unignored must
    // not claim it is safe to serve.
  }
  return { path: rel, size: 0, ignored: true, reason: 'ignored' };
}

/**
 * Read one file from the working tree (or from `HEAD` with `rev: 'head'`).
 *
 * Size is checked with `stat` before any read, never stream-then-truncate, so a
 * 2 GB file costs a `stat`. Both gates run before the bytes are touched, and
 * `HEAD` reads pass through the same gates — the point of the denylist is not
 * "the working copy is secret", it is "these bytes never leave the machine".
 */
export async function readFileView(
  cwd: string,
  relativePath: string,
  options: {
    rev?: 'head';
    maxBytes?: number;
    /** @internal Test-only barrier; see {@link AfterValidationHook}. */
    afterValidation?: AfterValidationHook;
  } = {},
): Promise<FsFileView> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const pinned = await pinRoot(cwd);
  try {
    if (options.rev === 'head') {
      // Syntactic validation is what contains this read: `HEAD:./../x` really
      // does resolve outside a subdirectory cwd, so `..` must already be gone.
      // The tree read never touches the working copy, so there is no walk here —
      // but git still runs from the PINNED root, so a cwd swapped for a symlink
      // to another repository cannot answer for this one.
      const rel = normalizeRelativePath(relativePath);
      if (rel === '') throw new FsError('invalid_path', 'a file path is required');
      const refusalBeforeRead = await refusalFor(pinned.dirPath, rel);
      if (refusalBeforeRead) return { ...refusalBeforeRead, rev: 'head' };

      const blob = await gitReadHeadBlob(pinned.dirPath, rel, maxBytes);
      // HEAD bytes come from the pinned object database, but ignore policy is
      // worktree state. Recheck after the read so a path that becomes ignored
      // during the request is never returned from the earlier safe verdict.
      const refusalAfterRead = await refusalFor(pinned.dirPath, rel);
      if (refusalAfterRead) return { ...refusalAfterRead, rev: 'head' };
      if (!blob) throw new FsError('not_found', `not in HEAD: ${rel}`);
      if (!blob.bytes) return { path: rel, size: blob.size, tooLarge: true, rev: 'head' };
      if (looksBinary(blob.bytes)) return { path: rel, size: blob.size, binary: true, rev: 'head' };
      return { path: rel, size: blob.size, content: new TextDecoder().decode(blob.bytes), rev: 'head' };
    }

    const rel = normalizeRelativePath(relativePath);
    if (rel === '') throw new FsError('invalid_path', 'a file path is required');

    // Evaluate policy before the descriptor walk, then again afterwards. The
    // first verdict belongs to the object named when the request began; the
    // second belongs to whatever the lexical name resolves to after the walk.
    // Retaining both is what prevents a rename/replacement from evaluating the
    // gate on one tree while the pinned descriptor supplies another tree's
    // bytes. A refusal on either side wins.
    const refusalBeforeOpen = await refusalFor(pinned.dirPath, rel);

    // The walk IS the containment proof and the open: every component is opened
    // no-follow from its already-open parent, and the handle it returns is the
    // object the bytes come from. No pathname is re-walked, so there is no
    // window in which a parent (or the root) can be substituted.
    const opened = await openInPinnedRoot(pinned, rel);
    try {
      const metadata = opened.metadata;
      if (metadata.isDirectory()) throw new FsError('not_a_file', `not a regular file: ${rel}`);
      if (!metadata.isFile()) throw new FsError('not_a_file', `not a regular file: ${rel}`);

      // Validated, not yet read — the window. See AfterValidationHook.
      await options.afterValidation?.();

      // Gate the canonical path too, not just the lexical one. Interior symlinks
      // are refused by the walk, so with this mechanism the two agree; the check
      // stays because the gates must never depend on that invariant holding.
      const refusalAfterOpen = await refusalFor(pinned.dirPath, rel, opened.canonical);
      const refusal = refusalBeforeOpen ?? refusalAfterOpen;
      if (refusal) return { ...refusal, size: metadata.size, mtime: metadata.mtime.toISOString() };
      if (!(await policyPathUnchanged(pinned, rel, opened.identities))) throw changedDuringPolicy(rel);

      const view: FsFileView = { path: rel, size: metadata.size, mtime: metadata.mtime.toISOString() };
      if (metadata.size > maxBytes) return { ...view, tooLarge: true };

      const bytes = await readOpenFile(opened.handle, metadata.size, maxBytes);
      if (bytes === undefined) return { ...view, tooLarge: true };
      if (looksBinary(bytes)) return { ...view, binary: true };
      return { ...view, content: new TextDecoder().decode(bytes) };
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  } finally {
    await pinned.close();
  }
}

/**
 * Read the bytes of an ALREADY-OPEN regular file.
 *
 * Taking a handle rather than a path is the whole point: `lstat` then `readFile`
 * checks one path and reads another, and everything in between — the leaf, any
 * parent directory, the root itself — can be replaced with a symlink pointing
 * anywhere. Here the descriptor was obtained by the same walk that proved
 * containment, so nothing is resolved a second time and there is no window.
 *
 * Returns undefined when the file exceeds the cap.
 */
async function readOpenFile(handle: FileHandle, size: number, maxBytes: number): Promise<Uint8Array | undefined> {
  if (size > maxBytes) return undefined;
  const bytes = new Uint8Array(size);
  let read = 0;
  while (read < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, read, bytes.byteLength - read, read);
    if (bytesRead === 0) break; // truncated under us; serve what exists
    read += bytesRead;
  }
  return read === bytes.byteLength ? bytes : bytes.subarray(0, read);
}

/** Changes under the session cwd. Non-git cwd → `{repo: false}`. */
export async function readChanges(cwd: string): Promise<GitChangesView> {
  const pinned = await pinRoot(cwd);
  try {
    // git runs against the pinned descriptor, so the status it reports is the
    // status of the tree that passed the root gate — not of whatever the cwd
    // pathname points at by the time the child spawns.
    return await gitChanges(pinned.dirPath);
  } finally {
    await pinned.close();
  }
}

export interface FsDiffView {
  path: string;
  diff: string;
  kind: 'tracked' | 'untracked' | 'none';
  truncated?: boolean;
  /** Hard denylist. */
  denied?: boolean;
  /** Gitignore gate. Same split as {@link FsFileView}. */
  ignored?: boolean;
  reason?: 'denylist' | 'ignored';
}

/**
 * Unified diff for one path, behind the same two gates as content — a diff of a
 * secret is a secret.
 *
 * A DELETED file is the common case that must still work: it is exactly what
 * the Changes list shows a ` D` row for, and it no longer exists on disk, so
 * requiring `realpath` to succeed would 404 every deletion. The path is
 * therefore resolved when it exists (full containment) and otherwise admitted
 * only when git confirms it is tracked in this cwd — which is itself a
 * containment proof, since `ls-files` runs with literal pathspecs relative to
 * the session cwd. An arbitrary missing path still 404s.
 */
export async function readDiff(
  cwd: string,
  relativePath: string,
  options: {
    /** @internal Test-only barrier; see {@link AfterValidationHook}. */
    afterValidation?: AfterValidationHook;
  } = {},
): Promise<FsDiffView> {
  const pinned = await pinRoot(cwd);
  try {
    const rel = normalizeRelativePath(relativePath);
    if (rel === '') throw new FsError('invalid_path', 'a file path is required');

    // Same two-sided policy binding as readFileView. Do not return early on a
    // refusal yet: retaining the pre-open verdict while the deterministic hook
    // swaps the parent is what proves an ignored original cannot be laundered
    // by an unignored replacement.
    const refusalBeforeOpen = await refusalFor(pinned.dirPath, rel);

    // Hold the working-tree side OPEN for the rest of the request. The walk both
    // contains the path and proves the leaf is a regular file, refusing any
    // symlinked component on the way; keeping the descriptor means the bytes
    // diffed below come from the very object that passed those checks, with no
    // second resolution of the name and so no window to swap anything — not a
    // parent, not the root, and not the leaf itself.
    let opened: Awaited<ReturnType<typeof openInPinnedRoot>> | undefined;
    try {
      opened = await openInPinnedRoot(pinned, rel);
      if (!opened.metadata.isFile()) {
        throw new FsError('not_a_file', `not a regular file: ${rel}`);
      }
    } catch (error) {
      await opened?.handle.close().catch(() => undefined);
      opened = undefined;
      // A missing path is the deleted-file case the Changes list depends on; the
      // index answers for it below. Every other refusal is final.
      if (error instanceof FsError && error.code !== 'not_found') throw error;
      if (!(error instanceof FsError) && !isMissing(error)) throw error;
    }

    try {
      // The window a name-reopening implementation would lose in: validated, but
      // not yet read. Tests swap the tree here; routes never pass this.
      await options.afterValidation?.();

      const tracked = await gitIsTracked(pinned.dirPath, rel).catch(() => false);

      const refusalAfterOpen = await refusalFor(pinned.dirPath, rel, opened?.canonical);
      const refusal = refusalBeforeOpen ?? refusalAfterOpen;
      if (refusal) {
        // refusalFor only ever reports the two content gates here; `escapes` is
        // raised as an FsError by the walk above, never as a view.
        const reason = refusal.denied ? ('denylist' as const) : ('ignored' as const);
        return {
          path: rel,
          diff: '',
          kind: 'none',
          ...(refusal.denied ? { denied: true } : { ignored: true }),
          reason,
        };
      }
      if (opened && !(await policyPathUnchanged(pinned, rel, opened.identities))) {
        throw changedDuringPolicy(rel);
      }

      const repo = await gitRepoInfo(pinned.dirPath);
      if (!repo.repo) {
        if (!opened) throw new FsError('not_found', `no such path: ${rel}`);
        return { path: rel, diff: '', kind: 'none' };
      }

      // Both sides are bytes WE read: HEAD from the object database (content
      // addressed, no worktree walk) and the working tree from the descriptor
      // above. git only formats them. Handing git the pathname instead is what
      // leaked — see gitDiffSnapshots for the observed mixing.
      // Ask HEAD even when the index no longer tracks the path. `git rm` removes
      // it from the index, but the Changes list still advertises the staged
      // deletion and HEAD is the exact old side the reviewer needs. Exact-path
      // matching inside gitHeadEntry keeps a missing directory pathspec from
      // being mistaken for one deleted file.
      const head = await gitHeadEntry(pinned.dirPath, rel, MAX_DIFF_SIDE_BYTES);
      if (!opened && !tracked && !head) throw new FsError('not_found', `no such path: ${rel}`);
      const working = opened ? await readOpenFile(opened.handle, opened.metadata.size, MAX_DIFF_SIDE_BYTES) : undefined;

      const kind = tracked || head ? 'tracked' : 'untracked';

      // Either side over the cap: report truncation rather than diffing a
      // partial file, which would render as spurious removals.
      if ((opened && !working) || head?.truncated) {
        return { path: rel, diff: '', kind, truncated: true };
      }

      const mode = opened?.metadata.mode ?? 0;
      const result = await gitDiffSnapshots(
        rel,
        head ? { bytes: head.bytes, mode: head.mode } : undefined,
        working ? { bytes: working, mode: (mode & 0o111) === 0 ? 0o100644 : 0o100755 } : undefined,
      );
      return {
        path: rel,
        diff: result.diff,
        kind,
        ...(result.truncated ? { truncated: true } : {}),
      };
    } finally {
      await opened?.handle.close().catch(() => undefined);
    }
  } finally {
    await pinned.close();
  }
}

/** Does this cwd sit in a git worktree? (`repo: false` hides diff affordances.) */
export async function isRepo(cwd: string): Promise<boolean> {
  const pinned = await pinRoot(cwd);
  try {
    return (await gitRepoInfo(pinned.dirPath)).repo;
  } finally {
    await pinned.close();
  }
}
