import { describe, expect, test } from 'bun:test';
import { compareVersions, formatUnknownRouteError, versionSkewWarning } from './api-client';
import { KTEAM_VERSION } from './version';

describe('version skew detection (B1)', () => {
  test('KTEAM_VERSION is a dotted numeric string', () => {
    expect(KTEAM_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('compareVersions orders by numeric segments, not lexically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1); // 10 > 9 (lexical would say <)
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });

  test('unparseable versions are treated as no-skew', () => {
    expect(compareVersions('dev', '0.2.1')).toBe(0);
    expect(compareVersions('0.2.1', '')).toBe(0);
  });

  test('matched versions produce NO warning', () => {
    expect(versionSkewWarning('0.2.1', '0.2.1')).toBeUndefined();
    // A daemon that never reported its version (old daemon) is not a skew.
    expect(versionSkewWarning('0.2.1', null)).toBeUndefined();
    expect(versionSkewWarning('0.2.1', undefined)).toBeUndefined();
  });

  test('skewed versions produce a warning naming BOTH versions', () => {
    const stale = versionSkewWarning('0.2.1', '0.2.0');
    expect(stale).toBeDefined();
    expect(stale).toContain('0.2.1');
    expect(stale).toContain('0.2.0');
    expect(stale).toContain('stale');
    expect(stale).toContain('restart');

    // Daemon newer than the CLI gets the softer note, still naming both.
    const newer = versionSkewWarning('0.2.0', '0.2.1');
    expect(newer).toBeDefined();
    expect(newer).toContain('0.2.0');
    expect(newer).toContain('0.2.1');
    expect(newer).toContain('newer');
  });

  test('404 unknown-route message names method, path, and both versions', () => {
    const msg = formatUnknownRouteError('POST /v1/sessions/s1/migrate', '0.2.1', '0.2.0');
    expect(msg).toContain('POST /v1/sessions/s1/migrate'); // method + path
    expect(msg).toContain('0.2.1'); // CLI version
    expect(msg).toContain('0.2.0'); // daemon version
    expect(msg).toContain('404'); // status
    // Skew direction (CLI newer) is surfaced as "restart kteamd".
    expect(msg).toContain('restart kteamd');
  });

  test('404 message without detectable skew still names route + versions', () => {
    const same = formatUnknownRouteError('GET /v1/nope', '0.2.1', '0.2.1');
    expect(same).toContain('GET /v1/nope');
    expect(same).toContain('0.2.1');
    expect(same).toContain('404');

    const unknown = formatUnknownRouteError('GET /v1/nope', '0.2.1', null);
    expect(unknown).toContain('GET /v1/nope');
    expect(unknown).toContain('unknown'); // daemon version unknown
    expect(unknown).toContain('0.2.1');
  });
});
