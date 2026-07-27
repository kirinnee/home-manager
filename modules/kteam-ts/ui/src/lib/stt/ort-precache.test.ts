import { describe, expect, test } from 'bun:test';
import { ORT_RUNTIME_BYTES, isOrtRuntimeAsset } from './ort-precache';

describe('isOrtRuntimeAsset', () => {
  test('matches the runtime binaries a Vite build emits, hash and all', () => {
    const emitted = [
      'assets/ort-wasm-simd-threaded.jsep-a1b2c3d4.wasm',
      'assets/ort-wasm-simd-threaded-9f8e7d6c.wasm',
      '/assets/ort-wasm-simd-threaded.jsep-a1b2c3d4.wasm',
      'assets/ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.wasm',
    ];
    for (const url of emitted) expect(isOrtRuntimeAsset(url)).toBe(true);
  });

  test('ignores a query string or fragment', () => {
    expect(isOrtRuntimeAsset('/assets/ort-wasm-simd-threaded.jsep-abc.wasm?v=2')).toBe(true);
    expect(isOrtRuntimeAsset('/assets/ort-wasm-simd-threaded.jsep-abc.wasm#x')).toBe(true);
  });

  test('does NOT match the app shell — the exclusion must be surgical', () => {
    const shell = [
      'assets/index-abc123.js',
      'assets/index-abc123.css',
      'assets/SessionChatPage-def456.js',
      'icons/favicon-abc.png',
      '/offline.html',
      '',
    ];
    for (const url of shell) expect(isOrtRuntimeAsset(url)).toBe(false);
  });

  test('does not match a lookalike in another directory segment', () => {
    expect(isOrtRuntimeAsset('assets/my-ort-wasm-simd-threaded.wasm')).toBe(false);
  });

  test('does not match a non-string', () => {
    expect(isOrtRuntimeAsset(undefined as unknown as string)).toBe(false);
  });
});

describe('ORT_RUNTIME_BYTES', () => {
  test('records why the exclusion is worth a build patch at all', () => {
    // A ~25 MB addition to every PWA install is the whole argument.
    expect(ORT_RUNTIME_BYTES.jsepWasm).toBeGreaterThan(20_000_000);
    expect(ORT_RUNTIME_BYTES.plainWasm).toBeGreaterThan(10_000_000);
    expect(ORT_RUNTIME_BYTES.jsepWasm).toBeGreaterThan(ORT_RUNTIME_BYTES.plainWasm);
  });
});
