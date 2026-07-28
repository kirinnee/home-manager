import { describe, expect, test } from 'bun:test';
import { closeThemePopoverForKeyboard, scrollThemeFamilyIntoView, THEME_FAMILY_CARD_CLASS } from './ThemeToggle';

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

  test('keyboard navigation reveals cards in only the picker-owned scroller', () => {
    const scroller = {
      scrollTop: 80,
      getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
    } as unknown as HTMLElement;
    const above = {
      getBoundingClientRect: () => ({ top: 60, bottom: 160 }),
    } as unknown as HTMLElement;
    const below = {
      getBoundingClientRect: () => ({ top: 260, bottom: 340 }),
    } as unknown as HTMLElement;
    const visible = {
      getBoundingClientRect: () => ({ top: 120, bottom: 220 }),
    } as unknown as HTMLElement;

    scrollThemeFamilyIntoView(scroller, above);
    expect(scroller.scrollTop).toBe(40);
    scrollThemeFamilyIntoView(scroller, below);
    expect(scroller.scrollTop).toBe(80);
    scrollThemeFamilyIntoView(scroller, visible);
    expect(scroller.scrollTop).toBe(80);
  });
});
