import { describe, expect, test } from 'bun:test';
import type { AccountUsage } from '../core/usage';
import { usageRow } from './usage';

const proxy = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  binary: 'claude-auto-loge',
  kind: 'claude',
  name: 'auto-loge',
  provider: 'cliproxy',
  usageBased: false,
  ok: true,
  availability: 'unavailable',
  unavailable: true,
  unavailableReason: 'cooldown',
  authOk: true,
  atLimit: true,
  ...over,
});

describe('CLIProxy rows in human usage output', () => {
  test('shows provider-down reason/retry without fabricated window percentages', () => {
    const rendered = usageRow(proxy({ retryAt: Date.now() + 10 * 60_000 }), 18);
    expect(rendered).toContain('CLI DOWN');
    expect(rendered).toContain('cooldown');
    expect(rendered).toContain('retry in');
    expect(rendered).not.toContain('100%');
    expect(rendered).not.toContain('AT LIMIT');
  });

  test('shows a selectable pool as available while keeping quota windows blank', () => {
    const rendered = usageRow(
      proxy({ availability: 'available', unavailable: false, unavailableReason: undefined, atLimit: false }),
      18,
    );
    expect(rendered).toContain('CLI available');
    expect(rendered).not.toContain('CLI DOWN');
  });
});
