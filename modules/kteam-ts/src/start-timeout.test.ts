import { describe, expect, test } from 'bun:test';
import {
  resolveKillTimeout,
  KILL_TIMEOUT_READINESS_HINT_SECONDS,
  TIMEOUT_KILL_HELP,
  KILL_AFTER_SECONDS_HELP,
} from './start-timeout';

describe('resolveKillTimeout (B5) — the --timeout / --kill-after-seconds kill timer', () => {
  test('--timeout alone sets the kill timer', () => {
    const { seconds } = resolveKillTimeout({ timeout: 3600 });
    expect(seconds).toBe(3600);
  });

  test('--kill-after-seconds alias sets the same kill timer as --timeout', () => {
    const viaAlias = resolveKillTimeout({ killAfterSeconds: 3600 });
    const viaLegacy = resolveKillTimeout({ timeout: 3600 });
    expect(viaAlias.seconds).toBe(3600);
    expect(viaAlias.seconds).toBe(viaLegacy.seconds);
  });

  test('the preferred alias wins when both flags are supplied', () => {
    const { seconds } = resolveKillTimeout({ timeout: 3600, killAfterSeconds: 7200 });
    expect(seconds).toBe(7200);
  });

  test('no flag leaves the daemon default (undefined) and warns nothing', () => {
    const resolved = resolveKillTimeout({});
    expect(resolved.seconds).toBeUndefined();
    expect(resolved.warning).toBeUndefined();
  });

  test('a readiness-wait-sized value warns that it is a hard KILL timer, not a wait', () => {
    const { seconds, warning } = resolveKillTimeout({ timeout: 120 });
    expect(seconds).toBe(120); // still honoured — a note, not a refusal
    expect(warning).toBeDefined();
    expect(warning).toContain('KILL timer');
    expect(warning).toContain('NOT a readiness wait');
  });

  test('the warning fires strictly below the readiness threshold, not at or above it', () => {
    expect(resolveKillTimeout({ timeout: KILL_TIMEOUT_READINESS_HINT_SECONDS - 1 }).warning).toBeDefined();
    expect(resolveKillTimeout({ timeout: KILL_TIMEOUT_READINESS_HINT_SECONDS }).warning).toBeUndefined();
    expect(resolveKillTimeout({ timeout: KILL_TIMEOUT_READINESS_HINT_SECONDS + 1 }).warning).toBeUndefined();
  });

  test('the alias value is what the threshold checks (a small alias value still warns)', () => {
    expect(resolveKillTimeout({ killAfterSeconds: 90 }).warning).toBeDefined();
  });
});

describe('start flag help text (B5) — the rename says exactly what the flag does', () => {
  test('--timeout help states it KILLS and is NOT a readiness wait, and names the alias', () => {
    // These constants are what index.ts feeds commander's .option(), so the help
    // the user sees is exactly this text — a revert of the wording fails here.
    expect(TIMEOUT_KILL_HELP).toContain('kill the session after N seconds');
    expect(TIMEOUT_KILL_HELP).toContain('NOT a readiness wait');
    expect(TIMEOUT_KILL_HELP).toContain('--kill-after-seconds');
  });

  test('--kill-after-seconds help advertises itself as the preferred alias of --timeout', () => {
    expect(KILL_AFTER_SECONDS_HELP).toContain('preferred alias of --timeout');
    expect(KILL_AFTER_SECONDS_HELP).toContain('kill the session after N seconds');
  });
});
