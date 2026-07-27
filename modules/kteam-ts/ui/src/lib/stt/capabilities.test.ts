import { describe, expect, test } from 'bun:test';
import { estimateFreeBytes, isLikelyIos, isLikelyMobile, readSttCapabilities } from './capabilities';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile';

describe('isLikelyIos', () => {
  test('recognises an iPhone by user agent', () => {
    expect(isLikelyIos({ userAgent: IPHONE })).toBe(true);
  });

  test('recognises an iPad, which reports a DESKTOP Safari user agent', () => {
    // The only tell iPadOS leaves is a touchscreen on a "Macintosh".
    expect(isLikelyIos({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })).toBe(true);
  });

  test('does not mistake a real Mac for one', () => {
    expect(isLikelyIos({ userAgent: MAC, maxTouchPoints: 0 })).toBe(false);
    expect(isLikelyIos({ userAgent: MAC })).toBe(false);
  });

  test('an absent navigator is not iOS', () => {
    expect(isLikelyIos(undefined)).toBe(false);
  });
});

describe('isLikelyMobile', () => {
  test('covers iOS and Android', () => {
    expect(isLikelyMobile({ userAgent: IPHONE })).toBe(true);
    expect(isLikelyMobile({ userAgent: ANDROID })).toBe(true);
  });

  test('a desktop is not mobile', () => {
    expect(isLikelyMobile({ userAgent: MAC })).toBe(false);
  });
});

describe('readSttCapabilities', () => {
  test('reports no microphone when mediaDevices is absent — the insecure-context case', () => {
    const capabilities = readSttCapabilities({ navigator: { userAgent: MAC }, isSecureContext: false });
    expect(capabilities.microphone).toBe(false);
    expect(capabilities.secureContext).toBe(false);
  });

  test('reports a microphone only when getUserMedia is callable', () => {
    const withApi = readSttCapabilities({
      navigator: { userAgent: MAC, mediaDevices: { getUserMedia: () => undefined } as unknown as MediaDevices },
      isSecureContext: true,
    });
    expect(withApi.microphone).toBe(true);
    expect(withApi.secureContext).toBe(true);
  });

  test('detects WebGPU presence without claiming it is usable', () => {
    expect(readSttCapabilities({ navigator: { userAgent: MAC, gpu: {} } }).webgpu).toBe(true);
    expect(readSttCapabilities({ navigator: { userAgent: MAC } }).webgpu).toBe(false);
  });

  test('passes through the injected AudioWorklet and CacheStorage answers', () => {
    const capabilities = readSttCapabilities({
      navigator: { userAgent: MAC },
      hasAudioWorklet: false,
      hasCacheStorage: false,
    });
    expect(capabilities.audioWorklet).toBe(false);
    expect(capabilities.cacheStorage).toBe(false);
  });

  test('reports cores when the browser says, and null when it will not', () => {
    expect(readSttCapabilities({ navigator: { userAgent: MAC, hardwareConcurrency: 10 } }).cores).toBe(10);
    expect(readSttCapabilities({ navigator: { userAgent: MAC } }).cores).toBeNull();
  });

  test('an entirely empty environment answers "nothing available" rather than throwing', () => {
    const capabilities = readSttCapabilities({
      navigator: {},
      isSecureContext: false,
      hasAudioWorklet: false,
      hasCacheStorage: false,
    });
    expect(capabilities.microphone).toBe(false);
    expect(capabilities.webgpu).toBe(false);
    expect(capabilities.likelyIos).toBe(false);
  });
});

describe('estimateFreeBytes', () => {
  test('returns quota minus usage', async () => {
    const nav = { storage: { estimate: async () => ({ quota: 1_000, usage: 250 }) } };
    expect(await estimateFreeBytes(nav as never)).toBe(750);
  });

  test('never goes negative', async () => {
    const nav = { storage: { estimate: async () => ({ quota: 100, usage: 500 }) } };
    expect(await estimateFreeBytes(nav as never)).toBe(0);
  });

  test('returns null when the browser will not say', async () => {
    expect(await estimateFreeBytes({} as never)).toBeNull();
    expect(await estimateFreeBytes({ storage: { estimate: async () => ({}) } } as never)).toBeNull();
  });

  test('a throwing estimate is null, not a crash — this only ever informs copy', async () => {
    const nav = {
      storage: {
        estimate: async () => {
          throw new Error('denied');
        },
      },
    };
    expect(await estimateFreeBytes(nav as never)).toBeNull();
  });
});
