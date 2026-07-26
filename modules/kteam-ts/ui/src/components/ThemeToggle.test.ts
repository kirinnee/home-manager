import { describe, expect, test } from 'bun:test';
import { closeThemePopoverForKeyboard, THEME_FAMILY_CARD_CLASS } from './ThemeToggle';

describe('ThemeToggle regression contracts', () => {
  test('family cards cannot shrink beneath their preview content', () => {
    // The radiogroup is intentionally height-capped and scrollable. Without
    // this class, flexbox compresses the cards and their visible-overflow
    // swatches paint over the following card on phone typography.
    expect(THEME_FAMILY_CARD_CLASS.split(/\s+/)).toContain('shrink-0');
  });

  test('keyboard opening closes without returning focus to its hidden trigger', () => {
    const closeCalls: boolean[] = [];

    closeThemePopoverForKeyboard(returnFocus => closeCalls.push(returnFocus));

    expect(closeCalls).toEqual([false]);
  });
});
