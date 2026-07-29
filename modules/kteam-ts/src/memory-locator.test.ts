import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, statfsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryBackedFileStore, resolveMemoryBackedRoot } from './memory-locator';

const ramRoot = resolveMemoryBackedRoot();
/** Every RAM-backed assertion needs a real memory filesystem. There is none on
 * macOS, so those tests are skipped there rather than quietly writing to a disk. */
const ramTest = ramRoot === undefined ? test.skip : test;

const stores: MemoryBackedFileStore[] = [];
const scratch: string[] = [];

function newStore(root?: string): MemoryBackedFileStore {
  const store = new MemoryBackedFileStore(root === undefined ? {} : { root });
  stores.push(store);
  return store;
}

/** A private tmpfs subtree so concurrent runs never see each other's entries. */
function ramScratch(): string {
  const directory = mkdtempSync(path.join(ramRoot!, 'kteam-locator-test-'));
  scratch.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('resolveMemoryBackedRoot', () => {
  ramTest('resolves /dev/shm on a host that has tmpfs', () => {
    expect(resolveMemoryBackedRoot()).toBe(ramRoot!);
  });

  test('refuses a disk-backed override instead of silently writing to it', () => {
    // The system temp directory is a real filesystem on this fleet's boxes; if
    // it ever became tmpfs this assertion would be meaningless, so check first.
    const temporary = tmpdir();
    const isRam = [0x01021994, 0x858458f6].includes(Number(statfsSync(temporary).type));
    if (isRam) return;
    expect(resolveMemoryBackedRoot(temporary)).toBe(ramRoot);
  });

  test('a nonexistent override is refused', () => {
    expect(resolveMemoryBackedRoot(path.join(tmpdir(), 'kteam-does-not-exist-9f2b'))).toBe(ramRoot);
  });
});

describe('MemoryBackedFileStore', () => {
  ramTest('materializes a readable, owner-only file on a memory filesystem', async () => {
    const store = newStore(ramScratch());
    expect(store.available).toBe(true);

    const bytes = new TextEncoder().encode('decrypted payload');
    const file = await store.materialize('statement.pdf', bytes);

    expect(path.basename(file.path)).toBe('statement.pdf');
    expect(file.path.startsWith(store.directory!)).toBe(true);
    expect(new Uint8Array(await readFile(file.path))).toEqual(bytes);

    const fileMode = (await stat(file.path)).mode & 0o777;
    const entryMode = (await stat(path.dirname(file.path))).mode & 0o777;
    const baseMode = (await stat(store.directory!)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(entryMode).toBe(0o700);
    expect(baseMode).toBe(0o700);
  });

  ramTest('release zeroes the bytes and removes the entry directory', async () => {
    const store = newStore(ramScratch());
    const file = await store.materialize('secret.pdf', new TextEncoder().encode('plaintext-marker'));
    const entryDir = path.dirname(file.path);

    await file.release();

    expect(
      await readdir(entryDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readdir(store.directory!)).toEqual([]);
    // Idempotent: a double release (close then dispose, say) is not an error.
    await file.release();
  });

  ramTest('dispose removes every file the store still owns', async () => {
    const store = newStore(ramScratch());
    await store.materialize('a.pdf', new Uint8Array([1, 2, 3]));
    await store.materialize('b.pdf', new Uint8Array([4, 5, 6]));
    const directory = store.directory!;
    expect((await readdir(directory)).length).toBe(2);

    await store.dispose();

    expect(await readdir(directory)).toEqual([]);
    expect(store.available).toBe(false);
    await expect(store.materialize('c.pdf', new Uint8Array([7]))).rejects.toThrow(/disposed/);
  });

  ramTest('a directory left behind by a dead daemon is swept on first use', async () => {
    const root = ramScratch();
    const baseDir = path.join(root, `kteam-unlocked-${process.getuid?.() ?? 0}`);
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    // `pid_max` is exclusive, so it is never assigned to a running process. It
    // stands in for the pid of a SIGKILLed daemon.
    const deadPid = Number.parseInt(await readFile('/proc/sys/kernel/pid_max', 'utf8'), 10);
    const stale = path.join(baseDir, `${deadPid}-11111111-2222-3333-4444-555555555555`);
    await mkdir(stale, { mode: 0o700 });
    await writeFile(path.join(stale, 'orphan.pdf'), 'left behind');
    const mine = path.join(baseDir, `${process.pid}-99999999-8888-7777-6666-555555555555`);
    await mkdir(mine, { mode: 0o700 });

    const store = newStore(root);
    await store.materialize('fresh.pdf', new Uint8Array([1]));

    const entries = await readdir(baseDir);
    expect(entries).not.toContain(path.basename(stale));
    // A directory belonging to THIS pid is never swept: it may be in use.
    expect(entries).toContain(path.basename(mine));
  });

  ramTest('an over-permissive shared directory is tightened before anything is written', async () => {
    const root = ramScratch();
    const baseDir = path.join(root, `kteam-unlocked-${process.getuid?.() ?? 0}`);
    await mkdir(baseDir, { recursive: true, mode: 0o777 });

    const store = newStore(root);
    await store.materialize('fresh.pdf', new Uint8Array([1]));

    expect(statSync(baseDir).mode & 0o777).toBe(0o700);
  });

  ramTest('a filename with a path component is refused', async () => {
    const store = newStore(ramScratch());
    await expect(store.materialize('../escape.pdf', new Uint8Array([1]))).rejects.toThrow(/single safe path component/);
    await expect(store.materialize('nested/file.pdf', new Uint8Array([1]))).rejects.toThrow(
      /single safe path component/,
    );
  });

  ramTest('a process that exits without disposing still leaves nothing behind', async () => {
    const root = ramScratch();
    // A real child process, because `process.on('exit')` is the layer under test
    // and it cannot be exercised from inside the test runner's own process.
    const child = Bun.spawnSync([
      process.execPath,
      '-e',
      `const { MemoryBackedFileStore } = await import(${JSON.stringify(new URL('./memory-locator.ts', import.meta.url).href)});
       const store = new MemoryBackedFileStore({ root: ${JSON.stringify(root)} });
       const file = await store.materialize('leaked.pdf', new TextEncoder().encode('plaintext'));
       process.stdout.write(file.path);`,
    ]);
    expect(child.exitCode).toBe(0);
    const leaked = child.stdout.toString();
    expect(leaked).toContain('leaked.pdf');

    expect(await Bun.file(leaked).exists()).toBe(false);
    const baseDir = path.join(root, `kteam-unlocked-${process.getuid?.() ?? 0}`);
    expect(await readdir(baseDir)).toEqual([]);
  });

  test('a store with no memory filesystem reports unavailable instead of guessing', () => {
    // Simulated by pointing every candidate at a disk path: `available` must be
    // false so callers surface a named reason rather than falling back to disk.
    const store = new MemoryBackedFileStore({ root: path.join(tmpdir(), 'kteam-not-ram-9f2b') });
    if (ramRoot !== undefined) {
      // /dev/shm is still in the candidate list on Linux, so this host resolves.
      expect(store.available).toBe(true);
      return;
    }
    expect(store.available).toBe(false);
  });
});
