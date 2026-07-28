import { describe, expect, test } from 'bun:test';
import type { WardenFailoverStatus } from '../types';
import { wardenExhaustionLabel } from './WardenStrip';

const exhausted = (accounts: WardenFailoverStatus['accounts']): WardenFailoverStatus => ({
  policy: 'fallback',
  failureThreshold: 2,
  cooldownMinutes: 30,
  accounts,
  exhaustedSince: '2026-07-27T12:00:00.000Z',
});

describe('wardenExhaustionLabel', () => {
  test('calls out absent credentials even when the feed also marks the account at limit', () => {
    expect(
      wardenExhaustionLabel(
        exhausted([
          {
            wrapper: 'claude-auto-glm52a',
            eligible: false,
            reason: 'at its usage limit (kfleet feed)',
            quota: { authOk: false },
          },
        ]),
      ),
    ).toBe('no warden credentials!');
  });

  test('keeps quota and other exhaustion causes generic', () => {
    expect(
      wardenExhaustionLabel(
        exhausted([
          {
            wrapper: 'claude-auto-glm52a',
            eligible: false,
            reason: 'at its usage limit (kfleet feed)',
            quota: { authOk: true, atLimit: true },
          },
        ]),
      ),
    ).toBe('no usable warden account!');
  });

  test('stays quiet outside an exhaustion episode', () => {
    expect(
      wardenExhaustionLabel({
        ...exhausted([]),
        exhaustedSince: undefined,
      }),
    ).toBeUndefined();
  });
});
