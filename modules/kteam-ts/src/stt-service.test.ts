import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KTeamPaths } from './paths';
import { encodeCanonicalWav } from './stt-audio';
import type { PublicSttModelFile } from './stt-model';
import { createSttService, type SttModelManager } from './stt-service';
import {
  STT_MAX_PCM_BYTES,
  SttError,
  type SttInstallStatus,
  type SttModelKind,
  type SttModelStatus,
  type SttWorkerModel,
  type SttWorkerStatus,
} from './stt-types';
import type { SttWorkerClientLike, SttWorkerTranscription } from './stt-worker-client';
import { KTEAM_VERSION } from './version';

function install(id: string, phase: SttInstallStatus['phase'] = 'idle'): SttInstallStatus {
  return { modelId: id, phase, receivedBytes: 0, totalBytes: 100 };
}

function modelStatus(kind: SttModelKind, state: SttModelStatus['state']): SttModelStatus {
  const id = kind === 'daemon' ? 'daemon-fixture' : 'browser-fixture';
  return {
    id,
    kind,
    label: `${kind} fixture`,
    state,
    languages: ['en'],
    costs:
      kind === 'daemon'
        ? {
            downloadBytes: 482_468_385,
            diskBytes: 661_428_477,
            ramBytesApprox: 1_073_741_824,
            summary: '460 MB download, 631 MB extracted, about 1 GB RAM while the batch worker is loaded.',
          }
        : {
            downloadBytes: 670_488_135,
            diskBytes: 670_488_135,
            ramBytesApprox: 1_073_741_824,
            summary: '640 MB browser model.',
          },
    install: install(id, state === 'ready' ? 'ready' : state === 'installing' ? 'downloading' : 'idle'),
  };
}

class FakeModels implements SttModelManager {
  daemon = modelStatus('daemon', 'ready');
  browser = modelStatus('browser', 'not-installed');
  installs = 0;
  publicFiles = new Map<string, PublicSttModelFile>();

  async inventory() {
    return { daemon: structuredClone(this.daemon), browser: structuredClone(this.browser) };
  }

  async modelStatus(modelId: string): Promise<SttModelStatus> {
    if (modelId === this.daemon.id) return structuredClone(this.daemon);
    if (modelId === this.browser.id) return structuredClone(this.browser);
    throw new SttError('model_not_found', `unknown STT model: ${modelId}`, 400);
  }

  async startInstall(modelId: string): Promise<{ started: boolean; status: SttModelStatus }> {
    const current = await this.modelStatus(modelId);
    if (current.state === 'installing' || current.state === 'ready') return { started: false, status: current };
    this.installs++;
    const next = { ...current, state: 'installing' as const, install: install(modelId, 'downloading') };
    if (current.kind === 'daemon') this.daemon = next;
    else this.browser = next;
    return { started: true, status: structuredClone(next) };
  }

  async resolveDaemonModel(): Promise<SttWorkerModel | undefined> {
    return this.daemon.state === 'ready'
      ? {
          id: this.daemon.id,
          directory: '/models/daemon-fixture',
          encoder: '/models/daemon-fixture/encoder',
          decoder: '/models/daemon-fixture/decoder',
          joiner: '/models/daemon-fixture/joiner',
          tokens: '/models/daemon-fixture/tokens',
        }
      : undefined;
  }

  async resolvePublicFile(modelId: string, fileName: string): Promise<PublicSttModelFile | undefined> {
    return this.publicFiles.get(`${modelId}/${fileName}`);
  }

  definitionFor(kind: SttModelKind): { id: string } {
    return { id: kind === 'daemon' ? this.daemon.id : this.browser.id };
  }
}

class FakeWorker implements SttWorkerClientLike {
  phase: SttWorkerStatus['phase'] = 'cold';
  calls: Float32Array[] = [];
  closes = 0;
  result: SttWorkerTranscription = {
    text: ' Raw batch transcript.',
    audioMs: 1_000,
    decodeMs: 250,
    modelId: 'daemon-fixture',
  };
  failure: unknown;

  status(): SttWorkerStatus {
    return { phase: this.phase };
  }

  async ensureReady() {
    return { modelId: 'daemon-fixture', loadMs: 1 };
  }

  async transcribe(audio: Float32Array): Promise<SttWorkerTranscription> {
    this.calls.push(audio);
    if (this.failure) throw this.failure;
    return this.result;
  }

  async close(): Promise<void> {
    this.closes++;
    this.phase = 'closed';
  }
}

function bytesBody(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function rawRequest(bytes: Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/stt/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/L16; rate=16000; channels=1', ...headers },
    body: bytesBody(bytes),
  });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function streamingRequest(chunks: Uint8Array[], contentType = 'audio/L16; rate=16000; channels=1'): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request('http://localhost/v1/stt/transcribe', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('STT service API', () => {
  let root: string;
  let models: FakeModels;
  let worker: FakeWorker;
  let service: ReturnType<typeof createSttService>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-stt-service-'));
    models = new FakeModels();
    worker = new FakeWorker();
    service = createSttService({
      paths: { home: root, daemon: path.join(root, 'daemon') } as KTeamPaths,
      models,
      worker,
    });
  });

  afterEach(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  test('reports an honest batch-only status with exact costs and browser state', async () => {
    const direct = await service.status();
    expect(direct).toMatchObject({
      available: true,
      streaming: false,
      mode: 'batch',
      language: 'en',
      languages: ['en'],
      worker: { phase: 'cold' },
      models: {
        daemon: {
          state: 'ready',
          costs: { downloadBytes: 482_468_385, diskBytes: 661_428_477, ramBytesApprox: 1_073_741_824 },
        },
        browser: { state: 'not-installed', costs: { downloadBytes: 670_488_135 } },
      },
      limits: { maxDurationSeconds: 120, maxPcmBytes: 3_840_000 },
    });
    const response = await service.handleApi(
      new Request('http://localhost/v1/stt/status'),
      new URL('http://localhost/v1/stt/status'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kteam-version')).toBe(KTEAM_VERSION);
    expect((await responseJson(response)).streaming).toBe(false);
    expect(models.installs).toBe(0);
    expect(worker.calls).toHaveLength(0);
  });

  test('transcribes raw PCM and returns one final transcript with no partial claim', async () => {
    const request = rawRequest(Uint8Array.of(0x00, 0x80, 0xff, 0x7f));
    const response = await service.handleApi(request, new URL(request.url));
    expect(response.status).toBe(200);
    expect(worker.calls).toHaveLength(1);
    expect(Array.from(worker.calls[0]!)).toEqual([-1, 32_767 / 32_768]);
    const body = await responseJson(response);
    expect(body).toEqual({
      text: ' Raw batch transcript.',
      audioMs: 1_000,
      decodeMs: 250,
      rtf: 0.25,
      modelId: 'daemon-fixture',
      language: 'en',
      mode: 'batch',
      streaming: false,
    });
    expect('partial' in body).toBe(false);
  });

  test('accepts canonical WAV and validates English-only/content-type contracts', async () => {
    const wav = encodeCanonicalWav(Float32Array.of(0, 0.5));
    const wavRequest = new Request('http://localhost/v1/stt/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: bytesBody(wav),
    });
    expect((await service.handleApi(wavRequest, new URL(wavRequest.url))).status).toBe(200);

    const languageRequest = rawRequest(Uint8Array.of(0, 0));
    const languageResponse = await service.handleApi(languageRequest, new URL(`${languageRequest.url}?language=fr`));
    expect(languageResponse.status).toBe(400);
    expect((await responseJson(languageResponse)).code).toBe('unsupported_language');

    const wrongType = new Request('http://localhost/v1/stt/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytesBody(Uint8Array.of(0, 0)),
    });
    const wrongTypeResponse = await service.handleApi(wrongType, new URL(wrongType.url));
    expect(wrongTypeResponse.status).toBe(400);
    expect((await responseJson(wrongTypeResponse)).code).toBe('bad_audio');
  });

  test('enforces the exact 120-second boundary for declared and streamed bodies', async () => {
    worker.result.audioMs = 120_000;
    const exact = rawRequest(new Uint8Array(STT_MAX_PCM_BYTES));
    expect((await service.handleApi(exact, new URL(exact.url))).status).toBe(200);

    const declared = rawRequest(Uint8Array.of(0, 0), { 'content-length': String(STT_MAX_PCM_BYTES + 2) });
    const declaredResponse = await service.handleApi(declared, new URL(declared.url));
    expect(declaredResponse.status).toBe(413);
    expect((await responseJson(declaredResponse)).code).toBe('too_long');

    const chunked = streamingRequest([new Uint8Array(STT_MAX_PCM_BYTES), Uint8Array.of(0, 0)]);
    const chunkedResponse = await service.handleApi(chunked, new URL(chunked.url));
    expect(chunkedResponse.status).toBe(413);
    expect((await responseJson(chunkedResponse)).code).toBe('too_long');
  });

  test('maps bad audio, missing/installing models, busy, and native failures to stable statuses', async () => {
    const odd = rawRequest(Uint8Array.of(0));
    let response = await service.handleApi(odd, new URL(odd.url));
    expect(response.status).toBe(400);
    expect((await responseJson(response)).code).toBe('bad_audio');

    models.daemon = modelStatus('daemon', 'not-installed');
    const missing = rawRequest(Uint8Array.of(0, 0));
    response = await service.handleApi(missing, new URL(missing.url));
    expect(response.status).toBe(503);
    expect((await responseJson(response)).code).toBe('model_missing');
    expect(worker.calls).toHaveLength(0);

    models.daemon = modelStatus('daemon', 'installing');
    const installing = rawRequest(Uint8Array.of(0, 0));
    response = await service.handleApi(installing, new URL(installing.url));
    expect(response.status).toBe(409);
    expect((await responseJson(response)).code).toBe('model_installing');

    models.daemon = modelStatus('daemon', 'ready');
    worker.phase = 'busy';
    const busy = rawRequest(Uint8Array.of(0, 0));
    response = await service.handleApi(busy, new URL(busy.url));
    expect(response.status).toBe(409);
    expect((await responseJson(response)).code).toBe('busy');

    worker.phase = 'cold';
    worker.failure = new SttError('native_missing', 'libstdc++ is missing', 503);
    const native = rawRequest(Uint8Array.of(0, 0));
    response = await service.handleApi(native, new URL(native.url));
    expect(response.status).toBe(503);
    expect((await responseJson(response)).code).toBe('native_missing');
  });

  test('starts installs only on the explicit route and reports progress through status', async () => {
    models.daemon = modelStatus('daemon', 'not-installed');
    const url = new URL('http://localhost/v1/stt/models/daemon-fixture/install');
    const started = await service.handleApi(new Request(url, { method: 'POST' }), url);
    expect(started.status).toBe(202);
    expect(models.installs).toBe(1);
    expect((await responseJson(started)).state).toBe('installing');

    const duplicate = await service.handleApi(new Request(url, { method: 'POST' }), url);
    expect(duplicate.status).toBe(409);
    expect((await responseJson(duplicate)).code).toBe('model_installing');

    const progress = await service.handleApi(
      new Request('http://localhost/v1/stt/status'),
      new URL('http://localhost/v1/stt/status'),
    );
    expect((await responseJson(progress)).models.daemon.install.phase).toBe('downloading');

    const unknownUrl = new URL('http://localhost/v1/stt/models/%2e%2e/install');
    const unknown = await service.handleApi(new Request(unknownUrl, { method: 'POST' }), unknownUrl);
    expect(unknown.status).toBe(404);
  });

  test('returns route-specific Allow headers and stable unknown-route errors', async () => {
    const methodCases = [
      { pathname: '/v1/stt/status', method: 'POST', allow: 'GET' },
      { pathname: '/v1/stt/transcribe', method: 'GET', allow: 'POST' },
      { pathname: '/v1/stt/models', method: 'POST', allow: 'GET' },
      { pathname: '/v1/stt/models/daemon-fixture/install', method: 'PATCH', allow: 'GET, POST' },
    ];
    for (const methodCase of methodCases) {
      const url = new URL(`http://localhost${methodCase.pathname}`);
      const response = await service.handleApi(new Request(url, { method: methodCase.method }), url);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe(methodCase.allow);
      expect(response.headers.get('x-kteam-version')).toBe(KTEAM_VERSION);
      expect((await responseJson(response)).code).toBe('method_not_allowed');
    }

    const missingUrl = new URL('http://localhost/v1/stt/nope');
    const missing = await service.handleApi(new Request(missingUrl), missingUrl);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-kteam-version')).toBe(KTEAM_VERSION);
    expect(await responseJson(missing)).toEqual({
      error: 'no route GET /v1/stt/nope',
      code: 'unknown_route',
      method: 'GET',
      path: '/v1/stt/nope',
    });
  });

  test('close delegates once and leaves a controlled unavailable surface', async () => {
    await Promise.all([service.close(), service.close()]);
    expect(worker.closes).toBe(1);
    const status = await service.status();
    expect(status.available).toBe(false);
    expect(status.worker.phase).toBe('closed');
    const request = rawRequest(Uint8Array.of(0, 0));
    const response = await service.handleApi(request, new URL(request.url));
    expect(response.status).toBe(503);
    expect((await responseJson(response)).code).toBe('service_closed');
  });
});

describe('public browser model serving', () => {
  let root: string;
  let file: string;
  let bytes: Uint8Array;
  let models: FakeModels;
  let worker: FakeWorker;
  let service: ReturnType<typeof createSttService>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-stt-public-'));
    bytes = new TextEncoder().encode('0123456789');
    file = path.join(root, 'vocab.txt');
    await writeFile(file, bytes);
    models = new FakeModels();
    models.publicFiles.set('browser-fixture/vocab.txt', {
      path: file,
      definition: {
        name: 'vocab.txt',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mime: 'text/plain; charset=utf-8',
        public: true,
      },
    });
    worker = new FakeWorker();
    service = createSttService({
      paths: { home: root, daemon: path.join(root, 'daemon') } as KTeamPaths,
      models,
      worker,
    });
  });

  afterEach(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  async function serve(pathname: string, init?: RequestInit): Promise<Response> {
    const url = new URL(`http://localhost${pathname}`);
    return await service.handlePublicModel(new Request(url, init), url);
  }

  test('serves GET and HEAD with immutable integrity-aware headers', async () => {
    const get = await serve('/stt-models/browser-fixture/vocab.txt');
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('0123456789');
    expect(get.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(get.headers.get('content-length')).toBe('10');
    expect(get.headers.get('accept-ranges')).toBe('bytes');
    expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(get.headers.get('etag')).toStartWith('"sha256-');

    const head = await serve('/stt-models/browser-fixture/vocab.txt', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(await head.text()).toBe('');
  });

  test('supports closed, open, and suffix byte ranges including HEAD', async () => {
    let response = await serve('/stt-models/browser-fixture/vocab.txt', { headers: { range: 'bytes=0-3' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('0123');
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(response.headers.get('content-length')).toBe('4');

    response = await serve('/stt-models/browser-fixture/vocab.txt', { headers: { range: 'bytes=4-' } });
    expect(await response.text()).toBe('456789');
    response = await serve('/stt-models/browser-fixture/vocab.txt', { headers: { range: 'bytes=-4' } });
    expect(await response.text()).toBe('6789');
    response = await serve('/stt-models/browser-fixture/vocab.txt', {
      method: 'HEAD',
      headers: { range: 'bytes=2-5' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('');
  });

  test('returns 416 for malformed, multiple, inverted, and out-of-bounds ranges', async () => {
    for (const range of ['items=0-1', 'bytes=', 'bytes=4-2', 'bytes=99-', 'bytes=0-1,3-4', 'bytes=-0']) {
      const response = await serve('/stt-models/browser-fixture/vocab.txt', { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
      expect(await response.text()).toBe('');
    }
  });

  test('rejects traversal, unknown files/models, extra segments, and non-read methods', async () => {
    for (const pathname of [
      '/stt-models/browser-fixture/%2e%2e',
      '/stt-models/browser-fixture/%252e%252e',
      '/stt-models/browser-fixture/%2Fetc',
      '/stt-models/browser-fixture/%5Cetc',
      '/stt-models/browser-fixture/nope.onnx',
      '/stt-models/unknown/vocab.txt',
      '/stt-models/browser-fixture/vocab.txt/extra',
    ]) {
      expect((await serve(pathname)).status).toBe(404);
    }
    const post = await serve('/stt-models/browser-fixture/vocab.txt', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(post.headers.get('x-kteam-version')).toBe(KTEAM_VERSION);
    expect((await responseJson(post)).code).toBe('method_not_allowed');
  });

  test('evaluates matching If-None-Match before valid or invalid ranges', async () => {
    const initial = await serve('/stt-models/browser-fixture/vocab.txt', { method: 'HEAD' });
    const etag = initial.headers.get('etag')!;
    for (const range of [undefined, 'bytes=2-5', 'bytes=99-', 'items=0-1']) {
      const response = await serve('/stt-models/browser-fixture/vocab.txt', {
        headers: { 'if-none-match': etag, ...(range ? { range } : {}) },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get('content-range')).toBeNull();
      expect(await response.text()).toBe('');
    }

    for (const validator of [`"stale", ${etag}`, `W/${etag}`, '*']) {
      const response = await serve('/stt-models/browser-fixture/vocab.txt', {
        headers: { 'if-none-match': validator },
      });
      expect(response.status).toBe(304);
    }
  });
});
