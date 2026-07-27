// Feature detection, as data.
//
// Every honest sentence this feature says about a device is derived from here,
// so it is a pure function of an injected `navigator`/`window` rather than a
// scattering of `typeof window !== 'undefined'` checks. That is what lets the
// copy be tested: "iOS may evict the model" is a UI string somewhere, but
// "this is iOS" is a value with a test.

export interface SttEnvironment {
  navigator?: Partial<Navigator> & { gpu?: unknown; deviceMemory?: number; storage?: Partial<StorageManager> };
  isSecureContext?: boolean;
  hasAudioWorklet?: boolean;
  hasCacheStorage?: boolean;
}

export interface SttCapabilities {
  /** `navigator.mediaDevices.getUserMedia` exists. FALSE in an insecure
   *  context, where the API is absent rather than denied. */
  microphone: boolean;
  /** `window.isSecureContext`. The reason `microphone` is false when it is. */
  secureContext: boolean;
  /** `navigator.gpu` exists. NOT the same as "WebGPU is usable here" — see
   *  `local-engine.ts`, which refuses WebGPU for the int8 model we host. */
  webgpu: boolean;
  /** AudioWorklet available; false means the ScriptProcessor fallback. */
  audioWorklet: boolean;
  /** CacheStorage available — required to pre-download the browser model. */
  cacheStorage: boolean;
  /** Apple's WebKit. Carries the model-eviction and WebGPU caveats. */
  likelyIos: boolean;
  /** Phone or tablet by pointer/UA. Drives the "slower on phones" copy. */
  likelyMobile: boolean;
  /** Logical cores, when the browser says. */
  cores: number | null;
}

function ua(nav: SttEnvironment['navigator']): string {
  return typeof nav?.userAgent === 'string' ? nav.userAgent : '';
}

/** iPadOS reports a desktop Safari UA, so the "Macintosh with a touchscreen"
 *  probe is the only reliable tell — and it is the standard one. */
export function isLikelyIos(nav: SttEnvironment['navigator']): boolean {
  const agent = ua(nav);
  if (/iPhone|iPad|iPod/u.test(agent)) return true;
  const maxTouch = typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
  return /Macintosh/u.test(agent) && maxTouch > 1;
}

export function isLikelyMobile(nav: SttEnvironment['navigator']): boolean {
  if (isLikelyIos(nav)) return true;
  return /Android|Mobile|Tablet|Silk|Kindle/u.test(ua(nav));
}

export function readSttCapabilities(env: SttEnvironment = {}): SttCapabilities {
  const nav =
    env.navigator ??
    (typeof navigator === 'undefined' ? undefined : (navigator as unknown as SttEnvironment['navigator']));
  const secureContext =
    env.isSecureContext ??
    (typeof globalThis !== 'undefined' && 'isSecureContext' in globalThis
      ? Boolean((globalThis as { isSecureContext?: boolean }).isSecureContext)
      : false);
  const audioWorklet =
    env.hasAudioWorklet ??
    (typeof globalThis !== 'undefined' &&
      typeof (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode === 'function');
  const cacheStorage =
    env.hasCacheStorage ??
    (typeof globalThis !== 'undefined' &&
      typeof (globalThis as { caches?: unknown }).caches === 'object' &&
      (globalThis as { caches?: unknown }).caches !== null);

  return {
    microphone: typeof nav?.mediaDevices?.getUserMedia === 'function',
    secureContext,
    webgpu: Boolean(nav && 'gpu' in nav && nav.gpu),
    audioWorklet,
    cacheStorage,
    likelyIos: isLikelyIos(nav),
    likelyMobile: isLikelyMobile(nav),
    cores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  };
}

/** Free bytes the browser is willing to admit to, or `null` when it will not
 *  say. Used only to warn BEFORE a ~640 MB download, never to block one: the
 *  estimate is deliberately fuzzy in every engine and treating it as a hard
 *  gate would refuse devices that would have coped fine. */
export async function estimateFreeBytes(
  nav: SttEnvironment['navigator'] = typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as SttEnvironment['navigator']),
): Promise<number | null> {
  const storage = nav?.storage;
  const estimate = storage?.estimate;
  if (!storage || typeof estimate !== 'function') return null;
  try {
    const result = await estimate.call(storage);
    const quota = typeof result?.quota === 'number' ? result.quota : null;
    const usage = typeof result?.usage === 'number' ? result.usage : 0;
    return quota === null ? null : Math.max(0, quota - usage);
  } catch {
    return null;
  }
}
