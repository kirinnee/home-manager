import { describe, expect, test } from 'bun:test';
import { isActiveShortcutComposer, shortcutTargetAllowed } from './use-dictation-shortcut';

describe('visible composer ownership', () => {
  test('rejects a retained aria-hidden pane and a detached textarea', () => {
    expect(isActiveShortcutComposer({ isConnected: true, closest: () => ({ hidden: true }) })).toBe(false);
    expect(isActiveShortcutComposer({ isConnected: false, closest: () => null })).toBe(false);
  });

  test('accepts the one connected composer outside an inert pane', () => {
    expect(isActiveShortcutComposer({ isConnected: true, closest: () => null })).toBe(true);
  });
});

describe('event target ownership', () => {
  test('allows the composer itself and ordinary page chrome', () => {
    const composer = {} as HTMLElement;
    expect(shortcutTargetAllowed(composer, composer)).toBe(true);
    expect(shortcutTargetAllowed({ tagName: 'BUTTON', closest: () => null }, composer)).toBe(true);
  });

  test('does not steal another input, dialog, or settings key capture', () => {
    const composer = {} as HTMLElement;
    expect(shortcutTargetAllowed({ tagName: 'INPUT', closest: () => ({ input: true }) }, composer)).toBe(false);
    expect(shortcutTargetAllowed({ tagName: 'BUTTON', closest: () => ({ dialog: true }) }, composer)).toBe(false);
  });
});
