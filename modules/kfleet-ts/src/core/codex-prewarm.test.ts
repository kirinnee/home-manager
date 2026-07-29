import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireCodexPrewarmLock,
  type AppServerChild,
  type AppServerSpawnOptions,
  CODEX_THREAD_SOURCE_KINDS,
  prewarmCodexSharedSqlite,
} from './codex-prewarm';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeControls {
  send(message: unknown): void;
  sendRaw(text: string): void;
  finish(code: number): void;
}

interface FakeOptions {
  stderr?: string;
  exitOnEnd?: boolean;
  ignoreSigterm?: boolean;
}

function fakeAppServer(
  handler: (message: Record<string, unknown>, controls: FakeControls) => void = (message, controls) => {
    if (message.id === 1) controls.send({ id: 1, result: { userAgent: 'test' } });
    if (message.id === 2) controls.send({ id: 2, result: { data: [{ id: 'active' }], nextCursor: null } });
    if (message.id === 3) controls.send({ id: 3, result: { data: [], nextCursor: null } });
  },
  options: FakeOptions = {},
): AppServerChild & { writes: string[]; kills: string[]; ended: boolean; controls: FakeControls } {
  const encoder = new TextEncoder();
  const exit = deferred<number>();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let input = '';

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
      if (options.stderr) controller.enqueue(encoder.encode(options.stderr));
    },
  });

  const controls: FakeControls = {
    send: message => controls.sendRaw(`${JSON.stringify(message)}\n`),
    sendRaw: text => {
      if (!finished) stdoutController.enqueue(encoder.encode(text));
    },
    finish: code => {
      if (finished) return;
      finished = true;
      stdoutController.close();
      stderrController.close();
      exit.resolve(code);
    },
  };

  const writes: string[] = [];
  const kills: string[] = [];
  const child = {
    stdin: {
      write(chunk: string | Uint8Array) {
        input += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        while (true) {
          const newline = input.indexOf('\n');
          if (newline < 0) break;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (!line.trim()) continue;
          writes.push(line);
          handler(JSON.parse(line) as Record<string, unknown>, controls);
        }
      },
      async flush() {},
      async end() {
        child.ended = true;
        if (options.exitOnEnd !== false) controls.finish(0);
      },
    },
    stdout,
    stderr,
    exited: exit.promise,
    kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
      kills.push(signal);
      if (signal === 'SIGTERM' && options.ignoreSigterm) return;
      controls.finish(signal === 'SIGKILL' ? 137 : 143);
    },
    writes,
    kills,
    ended: false,
    controls,
  } satisfies AppServerChild & { writes: string[]; kills: string[]; ended: boolean; controls: FakeControls };
  return child;
}

const tempRoot = (): string => mkdtempSync(path.join(os.tmpdir(), 'kfleet-prewarm-'));

describe('prewarmCodexSharedSqlite protocol', () => {
  test('initializes, repairs active + archived roots with every source kind, and never starts/resumes a thread', async () => {
    const root = tempRoot();
    const child = fakeAppServer();
    let spawned: AppServerSpawnOptions | undefined;

    const result = await prewarmCodexSharedSqlite({
      sharedRoot: root,
      timeoutMs: 1_000,
      shutdownGraceMs: 5,
      codexBin: '/opt/codex',
      spawn: options => {
        spawned = options;
        return child;
      },
    });

    expect(spawned?.cmd).toEqual(['/opt/codex', 'app-server', '--stdio']);
    expect(spawned?.cwd).toBe(root);
    expect(spawned?.env.CODEX_HOME).toBe(root);
    expect(spawned?.env.CODEX_SQLITE_HOME).toBe(path.join(root, 'sqlite'));
    expect(result).toMatchObject({
      sqliteDir: path.join(root, 'sqlite'),
      activeThreadsReturned: 1,
      archivedThreadsReturned: 0,
    });

    const messages = child.writes.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(messages.map(message => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/list',
      'thread/list',
    ]);
    expect(messages[0]).toMatchObject({
      id: 1,
      params: { clientInfo: { name: 'kfleet-prewarm', title: 'kfleet' }, capabilities: {} },
    });
    expect(messages[1]).not.toHaveProperty('id');
    const active = messages[2].params as Record<string, unknown>;
    const archived = messages[3].params as Record<string, unknown>;
    expect(active).toMatchObject({ archived: false, limit: 1, useStateDbOnly: false });
    expect(archived).toMatchObject({ archived: true, limit: 1, useStateDbOnly: false });
    expect(active.sourceKinds).toEqual([...CODEX_THREAD_SOURCE_KINDS]);
    expect(archived.sourceKinds).toEqual([...CODEX_THREAD_SOURCE_KINDS]);
    expect(messages.some(message => /^(thread\/(start|resume|fork)|turn\/)/.test(String(message.method)))).toBe(false);

    expect(existsSync(path.join(root, 'sessions'))).toBe(true);
    expect(existsSync(path.join(root, 'archived_sessions'))).toBe(true);
    expect(existsSync(path.join(root, 'sqlite'))).toBe(true);
    expect(existsSync(path.join(root, '.sqlite-prewarm-lock.sqlite3'))).toBe(true);
    expect(child.ended).toBe(true);
    expect(child.kills).toEqual([]);
  });

  test('handles notifications, multiple messages per chunk, and responses split across chunks', async () => {
    const child = fakeAppServer((message, controls) => {
      if (message.id === 1) {
        controls.sendRaw('{"method":"server/ready","params":{}}\n{"id":1,"res');
        controls.sendRaw('ult":{}}\n');
      }
      if (message.id === 2) controls.sendRaw('{"method":"thread/status","params":{}}\n{"id":2,"result":{"data":[]}}\n');
      if (message.id === 3) controls.send({ id: 3, result: { data: [] } });
    });

    await expect(
      prewarmCodexSharedSqlite({
        sharedRoot: tempRoot(),
        timeoutMs: 1_000,
        shutdownGraceMs: 5,
        spawn: () => child,
      }),
    ).resolves.toMatchObject({ activeThreadsReturned: 0, archivedThreadsReturned: 0 });
  });

  test('reports RPC errors with the failed root and cleans up the lock', async () => {
    const root = tempRoot();
    const child = fakeAppServer((message, controls) => {
      if (message.id === 1) controls.send({ id: 1, result: {} });
      if (message.id === 2) controls.send({ id: 2, error: { code: -32000, message: 'repair failed' } });
    });

    await expect(
      prewarmCodexSharedSqlite({ sharedRoot: root, timeoutMs: 1_000, shutdownGraceMs: 5, spawn: () => child }),
    ).rejects.toThrow(/thread\/list active failed \(code -32000\): repair failed/);
    expect(existsSync(path.join(root, '.sqlite-prewarm-lock.sqlite3'))).toBe(true);
  });

  test('reports malformed protocol output', async () => {
    const child = fakeAppServer((message, controls) => {
      if (message.id === 1) controls.sendRaw('{definitely-not-json}\n');
    });
    await expect(
      prewarmCodexSharedSqlite({
        sharedRoot: tempRoot(),
        timeoutMs: 1_000,
        shutdownGraceMs: 5,
        spawn: () => child,
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  test('reports early child exit with stderr and paths', async () => {
    const root = tempRoot();
    const child = fakeAppServer(
      (message, controls) => {
        if (message.id === 1) controls.finish(23);
      },
      { stderr: 'database open failed' },
    );
    await expect(
      prewarmCodexSharedSqlite({ sharedRoot: root, timeoutMs: 1_000, shutdownGraceMs: 5, spawn: () => child }),
    ).rejects.toThrow(new RegExp(`(exited with code 23|closed stdout)[\\s\\S]*database open failed[\\s\\S]*${root}`));
  });

  test('reports spawn failures and releases the lock', async () => {
    const root = tempRoot();
    await expect(
      prewarmCodexSharedSqlite({
        sharedRoot: root,
        timeoutMs: 1_000,
        shutdownGraceMs: 5,
        codexBin: '/missing/codex',
        spawn: () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toThrow(/failed to start \/missing\/codex app-server --stdio: ENOENT/);
    expect(existsSync(path.join(root, '.sqlite-prewarm-lock.sqlite3'))).toBe(true);
  });

  test('times out, terminates the child, and cleans up its lock', async () => {
    const root = tempRoot();
    const child = fakeAppServer(() => {}, { exitOnEnd: false });
    await expect(
      prewarmCodexSharedSqlite({ sharedRoot: root, timeoutMs: 15, shutdownGraceMs: 2, spawn: () => child }),
    ).rejects.toThrow(/initialize timed out after 15 ms/);
    expect(child.kills).toContain('SIGTERM');
    expect(existsSync(path.join(root, '.sqlite-prewarm-lock.sqlite3'))).toBe(true);
  });

  test('escalates clean shutdown to SIGKILL when the server ignores SIGTERM', async () => {
    const child = fakeAppServer(undefined, { exitOnEnd: false, ignoreSigterm: true });
    await prewarmCodexSharedSqlite({
      sharedRoot: tempRoot(),
      timeoutMs: 1_000,
      shutdownGraceMs: 2,
      spawn: () => child,
    });
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('Codex prewarm cross-process lock', () => {
  test('a held transaction rejects concurrent acquisition and release makes it reusable', () => {
    const lockPath = path.join(tempRoot(), 'prewarm-lock.sqlite3');
    const first = acquireCodexPrewarmLock(lockPath);

    expect(() => acquireCodexPrewarmLock(lockPath)).toThrow(
      new RegExp(`another Codex SQLite prewarm is already running; lock database: ${lockPath}`),
    );
    expect(existsSync(lockPath)).toBe(true);

    first.release();
    first.release(); // idempotent
    const next = acquireCodexPrewarmLock(lockPath);
    next.release();
    expect(existsSync(lockPath)).toBe(true); // persistent coordination DB
  });

  test('a crashed process auto-releases its SQLite transaction lock', async () => {
    const root = tempRoot();
    const lockPath = path.join(root, 'prewarm-lock.sqlite3');
    const readyPath = path.join(root, 'ready');
    const moduleUrl = new URL('./codex-prewarm.ts', import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { acquireCodexPrewarmLock } from ${JSON.stringify(moduleUrl)};
         import { writeFileSync } from 'node:fs';
         const held = acquireCodexPrewarmLock(${JSON.stringify(lockPath)});
         writeFileSync(${JSON.stringify(readyPath)}, 'ready');
         await new Promise(() => {});`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(readyPath)) {
      child.kill('SIGKILL');
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      throw new Error(`lock-holder child did not become ready: ${stderr}`);
    }

    expect(() => acquireCodexPrewarmLock(lockPath)).toThrow(/already running/);
    child.kill('SIGKILL');
    await child.exited;

    const recovered = acquireCodexPrewarmLock(lockPath);
    recovered.release();
  });
});
