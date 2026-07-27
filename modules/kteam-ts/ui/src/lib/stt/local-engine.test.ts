import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/* The two heavy dependencies are replaced before the module under test is
   imported. Nothing here loads a real ONNX Runtime or a real 652 MB encoder —
   what is being tested is WHICH URLs the loader is handed and WHEN it is
   allowed to run at all, and both of those are decisions this module makes on
   its own. */

const fromUrls = mock(async (config: Record<string, unknown>) => {
  void config;
  return { transcribe: async () => ({ utterance_text: '  hello from the browser  ' }) };
});
mock.module('parakeet.js', () => ({ fromUrls }));

const ortEnv = { env: { wasm: {} as Record<string, unknown> } };
mock.module('onnxruntime-web', () => ({ default: ortEnv }));

const {
  ORT_WASM_URL,
  PrepareError,
  STT_BROWSER_MODEL_ID,
  STT_MODEL_ASSETS,
  STT_MODEL_BASE,
  STT_MODEL_CACHE,
  clearLocalModel,
  localEngineAssets,
  localEngineTotalBytes,
  localModelReadiness,
  openPreparedAssets,
  prepareLocalModel,
  selectLocalBackend,
  transcribeLocal,
  unloadLocalEngine,
} = await import('./local-engine');
const { resetOrtRuntimeConfiguration } = await import('./ort-assets');

/* ---------- fakes ---------------------------------------------------------- */

class FakeCache {
  entries = new Map<string, Uint8Array>();
  putFailure: Error | null = null;

  async match(url: string): Promise<Response | undefined> {
    const bytes = this.entries.get(url);
    return bytes === undefined ? undefined : new Response(bytes as unknown as BodyInit);
  }

  async put(url: string, response: Response): Promise<void> {
    if (this.putFailure) throw this.putFailure;
    // Consuming the stream is what a real Cache does, and it is what makes the
    // counting TransformStream in the module under test actually run.
    const buffer = new Uint8Array(await response.arrayBuffer());
    this.entries.set(url, buffer);
  }

  async delete(url: string): Promise<boolean> {
    return this.entries.delete(url);
  }
}

let cache: FakeCache;
let deletedCaches: string[];

function installCaches(): void {
  cache = new FakeCache();
  deletedCaches = [];
  (globalThis as { caches?: unknown }).caches = {
    open: async () => cache,
    delete: async (name: string) => {
      deletedCaches.push(name);
      return true;
    },
  };
}

/** A response whose body is a stream and whose buffering accessors THROW, so a
 *  test fails loudly if the implementation ever goes back to collecting the
 *  whole 652 MB body before storing it. */
function streamingResponse(totalBytes: number, chunkSize = 8): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
  });
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(totalBytes) }),
    body,
    arrayBuffer() {
      throw new Error('arrayBuffer() was called — the body must never be buffered whole');
    },
    blob() {
      throw new Error('blob() was called — the body must never be buffered whole');
    },
  };
  return response as unknown as Response;
}

/** A byte-exact MINIATURE manifest.
 *
 *  The production manifest is 670 MB; iterating it in a test would be minutes
 *  of pure loop. These four assets have the same shape and the same
 *  `exactBytes` contract at a scale a test can afford, and the real pinned
 *  sizes are asserted separately in "the pinned manifest". */
const TINY_ASSETS = [
  { url: '/stt-models/parakeet-browser-v3/encoder-model.int8.onnx', label: 'Encoder', bytes: 4_096, exactBytes: true },
  {
    url: '/stt-models/parakeet-browser-v3/decoder_joint-model.int8.onnx',
    label: 'Decoder',
    bytes: 512,
    exactBytes: true,
  },
  { url: '/stt-models/parakeet-browser-v3/vocab.txt', label: 'Vocabulary', bytes: 128, exactBytes: true },
  { url: ORT_WASM_URL, label: 'Speech runtime', bytes: 256, exactBytes: false },
] as const;

const TINY_TOTAL = TINY_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);

/** Serve every miniature asset at exactly its declared size. */
function serveTiny(overrides?: Map<string, number>) {
  return async (url: string) => {
    const asset = TINY_ASSETS.find(candidate => candidate.url === url);
    return streamingResponse(overrides?.get(url) ?? asset?.bytes ?? 0);
  };
}

beforeEach(() => {
  installCaches();
  unloadLocalEngine();
  resetOrtRuntimeConfiguration();
  fromUrls.mockClear();
  ortEnv.env.wasm = {};
});

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

/* ---------- the manifest --------------------------------------------------- */

describe('the pinned manifest', () => {
  test("names the daemon's model id and its three public files", () => {
    expect(STT_BROWSER_MODEL_ID).toBe('parakeet-browser-v3');
    expect(STT_MODEL_BASE).toBe('/stt-models/parakeet-browser-v3');
    expect(STT_MODEL_ASSETS.map(asset => asset.url)).toEqual([
      '/stt-models/parakeet-browser-v3/encoder-model.int8.onnx',
      '/stt-models/parakeet-browser-v3/decoder_joint-model.int8.onnx',
      '/stt-models/parakeet-browser-v3/vocab.txt',
    ]);
  });

  test("carries the daemon manifest's EXACT byte counts, not approximations", () => {
    // These are the numbers in `src/stt-model.ts`. If either side moves, the
    // progress bar lies and the completeness check rejects a good download.
    expect(STT_MODEL_ASSETS.map(asset => asset.bytes)).toEqual([652_183_999, 18_202_004, 102_132]);
    expect(STT_MODEL_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0)).toBe(670_488_135);
    for (const asset of STT_MODEL_ASSETS) expect(asset.exactBytes).toBe(true);
  });

  test('includes the ONNX runtime, because a prepared device needs it too', () => {
    const assets = localEngineAssets();
    expect(assets).toHaveLength(4);
    expect(assets[3]?.url).toBe(ORT_WASM_URL);
    // Its size is a build detail, so it is NOT completeness-checked.
    expect(assets[3]?.exactBytes).toBe(false);
    expect(localEngineTotalBytes()).toBeGreaterThan(670_488_135);
  });

  test("the cache name is outside the service worker's pruning prefix", () => {
    // `cachesToDelete` deletes everything starting with `kteam-shell-`. If this
    // name ever gained that prefix, a deploy would silently throw away 670 MB.
    expect(STT_MODEL_CACHE).toBe('kteam-stt-model-v1');
    expect(STT_MODEL_CACHE.startsWith('kteam-shell-')).toBe(false);
  });
});

/* ---------- backend -------------------------------------------------------- */

describe('selectLocalBackend', () => {
  test('is WASM even where WebGPU exists, and says why', () => {
    // parakeet.js: the WebGPU execution provider cannot run an int8 encoder,
    // and the int8 encoder is the only one the box hosts.
    const choice = selectLocalBackend({ webgpu: true, likelyMobile: false });
    expect(choice.backend).toBe('wasm');
    expect(choice.webgpuBlockedReason).toContain('int8');
  });

  test('has a different, equally honest reason where WebGPU is absent', () => {
    const choice = selectLocalBackend({ webgpu: false, likelyMobile: false });
    expect(choice.backend).toBe('wasm');
    expect(choice.webgpuBlockedReason).toContain('no WebGPU');
  });

  test('flags a phone as slow', () => {
    expect(selectLocalBackend({ webgpu: false, likelyMobile: true }).slow).toBe(true);
    expect(selectLocalBackend({ webgpu: false, likelyMobile: false }).slow).toBe(false);
  });
});

/* ---------- readiness ------------------------------------------------------ */

describe('localModelReadiness', () => {
  test('an empty cache is not ready, and every asset is missing', async () => {
    const readiness = await localModelReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toHaveLength(4);
  });

  test('a PARTIAL cache — the eviction case — is not ready and names what went', async () => {
    for (const asset of localEngineAssets()) cache.entries.set(asset.url, new Uint8Array(1));
    cache.entries.delete(STT_MODEL_ASSETS[0]!.url);
    const readiness = await localModelReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual([STT_MODEL_ASSETS[0]!.url]);
  });

  test('no CacheStorage at all is not ready rather than a crash', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    expect((await localModelReadiness()).ready).toBe(false);
  });

  test('a complete cache is ready', async () => {
    for (const asset of localEngineAssets()) cache.entries.set(asset.url, new Uint8Array(1));
    expect((await localModelReadiness()).ready).toBe(true);
  });
});

/* ---------- THE GATE ------------------------------------------------------- */

describe('the first-microphone download is forbidden', () => {
  test('an unprepared device refuses BEFORE loading parakeet or touching the network', async () => {
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('the engine must not fetch anything before it is prepared');
    }) as unknown as typeof fetch;
    try {
      await expect(transcribeLocal(new Float32Array([0.1, 0.2]))).rejects.toMatchObject({ code: 'not-prepared' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fromUrls).not.toHaveBeenCalled();
    expect(fetched).toBe(false);
  });

  test('a PARTIALLY evicted device refuses too, with the eviction wording', async () => {
    for (const asset of localEngineAssets()) cache.entries.set(asset.url, new Uint8Array(4));
    cache.entries.delete(STT_MODEL_ASSETS[1]!.url);
    await expect(transcribeLocal(new Float32Array([0.1]))).rejects.toMatchObject({ code: 'not-prepared' });
    await expect(transcribeLocal(new Float32Array([0.1]))).rejects.toThrow(/no longer on this device/);
    expect(fromUrls).not.toHaveBeenCalled();
  });

  test('an empty utterance never reaches the gate at all', async () => {
    expect(await transcribeLocal(new Float32Array(0))).toBe('');
    expect(fromUrls).not.toHaveBeenCalled();
  });
});

/* ---------- loading from the prepared cache -------------------------------- */

describe('loading uses the PREPARED bytes, not the network', () => {
  beforeEach(() => {
    for (const asset of localEngineAssets()) cache.entries.set(asset.url, new Uint8Array(8).fill(1));
  });

  test('hands parakeet blob: URLs, so a page the service worker does not control still works offline', async () => {
    const text = await transcribeLocal(new Float32Array([0.1, 0.2]), {
      capabilities: { webgpu: true, likelyMobile: false },
    });
    expect(text).toBe('hello from the browser');
    expect(fromUrls).toHaveBeenCalledTimes(1);
    const config = fromUrls.mock.calls[0]?.[0] as Record<string, string>;
    for (const key of ['encoderUrl', 'decoderUrl', 'tokenizerUrl']) {
      expect(config[key]?.startsWith('blob:')).toBe(true);
      expect(config[key]).not.toContain('/stt-models/');
    }
  });

  test('pins the backend to WASM and the preprocessor to JS, overriding the library defaults', async () => {
    // parakeet.js defaults to `webgpu-hybrid`, which cannot run our encoder.
    await transcribeLocal(new Float32Array([0.1]), { capabilities: { webgpu: true, likelyMobile: false } });
    const config = fromUrls.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['backend']).toBe('wasm');
    expect(config['preprocessorBackend']).toBe('js');
    expect(config['nMels']).toBe(128);
  });

  test('points ONNX Runtime at a same-document binary and NEVER at a CDN', async () => {
    await transcribeLocal(new Float32Array([0.1]));
    const paths = ortEnv.env.wasm['wasmPaths'] as { wasm: string };
    expect(paths.wasm.startsWith('blob:')).toBe(true);
    expect(JSON.stringify(ortEnv.env.wasm)).not.toContain('jsdelivr');
    // No `mjs` override: that would switch ORT away from its embedded glue and
    // make it fetch a second file.
    expect(paths).not.toHaveProperty('mjs');
  });

  test('passes NO language anywhere, because parakeet 1.4.4 has no such input', async () => {
    // A cosmetic language field the library silently drops would look like it
    // worked. The settings copy carries this instead.
    await transcribeLocal(new Float32Array([0.1]));
    const config = fromUrls.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(config).some(key => key.toLowerCase().includes('lang'))).toBe(false);
  });

  test('loads once and reuses the model for a second utterance', async () => {
    await transcribeLocal(new Float32Array([0.1]));
    await transcribeLocal(new Float32Array([0.2]));
    expect(fromUrls).toHaveBeenCalledTimes(1);
  });
});

describe('openPreparedAssets', () => {
  test('reports what is missing rather than half-opening', async () => {
    cache.entries.set(STT_MODEL_ASSETS[0]!.url, new Uint8Array(1));
    const opened = await openPreparedAssets();
    expect(opened.ready).toBe(false);
    if (!opened.ready) expect(opened.missing).toHaveLength(3);
  });

  test('mints one object URL per asset and revokes them all on request', async () => {
    for (const asset of localEngineAssets()) cache.entries.set(asset.url, new Uint8Array(2));
    const opened = await openPreparedAssets();
    expect(opened.ready).toBe(true);
    if (!opened.ready) return;
    expect(opened.urls.size).toBe(4);
    for (const url of opened.urls.values()) expect(url.startsWith('blob:')).toBe(true);
    expect(() => opened.revoke()).not.toThrow();
  });
});

/* ---------- preparing ------------------------------------------------------ */

describe('prepareLocalModel', () => {
  test('streams into CacheStorage — the body is NEVER buffered whole', async () => {
    // `streamingResponse` throws from arrayBuffer() and blob(). If this passes,
    // no asset was materialised in the JS heap on the way to the cache — which
    // at production scale is the difference between working and an
    // out-of-memory kill on a phone.
    await prepareLocalModel({ assets: TINY_ASSETS, fetchImpl: serveTiny() });
    expect(cache.entries.size).toBe(4);
    for (const asset of TINY_ASSETS) expect(cache.entries.get(asset.url)?.byteLength).toBe(asset.bytes);
  });

  test('reports monotonic progress while the bytes are still moving', async () => {
    const progress: number[] = [];
    await prepareLocalModel({
      assets: TINY_ASSETS,
      fetchImpl: serveTiny(),
      onProgress: report => progress.push(report.receivedBytes),
    });
    expect(progress.length).toBeGreaterThan(3);
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(progress.at(-1)).toBe(TINY_TOTAL);
  });

  test('names each asset as it goes, and ends in the `done` phase', async () => {
    const labels = new Set<string>();
    let last = '';
    await prepareLocalModel({
      assets: TINY_ASSETS,
      fetchImpl: serveTiny(),
      onProgress: report => {
        if (report.label) labels.add(report.label);
        last = report.phase;
      },
    });
    expect([...labels].sort()).toEqual(['Decoder', 'Encoder', 'Speech runtime', 'Vocabulary']);
    expect(last).toBe('done');
  });

  test('skips an asset that is already cached instead of re-downloading it', async () => {
    for (const asset of TINY_ASSETS) cache.entries.set(asset.url, new Uint8Array(asset.bytes));
    const requested: string[] = [];
    await prepareLocalModel({
      assets: TINY_ASSETS,
      fetchImpl: async url => {
        requested.push(url);
        return streamingResponse(1);
      },
    });
    expect(requested).toEqual([]);
  });

  test('REJECTS a short download and keeps nothing of it', async () => {
    const short = new Map([[TINY_ASSETS[2].url, 10]]); // vocab.txt truncated
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl: serveTiny(short) })).rejects.toMatchObject({
      code: 'network',
    });
    expect(cache.entries.has(TINY_ASSETS[2].url)).toBe(false);
  });

  test('rejects a wrong `content-length` before moving a single byte', async () => {
    let bodyPulled = false;
    const fetchImpl = async (url: string) => {
      if (url !== TINY_ASSETS[0].url) return serveTiny()(url);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': '99' }),
        get body() {
          bodyPulled = true;
          return new ReadableStream<Uint8Array>({ start: controller => controller.close() });
        },
      } as unknown as Response;
    };
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl })).rejects.toThrow(/wrong size/);
    expect(bodyPulled).toBe(false);
  });

  test('does NOT size-check the runtime, whose size is a build detail', async () => {
    const odd = new Map([[ORT_WASM_URL, 999]]);
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl: serveTiny(odd) })).resolves.toBeUndefined();
    expect(cache.entries.get(ORT_WASM_URL)?.byteLength).toBe(999);
  });

  test('names the missing-route case, not a generic failure', async () => {
    const fetchImpl = async () => new Response('', { status: 404 });
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl })).rejects.toMatchObject({ code: 'not-served' });
  });

  test('recognises the SPA shell answering instead of a model file', async () => {
    // The daemon serves index.html for unknown paths, so a missing route is a
    // 200 with HTML — the failure mode a plain `res.ok` check would miss.
    const fetchImpl = async () =>
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl })).rejects.toMatchObject({ code: 'not-served' });
  });

  test('maps a storage refusal onto an actionable quota message', async () => {
    cache.putFailure = Object.assign(new Error('no room'), { name: 'QuotaExceededError' });
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl: serveTiny() })).rejects.toMatchObject({
      code: 'quota',
    });
  });

  test('a cancelled preparation stops, and says it was cancelled', async () => {
    const controller = new AbortController();
    const promise = prepareLocalModel({
      assets: TINY_ASSETS,
      fetchImpl: serveTiny(),
      signal: controller.signal,
      onProgress: report => {
        if (report.receivedBytes > 16) controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  test('a browser with no CacheStorage refuses up front', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    await expect(prepareLocalModel()).rejects.toMatchObject({ code: 'no-cache-storage' });
  });

  test('PrepareError is thrown, so callers can branch on the code', async () => {
    const fetchImpl = async () => {
      throw new Error('offline');
    };
    await expect(prepareLocalModel({ assets: TINY_ASSETS, fetchImpl })).rejects.toBeInstanceOf(PrepareError);
  });

  test('production callers get the pinned manifest, not the injected one', async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string) => {
      requested.push(url);
      throw new Error('stop here — only the URL list is under test');
    };
    await expect(prepareLocalModel({ fetchImpl })).rejects.toBeDefined();
    expect(requested[0]).toBe(STT_MODEL_ASSETS[0]!.url);
  });
});

describe('clearLocalModel', () => {
  test('deletes the model cache by name and nothing else', async () => {
    expect(await clearLocalModel()).toBe(true);
    expect(deletedCaches).toEqual([STT_MODEL_CACHE]);
  });

  test('ALSO unloads the in-page model, so Remove actually removes', async () => {
    // The memoised model is returned before the readiness gate — it must be,
    // or every utterance would re-open the cache. So deleting the cache without
    // unloading would leave dictation working, and ~1 GB resident, on the very
    // page that just removed it.
    const { localEngineLoaded } = await import('./local-engine');
    for (const asset of localEngineAssets()) cache.entries.set(asset.url, new Uint8Array(4));
    await transcribeLocal(new Float32Array([0.1]));
    expect(localEngineLoaded()).toBe(true);

    await clearLocalModel();
    expect(localEngineLoaded()).toBe(false);

    // And the next attempt must pass readiness again — which it now cannot,
    // because the entries are gone.
    cache.entries.clear();
    await expect(transcribeLocal(new Float32Array([0.1]))).rejects.toMatchObject({ code: 'not-prepared' });
  });

  test('is false rather than a throw where there is no CacheStorage', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    expect(await clearLocalModel()).toBe(false);
  });
});
