// THE BROWSER ENGINE — local, explicit, and serialized.
//
// It runs Parakeet TDT 0.6B v3 (int8) entirely inside the page via
// `parakeet.js@1.4.4` on `onnxruntime-web@1.24.1`. Nothing leaves the device,
// not even to the reader's own box. The hosted model is an offline TDT
// transducer. Live dictation therefore re-runs bounded audio snapshots and
// stabilises their timestamped word hypotheses; this file never pretends the
// encoder itself is streaming.
//
// ── WHY THE BACKEND IS PINNED TO WASM, even where WebGPU exists ────────────
//
// `parakeet.js`'s own hub path contains this (src/hub.js:426):
//
//     if (backend.startsWith('webgpu') && encoderQ === 'int8')
//       console.warn('[Hub] Forcing encoder to fp32 on WebGPU (int8 unsupported)');
//
// — it swaps to a DIFFERENT FILE, because the WebGPU execution provider cannot
// run this int8 encoder. `fromUrls` performs no such check: it hands whatever
// you give it straight to the provider. We host exactly one encoder, the int8
// one, because the fp32 export is ~2.48 GB and is not a browser download. So
// for our manifest, "use WebGPU when safely available" resolves to: it is never
// safely available. `selectLocalBackend()` says so with a reason rather than
// leaving a plausible-looking WebGPU branch that would fail in the field.
//
// (`fromUrls`'s own default is `'webgpu-hybrid'`, so passing `backend`
// explicitly is not belt-and-braces — it is the entire difference between a
// working engine and a broken one.)
//
// ── COSTS, STATED ONCE AND SHOWN TO THE READER ────────────────────────────
//
//   - Model: ~640 MB per device, per browser profile. The daemon downloads
//     once, on the box, for every device.
//   - ONNX Runtime: ~25 MB of WASM, fetched on the same explicit action.
//   - Memory: ~1 GB while loaded on the WASM path.
//   - Speed: slower on phones — plausibly slower than the recording itself.
//   - Durability: WebKit can reclaim unused site storage after about seven days
//     of not opening the app, and the download happens again.
//   - Battery and heat while transcribing.
//
// ── WHY CacheStorage AND NOT IndexedDB ────────────────────────────────────
//
// `parakeet.js` caches into IndexedDB itself, but nothing else in this app can
// see that cache, and the service worker certainly cannot. Storing the weights
// in a CacheStorage cache under their ORIGINAL request URLs means the worker's
// existing cache-first policy answers ORT's own `fetch` for them — `respond()`
// calls `caches.match(request)`, which searches EVERY cache, not just the shell
// generations. So the model works offline with no worker change at all. And the
// worker's retention sweep (`cachesToDelete`) only deletes names starting with
// `kteam-shell-`, so `kteam-stt-model-v1` survives every deploy.

import { configureOrtRuntime, ORT_WASM_URL } from './ort-assets';

/** Re-exported because it is part of THIS module's asset contract: it is one of
 *  the four URLs `prepareLocalModel` stores and `openPreparedAssets` reopens,
 *  and a caller reasoning about what a prepared device holds should not have to
 *  know which file the ONNX Runtime path happens to live in. */
export { ORT_WASM_URL };

/** Sole owner of this cache name. Chosen NOT to start with `kteam-shell-`, so
 *  the service worker's generation pruning leaves it alone. */
export const STT_MODEL_CACHE = 'kteam-stt-model-v1';

/** The daemon's id for the browser model, and the same-origin root it serves
 *  the weights from: unauthenticated, range-capable `GET /stt-models/<modelId>/<file>`,
 *  deliberately OUTSIDE `/v1/` because `fromUrls`/ORT fetch with a plain
 *  `fetch()` that carries no bearer token — and because the weights are public
 *  CC-BY-4.0 files with nothing to protect. Confirmed against the daemon's
 *  `SttModelStore.resolvePublicFile`. */
export const STT_BROWSER_MODEL_ID = 'parakeet-browser-v3';
export const STT_MODEL_BASE = `/stt-models/${STT_BROWSER_MODEL_ID}`;

export interface ModelAsset {
  url: string;
  label: string;
  /** Published byte size, used for progress before the first byte arrives and
   *  as the "this will cost you" number in the settings sheet. */
  bytes: number;
  /** True when `bytes` is the EXACT pinned size from the daemon's manifest, so
   *  a short or long download can be detected and rejected. False for the ORT
   *  runtime, whose size is a build detail rather than a pinned contract. */
  exactBytes: boolean;
}

/** The exact three files, with the byte counts taken VERBATIM from the daemon's
 *  pinned manifest (`src/stt-model.ts` → `DEFAULT_STT_MODELS`, revision
 *  `f88260fa…` of `ysdede/parakeet-tdt-0.6b-v3-onnx`) so the browser's progress
 *  bar and the box's own accounting cannot disagree. Total: 670,488,135 bytes.
 *
 *  The preprocessor is NOT among them: `preprocessorBackend: 'js'` computes the
 *  mel spectrogram in JavaScript, which removes a fourth download. */
export const STT_MODEL_ASSETS: readonly ModelAsset[] = [
  { url: `${STT_MODEL_BASE}/encoder-model.int8.onnx`, label: 'Encoder', bytes: 652_183_999, exactBytes: true },
  { url: `${STT_MODEL_BASE}/decoder_joint-model.int8.onnx`, label: 'Decoder', bytes: 18_202_004, exactBytes: true },
  { url: `${STT_MODEL_BASE}/vocab.txt`, label: 'Vocabulary', bytes: 102_132, exactBytes: true },
] as const;

/** Everything the device must hold to transcribe offline: the weights AND the
 *  runtime that executes them. */
export function localEngineAssets(): ModelAsset[] {
  return [...STT_MODEL_ASSETS, { url: ORT_WASM_URL, label: 'Speech runtime', bytes: 25_000_000, exactBytes: false }];
}

export function localEngineTotalBytes(): number {
  return localEngineAssets().reduce((total, asset) => total + asset.bytes, 0);
}

export type LocalBackend = 'wasm';

export interface BackendChoice {
  backend: LocalBackend;
  /** Why WebGPU was not chosen. Always populated today — see the header. */
  webgpuBlockedReason: string;
  /** True when the device is expected to be slower than real time. */
  slow: boolean;
}

/** The backend decision, as a pure function so the reason is testable. */
export function selectLocalBackend(capabilities: { webgpu: boolean; likelyMobile: boolean }): BackendChoice {
  return {
    backend: 'wasm',
    webgpuBlockedReason: capabilities.webgpu
      ? 'This device has WebGPU, but the ONNX Runtime WebGPU backend cannot run the int8 encoder we host, and the fp32 encoder is a ~2.5 GB download. Transcription runs on the CPU instead.'
      : 'This browser has no WebGPU, so transcription runs on the CPU.',
    slow: capabilities.likelyMobile,
  };
}

/* ---------- preparing the device ------------------------------------------ */

export type PreparePhase = 'checking' | 'downloading' | 'storing' | 'done' | 'failed';

export interface PrepareProgress {
  phase: PreparePhase;
  /** Which asset is in flight. */
  label: string;
  receivedBytes: number;
  totalBytes: number;
  /** 0–1, or `null` when nothing is known yet. */
  fraction: number | null;
}

export type PrepareErrorCode =
  | 'no-cache-storage'
  | 'not-served'
  | 'quota'
  | 'network'
  | 'aborted'
  /** The device has not been prepared, or the browser reclaimed the storage.
   *  Raised BEFORE anything is fetched — see `loadLocalEngine`. */
  | 'not-prepared';

export class PrepareError extends Error {
  code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, message: string) {
    super(message);
    this.name = 'PrepareError';
    this.code = code;
  }
}

function cacheStorage(): CacheStorage | null {
  const candidate = (globalThis as { caches?: CacheStorage }).caches;
  return candidate && typeof candidate.open === 'function' ? candidate : null;
}

/** Which of the required assets are already on this device. */
export async function localModelReadiness(): Promise<{ ready: boolean; missing: string[] }> {
  const caches = cacheStorage();
  const assets = localEngineAssets();
  if (!caches) return { ready: false, missing: assets.map(asset => asset.url) };
  let cache: Cache;
  try {
    cache = await caches.open(STT_MODEL_CACHE);
  } catch {
    return { ready: false, missing: assets.map(asset => asset.url) };
  }
  const missing: string[] = [];
  for (const asset of assets) {
    const hit = await cache.match(asset.url).catch(() => undefined);
    if (!hit) missing.push(asset.url);
  }
  return { ready: missing.length === 0, missing };
}

/** Download everything this device needs and store it under the ORIGINAL
 *  request URLs, so the service worker can serve them later.
 *
 *  EXPLICIT: nothing here runs on its own. It is called from a button the
 *  reader presses after reading what it costs. */
export async function prepareLocalModel(
  options: {
    onProgress?: (progress: PrepareProgress) => void;
    signal?: AbortSignal;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    /** TEST INJECTION ONLY. Application code never passes this and always gets
     *  the pinned manifest.
     *
     *  It exists because the real manifest is 670 MB: a test that exercised the
     *  streaming path against the production sizes would have to move — or at
     *  minimum iterate over — two thirds of a gigabyte to prove a progress
     *  callback fires. Substituting a byte-exact miniature manifest tests the
     *  same code with the same completeness rules in milliseconds. The pinned
     *  production sizes are asserted separately, and are not weakened by this. */
    assets?: readonly ModelAsset[];
  } = {},
): Promise<void> {
  const caches = cacheStorage();
  if (!caches) {
    throw new PrepareError('no-cache-storage', 'This browser cannot store the speech model offline.');
  }
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const assets = options.assets ?? localEngineAssets();
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  let done = 0;

  const report = (phase: PreparePhase, label: string, received: number): void => {
    options.onProgress?.({
      phase,
      label,
      receivedBytes: received,
      totalBytes: total,
      fraction: total > 0 ? Math.min(1, received / total) : null,
    });
  };

  const cache = await caches.open(STT_MODEL_CACHE);
  report('checking', '', 0);

  for (const asset of assets) {
    if (options.signal?.aborted) throw new PrepareError('aborted', 'Preparation was cancelled.');
    const already = await cache.match(asset.url).catch(() => undefined);
    if (already) {
      done += asset.bytes;
      report('downloading', asset.label, done);
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(asset.url, { signal: options.signal });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        throw new PrepareError('aborted', 'Preparation was cancelled.');
      }
      throw new PrepareError('network', `${asset.label} could not be downloaded.`);
    }
    if (!response.ok) {
      // The daemon serves the SPA shell for unknown paths, so a missing model
      // route answers 200 with HTML rather than 404. Both are "not served".
      throw new PrepareError(
        'not-served',
        response.status === 404
          ? `Your kteam box is not serving the speech model yet (${asset.url}).`
          : `${asset.label} could not be downloaded (HTTP ${response.status}).`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (asset.url.endsWith('.onnx') && contentType.includes('text/html')) {
      throw new PrepareError(
        'not-served',
        `Your kteam box answered with the app page instead of ${asset.label} — the /stt-models route is not installed.`,
      );
    }
    if (asset.exactBytes && asset.bytes > 0) {
      const declaredLength = Number(response.headers.get('content-length') ?? '');
      // A `content-length` that already disagrees with the pinned manifest is a
      // wrong or truncated file, and it is knowable before a single byte moves.
      if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== asset.bytes) {
        throw new PrepareError(
          'network',
          `${asset.label} is the wrong size (${declaredLength} bytes, expected ${asset.bytes}). Nothing was downloaded.`,
        );
      }
    }

    // STREAMED STRAIGHT INTO CacheStorage — never buffered.
    //
    // The encoder is 652 MB. Collecting it into an array of chunks and then
    // wrapping that in a Blob before `cache.put` would hold two copies at once,
    // which is over a gigabyte of JS heap on a device that may have 2–3 GB
    // total — an out-of-memory kill on mobile Safari long before the download
    // finishes. So the response body is piped through a TransformStream that
    // does nothing but count bytes and report them, and `cache.put` consumes
    // that stream directly. Peak memory is one chunk plus whatever the browser
    // buffers on the way to disk.
    const declared = Number(response.headers.get('content-length') ?? '') || asset.bytes;
    let received = 0;

    if (!response.body) {
      // A body-less response is not something this can stream, and it is also
      // not something a 652 MB download can legitimately be.
      throw new PrepareError('network', `${asset.label} arrived without a body.`);
    }

    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (options.signal?.aborted) {
          controller.error(new PrepareError('aborted', 'Preparation was cancelled.'));
          return;
        }
        received += chunk.byteLength;
        report('downloading', asset.label, done + Math.min(received, asset.bytes));
        controller.enqueue(chunk);
      },
    });

    const stored = new Response(response.body.pipeThrough(counter), {
      status: 200,
      headers: {
        'content-type': contentType || 'application/octet-stream',
        'content-length': String(declared),
      },
    });

    report('storing', asset.label, done);
    try {
      await cache.put(asset.url, stored);
    } catch (error) {
      if (error instanceof PrepareError) throw error;
      const name = (error as { name?: string } | null)?.name ?? '';
      if (name === 'AbortError') throw new PrepareError('aborted', 'Preparation was cancelled.');
      if (name === 'QuotaExceededError') {
        throw new PrepareError(
          'quota',
          'This device would not give the browser enough storage for the speech model (~640 MB). Free some space, then prepare this device again.',
        );
      }
      throw new PrepareError('network', `${asset.label} could not be stored on this device.`);
    }

    // The daemon pins an exact byte count per file. A short read that still
    // resolved — a truncated proxy response, a half-written cache entry — would
    // otherwise sit on disk looking installed and fail much later, inside ONNX,
    // as an unreadable model. So the entry is deleted and the failure named
    // here instead.
    if (asset.exactBytes && received !== asset.bytes) {
      await cache.delete(asset.url).catch(() => false);
      throw new PrepareError(
        'network',
        `${asset.label} arrived incomplete (${received} of ${asset.bytes} bytes). Nothing was kept; try again.`,
      );
    }

    done += asset.bytes;
    report('downloading', asset.label, done);
  }

  report('done', '', total);
}

/** Hand the PREPARED bytes to the loader directly, as `blob:` URLs.
 *
 *  WHY NOT JUST LET ORT FETCH THE SAME-ORIGIN URLs. The service worker does not
 *  control the page that installed it (there is no `clients.claim()` here, on
 *  purpose — claiming would swap the worker under a live page mid-session). On
 *  that first page, `fetch()` goes straight to the network and never consults
 *  CacheStorage, so a reader who prepares the device and immediately holds the
 *  microphone would re-download 670 MB — or fail outright with the box offline.
 *  Reading the cache entries here removes the dependency entirely: prepared
 *  means usable NOW, on this page, controlled or not, online or not.
 *
 *  Blobs rather than ArrayBuffers because a 652 MB `arrayBuffer()` is 652 MB of
 *  JS heap, while a Blob stays in the browser's blob store and is streamed by
 *  the consumer.
 *
 *  The returned `revoke` MUST be called once loading has finished, successfully
 *  or not: an un-revoked object URL pins its blob for the life of the document. */
export async function openPreparedAssets(): Promise<
  { ready: false; missing: string[] } | { ready: true; urls: Map<string, string>; revoke: () => void }
> {
  const caches = cacheStorage();
  const assets = localEngineAssets();
  if (!caches) return { ready: false, missing: assets.map(asset => asset.url) };
  let cache: Cache;
  try {
    cache = await caches.open(STT_MODEL_CACHE);
  } catch {
    return { ready: false, missing: assets.map(asset => asset.url) };
  }

  const urls = new Map<string, string>();
  const created: string[] = [];
  const revoke = (): void => {
    for (const url of created) URL.revokeObjectURL(url);
    created.length = 0;
  };

  const missing: string[] = [];
  for (const asset of assets) {
    const hit = await cache.match(asset.url).catch(() => undefined);
    if (!hit) {
      missing.push(asset.url);
      continue;
    }
    try {
      const blob = await hit.blob();
      const objectUrl = URL.createObjectURL(blob);
      created.push(objectUrl);
      urls.set(asset.url, objectUrl);
    } catch {
      missing.push(asset.url);
    }
  }

  if (missing.length > 0) {
    revoke();
    return { ready: false, missing };
  }
  return { ready: true, urls, revoke };
}

/** Give the storage AND the memory back.
 *
 *  Unloading the in-page model is not a bonus, it is required for correctness:
 *  `loadLocalEngine` returns the memoised model BEFORE the readiness gate — it
 *  has to, or every utterance would re-open the cache — so deleting the cache
 *  alone would leave "Remove from this device" as a button that frees nothing
 *  and changes nothing. Dictation would keep working on the page that just
 *  removed the model, and ~1 GB of weights would stay resident until reload. */
export async function clearLocalModel(): Promise<boolean> {
  await unloadLocalEngine();
  const caches = cacheStorage();
  if (!caches) return false;
  return caches.delete(STT_MODEL_CACHE).catch(() => false);
}

/* ---------- running it ----------------------------------------------------- */

/** The slice of `ParakeetModel` this engine uses. Declared locally so the
 *  loading code states its own contract and a library upgrade that changes
 *  something else cannot quietly change this. */
interface LoadedModel {
  transcribe(
    audio: Float32Array | null,
    sampleRate?: number,
    opts?: Record<string, unknown>,
  ): Promise<ModelTranscriptResult>;
  transcribeLongAudio?(
    audio: Float32Array,
    sampleRate?: number,
    opts?: Record<string, unknown>,
  ): Promise<ModelLongTranscriptResult>;
  /** parakeet.js does not expose a public model-level dispose method, but these
   * are the ONNX sessions it owns. Releasing them is what actually gives the
   * ~1 GB of weights back when dictation is disabled. */
  encoderSession?: { release?(): Promise<void> | void };
  joinerSession?: { release?(): Promise<void> | void };
  _onnxPreprocessor?: { session?: { release?(): Promise<void> | void } } | null;
  _combState1?: { dispose?(): void };
  _combState2?: { dispose?(): void };
  _targetTensor?: { dispose?(): void };
  _targetLenTensor?: { dispose?(): void };
  _encoderFrameTensor?: { dispose?(): void } | null;
}

interface ModelTranscriptWord {
  text?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  confidence?: unknown;
}

interface ModelTranscriptResult {
  utterance_text?: unknown;
  words?: unknown;
  confidence_scores?: { word_avg?: unknown } | null;
  metrics?: { total_ms?: unknown } | null;
}

interface ModelLongTranscriptResult {
  text?: unknown;
  words?: unknown;
  metrics?: { total_ms?: unknown } | null;
}

export interface LocalTranscriptWord {
  text: string;
  /** Seconds from the beginning of the supplied audio buffer. */
  startTime: number;
  /** Seconds from the beginning of the supplied audio buffer. */
  endTime: number;
  /** Greedy-decoder probability, when parakeet.js returned one. */
  confidence?: number;
}

export interface LocalTranscript {
  text: string;
  words: LocalTranscriptWord[];
  /** `true` only when every runtime word had a complete numeric timing pair.
   * `false` means at least one record was malformed; `null` means the runtime
   * supplied no word sequence. Live agreement may still use the text, but it
   * must never trim audio from a partial/corrupt timing sequence. */
  timestampsValid: boolean | null;
  /** Mean word confidence, or null when the runtime did not expose one. */
  confidence: number | null;
  /** Audio presented to the model, excluding queue time. */
  audioMs: number;
  /** Wall-clock model time measured around the package call. */
  processingMs: number;
}

let loaded: LoadedModel | null = null;
let loading: Promise<LoadedModel> | null = null;
let engineGeneration = 0;
let releaseTail: Promise<void> = Promise.resolve();
/** `ParakeetModel.transcribe` has no concurrency or cancellation contract.
 * Keep one global tail so a new recording cannot enter the same model while a
 * logically-cancelled decode from the previous generation is still running. */
let localDecodeTail: Promise<void> = Promise.resolve();

export interface LoadLocalOptions {
  capabilities?: { webgpu: boolean; likelyMobile: boolean };
  /** Logical cancellation only. ONNX cannot interrupt an in-flight decode, but
   * an aborted queued call is skipped and an in-flight result is discarded. */
  signal?: AbortSignal;
}

/** Load the model, once. Concurrent callers share the in-flight load; a failed
 *  load is not memoised, so pressing the button again genuinely retries. */
export async function loadLocalEngine(options: LoadLocalOptions = {}): Promise<LoadedModel> {
  if (loaded) return loaded;
  if (loading) return loading;
  const generation = engineGeneration;
  const priorRelease = releaseTail;
  const capabilities = options.capabilities ?? { webgpu: false, likelyMobile: false };
  const load = (async () => {
    // A reader may re-enable immediately after disabling. Never instantiate new
    // sessions while the old pair is still releasing its ~1 GB allocation.
    await priorRelease;
    if (generation !== engineGeneration) {
      throw new PrepareError('aborted', 'Dictation was disabled before the speech model loaded.');
    }
    // THE READINESS GATE, and it comes before everything.
    //
    // `fromUrls` fetches whatever it is given. Without this check, a reader who
    // started dictation without pressing Prepare — or whose browser reclaimed
    // the storage, which WebKit does after about seven days of not opening the
    // app — would trigger a silent ~670 MB download by holding the microphone
    // button. On a phone, on cellular. That is precisely the surprise this
    // feature is built to avoid, so an unprepared device is an actionable
    // error, not a download.
    //
    // It is also why this runs before `import('parakeet.js')` and before
    // `configureOrtRuntime()`: not one byte of the runtime is fetched either.
    const prepared = await openPreparedAssets();
    if (!prepared.ready) {
      throw new PrepareError(
        'not-prepared',
        prepared.missing.length === localEngineAssets().length
          ? 'This device has not downloaded the speech model yet. Open Settings → Dictation and choose “Prepare this device”.'
          : 'Part of the speech model is no longer on this device — browsers reclaim unused storage. Open Settings → Dictation and prepare it again.',
      );
    }

    const url = (key: string): string => {
      const value = prepared.urls.get(key);
      if (!value) throw new PrepareError('not-prepared', 'A prepared model file went missing while loading.');
      return value;
    };

    try {
      // Same-origin (in fact same-document) WASM path FIRST — `parakeet.js`
      // reaches for jsDelivr the moment it initialises the runtime with no path
      // set.
      await configureOrtRuntime(url(ORT_WASM_URL));
      const { fromUrls } = await import('parakeet.js');
      const choice = selectLocalBackend(capabilities);
      const model = (await fromUrls({
        encoderUrl: url(`${STT_MODEL_BASE}/encoder-model.int8.onnx`),
        decoderUrl: url(`${STT_MODEL_BASE}/decoder_joint-model.int8.onnx`),
        tokenizerUrl: url(`${STT_MODEL_BASE}/vocab.txt`),
        // Explicit, because the library's own default is `'webgpu-hybrid'` and
        // that cannot run our int8 encoder. See the header.
        backend: choice.backend,
        // JS mel computation: removes the fourth (`nemo128.onnx`) download.
        preprocessorBackend: 'js',
        // v3's feature size. Auto-detection guesses 128 anyway; stating it means
        // a wrong guess is impossible.
        nMels: 128,
        cpuThreads: 1,
      })) as unknown as LoadedModel;
      if (generation !== engineGeneration) {
        await releaseLoadedModel(model);
        throw new PrepareError('aborted', 'Dictation was disabled while the speech model was loading.');
      }
      loaded = model;
      return model;
    } finally {
      // Once `fromUrls` has resolved, ORT holds its own instantiated sessions
      // and the WASM module is compiled; the object URLs have done their job.
      // Revoked in `finally` so a failed load does not leak ~670 MB of pinned
      // blobs either.
      prepared.revoke();
    }
  })();
  loading = load;
  try {
    return await load;
  } finally {
    if (loading === load) loading = null;
  }
}

/** True once the weights are resident in this page. */
export function localEngineLoaded(): boolean {
  return loaded !== null;
}

async function releaseLoadedModel(model: LoadedModel): Promise<void> {
  const tensors = [
    model._combState1,
    model._combState2,
    model._targetTensor,
    model._targetLenTensor,
    model._encoderFrameTensor,
  ];
  for (const tensor of tensors) {
    try {
      tensor?.dispose?.();
    } catch {
      // Session release below is still the material memory reclamation.
    }
  }
  const sessions = [model.encoderSession, model.joinerSession, model._onnxPreprocessor?.session];
  await Promise.allSettled(
    sessions.map(async session => {
      await session?.release?.();
    }),
  );
}

/** Drop the in-page model while keeping its prepared CacheStorage copy. The
 * ONNX sessions are explicitly released after any in-flight decode, so this
 * gives back the ~1 GB resident allocation rather than waiting for GC. A model
 * that was still loading is released as soon as construction finishes. */
export function unloadLocalEngine(): Promise<void> {
  engineGeneration += 1;
  const model = loaded;
  const pendingLoad = loading;
  loaded = null;
  loading = null;
  const prior = releaseTail;
  releaseTail = (async () => {
    await prior;
    // The stale load observes engineGeneration and releases its own sessions.
    if (pendingLoad) await pendingLoad.catch(() => undefined);
    await localDecodeTail;
    if (model) await releaseLoadedModel(model);
  })();
  return releaseTail;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function transcriptWords(value: unknown): { words: LocalTranscriptWord[]; timestampsValid: boolean | null } {
  if (!Array.isArray(value) || value.length === 0) return { words: [], timestampsValid: null };
  const words: LocalTranscriptWord[] = [];
  let timestampsValid = true;
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      timestampsValid = false;
      continue;
    }
    const word = item as ModelTranscriptWord;
    const text = typeof word.text === 'string' ? word.text.trim() : '';
    const startTime = finiteNumber(word.start_time);
    const endTime = finiteNumber(word.end_time);
    if (!text || startTime === null || endTime === null) {
      timestampsValid = false;
      continue;
    }
    const confidence = finiteNumber(word.confidence);
    words.push({
      text,
      startTime,
      endTime,
      ...(confidence === null ? {} : { confidence }),
    });
  }
  return { words, timestampsValid };
}

function meanWordConfidence(words: readonly LocalTranscriptWord[], preferred: unknown): number | null {
  const aggregate = finiteNumber(preferred);
  if (aggregate !== null) return aggregate;
  const values = words.flatMap(word => (word.confidence === undefined ? [] : [word.confidence]));
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function localTranscript(
  text: unknown,
  rawWords: unknown,
  preferredConfidence: unknown,
  samples: Float32Array,
  processingMs: number,
): LocalTranscript {
  const { words, timestampsValid } = transcriptWords(rawWords);
  return {
    text: typeof text === 'string' ? text.trim() : '',
    words,
    timestampsValid,
    confidence: meanWordConfidence(words, preferredConfidence),
    audioMs: (samples.length / 16_000) * 1_000,
    processingMs,
  };
}

function emptyLocalTranscript(): LocalTranscript {
  return { text: '', words: [], timestampsValid: null, confidence: null, audioMs: 0, processingMs: 0 };
}

/** Serialize every use of the shared ONNX sessions. Abort is logical: queued
 * work is skipped and an in-flight result is suppressed at publication. */
function runLocalDecode<T>(options: LoadLocalOptions, decode: (model: LoadedModel) => Promise<T>): Promise<T> {
  const run = localDecodeTail.then(async () => {
    if (options.signal?.aborted) throw new PrepareError('aborted', 'Transcription was cancelled.');
    const model = await loadLocalEngine(options);
    if (options.signal?.aborted) throw new PrepareError('aborted', 'Transcription was cancelled.');
    const result = await decode(model);
    if (options.signal?.aborted) throw new PrepareError('aborted', 'Transcription was cancelled.');
    return result;
  });
  localDecodeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Rich snapshot decode for live hypothesis agreement. Timestamps and
 * confidences are opt-in in parakeet.js; this is the one application seam that
 * turns them on. */
export async function transcribeLocalDetailed(
  samples: Float32Array,
  options: LoadLocalOptions = {},
): Promise<LocalTranscript> {
  if (samples.length === 0) return emptyLocalTranscript();
  return runLocalDecode(options, async model => {
    const started = performance.now();
    const result = await model.transcribe(samples, 16_000, {
      returnTimestamps: true,
      returnConfidences: true,
      enableProfiling: false,
    });
    const elapsed = Math.max(0, performance.now() - started);
    return localTranscript(
      result?.utterance_text,
      result?.words,
      result?.confidence_scores?.word_avg,
      samples,
      elapsed,
    );
  });
}

/** One clean batch pass after capture stops. parakeet.js' long-audio helper
 * windows and merges long recordings internally, so this is O(n) once rather
 * than repeatedly decoding the full growing utterance. */
export async function transcribeLocalFinal(
  samples: Float32Array,
  options: LoadLocalOptions = {},
): Promise<LocalTranscript> {
  if (samples.length === 0) return emptyLocalTranscript();
  return runLocalDecode(options, async model => {
    const started = performance.now();
    if (typeof model.transcribeLongAudio === 'function') {
      const result = await model.transcribeLongAudio(samples, 16_000, {
        returnTimestamps: 'word',
        returnConfidences: true,
        enableProfiling: false,
      });
      const elapsed = Math.max(0, performance.now() - started);
      return localTranscript(result?.text, result?.words, null, samples, elapsed);
    }
    // Compatibility for an older cached package surface. The installed 1.4.4
    // build has `transcribeLongAudio`; falling back keeps a package mismatch
    // from throwing away an otherwise usable short recording.
    const result = await model.transcribe(samples, 16_000, {
      returnTimestamps: true,
      returnConfidences: true,
      enableProfiling: false,
    });
    const elapsed = Math.max(0, performance.now() - started);
    return localTranscript(
      result?.utterance_text,
      result?.words,
      result?.confidence_scores?.word_avg,
      samples,
      elapsed,
    );
  });
}

/** Transcribe one finished utterance. 16 kHz mono float, straight from
 *  `audio-capture`.
 *
 *  THERE IS NO LANGUAGE ARGUMENT, and that is not an omission. Checked against
 *  the installed `parakeet.js@1.4.4`: neither `fromUrls` nor
 *  `ParakeetModel.transcribe` accepts a language, and the package's own
 *  `MODELS[...].languages` list is metadata for a UI, not an input to decoding.
 *  The v3 export is a single multilingual model that decodes whatever it hears.
 *  So a language choice CANNOT be forced here, and passing a cosmetic field
 *  that the library silently drops would be worse than omitting the selector:
 *  it would look like it worked. */
export async function transcribeLocal(samples: Float32Array, options: LoadLocalOptions = {}): Promise<string> {
  if (samples.length === 0) return '';
  return runLocalDecode(options, async model => {
    const result = await model.transcribe(samples, 16_000, { returnTimestamps: false, returnConfidences: false });
    return typeof result?.utterance_text === 'string' ? result.utterance_text.trim() : '';
  });
}
