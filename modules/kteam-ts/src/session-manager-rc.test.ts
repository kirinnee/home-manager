import { describe, expect, test } from 'bun:test';
import { resolveRemoteControl } from './session-manager';

// Remote Control is for a HUMAN to watch/steer a session. An autonomous
// teammate has no human at the wheel, so RC defaults OFF for auto and stays ON
// for the user's own interactive sessions. An explicit --rc/--no-rc wins in
// either direction. These pin all four mode x flag combinations, plus the
// codex (no-RC) and fleet-default interactions.

describe('resolveRemoteControl', () => {
  describe('no explicit flag: mode decides', () => {
    test('interactive defaults ON (follows the fleet default)', () => {
      expect(resolveRemoteControl('claude', 'interactive', undefined, undefined)).toBe(true);
      expect(resolveRemoteControl('claude', 'interactive', undefined, true)).toBe(true);
    });

    test('auto defaults OFF', () => {
      expect(resolveRemoteControl('claude', 'auto', undefined, undefined)).toBe(false);
      expect(resolveRemoteControl('claude', 'auto', undefined, true)).toBe(false);
    });
  });

  describe('explicit flag wins over the mode default', () => {
    test('--rc forces RC on for an auto session', () => {
      expect(resolveRemoteControl('claude', 'auto', true, undefined)).toBe(true);
    });

    test('--no-rc forces RC off for an interactive session', () => {
      expect(resolveRemoteControl('claude', 'interactive', false, true)).toBe(false);
    });

    test('the explicit choice beats the fleet default too', () => {
      expect(resolveRemoteControl('claude', 'interactive', false, true)).toBe(false);
      expect(resolveRemoteControl('claude', 'auto', true, false)).toBe(true);
    });
  });

  describe('fleet default only applies to interactive-with-no-flag', () => {
    test('a fleet default of false turns interactive off', () => {
      expect(resolveRemoteControl('claude', 'interactive', undefined, false)).toBe(false);
    });

    test('the fleet default never turns an auto session on', () => {
      expect(resolveRemoteControl('claude', 'auto', undefined, true)).toBe(false);
    });
  });

  describe('codex has no Remote Control', () => {
    test('always false regardless of mode, flag, or fleet default', () => {
      expect(resolveRemoteControl('codex', 'interactive', true, true)).toBe(false);
      expect(resolveRemoteControl('codex', 'interactive', undefined, true)).toBe(false);
      expect(resolveRemoteControl('codex', 'auto', true, true)).toBe(false);
    });
  });
});
