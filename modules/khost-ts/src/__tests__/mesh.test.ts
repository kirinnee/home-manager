import { describe, expect, test } from 'bun:test';
import { resolveMeshListen } from '../mesh';

describe('resolveMeshListen passthrough', () => {
  // Non-'auto' values short-circuit before any warp-cli / Cloudflare / interface IO,
  // so these are pure and safe to assert without mocks.
  test('a literal IP is used verbatim (manual override)', async () => {
    expect(await resolveMeshListen('10.213.0.9')).toBe('10.213.0.9');
  });

  test('empty string stays empty (loopback only)', async () => {
    expect(await resolveMeshListen('')).toBe('');
  });
});
