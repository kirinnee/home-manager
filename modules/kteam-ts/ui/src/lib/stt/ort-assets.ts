// SAME-ORIGIN ONNX Runtime. No CDN, ever — and this file is the whole reason
// that sentence is true.
//
// WHAT WOULD HAPPEN WITHOUT IT (read in `parakeet.js@1.4.4`'s own source,
// `src/backend.js`):
//
//     if (!ort.env.wasm.wasmPaths) {
//       ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/`;
//     }
//
// So the library silently reaches for jsDelivr unless something has already set
// a path. That default is checked, not overwritten — which means setting
// `ort.env.wasm.wasmPaths` BEFORE the library initialises is sufficient and is
// exactly what `configureOrtRuntime()` does. There is no CDN fallback path in
// this feature; if the same-origin asset is missing the engine fails loudly.
//
// WHY AN OBJECT AND NOT A PREFIX. Vite fingerprints emitted assets, so
// `ort-wasm-simd-threaded.jsep.wasm` becomes `ort-wasm-simd-threaded.jsep-<hash>.wasm`
// and a directory prefix would resolve to a 404. ONNX Runtime accepts
// `{ wasm, mjs }` overrides instead of a prefix, so the fingerprinted URL is
// handed over directly.
//
// WHY `mjs` IS DELIBERATELY OMITTED. `onnxruntime-web`'s default browser entry
// is `dist/ort.bundle.min.mjs`, whose loader reads (minified)
// `o = embeddedFactory && !(mjsOverride || prefix)` — it uses its EMBEDDED
// JavaScript glue only while neither an `mjs` override nor a prefix is set.
// Supplying `mjs` would switch it to fetching a second file for no benefit.
// Only `wasm` is overridden, so the glue stays inlined and exactly one binary
// is fetched.
//
// The static `?url` import below is what makes Vite emit the binary into the
// build. It is ~25 MB, and it is excluded from the PWA install closure — see
// `ort-precache.ts` for the one-line build patch that does the excluding and
// why the exclusion is safe.

import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

/** The fingerprinted, same-origin URL of the ONNX Runtime WASM binary.
 *
 *  Exported so `local-engine.ts` can pre-download it into the model cache
 *  alongside the weights: a reader who prepares this device offline needs the
 *  runtime as much as they need the model. */
export const ORT_WASM_URL: string = ortWasmUrl;

/** The minimal slice of the ORT module surface this file touches. Declared
 *  locally rather than imported so nothing here depends on ORT's type package
 *  resolving, and so the shape we rely on is written down. */
interface OrtEnvLike {
  env: {
    wasm: {
      wasmPaths?: unknown;
      numThreads?: number;
      proxy?: boolean;
      simd?: boolean | string;
    };
  };
}

let configured: Promise<void> | null = null;
let configuredFor: string | null = null;

/** Point ONNX Runtime at a same-origin binary. Idempotent and safe to call
 *  before every load; the work happens once per URL.
 *
 *  `wasmUrl` defaults to the build's fingerprinted asset. `local-engine.ts`
 *  passes a `blob:` URL read straight out of the prepared CacheStorage entry
 *  instead, so a prepared device works offline even on a page the service
 *  worker does not yet control — an uncontrolled page's `fetch` never consults
 *  CacheStorage at all, and this is the difference between "prepared" meaning
 *  "works now" and "works after you reload".
 *
 *  MUST run before `parakeet.js` initialises the runtime. */
export function configureOrtRuntime(wasmUrl: string = ORT_WASM_URL): Promise<void> {
  if (configured && configuredFor === wasmUrl) return configured;
  configuredFor = wasmUrl;
  configured = (async () => {
    // Dynamic, so this module can be imported (and its URL constant read)
    // without pulling the runtime in.
    const module = (await import('onnxruntime-web')) as unknown as { default?: OrtEnvLike } & Partial<OrtEnvLike>;
    const ort = (module.default ?? module) as OrtEnvLike;
    if (!ort?.env?.wasm) throw new Error('ONNX Runtime loaded without an env — the bundle is not the browser build.');
    ort.env.wasm.wasmPaths = { wasm: wasmUrl };
    // The app sends no COOP/COEP headers — a deliberate choice, because
    // cross-origin isolation is a global constraint on every future resource
    // this app might load, and single-threaded WASM works without it. So
    // `SharedArrayBuffer` is absent and multithreading is off. Stated
    // explicitly rather than left to feature detection so the honest "slower"
    // copy in the settings sheet has something concrete behind it.
    if (typeof SharedArrayBuffer === 'undefined') ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  })();
  return configured;
}

/** Reset for tests. Not used by application code. */
export function resetOrtRuntimeConfiguration(): void {
  configured = null;
  configuredFor = null;
}
