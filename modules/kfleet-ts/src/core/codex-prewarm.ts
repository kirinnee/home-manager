import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { codexPrewarmLockPath, codexSharedDir, codexSharedSqliteDir } from '../deps';

export const CODEX_THREAD_SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
] as const;

export const DEFAULT_CODEX_PREWARM_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 750;
const STDERR_TAIL_BYTES = 8 * 1024;

export interface AppServerChild {
  stdin: {
    write(chunk: string | Uint8Array): unknown;
    flush?(): unknown;
    end?(): unknown;
  };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): unknown;
}

export interface AppServerSpawnOptions {
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type SpawnAppServer = (options: AppServerSpawnOptions) => AppServerChild;

export interface CodexPrewarmOptions {
  timeoutMs?: number;
  shutdownGraceMs?: number;
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  /** Test/advanced override. Defaults to ~/.kfleet/shared/codex. */
  sharedRoot?: string;
  /** Defaults to <sharedRoot>/sqlite. */
  sqliteDir?: string;
  /** Defaults to <sharedRoot>/.sqlite-prewarm-lock.sqlite3. */
  lockPath?: string;
  spawn?: SpawnAppServer;
  now?: () => number;
}

export interface CodexPrewarmResult {
  sqliteDir: string;
  elapsedMs: number;
  activeThreadsReturned: number;
  archivedThreadsReturned: number;
}

interface LockOwner {
  pid: number;
  token: string;
  startedAt: string;
}

export interface CodexPrewarmLock {
  path: string;
  owner: LockOwner;
  release(): void;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const isSqliteBusy = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || /database is (locked|busy)/i.test(String(error));
};

/** Hold a write transaction in a dedicated persistent SQLite database. SQLite
 *  arbitrates acquisition atomically across processes and releases the lock if
 *  an owner exits or crashes, so no stale filesystem takeover is required. */
export function acquireCodexPrewarmLock(lockPath = codexPrewarmLockPath): CodexPrewarmLock {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  let database: Database | undefined;
  try {
    database = new Database(lockPath, { create: true, readwrite: true, strict: true });
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN EXCLUSIVE');
    let released = false;
    return {
      path: lockPath,
      owner,
      release: () => {
        if (released) return;
        released = true;
        try {
          database!.exec('ROLLBACK');
        } finally {
          database!.close();
        }
      },
    };
  } catch (error) {
    database?.close();
    if (isSqliteBusy(error)) {
      throw new Error(
        `another Codex SQLite prewarm is already running; lock database: ${lockPath}. Wait for it to finish.`,
      );
    }
    throw new Error(`failed to acquire Codex SQLite prewarm lock database ${lockPath}: ${(error as Error).message}`);
  }
}

type RpcMessage = {
  id?: string | number;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
  method?: unknown;
};

async function* jsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          throw new Error(`app-server emitted invalid JSON: ${line.slice(0, 240)}`);
        }
      }
    }
    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine) {
      try {
        yield JSON.parse(finalLine);
      } catch {
        throw new Error(`app-server emitted invalid JSON: ${finalLine.slice(0, 240)}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function captureTextTail(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-limit);
    }
    tail = (tail + decoder.decode()).slice(-limit);
    return tail.trim();
  } finally {
    reader.releaseLock();
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = promise.then(
    () => true as const,
    () => true as const,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdownChild(child: AppServerChild, graceMs: number): Promise<string | null> {
  try {
    if (child.stdin.end) {
      const ended = Promise.resolve(child.stdin.end());
      await settlesWithin(ended, graceMs);
    }
  } catch {
    // The server may have already closed stdin after reporting an error.
  }
  if (await settlesWithin(child.exited, graceMs)) return null;

  try {
    child.kill('SIGTERM');
  } catch {
    // Race: it may have exited between the check and signal.
  }
  if (await settlesWithin(child.exited, graceMs)) return null;

  try {
    child.kill('SIGKILL');
  } catch {
    // Same exit race; the final wait below decides whether it was reaped.
  }
  if (await settlesWithin(child.exited, graceMs)) return null;
  return 'app-server did not exit after stdin close, SIGTERM, and SIGKILL';
}

const defaultSpawn: SpawnAppServer = options =>
  Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as AppServerChild;

function threadListCount(result: unknown, method: string): number {
  if (typeof result !== 'object' || result === null || !('data' in result) || !Array.isArray(result.data)) {
    throw new Error(`${method} returned a malformed result (expected a data array)`);
  }
  return result.data.length;
}

/** Reconcile the fresh shared state DB from pooled rollout files without
 *  starting/resuming a thread or issuing any model turn. */
export async function prewarmCodexSharedSqlite(options: CodexPrewarmOptions = {}): Promise<CodexPrewarmResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_PREWARM_TIMEOUT_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Codex prewarm timeout must be greater than zero');
  if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs <= 0)
    throw new Error('Codex prewarm shutdown grace must be greater than zero');

  const sharedRoot = path.resolve(options.sharedRoot ?? codexSharedDir);
  const sqliteDir = path.resolve(
    options.sqliteDir ?? (options.sharedRoot ? path.join(sharedRoot, 'sqlite') : codexSharedSqliteDir),
  );
  const lockPath = path.resolve(
    options.lockPath ??
      (options.sharedRoot ? path.join(sharedRoot, '.sqlite-prewarm-lock.sqlite3') : codexPrewarmLockPath),
  );
  mkdirSync(path.join(sharedRoot, 'sessions'), { recursive: true });
  mkdirSync(path.join(sharedRoot, 'archived_sessions'), { recursive: true });
  mkdirSync(sqliteDir, { recursive: true });

  const lock = acquireCodexPrewarmLock(lockPath);

  const startedAt = (options.now ?? Date.now)();
  const codexBin = options.codexBin ?? Bun.which('codex') ?? 'codex';
  const spawn = options.spawn ?? defaultSpawn;
  let child: AppServerChild | undefined;
  let stderrPromise: Promise<string> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  let shutdownFailure: string | null = null;
  let stderr = '';
  let activeThreadsReturned = 0;
  let archivedThreadsReturned = 0;
  let phase = 'starting app-server';

  try {
    try {
      child = spawn({
        cmd: [codexBin, 'app-server', '--stdio'],
        cwd: sharedRoot,
        env: {
          ...(options.env ?? process.env),
          CODEX_HOME: sharedRoot,
          CODEX_SQLITE_HOME: sqliteDir,
        },
      });
    } catch (error) {
      throw new Error(`failed to start ${codexBin} app-server --stdio: ${(error as Error).message}`);
    }
    stderrPromise = captureTextTail(child.stderr, STDERR_TAIL_BYTES);
    const messages = jsonLines(child.stdout);

    let signalTimeout: (() => void) | undefined;
    const timedOut = new Promise<{ kind: 'timeout' }>(resolve => {
      signalTimeout = () => resolve({ kind: 'timeout' });
    });
    timeoutTimer = setTimeout(() => signalTimeout?.(), timeoutMs);

    const send = async (message: unknown): Promise<void> => {
      child!.stdin.write(`${JSON.stringify(message)}\n`);
      const flushed = child!.stdin.flush ? Promise.resolve(child!.stdin.flush()) : Promise.resolve();
      const winner = await Promise.race([
        flushed.then(() => ({ kind: 'flushed' as const })),
        child!.exited.then(code => ({ kind: 'exit' as const, code })),
        timedOut,
      ]);
      if (winner.kind === 'timeout') throw new Error(`${phase} timed out after ${timeoutMs} ms`);
      if (winner.kind === 'exit') throw new Error(`app-server exited with code ${winner.code} while sending ${phase}`);
    };

    const request = async (
      id: number,
      method: string,
      params: Record<string, unknown>,
      label = method,
    ): Promise<unknown> => {
      phase = label;
      await send({ method, id, params });
      while (true) {
        const winner = await Promise.race([
          messages.next().then(step => ({ kind: 'message' as const, step })),
          child!.exited.then(code => ({ kind: 'exit' as const, code })),
          timedOut,
        ]);
        if (winner.kind === 'timeout') throw new Error(`${phase} timed out after ${timeoutMs} ms`);
        if (winner.kind === 'exit')
          throw new Error(`app-server exited with code ${winner.code} while waiting for ${label}`);
        if (winner.step.done) throw new Error(`app-server closed stdout while waiting for ${label}`);
        if (typeof winner.step.value !== 'object' || winner.step.value === null) {
          throw new Error(`app-server emitted a non-object JSON-RPC message while waiting for ${label}`);
        }
        const message = winner.step.value as RpcMessage;
        if (message.id !== id) continue; // notification or unrelated response
        if (message.error) {
          const code = message.error.code === undefined ? '' : ` (code ${String(message.error.code)})`;
          const detail =
            typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error);
          throw new Error(`${label} failed${code}: ${detail}`);
        }
        if (!('result' in message)) throw new Error(`${label} returned neither result nor error`);
        return message.result;
      }
    };

    phase = 'initialize';
    await request(1, 'initialize', {
      clientInfo: { name: 'kfleet-prewarm', title: 'kfleet', version: '0.1.0' },
      capabilities: {},
    });
    await send({ method: 'initialized', params: {} });

    const listParams = {
      limit: 1,
      sourceKinds: [...CODEX_THREAD_SOURCE_KINDS],
      useStateDbOnly: false,
    };
    activeThreadsReturned = threadListCount(
      await request(2, 'thread/list', { ...listParams, archived: false }, 'thread/list active'),
      'thread/list active',
    );
    archivedThreadsReturned = threadListCount(
      await request(3, 'thread/list', { ...listParams, archived: true }, 'thread/list archived'),
      'thread/list archived',
    );
  } catch (error) {
    failure = error;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (child) shutdownFailure = await shutdownChild(child, shutdownGraceMs);
    if (stderrPromise) {
      try {
        stderr = await Promise.race([stderrPromise, delay(shutdownGraceMs).then(() => '')]);
      } catch {
        // A broken stderr stream should not hide the primary protocol error.
      }
    }
    lock.release();
  }

  if (failure || shutdownFailure) {
    const parts = [failure ? (failure as Error).message : shutdownFailure!];
    if (shutdownFailure && failure) parts.push(shutdownFailure);
    if (stderr) parts.push(`app-server stderr:\n${stderr}`);
    parts.push(`shared Codex home: ${sharedRoot}`, `shared SQLite directory: ${sqliteDir}`);
    throw new Error(parts.join('\n'));
  }

  return {
    sqliteDir,
    elapsedMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
    activeThreadsReturned,
    archivedThreadsReturned,
  };
}
