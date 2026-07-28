import { describe, expect, test } from 'bun:test';
import {
  BARE_ALT_WARNING,
  DEFAULT_DICTATION_SHORTCUT,
  DictationShortcutGesture,
  beginDictationShortcutCapture,
  dictationShortcutAria,
  dictationShortcutCaptureActive,
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  matchesDictationShortcut,
  parseDictationShortcut,
  sameDictationShortcutTrigger,
  validateDictationShortcut,
  type ShortcutKeyboardEvent,
} from './dictation-shortcut';

function key(overrides: Partial<ShortcutKeyboardEvent> = {}): ShortcutKeyboardEvent {
  return {
    key: 'Alt',
    code: 'AltLeft',
    metaKey: false,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    ...overrides,
  };
}

describe('default shortcut', () => {
  test('is either Alt key and labels that honestly', () => {
    expect(dictationShortcutLabel(DEFAULT_DICTATION_SHORTCUT)).toBe('Alt (either side)');
    expect(dictationShortcutAria(DEFAULT_DICTATION_SHORTCUT)).toBe('Alt');
    expect(matchesDictationShortcut(DEFAULT_DICTATION_SHORTCUT, key())).toBe(true);
    expect(matchesDictationShortcut(DEFAULT_DICTATION_SHORTCUT, key({ code: 'AltRight' }))).toBe(true);
    expect(sameDictationShortcutTrigger(DEFAULT_DICTATION_SHORTCUT, key({ altKey: false }))).toBe(true);
  });

  test('warns at pick time that the desktop may intercept bare Alt', () => {
    expect(validateDictationShortcut(DEFAULT_DICTATION_SHORTCUT)).toEqual({ ok: true, warning: BARE_ALT_WARNING });
  });
});

describe('capture, matching and defensive parse', () => {
  test('captures the physical primary key and excludes its own modifier flag', () => {
    const binding = dictationShortcutFromEvent(key({ key: 'v', code: 'KeyV', altKey: true, shiftKey: true }));
    expect(binding).toEqual({ code: 'KeyV', key: 'v', modifiers: ['Alt', 'Shift'] });
    expect(dictationShortcutLabel(binding)).toBe('Alt + Shift + V');
    expect(matchesDictationShortcut(binding, key({ key: 'v', code: 'KeyV', shiftKey: true }))).toBe(true);
    expect(matchesDictationShortcut(binding, key({ key: 'v', code: 'KeyV', shiftKey: false }))).toBe(false);
  });

  test('matches a real-browser-shaped keyup whose key and code live on the prototype', () => {
    const browserEvent = Object.create(
      Object.defineProperties(
        {},
        {
          key: { get: () => 'v' },
          code: { get: () => 'KeyV' },
        },
      ),
    ) as Pick<ShortcutKeyboardEvent, 'code' | 'key'>;
    expect(Object.keys(browserEvent)).toEqual([]);
    expect(sameDictationShortcutTrigger({ code: 'KeyV', key: 'v', modifiers: ['Alt', 'Shift'] }, browserEvent)).toBe(
      true,
    );
  });

  test('a corrupt stored value degrades to the sane default', () => {
    expect(parseDictationShortcut({ code: '', key: '\u0000', modifiers: ['Telepathy'] })).toEqual({
      ...DEFAULT_DICTATION_SHORTCUT,
      modifiers: [],
    });
    expect(parseDictationShortcut(null)).toEqual({ ...DEFAULT_DICTATION_SHORTCUT, modifiers: [] });
    expect(parseDictationShortcut({ code: 'AltLeft', key: 'Alt', modifiers: ['Alt'] })).toEqual({
      code: 'AltLeft',
      key: 'Alt',
      modifiers: [],
    });
  });
});

describe('validation', () => {
  test('refuses keys that fire while typing', () => {
    expect(validateDictationShortcut({ code: 'KeyD', key: 'd', modifiers: [] }).reason).toMatch(/while you type/i);
    expect(validateDictationShortcut({ code: 'KeyD', key: 'D', modifiers: ['Shift'] }).reason).toMatch(
      /while you type/i,
    );
  });

  test('refuses the app command and common browser/OS chords with a reason', () => {
    expect(validateDictationShortcut({ code: 'KeyK', key: 'k', modifiers: ['Control'] }).reason).toMatch(
      /command palette/i,
    );
    expect(validateDictationShortcut({ code: 'KeyL', key: 'l', modifiers: ['Control'] }).reason).toMatch(
      /browser command/i,
    );
    expect(validateDictationShortcut({ code: 'Tab', key: 'Tab', modifiers: ['Alt'] }).reason).toMatch(
      /operating system/i,
    );
  });

  test('accepts a customized non-colliding chord', () => {
    expect(validateDictationShortcut({ code: 'KeyV', key: 'v', modifiers: ['Alt', 'Shift'] })).toEqual({ ok: true });
  });
});

describe('hybrid hold/tap gesture', () => {
  test('hold starts on press and finishes on release', () => {
    const gesture = new DictationShortcutGesture(500);
    expect(gesture.keyDown(1_000, false)).toBe('start');
    expect(gesture.keyUp(1_600)).toBe('stop');
  });

  test('a quick tap latches; the next press finishes', () => {
    const gesture = new DictationShortcutGesture(500);
    expect(gesture.keyDown(1_000, false)).toBe('start');
    expect(gesture.keyUp(1_100)).toBeNull();
    expect(gesture.keyDown(2_000, true)).toBe('stop');
    expect(gesture.keyUp(2_050)).toBeNull();
  });

  test('stops a mic-button recording and cannot leave a held mic open on blur', () => {
    const toggle = new DictationShortcutGesture();
    expect(toggle.keyDown(0, true)).toBe('stop');
    const held = new DictationShortcutGesture();
    expect(held.keyDown(0, false)).toBe('start');
    expect(held.blur(true)).toBe('stop');
    const beforeReactRenders = new DictationShortcutGesture();
    expect(beforeReactRenders.keyDown(0, false)).toBe('start');
    expect(beforeReactRenders.blur(false)).toBe('stop');
  });
});

describe('picker suppression', () => {
  test('is balanced and idempotent', () => {
    const first = beginDictationShortcutCapture();
    const second = beginDictationShortcutCapture();
    expect(dictationShortcutCaptureActive()).toBe(true);
    first();
    first();
    expect(dictationShortcutCaptureActive()).toBe(true);
    second();
    expect(dictationShortcutCaptureActive()).toBe(false);
  });
});
