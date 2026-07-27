import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SttWorkerClient,
  buildSttWorkerEnvironment,
  createBoundedSttLogSink,
  discoverNixLibstdcxx,
  resolveSttWorkerEntry,
  type SpawnSttWorker,
  type SpawnSttWorkerOptions,
  type SttChildHandle,
  type SttClock,
} from './stt-worker-client';
import { SttError, type SttWorkerModel, type SttWorkerRequest } from './stt-types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeClock implements SttClock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.time;

  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + milliseconds, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

class FakeChild implements SttChildHandle {
  readonly pid: number;
  readonly sent: SttWorkerRequest[] = [];
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  disconnects = 0;
  throwOnSend = false;
  private readonly exitGate = deferred<number>();
  readonly exited = this.exitGate.promise;

  constructor(
    pid: number,
    readonly options: SpawnSttWorkerOptions,
  ) {
    this.pid = pid;
  }

  send(message: SttWorkerRequest): void {
    if (this.throwOnSend) throw new Error('IPC is closed');
    this.sent.push(message);
  }

  kill(signal?: NodeJS.Signals | number): void {
    this.kills.push(signal);
  }

  disconnect(): void {
    this.disconnects++;
  }

  emit(message: unknown): void {
    this.options.onMessage(message);
  }

  exit(code = 1, signal: NodeJS.Signals | number | null = null, error?: unknown): void {
    this.options.onExit(code, signal, error);
    this.exitGate.resolve(code);
  }
}

class FakeSpawner {
  readonly children: FakeChild[] = [];
  readonly spawn: SpawnSttWorker = options => {
    const child = new FakeChild(100 + this.children.length, options);
    this.children.push(child);
    return child;
  };
}

const model: SttWorkerModel = {
  id: 'daemon-fixture',
  directory: '/models/daemon-fixture',
  encoder: '/models/daemon-fixture/encoder.int8.onnx',
  decoder: '/models/daemon-fixture/decoder.int8.onnx',
  joiner: '/models/daemon-fixture/joiner.int8.onnx',
  tokens: '/models/daemon-fixture/tokens.txt',
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sttCode(error: unknown): string | undefined {
  return error instanceof SttError ? error.code : undefined;
}

function client(
  spawner: FakeSpawner,
  clock: FakeClock,
  overrides: Partial<ConstructorParameters<typeof SttWorkerClient>[0]> = {},
): SttWorkerClient {
  return new SttWorkerClient({
    resolveModel: async () => model,
    workerEntry: '/src/stt-worker.ts',
    spawn: spawner.spawn,
    clock,
    randomId: (() => {
      let id = 0;
      return () => `request-${++id}`;
    })(),
    resolveAddonDirectory: () => '/node_modules/sherpa-onnx-linux-x64',
    discoverNativeLibDirectory: () => undefined,
    env: { PATH: '/bin', LD_LIBRARY_PATH: '/existing' },
    ...overrides,
  });
}

describe('STT worker client', () => {
  test('shares one in-flight warm-up and uses advanced-IPC message shapes', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const first = worker.ensureReady();
    const second = worker.ensureReady();
    await flush();
    expect(spawner.children).toHaveLength(1);
    const child = spawner.children[0]!;
    expect(child.sent).toHaveLength(1);
    expect(child.sent[0]).toMatchObject({
      type: 'load',
      requestId: 'request-1',
      model,
      threads: 4,
    });
    child.emit({ type: 'ready', requestId: 'request-1', modelId: model.id, loadMs: 42 });
    expect(await first).toEqual({ modelId: model.id, loadMs: 42 });
    expect(await second).toEqual({ modelId: model.id, loadMs: 42 });
    expect(worker.status()).toMatchObject({ phase: 'ready', pid: child.pid, modelId: model.id });
  });

  test('serializes transcription and returns busy without sending a second clip', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const audio = Float32Array.of(-1, 0, 1);
    const first = worker.transcribe(audio);
    await flush();
    const child = spawner.children[0]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await flush();
    const request = child.sent[1] as Extract<SttWorkerRequest, { type: 'transcribe' }>;
    expect(request.type).toBe('transcribe');
    expect(request.audio).toBeInstanceOf(Float32Array);
    expect(Array.from(request.audio)).toEqual(Array.from(audio));
    expect(sttCode(await worker.transcribe(Float32Array.of(0)).catch(error => error))).toBe('busy');
    expect(child.sent).toHaveLength(2);
    child.emit({
      type: 'result',
      requestId: request.requestId,
      modelId: model.id,
      text: ' Batch result.',
      audioMs: 0.1875,
      decodeMs: 9,
    });
    expect(await first).toEqual({
      modelId: model.id,
      text: ' Batch result.',
      audioMs: 0.1875,
      decodeMs: 9,
    });
    expect(worker.status().phase).toBe('ready');
  });

  test('unloads gracefully after 300 seconds and cancels escalation on clean exit', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const ready = worker.ensureReady();
    await flush();
    const child = spawner.children[0]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await ready;
    await flush();
    clock.advance(299_999);
    expect(child.sent.filter(message => message.type === 'shutdown')).toHaveLength(0);
    clock.advance(1);
    expect(child.sent.at(-1)).toEqual({ type: 'shutdown' });
    expect(child.disconnects).toBe(0);
    expect(worker.status().phase).toBe('cold');
    child.emit({ type: 'bye' });
    child.exit(0);
    clock.advance(1_000);
    expect(child.kills).toEqual([]);
    expect(child.disconnects).toBe(0);
  });

  test('escalates a hung graceful idle shutdown after one second', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, { idleMs: 10 });
    const ready = worker.ensureReady();
    await flush();
    const child = spawner.children[0]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await ready;
    await flush();
    clock.advance(10);
    expect(child.sent.at(-1)).toEqual({ type: 'shutdown' });
    clock.advance(999);
    expect(child.kills).toEqual([]);
    clock.advance(1);
    expect(child.disconnects).toBe(1);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('propagates a load crash and respawns on the next call', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const first = worker.ensureReady();
    await flush();
    spawner.children[0]!.options.onStderr('native exploded');
    spawner.children[0]!.exit(139, 'SIGSEGV');
    expect(sttCode(await first.catch(error => error))).toBe('worker_crashed');
    expect(worker.status()).toMatchObject({ phase: 'error', lastError: { code: 'worker_crashed' } });

    const second = worker.ensureReady();
    await flush();
    expect(spawner.children).toHaveLength(2);
    const child = spawner.children[1]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 2 });
    expect(await second).toEqual({ modelId: model.id, loadMs: 2 });
    expect(worker.status().lastError).toBeUndefined();
  });

  test('times out a hung model load, kills it, and allows a clean respawn', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, { loadTimeoutMs: 50 });
    const hung = worker.ensureReady();
    await flush();
    const first = spawner.children[0]!;
    clock.advance(49);
    expect(first.kills).toEqual([]);
    clock.advance(1);
    expect(sttCode(await hung.catch(error => error))).toBe('load_failed');
    expect(first.kills).toEqual(['SIGTERM']);
    first.emit({ type: 'ready', requestId: 'request-1', modelId: model.id, loadMs: 1 });
    expect(worker.status()).toMatchObject({ phase: 'error', modelId: undefined });

    const retry = worker.ensureReady();
    await flush();
    const replacement = spawner.children[1]!;
    const load = replacement.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    replacement.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    expect(await retry).toEqual({ modelId: model.id, loadMs: 1 });
  });

  test('retries timed-out discovery and ignores its late result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kteam-stt-discovery-retry-'));
    const good = path.join(root, 'good-lib');
    const late = path.join(root, 'late-lib');
    await mkdir(good, { recursive: true });
    await mkdir(late, { recursive: true });
    await writeFile(path.join(good, 'libstdc++.so.6'), '');
    await writeFile(path.join(late, 'libstdc++.so.6'), '');
    try {
      const spawner = new FakeSpawner();
      const clock = new FakeClock();
      const firstDiscovery = deferred<string | undefined>();
      let discoveries = 0;
      const worker = client(spawner, clock, {
        loadTimeoutMs: 50,
        discoverNativeLibDirectory: () => {
          discoveries++;
          return discoveries === 1 ? firstDiscovery.promise : good;
        },
      });

      let settled = false;
      const firstOutcome = worker.ensureReady().then(
        value => {
          settled = true;
          return value;
        },
        error => {
          settled = true;
          return error;
        },
      );
      await flush();
      expect(discoveries).toBe(1);
      expect(worker.status().phase).toBe('loading');
      expect(spawner.children).toHaveLength(0);
      clock.advance(49);
      await flush();
      expect(settled).toBe(false);
      clock.advance(1);
      expect(sttCode(await firstOutcome)).toBe('load_failed');
      expect(worker.status()).toMatchObject({ phase: 'error', lastError: { code: 'load_failed' } });

      const retry = worker.ensureReady();
      await flush();
      expect(discoveries).toBe(2);
      const child = spawner.children[0]!;
      const childLibraries = child.options.env.LD_LIBRARY_PATH!.split(path.delimiter);
      expect(childLibraries).toContain(good);
      expect(childLibraries).not.toContain(late);
      const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
      child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
      await retry;

      firstDiscovery.resolve(late);
      await flush();
      child.exit(1);
      const respawn = worker.ensureReady();
      await flush();
      expect(discoveries).toBe(2);
      const replacement = spawner.children[1]!;
      const replacementLibraries = replacement.options.env.LD_LIBRARY_PATH!.split(path.delimiter);
      expect(replacementLibraries).toContain(good);
      expect(replacementLibraries).not.toContain(late);
      const replacementLoad = replacement.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
      replacement.emit({
        type: 'ready',
        requestId: replacementLoad.requestId,
        modelId: model.id,
        loadMs: 1,
      });
      await respawn;

      const closing = worker.close();
      replacement.exit(0, 'SIGTERM');
      await closing;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds unresolved model resolution within the same warm-up timeout', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const modelGate = deferred<SttWorkerModel | undefined>();
    const worker = client(spawner, clock, { loadTimeoutMs: 30, resolveModel: () => modelGate.promise });
    const outcome = worker.ensureReady().catch(error => error);
    await flush();
    clock.advance(30);
    expect(sttCode(await outcome)).toBe('load_failed');
    expect(spawner.children).toHaveLength(0);

    modelGate.resolve(model);
    await flush();
    expect(spawner.children).toHaveLength(0);
    await worker.close();
  });

  test('propagates a decode crash without replaying audio, then respawns', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const first = worker.transcribe(Float32Array.of(0));
    await flush();
    const child = spawner.children[0]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await flush();
    expect(child.sent.filter(message => message.type === 'transcribe')).toHaveLength(1);
    child.exit(1);
    expect(sttCode(await first.catch(error => error))).toBe('worker_crashed');
    expect(child.sent.filter(message => message.type === 'transcribe')).toHaveLength(1);

    const next = worker.transcribe(Float32Array.of(0));
    await flush();
    const replacement = spawner.children[1]!;
    const replacementLoad = replacement.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    replacement.emit({ type: 'ready', requestId: replacementLoad.requestId, modelId: model.id, loadMs: 1 });
    await flush();
    const transcribe = replacement.sent[1] as Extract<SttWorkerRequest, { type: 'transcribe' }>;
    replacement.emit({
      type: 'result',
      requestId: transcribe.requestId,
      modelId: model.id,
      text: 'ok',
      audioMs: 1,
      decodeMs: 1,
    });
    expect((await next).text).toBe('ok');
  });

  test('times out a hung decode, releases busy, and respawns for the next clip', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, { decodeTimeoutMs: 75 });
    const hung = worker.transcribe(Float32Array.of(0));
    await flush();
    const first = spawner.children[0]!;
    const load = first.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    first.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await flush();
    clock.advance(75);
    expect(sttCode(await hung.catch(error => error))).toBe('decode_failed');
    expect(first.kills).toEqual(['SIGTERM']);

    const next = worker.transcribe(Float32Array.of(0));
    await flush();
    expect(spawner.children).toHaveLength(2);
    const replacement = spawner.children[1]!;
    const nextLoad = replacement.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    replacement.emit({ type: 'ready', requestId: nextLoad.requestId, modelId: model.id, loadMs: 1 });
    await flush();
    const request = replacement.sent[1] as Extract<SttWorkerRequest, { type: 'transcribe' }>;
    replacement.emit({
      type: 'result',
      requestId: request.requestId,
      modelId: model.id,
      text: 'recovered',
      audioMs: 1,
      decodeMs: 1,
    });
    expect((await next).text).toBe('recovered');
  });

  test('maps worker errors and malformed responses without hanging a request', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const loading = worker.ensureReady();
    await flush();
    const child = spawner.children[0]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'error', requestId: load.requestId, code: 'native_missing', message: 'libstdc++ missing' });
    expect(sttCode(await loading.catch(error => error))).toBe('native_missing');
    expect(child.kills).toEqual(['SIGTERM']);

    const retry = worker.ensureReady();
    await flush();
    const replacement = spawner.children[1]!;
    replacement.emit({ nonsense: true });
    expect(sttCode(await retry.catch(error => error))).toBe('worker_unavailable');
    expect(replacement.kills).toEqual(['SIGTERM']);
  });

  test('handles an IPC send failure and allows a later respawn', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const loading = worker.ensureReady();
    await flush();
    const child = spawner.children[0]!;
    child.emit({ type: 'ready', requestId: 'request-1', modelId: model.id, loadMs: 1 });
    await loading;
    child.throwOnSend = true;
    expect(sttCode(await worker.transcribe(Float32Array.of(0)).catch(error => error))).toBe('worker_crashed');
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('close is idempotent and resolves when its child exits cleanly', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const loading = worker.ensureReady();
    await flush();
    const child = spawner.children[0]!;
    const loadingError = loading.catch(error => error);
    const closing = worker.close();
    expect(worker.close()).toBe(closing);
    expect(sttCode(await loadingError)).toBe('service_closed');
    expect(child.sent.at(-1)).toEqual({ type: 'shutdown' });
    expect(child.kills).toEqual(['SIGTERM']);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    child.exit(0, 'SIGTERM');
    await closing;
    clock.advance(3_000);
    expect(child.kills).toEqual(['SIGTERM']);
    expect(worker.status().phase).toBe('closed');
    expect(sttCode(await worker.ensureReady().catch(error => error))).toBe('service_closed');
  });

  test('close escalates a never-settling child to SIGKILL and has a bounded final fallback', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, { shutdownTimeoutMs: 50, killTimeoutMs: 25 });
    const loading = worker.ensureReady();
    await flush();
    const child = spawner.children[0]!;
    const loadingError = loading.catch(error => error);
    const closing = worker.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });

    expect(sttCode(await loadingError)).toBe('service_closed');
    expect(child.kills).toEqual(['SIGTERM']);
    clock.advance(49);
    await flush();
    expect(child.kills).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    clock.advance(1);
    await flush();
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(false);
    clock.advance(24);
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    await closing;
    expect(settled).toBe(true);
  });

  test('close drains detached predecessors and the current worker together', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, {
      loadTimeoutMs: 10,
      shutdownTimeoutMs: 20,
      killTimeoutMs: 10,
    });
    const firstLoad = worker.ensureReady();
    await flush();
    const predecessor = spawner.children[0]!;
    clock.advance(10);
    expect(sttCode(await firstLoad.catch(error => error))).toBe('load_failed');
    expect(predecessor.kills).toEqual(['SIGTERM']);

    const retry = worker.ensureReady();
    await flush();
    const current = spawner.children[1]!;
    const retryError = retry.catch(error => error);
    const closing = worker.close();
    expect(sttCode(await retryError)).toBe('service_closed');
    expect(current.kills).toEqual(['SIGTERM']);
    current.exit(0, 'SIGTERM');
    await flush();

    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    clock.advance(19);
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    await flush();
    expect(predecessor.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(current.kills).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    predecessor.exit(0, 'SIGKILL');
    await closing;
    expect(settled).toBe(true);
  });

  test('close during model resolution cannot spawn a late worker', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const modelGate = deferred<SttWorkerModel | undefined>();
    const worker = client(spawner, clock, { resolveModel: () => modelGate.promise });
    const loading = worker.ensureReady();
    const loadingError = loading.catch(error => error);
    await flush();
    await worker.close();
    modelGate.resolve(model);
    expect(sttCode(await loadingError)).toBe('service_closed');
    expect(spawner.children).toHaveLength(0);
  });

  test('close during asynchronous native discovery cannot spawn a late worker', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const discoveryGate = deferred<string | undefined>();
    const worker = client(spawner, clock, { discoverNativeLibDirectory: () => discoveryGate.promise });
    const loading = worker.ensureReady();
    const loadingError = loading.catch(error => error);
    await flush();
    expect(spawner.children).toHaveLength(0);
    await worker.close();
    discoveryGate.resolve(undefined);
    expect(sttCode(await loadingError)).toBe('service_closed');
    await flush();
    expect(spawner.children).toHaveLength(0);
  });

  test('rejects a transcript attributed to a different model', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock);
    const transcription = worker.transcribe(Float32Array.of(0));
    await flush();
    const child = spawner.children[0]!;
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await flush();
    const request = child.sent[1] as Extract<SttWorkerRequest, { type: 'transcribe' }>;
    child.emit({
      type: 'result',
      requestId: request.requestId,
      modelId: 'unexpected-model',
      text: 'wrong provenance',
      audioMs: 1,
      decodeMs: 1,
    });
    expect(sttCode(await transcription.catch(error => error))).toBe('worker_unavailable');
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('reports model absence without spawning or fetching anything', async () => {
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, { resolveModel: async () => undefined });
    expect(sttCode(await worker.ensureReady().catch(error => error))).toBe('model_missing');
    expect(spawner.children).toHaveLength(0);
  });
});

describe('worker path and native environment helpers', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-stt-worker-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('selects source TypeScript or built JavaScript beside the caller', async () => {
    await writeFile(path.join(root, 'stt-worker.ts'), '');
    expect(resolveSttWorkerEntry(root)).toBe(path.join(root, 'stt-worker.ts'));
    await writeFile(path.join(root, 'stt-worker.js'), '');
    expect(resolveSttWorkerEntry(root)).toBe(path.join(root, 'stt-worker.js'));
  });

  test('discovers the newest usable Nix GCC runtime asynchronously', async () => {
    const store = path.join(root, 'store');
    const older = path.join(store, 'aaa-gcc-12.3.0-lib', 'lib');
    const newest = path.join(store, 'bbb-gcc-14.2.1-lib', 'lib');
    await mkdir(older, { recursive: true });
    await mkdir(newest, { recursive: true });
    await mkdir(path.join(store, 'ccc-gcc-99.0-lib', 'lib'), { recursive: true });
    await writeFile(path.join(older, 'libstdc++.so.6'), '');
    await writeFile(path.join(newest, 'libstdc++.so.6'), '');
    await writeFile(path.join(store, 'not-a-gcc-runtime'), '');
    expect(await discoverNixLibstdcxx(store)).toBe(newest);
    expect(await discoverNixLibstdcxx(path.join(root, 'missing-store'))).toBeUndefined();
  });

  test('awaits native discovery once and reuses it for respawns', async () => {
    const discovered = path.join(root, 'gcc-lib');
    await mkdir(discovered, { recursive: true });
    await writeFile(path.join(discovered, 'libstdc++.so.6'), '');
    const discoveryGate = deferred<string | undefined>();
    let discoveries = 0;
    const spawner = new FakeSpawner();
    const clock = new FakeClock();
    const worker = client(spawner, clock, {
      discoverNativeLibDirectory: () => {
        discoveries++;
        return discoveryGate.promise;
      },
    });

    const first = worker.ensureReady();
    await flush();
    expect(discoveries).toBe(1);
    expect(spawner.children).toHaveLength(0);
    discoveryGate.resolve(discovered);
    await flush();
    const child = spawner.children[0]!;
    expect(child.options.env.LD_LIBRARY_PATH).toBe(
      ['/node_modules/sherpa-onnx-linux-x64', discovered, '/existing'].join(path.delimiter),
    );
    const load = child.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    child.emit({ type: 'ready', requestId: load.requestId, modelId: model.id, loadMs: 1 });
    await first;
    child.exit(1);

    const retry = worker.ensureReady();
    await flush();
    expect(discoveries).toBe(1);
    expect(spawner.children).toHaveLength(2);
    expect(spawner.children[1]!.options.env.LD_LIBRARY_PATH).toBe(child.options.env.LD_LIBRARY_PATH);
    const retryLoad = spawner.children[1]!.sent[0] as Extract<SttWorkerRequest, { type: 'load' }>;
    spawner.children[1]!.emit({
      type: 'ready',
      requestId: retryLoad.requestId,
      modelId: model.id,
      loadMs: 1,
    });
    await retry;
  });

  test('prepends addon and configured/discovered libstdc++ directories without empty entries', async () => {
    const configured = path.join(root, 'configured');
    const discoveredRoot = path.join(root, 'gcc-lib');
    const discovered = path.join(discoveredRoot, 'lib');
    await mkdir(configured, { recursive: true });
    await mkdir(discovered, { recursive: true });
    await writeFile(path.join(configured, 'libstdc++.so.6'), '');
    await writeFile(path.join(discovered, 'libstdc++.so.6'), '');
    const env = buildSttWorkerEnvironment({
      env: { KEEP: 'yes', LD_LIBRARY_PATH: '/old' },
      addonDirectory: '/addon',
      configuredNativeLibPath: configured,
      discoveredNativeLibDirectory: discoveredRoot,
    });
    if (process.platform === 'linux') {
      expect(env.LD_LIBRARY_PATH).toBe(['/addon', configured, discovered, '/old'].join(path.delimiter));
    }
    expect(env.KEEP).toBe('yes');
    expect(env.LD_LIBRARY_PATH).not.toContain('undefined');
  });

  test('persists native stderr in a serialized bounded diagnostic log', async () => {
    const file = path.join(root, 'daemon', 'stt', 'worker.log');
    const sink = createBoundedSttLogSink(file, 1_024);
    await Promise.all([sink('A'.repeat(700)), sink('B'.repeat(700))]);
    const bytes = await readFile(file);
    expect(bytes.byteLength).toBe(1_024);
    expect(bytes.toString('utf8')).toEndWith('B'.repeat(700));
  });
});
