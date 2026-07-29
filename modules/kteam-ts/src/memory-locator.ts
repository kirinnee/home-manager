import { randomUUID } from 'node:crypto';
import { rmSync, statfsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * RAM-backed file locators for bytes that must be readable by another process
 * but must never reach a disk.
 *
 * The agent handoff in kteam is path-only: every send path formats a filesystem
 * path for the TUI to open. Decrypted attachment bytes therefore have to exist
 * at *some* path, and the only honest way to satisfy "never written to disk" is
 * to put that path on a filesystem that is memory: Linux tmpfs, normally
 * `/dev/shm`. Pages live in RAM (they can be pushed to swap, which is the one
 * caveat worth stating out loud) and vanish on reboot.
 *
 * A memfd + `/proc/<pid>/fd/<n>` locator was rejected: with
 * `kernel.yama.ptrace_scope = 1` — the default on this fleet's boxes — another
 * same-user process that is not a descendant of the daemon cannot open that
 * path, and tmux-hosted agents are exactly that case. It would have produced a
 * path that looks valid and fails to open, which is the failure mode the house
 * rules single out.
 */

/** statfs(2) magics for the filesystems that are actually RAM. */
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

const RAM_FILESYSTEM_MAGICS = new Set<number>([TMPFS_MAGIC, RAMFS_MAGIC]);

const DEFAULT_CANDIDATES = ['/dev/shm'];

export interface MemoryBackedFile {
  /** Absolute path another same-user process can open. Never on a disk. */
  readonly path: string;
  readonly bytes: number;
  /** Zero the pages, then remove the file and its directory. Idempotent. */
  release(): Promise<void>;
}

export interface MemoryBackedFileStoreOptions {
  /** Explicit RAM-backed root. Still verified — an unverifiable override is
   * refused rather than silently accepted. */
  root?: string;
}

function isRamBacked(directory: string): boolean {
  try {
    return RAM_FILESYSTEM_MAGICS.has(Number(statfsSync(directory).type));
  } catch {
    // Unverifiable is not the same as fine. Refuse.
    return false;
  }
}

/**
 * Pick a directory that is provably a memory filesystem, or return undefined.
 *
 * Order: explicit option, `KTEAM_MEMORY_DIR`, then `/dev/shm`. Every candidate —
 * including the explicit ones — has to pass the statfs check, so a misconfigured
 * override degrades to "no locator available" instead of quietly writing
 * plaintext onto a disk.
 */
export function resolveMemoryBackedRoot(override?: string): string | undefined {
  const candidates = [override, process.env['KTEAM_MEMORY_DIR'], ...DEFAULT_CANDIDATES].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isRamBacked(resolved)) return resolved;
  }
  return undefined;
}

function assertSingleComponent(filename: string): string {
  const leaf = path.basename(filename);
  if (
    !leaf ||
    leaf !== filename ||
    leaf === '.' ||
    leaf === '..' ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error('memory-backed filename must be a single safe path component');
  }
  return leaf;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to somebody else — still "alive"
    // for the purpose of not deleting its directory.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Owner-only directory of RAM-backed files, with guaranteed cleanup.
 *
 * Every entry is `<root>/kteam-unlocked-<uid>/<pid>-<uuid>/<filename>` with the
 * shared directory and each entry directory at 0700 and the file at 0600. The
 * shared directory sits in world-writable `/dev/shm`, so it is re-verified on
 * every use: if anything else owns it or its mode has been widened, this store
 * refuses to run rather than trusting it.
 *
 * Cleanup has three layers, because one is never enough for bytes like these:
 * `release()` on the caller's own schedule, a synchronous `process.on('exit')`
 * sweep of everything still live, and a startup sweep of entry directories whose
 * owning pid is gone (a `SIGKILL`ed daemon leaves those behind).
 */
export class MemoryBackedFileStore {
  private readonly root: string | undefined;
  private readonly baseDir: string | undefined;
  private readonly live = new Set<string>();
  private exitHandler: (() => void) | undefined;
  private sweptStale = false;
  private disposed = false;

  constructor(options: MemoryBackedFileStoreOptions = {}) {
    this.root = resolveMemoryBackedRoot(options.root);
    this.baseDir =
      this.root === undefined ? undefined : path.join(this.root, `kteam-unlocked-${process.getuid?.() ?? 0}`);
  }

  /** False when no memory filesystem could be verified (notably macOS, which has
   * no `/dev/shm`). Callers must surface that as a named reason, never fall back
   * to a disk path. */
  get available(): boolean {
    return this.baseDir !== undefined && !this.disposed;
  }

  /** The verified RAM-backed directory, for diagnostics and tests. */
  get directory(): string | undefined {
    return this.baseDir;
  }

  private async ensureBaseDir(): Promise<string> {
    const baseDir = this.baseDir;
    if (baseDir === undefined) throw new Error('no RAM-backed filesystem is available for decrypted attachments');
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    const metadata = await lstat(baseDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('the RAM-backed attachment directory is not a regular directory');
    }
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid) {
      throw new Error('the RAM-backed attachment directory is owned by another user');
    }
    // `mkdir` honours the umask, and a pre-existing directory keeps whatever mode
    // it had. Force it rather than hoping.
    if ((metadata.mode & 0o077) !== 0) await chmod(baseDir, 0o700);
    if (!this.sweptStale) {
      this.sweptStale = true;
      await this.sweepStale(baseDir);
    }
    return baseDir;
  }

  /** Remove entry directories left behind by daemons that are no longer running. */
  private async sweepStale(baseDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pid = Number.parseInt(entry.name.split('-', 1)[0] ?? '', 10);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || processIsAlive(pid)) continue;
      await rm(path.join(baseDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private registerExitCleanup(): void {
    if (this.exitHandler) return;
    // Synchronous by necessity: 'exit' listeners cannot await. This is the last
    // line of defence for an orderly shutdown that skipped dispose().
    this.exitHandler = () => {
      for (const directory of this.live) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          /* nothing useful can be done from an exit handler */
        }
      }
      this.live.clear();
    };
    process.on('exit', this.exitHandler);
  }

  /**
   * Write `bytes` to a fresh RAM-backed file named `filename` and return its
   * path. The bytes are written with 0600 from creation — there is no window in
   * which the file is readable by anyone else.
   */
  async materialize(filename: string, bytes: Uint8Array): Promise<MemoryBackedFile> {
    if (this.disposed) throw new Error('this memory-backed file store has been disposed');
    const leaf = assertSingleComponent(filename);
    const baseDir = await this.ensureBaseDir();
    const entryDir = path.join(baseDir, `${process.pid}-${randomUUID()}`);
    await mkdir(entryDir, { mode: 0o700 });
    this.live.add(entryDir);
    this.registerExitCleanup();

    const filePath = path.join(entryDir, leaf);
    let handle;
    try {
      handle = await open(filePath, 'wx', 0o600);
      await handle.write(bytes, 0, bytes.byteLength, 0);
    } catch (error) {
      this.live.delete(entryDir);
      await handle?.close().catch(() => undefined);
      await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();

    let released = false;
    const store = this;
    return {
      path: filePath,
      bytes: bytes.byteLength,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        store.live.delete(entryDir);
        await zeroAndRemove(filePath, bytes.byteLength, entryDir);
      },
    };
  }

  /** Release everything this store still owns and stop listening for exit. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const directories = [...this.live];
    this.live.clear();
    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = undefined;
    }
    await Promise.all(
      directories.map(directory => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
    );
  }
}

/**
 * Overwrite the file's pages with zeros before unlinking it. On tmpfs the write
 * lands on the very pages that held the plaintext, so the bytes are gone even if
 * something else still holds the inode open.
 */
async function zeroAndRemove(filePath: string, bytes: number, entryDir: string): Promise<void> {
  try {
    const handle = await open(filePath, 'r+');
    try {
      const zeros = new Uint8Array(Math.min(bytes, 1024 * 1024));
      for (let offset = 0; offset < bytes; offset += zeros.byteLength) {
        const length = Math.min(zeros.byteLength, bytes - offset);
        await handle.write(zeros, 0, length, offset);
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Already gone, or unwritable: the unlink below is still worth attempting.
  }
  await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
}
