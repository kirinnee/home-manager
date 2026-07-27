import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  STT_MAX_SAMPLES,
  STT_SAMPLE_RATE,
  SttError,
  type SttErrorCode,
  type SttWorkerModel,
  type SttWorkerPhase,
  type SttWorkerRequest,
  type SttWorkerResponse,
  type SttWorkerStatus,
} from './stt-types';

export interface SttWorkerTranscription {
  text: string;
  audioMs: number;
  decodeMs: number;
  modelId: string;
}

export interface SttWorkerClientLike {
  status(): SttWorkerStatus;
  ensureReady(): Promise<{ modelId: string; loadMs: number }>;
  transcribe(audio: Float32Array): Promise<SttWorkerTranscription>;
  close(): Promise<void>;
}

export interface SttChildHandle {
  readonly pid?: number;
  readonly exited: Promise<number>;
  send(message: SttWorkerRequest): void;
  kill(signal?: NodeJS.Signals | number): void;
  disconnect?(): void;
}

export interface SpawnSttWorkerOptions {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onMessage(message: unknown): void;
  onExit(exitCode: number | null, signalCode: NodeJS.Signals | number | null, error?: unknown): void;
  onStderr(chunk: string): void;
}

export type SpawnSttWorker = (options: SpawnSttWorkerOptions) => SttChildHandle;

export interface SttClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SttWorkerClientOptions {
  resolveModel: () => Promise<SttWorkerModel | undefined>;
  threads?: number;
  idleMs?: number;
  loadTimeoutMs?: number;
  decodeTimeoutMs?: number;
  /** Time after SIGTERM before close() escalates a live worker to SIGKILL. */
  shutdownTimeoutMs?: number;
  /** Final bounded wait after SIGKILL before close() gives up on an exit notification. */
  killTimeoutMs?: number;
  nativeLibPath?: string;
  workerEntry?: string;
  workerDirectory?: string;
  bunExecutable?: string;
  env?: Record<string, string | undefined>;
  spawn?: SpawnSttWorker;
  clock?: SttClock;
  randomId?: () => string;
  resolveAddonDirectory?: () => string | undefined;
  discoverNativeLibDirectory?: () => string | undefined | Promise<string | undefined>;
  /** Receives native stderr chunks; the service wires this to a bounded log. */
  stderrLog?: (chunk: string) => void | Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorStatus(code: SttErrorCode): number {
  if (code === 'bad_request' || code === 'bad_audio' || code === 'unsupported_language') return 400;
  if (code === 'too_long') return 413;
  if (code === 'busy' || code === 'model_installing') return 409;
  return 503;
}

function versionParts(value: string): number[] {
  return value.split('.').map(part => Number(part));
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizeNativeLibraryDirectory(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (existsSync(path.join(value, 'libstdc++.so.6'))) return value;
  const nested = path.join(value, 'lib');
  if (existsSync(path.join(nested, 'libstdc++.so.6'))) return nested;
  return undefined;
}

/** Resolve the native platform package installed beside sherpa-onnx-node. */
export function resolveSherpaAddonDirectory(
  platform = process.platform,
  architecture = process.arch,
): string | undefined {
  const packagePlatform = platform === 'win32' ? 'win' : platform;
  const packageName = `sherpa-onnx-${packagePlatform}-${architecture}`;
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

/** Find a current Nix GCC runtime without synchronously scanning the whole store. */
export async function discoverNixLibstdcxx(store = '/nix/store'): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(store);
  } catch {
    return undefined;
  }
  const gccCandidates: Array<{ directory: string; version: string }> = [];
  for (const entry of entries) {
    const match = entry.match(/-gcc-(\d+(?:\.\d+)*)-lib$/);
    if (match) {
      gccCandidates.push({ directory: path.join(store, entry, 'lib'), version: match[1]! });
    }
  }
  const candidates = (
    await Promise.all(
      gccCandidates.map(async candidate => {
        try {
          await access(path.join(candidate.directory, 'libstdc++.so.6'));
          return candidate;
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((candidate): candidate is { directory: string; version: string } => candidate !== undefined)
    .sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.directory;
}

export function resolveSttWorkerEntry(
  directory = import.meta.dir,
  fileExists: (file: string) => boolean = existsSync,
): string {
  const built = path.join(directory, 'stt-worker.js');
  if (fileExists(built)) return built;
  const source = path.join(directory, 'stt-worker.ts');
  if (fileExists(source)) return source;
  throw new SttError('worker_unavailable', `STT worker entry is missing beside ${directory}`, 503);
}

export function buildSttWorkerEnvironment(options: {
  env: Record<string, string | undefined>;
  addonDirectory?: string;
  configuredNativeLibPath?: string;
  discoveredNativeLibDirectory?: string;
}): Record<string, string | undefined> {
  const result = { ...options.env };
  if (process.platform !== 'linux') return result;
  const configured = options.configuredNativeLibPath
    ?.split(path.delimiter)
    .map(normalizeNativeLibraryDirectory)
    .filter((value): value is string => value !== undefined);
  const directories = [
    options.addonDirectory,
    ...(configured ?? []),
    normalizeNativeLibraryDirectory(options.discoveredNativeLibDirectory),
    ...(options.env.LD_LIBRARY_PATH?.split(path.delimiter) ?? []),
  ].filter((value): value is string => Boolean(value));
  result.LD_LIBRARY_PATH = [...new Set(directories)].join(path.delimiter);
  return result;
}

/**
 * Serialize appends and retain only the newest bytes. Native loader failures
 * are therefore durable without allowing an unbounded daemon log.
 */
export function createBoundedSttLogSink(file: string, maxBytes = 256 * 1_024): (chunk: string) => Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024) throw new RangeError('maxBytes must be at least 1024');
  let writes = Promise.resolve();
  return async chunk => {
    if (!chunk) return;
    const next = writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, chunk, { encoding: 'utf8', mode: 0o600 });
      const info = await stat(file);
      if (info.size <= maxBytes) return;
      const bytes = await readFile(file);
      const tail = bytes.subarray(Math.max(0, bytes.byteLength - maxBytes));
      const temporary = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
      await writeFile(temporary, tail, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    });
    writes = next.catch(() => undefined);
    return await next;
  };
}

function defaultClock(): SttClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

async function consumeStderr(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch {
    // A killed worker closes stderr abruptly; exit handling owns the error.
  }
}

export const spawnSttWorker: SpawnSttWorker = options => {
  const subprocess = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    serialization: 'advanced',
    ipc: message => options.onMessage(message),
    onExit: (_child, exitCode, signalCode, error) => options.onExit(exitCode, signalCode, error),
  });
  if (subprocess.stderr) void consumeStderr(subprocess.stderr, options.onStderr);
  return {
    pid: subprocess.pid,
    exited: subprocess.exited,
    send: message => subprocess.send(message),
    kill: signal => subprocess.kill(signal),
    disconnect: () => subprocess.disconnect(),
  };
};

interface PendingLoad {
  requestId: string;
  model: SttWorkerModel;
  deferred: Deferred<{ modelId: string; loadMs: number }>;
}

interface PendingTranscription {
  requestId: string;
  deferred: Deferred<SttWorkerTranscription>;
  timeout: unknown;
}

interface OwnedChild {
  generation: number;
  child: SttChildHandle;
  exited: Promise<void>;
  resolveExited(): void;
  settled: boolean;
  disconnected: boolean;
  termSent: boolean;
  killSent: boolean;
}

interface NativeLibDiscovery {
  owner: WarmAttempt;
  promise: Promise<string | undefined>;
  pending: boolean;
}

interface WarmAttempt {
  interruption: Deferred<never>;
  timeout: unknown;
  cancelled: boolean;
  failure?: SttError;
  nativeLibDiscovery?: NativeLibDiscovery;
}

export class SttWorkerClient implements SttWorkerClientLike {
  private readonly spawn: SpawnSttWorker;
  private readonly clock: SttClock;
  private readonly randomId: () => string;
  private readonly threads: number;
  private readonly idleMs: number;
  private readonly loadTimeoutMs: number;
  private readonly decodeTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private child: SttChildHandle | undefined;
  private generation = 0;
  private readonly expectedExits = new Set<number>();
  private readonly shutdownEscalations = new Map<number, { timer: unknown; child: SttChildHandle }>();
  private readonly ownedChildren = new Map<number, OwnedChild>();
  private nativeLibDiscovery: NativeLibDiscovery | undefined;
  private loadedModel: SttWorkerModel | undefined;
  private loadedAt: string | undefined;
  private loading: Promise<{ modelId: string; loadMs: number }> | undefined;
  private warmAttempt: WarmAttempt | undefined;
  private pendingLoad: PendingLoad | undefined;
  private pendingTranscription: PendingTranscription | undefined;
  private busy = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private idleTimer: unknown;
  private stderrTail = '';
  private lastError: SttWorkerStatus['lastError'];

  constructor(private readonly options: SttWorkerClientOptions) {
    this.spawn = options.spawn ?? spawnSttWorker;
    this.clock = options.clock ?? defaultClock();
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.threads = options.threads ?? 4;
    this.idleMs = options.idleMs ?? 300_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 60_000;
    this.decodeTimeoutMs = options.decodeTimeoutMs ?? 180_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 1_000;
    if (!Number.isInteger(this.threads) || this.threads < 1 || this.threads > 32) {
      throw new RangeError('threads must be an integer from 1 to 32');
    }
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) throw new RangeError('idleMs must be positive');
    if (!Number.isFinite(this.loadTimeoutMs) || this.loadTimeoutMs <= 0) {
      throw new RangeError('loadTimeoutMs must be positive');
    }
    if (!Number.isFinite(this.decodeTimeoutMs) || this.decodeTimeoutMs <= 0) {
      throw new RangeError('decodeTimeoutMs must be positive');
    }
    if (!Number.isFinite(this.shutdownTimeoutMs) || this.shutdownTimeoutMs <= 0) {
      throw new RangeError('shutdownTimeoutMs must be positive');
    }
    if (!Number.isFinite(this.killTimeoutMs) || this.killTimeoutMs <= 0) {
      throw new RangeError('killTimeoutMs must be positive');
    }
  }

  status(): SttWorkerStatus {
    let phase: SttWorkerPhase;
    if (this.closed) phase = 'closed';
    else if (this.busy) phase = 'busy';
    else if (this.loading) phase = 'loading';
    else if (this.child && this.loadedModel) phase = 'ready';
    else if (this.lastError) phase = 'error';
    else phase = 'cold';
    return {
      phase,
      pid: this.child?.pid,
      modelId: this.loadedModel?.id,
      loadedAt: this.loadedAt,
      lastError: this.lastError,
    };
  }

  ensureReady(): Promise<{ modelId: string; loadMs: number }> {
    if (this.closed) return Promise.reject(new SttError('service_closed', 'STT worker client is closed', 503));
    if (this.child && this.loadedModel) return Promise.resolve({ modelId: this.loadedModel.id, loadMs: 0 });
    if (this.loading) return this.loading;
    this.cancelIdle();
    const loading = this.warm();
    this.loading = loading;
    void loading.then(
      () => {
        if (this.loading === loading) this.loading = undefined;
        this.scheduleIdle();
      },
      () => {
        if (this.loading === loading) this.loading = undefined;
      },
    );
    return loading;
  }

  transcribe(audio: Float32Array): Promise<SttWorkerTranscription> {
    if (this.closed) return Promise.reject(new SttError('service_closed', 'STT worker client is closed', 503));
    if (!(audio instanceof Float32Array) || audio.length === 0) {
      return Promise.reject(new SttError('bad_audio', 'audio is empty or invalid', 400));
    }
    if (audio.length > STT_MAX_SAMPLES) {
      return Promise.reject(new SttError('too_long', 'audio exceeds the 120 second limit', 413));
    }
    if (this.busy) return Promise.reject(new SttError('busy', 'the batch transcriber is busy', 409));
    this.busy = true;
    this.cancelIdle();
    return this.runTranscription(audio).finally(() => {
      this.busy = false;
      this.pendingTranscription = undefined;
      this.scheduleIdle();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelIdle();
    const failure = new SttError('service_closed', 'STT worker client is closed', 503);
    this.cancelWarmAttempt(this.warmAttempt, failure);
    this.pendingLoad?.deferred.reject(failure);
    this.pendingTranscription?.deferred.reject(failure);
    this.clearPendingTimeouts();
    this.pendingLoad = undefined;
    this.pendingTranscription = undefined;
    this.loading = undefined;
    this.busy = false;
    this.stopChild(true);
    this.forcePendingShutdowns();
    const children = [...this.ownedChildren.values()];
    for (const child of children) this.signalChild(child, 'SIGTERM');
    this.closePromise = this.drainOwnedChildren(children);
    return this.closePromise;
  }

  private async warm(): Promise<{ modelId: string; loadMs: number }> {
    const interruption = deferred<never>();
    const attempt: WarmAttempt = {
      interruption,
      timeout: undefined,
      cancelled: false,
    };
    attempt.timeout = this.clock.setTimeout(() => {
      const failure = new SttError('load_failed', `STT model load timed out after ${this.loadTimeoutMs} ms`, 503);
      if (!this.cancelWarmAttempt(attempt, failure)) return;
      this.recordError(failure.code, failure.message);
      this.pendingLoad?.deferred.reject(failure);
      this.stopChild(true);
    }, this.loadTimeoutMs);
    this.warmAttempt = attempt;
    try {
      return await Promise.race([this.performWarm(attempt), interruption.promise]);
    } catch (error) {
      const failure = this.closed
        ? new SttError('service_closed', 'STT worker client is closed', 503, { cause: error })
        : error instanceof SttError
          ? error
          : new SttError('worker_unavailable', error instanceof Error ? error.message : String(error), 503, {
              cause: error,
            });
      this.recordError(failure.code, failure.message);
      if (failure.code !== 'model_missing') this.stopChild(true);
      throw failure;
    } finally {
      this.finishWarmAttempt(attempt);
      this.pendingLoad = undefined;
    }
  }

  private async performWarm(attempt: WarmAttempt): Promise<{ modelId: string; loadMs: number }> {
    const model = await this.options.resolveModel();
    this.assertWarmAttempt(attempt);
    if (!model) throw new SttError('model_missing', 'the daemon STT model is not installed', 503);
    if (this.child && this.loadedModel && this.loadedModel.id !== model.id) this.stopChild(true);
    await this.ensureChild(model.directory, attempt);
    this.assertWarmAttempt(attempt);
    const requestId = this.randomId();
    const waiting = deferred<{ modelId: string; loadMs: number }>();
    this.pendingLoad = { requestId, model, deferred: waiting };
    try {
      this.child!.send({ type: 'load', requestId, model, threads: this.threads });
    } catch (error) {
      throw new SttError('worker_crashed', `failed to send model to the STT worker: ${String(error)}`, 503, {
        cause: error,
      });
    }
    const ready = await waiting.promise;
    this.lastError = undefined;
    return ready;
  }

  private async runTranscription(audio: Float32Array): Promise<SttWorkerTranscription> {
    await this.ensureReady();
    if (!this.child) throw new SttError('worker_unavailable', 'STT worker disappeared during warm-up', 503);
    const requestId = this.randomId();
    const waiting = deferred<SttWorkerTranscription>();
    const timeout = this.clock.setTimeout(() => {
      if (this.pendingTranscription?.requestId !== requestId) return;
      const failure = new SttError('decode_failed', `STT batch decode timed out after ${this.decodeTimeoutMs} ms`, 503);
      this.recordError(failure.code, failure.message);
      this.pendingTranscription.deferred.reject(failure);
      this.clearPendingTranscriptionTimeout();
      this.stopChild(true);
    }, this.decodeTimeoutMs);
    this.pendingTranscription = { requestId, deferred: waiting, timeout };
    try {
      this.child.send({ type: 'transcribe', requestId, sampleRate: STT_SAMPLE_RATE, audio });
    } catch (error) {
      const failure = new SttError('worker_crashed', `failed to send audio to the STT worker: ${String(error)}`, 503, {
        cause: error,
      });
      this.recordError(failure.code, failure.message);
      this.stopChild(true);
      throw failure;
    }
    return await waiting.promise;
  }

  private async ensureChild(cwd: string, attempt: WarmAttempt): Promise<void> {
    this.assertWarmAttempt(attempt);
    if (this.child) return;
    const entry = this.options.workerEntry ?? resolveSttWorkerEntry(this.options.workerDirectory ?? import.meta.dir);
    const addon = (this.options.resolveAddonDirectory ?? resolveSherpaAddonDirectory)();
    if (process.platform === 'linux' && !addon) {
      throw new SttError('native_missing', 'the sherpa-onnx platform package is not installed', 503);
    }
    const discovered = process.platform === 'linux' ? await this.discoverNativeLibDirectory(attempt) : undefined;
    this.assertWarmAttempt(attempt);
    if (this.child) return;
    const env = buildSttWorkerEnvironment({
      env: this.options.env ?? process.env,
      addonDirectory: addon,
      configuredNativeLibPath: this.options.nativeLibPath ?? process.env.KTEAM_STT_LIB_PATH,
      discoveredNativeLibDirectory: discovered,
    });
    const generation = ++this.generation;
    this.stderrTail = '';
    const child = this.spawn({
      command: [this.options.bunExecutable ?? process.execPath, entry],
      cwd,
      env,
      onMessage: message => this.onMessage(generation, message),
      onExit: (exitCode, signalCode, error) => this.onExit(generation, exitCode, signalCode, error),
      onStderr: chunk => {
        if (generation !== this.generation) return;
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
        try {
          const logged = this.options.stderrLog?.(chunk);
          if (logged && typeof (logged as Promise<void>).catch === 'function') {
            void (logged as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Diagnostics must never take down transcription.
        }
      },
    });
    this.trackChild(generation, child);
    this.child = child;
  }

  private assertWarmAttempt(attempt: WarmAttempt): void {
    if (attempt.cancelled)
      throw attempt.failure ?? new SttError('load_failed', 'STT worker warm-up was cancelled', 503);
    if (this.closed) throw new SttError('service_closed', 'STT worker client is closed', 503);
  }

  private cancelWarmAttempt(attempt: WarmAttempt | undefined, failure: SttError): boolean {
    if (!attempt || attempt.cancelled) return false;
    attempt.cancelled = true;
    attempt.failure = failure;
    this.invalidatePendingNativeLibDiscovery(attempt);
    attempt.interruption.reject(failure);
    return true;
  }

  private finishWarmAttempt(attempt: WarmAttempt): void {
    if (attempt.timeout !== undefined) {
      this.clock.clearTimeout(attempt.timeout);
      attempt.timeout = undefined;
    }
    attempt.cancelled = true;
    if (this.warmAttempt === attempt) this.warmAttempt = undefined;
  }

  private discoverNativeLibDirectory(attempt: WarmAttempt): Promise<string | undefined> {
    let discovery = this.nativeLibDiscovery;
    if (discovery) {
      attempt.nativeLibDiscovery = discovery;
      return discovery.promise;
    }
    const discover = this.options.discoverNativeLibDirectory ?? discoverNixLibstdcxx;
    let source: Promise<string | undefined>;
    try {
      source = Promise.resolve(discover());
    } catch (error) {
      return Promise.reject(error);
    }
    let created!: NativeLibDiscovery;
    const promise = source.then(
      value => {
        created.pending = false;
        return value;
      },
      error => {
        created.pending = false;
        if (this.nativeLibDiscovery === created) this.nativeLibDiscovery = undefined;
        throw error;
      },
    );
    created = { owner: attempt, promise, pending: true };
    this.nativeLibDiscovery = created;
    attempt.nativeLibDiscovery = created;
    return promise;
  }

  private invalidatePendingNativeLibDiscovery(attempt: WarmAttempt): void {
    const discovery = attempt.nativeLibDiscovery;
    if (discovery?.pending && discovery.owner === attempt && this.nativeLibDiscovery === discovery) {
      this.nativeLibDiscovery = undefined;
    }
  }

  private onMessage(generation: number, message: unknown): void {
    if (generation !== this.generation || this.closed || !isRecord(message) || typeof message.type !== 'string') {
      if (generation === this.generation && !this.closed) this.protocolFailure('invalid worker response');
      return;
    }
    if (message.type === 'ready') {
      const pending = this.pendingLoad;
      if (
        !pending ||
        message.requestId !== pending.requestId ||
        message.modelId !== pending.model.id ||
        typeof message.loadMs !== 'number' ||
        !Number.isFinite(message.loadMs)
      ) {
        this.protocolFailure('invalid worker ready response');
        return;
      }
      this.loadedModel = pending.model;
      this.loadedAt = new Date(this.clock.now()).toISOString();
      this.clearPendingLoadTimeout();
      pending.deferred.resolve({ modelId: pending.model.id, loadMs: Math.max(0, message.loadMs) });
      return;
    }
    if (message.type === 'result') {
      const pending = this.pendingTranscription;
      const loadedModelId = this.loadedModel?.id;
      if (
        !pending ||
        typeof loadedModelId !== 'string' ||
        message.requestId !== pending.requestId ||
        message.modelId !== loadedModelId ||
        typeof message.text !== 'string' ||
        typeof message.audioMs !== 'number' ||
        typeof message.decodeMs !== 'number' ||
        !Number.isFinite(message.audioMs) ||
        !Number.isFinite(message.decodeMs)
      ) {
        this.protocolFailure('invalid worker transcript response');
        return;
      }
      pending.deferred.resolve({
        modelId: loadedModelId,
        text: message.text,
        audioMs: Math.max(0, message.audioMs),
        decodeMs: Math.max(0, message.decodeMs),
      });
      this.clearPendingTranscriptionTimeout();
      return;
    }
    if (message.type === 'error') {
      const code = message.code;
      const validCodes = new Set<SttErrorCode>([
        'bad_request',
        'bad_audio',
        'too_long',
        'model_missing',
        'native_missing',
        'load_failed',
        'decode_failed',
      ]);
      if (typeof code !== 'string' || !validCodes.has(code as SttErrorCode) || typeof message.message !== 'string') {
        this.protocolFailure('invalid worker error response');
        return;
      }
      const failure = new SttError(
        code as SttErrorCode,
        message.message.slice(0, 1_000),
        errorStatus(code as SttErrorCode),
      );
      this.recordError(failure.code, failure.message);
      const pendingLoad = this.pendingLoad;
      const pendingTranscription = this.pendingTranscription;
      if (pendingLoad && message.requestId === pendingLoad.requestId) {
        this.clearPendingLoadTimeout();
        pendingLoad.deferred.reject(failure);
      } else if (pendingTranscription && message.requestId === pendingTranscription.requestId) {
        this.clearPendingTranscriptionTimeout();
        pendingTranscription.deferred.reject(failure);
      } else this.protocolFailure('worker error did not match an active request');
      return;
    }
    if (message.type === 'bye') return;
    this.protocolFailure('unknown worker response');
  }

  private protocolFailure(message: string): void {
    const failure = new SttError('worker_unavailable', message, 503);
    this.recordError(failure.code, failure.message);
    this.pendingLoad?.deferred.reject(failure);
    this.pendingTranscription?.deferred.reject(failure);
    this.clearPendingTimeouts();
    this.stopChild(true);
  }

  private onExit(
    generation: number,
    exitCode: number | null,
    signalCode: NodeJS.Signals | number | null,
    error?: unknown,
  ): void {
    this.markChildExited(generation);
    this.cancelShutdownEscalation(generation);
    const expected = this.expectedExits.delete(generation);
    if (generation !== this.generation) return;
    this.child = undefined;
    this.loadedModel = undefined;
    this.loadedAt = undefined;
    if (expected || this.closed) return;
    const details = [
      `STT worker exited${exitCode === null ? '' : ` with code ${exitCode}`}${signalCode ? ` (${signalCode})` : ''}`,
      error instanceof Error ? error.message : '',
      this.stderrTail.trim(),
    ]
      .filter(Boolean)
      .join(': ')
      .slice(0, 1_000);
    const failure = new SttError('worker_crashed', details || 'STT worker crashed', 503);
    this.recordError(failure.code, failure.message);
    this.pendingLoad?.deferred.reject(failure);
    this.pendingTranscription?.deferred.reject(failure);
    this.clearPendingTimeouts();
  }

  private stopChild(killImmediately: boolean): void {
    const child = this.child;
    if (!child) return;
    const generation = this.generation;
    this.expectedExits.add(generation);
    // A stopped process may still flush queued IPC/stderr before its exit
    // callback. Invalidate those callbacks immediately, before a replacement
    // can be spawned.
    this.generation++;
    this.child = undefined;
    this.loadedModel = undefined;
    this.loadedAt = undefined;
    if (!killImmediately) {
      const timer = this.clock.setTimeout(() => {
        this.shutdownEscalations.delete(generation);
        this.signalChild(this.ownedChildren.get(generation), 'SIGTERM');
      }, 1_000);
      this.shutdownEscalations.set(generation, { timer, child });
    }
    try {
      child.send({ type: 'shutdown' });
    } catch {
      // The exit path below still releases the process.
    }
    if (killImmediately) {
      this.signalChild(this.ownedChildren.get(generation), 'SIGTERM');
    }
  }

  private cancelShutdownEscalation(generation: number): void {
    const escalation = this.shutdownEscalations.get(generation);
    if (!escalation) return;
    this.clock.clearTimeout(escalation.timer);
    this.shutdownEscalations.delete(generation);
  }

  private forcePendingShutdowns(): void {
    for (const [generation, escalation] of this.shutdownEscalations) {
      this.clock.clearTimeout(escalation.timer);
      this.shutdownEscalations.delete(generation);
      this.signalChild(this.ownedChildren.get(generation), 'SIGTERM');
    }
  }

  private trackChild(generation: number, child: SttChildHandle): void {
    const completion = deferred<void>();
    const owned: OwnedChild = {
      generation,
      child,
      exited: completion.promise,
      resolveExited: () => completion.resolve(undefined),
      settled: false,
      disconnected: false,
      termSent: false,
      killSent: false,
    };
    this.ownedChildren.set(generation, owned);
    void child.exited.then(
      () => this.markChildExited(generation),
      () => undefined,
    );
  }

  private markChildExited(generation: number): void {
    const owned = this.ownedChildren.get(generation);
    if (!owned || owned.settled) return;
    owned.settled = true;
    owned.resolveExited();
    this.ownedChildren.delete(generation);
  }

  private signalChild(owned: OwnedChild | undefined, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!owned || owned.settled) return;
    if (!owned.disconnected) {
      owned.disconnected = true;
      try {
        owned.child.disconnect?.();
      } catch {
        // Already disconnected.
      }
    }
    const key = signal === 'SIGTERM' ? 'termSent' : 'killSent';
    if (owned[key]) return;
    owned[key] = true;
    try {
      owned.child.kill(signal);
    } catch {
      // The process may have exited between the settled check and the signal.
    }
  }

  private async drainOwnedChildren(children: OwnedChild[]): Promise<void> {
    if (children.length === 0 || (await this.waitForChildren(children, this.shutdownTimeoutMs))) return;
    for (const child of children) this.signalChild(child, 'SIGKILL');
    await this.waitForChildren(children, this.killTimeoutMs);
    for (const child of children) {
      if (!child.settled && this.ownedChildren.get(child.generation) === child) {
        this.ownedChildren.delete(child.generation);
        this.expectedExits.delete(child.generation);
      }
    }
  }

  private waitForChildren(children: OwnedChild[], timeoutMs: number): Promise<boolean> {
    if (children.every(child => child.settled)) return Promise.resolve(true);
    return new Promise(resolve => {
      let finished = false;
      let timer: unknown;
      const finish = (exited: boolean) => {
        if (finished) return;
        finished = true;
        this.clock.clearTimeout(timer);
        resolve(exited);
      };
      timer = this.clock.setTimeout(() => finish(false), timeoutMs);
      void Promise.all(children.map(child => child.exited)).then(() => finish(true));
    });
  }

  private recordError(code: SttErrorCode, message: string): void {
    this.lastError = {
      code,
      message: message.slice(0, 1_000),
      at: new Date(this.clock.now()).toISOString(),
    };
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    if (this.closed || this.busy || this.loading || !this.child) return;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.busy && !this.loading) this.stopChild(false);
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer === undefined) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearPendingLoadTimeout(): void {
    const attempt = this.warmAttempt;
    if (!attempt || attempt.timeout === undefined) return;
    this.clock.clearTimeout(attempt.timeout);
    attempt.timeout = undefined;
  }

  private clearPendingTranscriptionTimeout(): void {
    const timeout = this.pendingTranscription?.timeout;
    if (timeout !== undefined) this.clock.clearTimeout(timeout);
  }

  private clearPendingTimeouts(): void {
    this.clearPendingLoadTimeout();
    this.clearPendingTranscriptionTimeout();
  }
}
