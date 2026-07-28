// Pure push-to-talk shortcut policy.
//
// The binding is persisted by `stt-settings.ts`; this module owns its shape,
// event capture/matching, collision policy and the hybrid hold/tap gesture.
// It intentionally imports neither React nor browser globals, so every key
// decision can be tested without pretending Bun has a desktop keyboard.

export type DictationShortcutModifier = 'Meta' | 'Control' | 'Alt' | 'Shift';

export interface DictationShortcutBinding {
  /** Physical KeyboardEvent.code. The semantic `Alt` value is the one special
   * case: it deliberately means either AltLeft or AltRight. */
  code: string;
  /** KeyboardEvent.key captured with the code, used only for a readable label
   * and as the fallback in browsers that omit `code`. */
  key: string;
  modifiers: DictationShortcutModifier[];
}

export const DEFAULT_DICTATION_SHORTCUT: Readonly<DictationShortcutBinding> = Object.freeze({
  code: 'Alt',
  key: 'Alt',
  modifiers: Object.freeze([]) as unknown as DictationShortcutModifier[],
});

export const DICTATION_SHORTCUT_HOLD_MS = 500;

export const BARE_ALT_WARNING =
  'Bare Alt can be intercepted by a browser menu or window manager before this page sees it. Use Change and press then release Alt here to test this browser, or choose another chord.';

const MODIFIER_ORDER: readonly DictationShortcutModifier[] = ['Meta', 'Control', 'Alt', 'Shift'];
const MODIFIER_CODES: Readonly<Record<DictationShortcutModifier, readonly string[]>> = {
  Meta: ['Meta', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'],
  Control: ['Control', 'ControlLeft', 'ControlRight'],
  Alt: ['Alt', 'AltLeft', 'AltRight'],
  Shift: ['Shift', 'ShiftLeft', 'ShiftRight'],
};

export interface ShortcutKeyboardEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface DictationShortcutVerdict {
  ok: boolean;
  reason?: string;
  warning?: string;
}

function primaryModifier(code: string): DictationShortcutModifier | null {
  for (const modifier of MODIFIER_ORDER) {
    if (MODIFIER_CODES[modifier].includes(code)) return modifier;
  }
  return null;
}

function canonicalModifiers(values: readonly unknown[]): DictationShortcutModifier[] {
  const selected = new Set<DictationShortcutModifier>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (MODIFIER_ORDER.includes(value as DictationShortcutModifier)) selected.add(value as DictationShortcutModifier);
  }
  return MODIFIER_ORDER.filter(value => selected.has(value));
}

function eventModifiers(event: ShortcutKeyboardEvent, primaryCode: string): DictationShortcutModifier[] {
  const active: DictationShortcutModifier[] = [];
  if (event.metaKey) active.push('Meta');
  if (event.ctrlKey) active.push('Control');
  if (event.altKey) active.push('Alt');
  if (event.shiftKey) active.push('Shift');
  const own = primaryModifier(primaryCode);
  return own === null ? active : active.filter(modifier => modifier !== own);
}

/** Capture what the browser actually reported. A modifier pressed first may be
 * replaced by a later non-modifier key before the picker saves on keyup. */
export function dictationShortcutFromEvent(event: ShortcutKeyboardEvent): DictationShortcutBinding {
  const code = (event.code || event.key).slice(0, 48);
  const key = event.key.slice(0, 24);
  return { code, key, modifiers: eventModifiers(event, code) };
}

/** Defensive nested-field parser for the versioned STT settings owner. */
export function parseDictationShortcut(value: unknown): DictationShortcutBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ...DEFAULT_DICTATION_SHORTCUT, modifiers: [] };
  const candidate = value as Record<string, unknown>;
  const code = typeof candidate['code'] === 'string' ? candidate['code'].slice(0, 48) : '';
  const key = typeof candidate['key'] === 'string' ? candidate['key'].slice(0, 24) : '';
  let modifiers = Array.isArray(candidate['modifiers']) ? canonicalModifiers(candidate['modifiers']) : [];
  if (!code || !key || /[\u0000-\u001f\u007f]/u.test(code + key)) {
    return { ...DEFAULT_DICTATION_SHORTCUT, modifiers: [] };
  }
  const ownModifier = primaryModifier(code);
  if (ownModifier !== null) modifiers = modifiers.filter(modifier => modifier !== ownModifier);
  const binding = { code, key, modifiers };
  return validateDictationShortcut(binding).ok ? binding : { ...DEFAULT_DICTATION_SHORTCUT, modifiers: [] };
}

function isBare(binding: DictationShortcutBinding): boolean {
  return binding.modifiers.length === 0 && primaryModifier(binding.code) === null;
}

function isPrintablePrimary(binding: DictationShortcutBinding): boolean {
  return binding.key.length === 1 || /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|Space)$/u.test(binding.code);
}

function hasCommandModifier(binding: DictationShortcutBinding): boolean {
  return binding.modifiers.some(modifier => modifier === 'Meta' || modifier === 'Control' || modifier === 'Alt');
}

function exactModifiers(binding: DictationShortcutBinding, expected: readonly DictationShortcutModifier[]): boolean {
  return (
    binding.modifiers.length === expected.length && expected.every(modifier => binding.modifiers.includes(modifier))
  );
}

/** Reject collisions and chords a page cannot safely own. This list is
 * intentionally conservative: a shortcut that silently closes a tab or types
 * into the composer is worse than asking the reader for another chord. */
export function validateDictationShortcut(binding: DictationShortcutBinding): DictationShortcutVerdict {
  if (!binding.code || !binding.key) return { ok: false, reason: 'Press a real key or key combination.' };

  const ownModifier = primaryModifier(binding.code);
  if (ownModifier === 'Alt' && binding.modifiers.length === 0) return { ok: true, warning: BARE_ALT_WARNING };
  if (ownModifier !== null && binding.modifiers.length === 0) {
    return {
      ok: false,
      reason: `${ownModifier} by itself is reserved for typing or system controls. Add another key.`,
    };
  }

  if (isPrintablePrimary(binding) && !hasCommandModifier(binding)) {
    return {
      ok: false,
      reason: 'A bare printable key (or Shift plus a printable key) would fire while you type in the composer.',
    };
  }

  if (binding.code === 'KeyK' && (exactModifiers(binding, ['Meta']) || exactModifiers(binding, ['Control']))) {
    return { ok: false, reason: '⌘K / Ctrl K already opens the command palette.' };
  }

  const browserReserved = new Set(['KeyL', 'KeyT', 'KeyW', 'KeyR', 'KeyN', 'KeyP', 'KeyF', 'KeyS', 'KeyO']);
  if (
    browserReserved.has(binding.code) &&
    (exactModifiers(binding, ['Meta']) || exactModifiers(binding, ['Control']))
  ) {
    return { ok: false, reason: 'That chord is a standard browser command and may never reach this page.' };
  }

  if (
    (binding.code === 'Tab' && binding.modifiers.includes('Alt')) ||
    (binding.code === 'F4' && binding.modifiers.includes('Alt')) ||
    (binding.code === 'Space' && binding.modifiers.includes('Meta')) ||
    (binding.code === 'Delete' && exactModifiers(binding, ['Control', 'Alt']))
  ) {
    return { ok: false, reason: 'The operating system reserves that chord before a web page can observe it.' };
  }

  if (['F1', 'F5', 'F6', 'F11', 'F12'].includes(binding.code)) {
    return { ok: false, reason: 'That function key is reserved by common browser controls.' };
  }

  if (
    isBare(binding) &&
    (isPrintablePrimary(binding) ||
      ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
        binding.code,
      ))
  ) {
    return { ok: false, reason: 'That bare key already edits or navigates the composer.' };
  }

  return { ok: true };
}

function codeLabel(binding: DictationShortcutBinding): string {
  if (binding.code === 'Alt') return 'Alt (either side)';
  const known: Record<string, string> = {
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    MetaLeft: 'Left Meta',
    MetaRight: 'Right Meta',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    Space: 'Space',
  };
  if (known[binding.code]) return known[binding.code]!;
  if (/^Key[A-Z]$/u.test(binding.code)) return binding.code.slice(3);
  if (/^Digit[0-9]$/u.test(binding.code)) return binding.code.slice(5);
  return binding.key === ' ' ? 'Space' : binding.key || binding.code;
}

export function dictationShortcutLabel(binding: DictationShortcutBinding): string {
  const modifierLabels: Record<DictationShortcutModifier, string> = {
    Meta: 'Meta',
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
  };
  return [...binding.modifiers.map(modifier => modifierLabels[modifier]), codeLabel(binding)].join(' + ');
}

export function dictationShortcutAria(binding: DictationShortcutBinding): string {
  const primary = binding.code === 'Alt' ? 'Alt' : codeLabel(binding).replace(/^(?:Left|Right) /u, '');
  return [...binding.modifiers, primary].join('+');
}

function primaryMatches(binding: DictationShortcutBinding, event: ShortcutKeyboardEvent): boolean {
  if (binding.code === 'Alt') return event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
  return event.code === binding.code || (!event.code && event.key === binding.key);
}

export function matchesDictationShortcut(binding: DictationShortcutBinding, event: ShortcutKeyboardEvent): boolean {
  if (!primaryMatches(binding, event)) return false;
  const current = eventModifiers(event, event.code || event.key);
  return current.length === binding.modifiers.length && binding.modifiers.every(modifier => current.includes(modifier));
}

export function sameDictationShortcutTrigger(
  binding: DictationShortcutBinding,
  event: Pick<ShortcutKeyboardEvent, 'code' | 'key'>,
): boolean {
  return primaryMatches(binding, {
    // Native KeyboardEvent fields are prototype-backed accessors, so spreading
    // the event drops both values. Read them explicitly for real browser
    // keyups as well as the plain objects used by unit tests.
    key: event.key,
    code: event.code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });
}

export type DictationShortcutAction = 'start' | 'stop' | null;

type GestureState = 'idle' | 'pressed' | 'latched' | 'stopping';

/** Hybrid interaction: a hold releases to finish; a quick tap latches and the
 * next press finishes. `currentlyActive` also makes the shortcut stop a
 * recording begun with the visible mic button. */
export class DictationShortcutGesture {
  private state: GestureState = 'idle';
  private pressedAt = 0;

  constructor(private readonly holdMs = DICTATION_SHORTCUT_HOLD_MS) {}

  keyDown(now: number, currentlyActive: boolean): DictationShortcutAction {
    if (this.state === 'pressed' || this.state === 'stopping') return null;
    if (this.state === 'latched' || currentlyActive) {
      this.state = 'stopping';
      return 'stop';
    }
    this.state = 'pressed';
    this.pressedAt = now;
    return 'start';
  }

  keyUp(now: number): DictationShortcutAction {
    if (this.state === 'stopping') {
      this.state = 'idle';
      return null;
    }
    if (this.state !== 'pressed') return null;
    if (Math.max(0, now - this.pressedAt) >= this.holdMs) {
      this.state = 'idle';
      return 'stop';
    }
    this.state = 'latched';
    return null;
  }

  blur(_currentlyActive: boolean): DictationShortcutAction {
    // The React phase update triggered by `start()` may not have committed yet
    // when bare Alt immediately moves focus. Gesture state is the stronger fact:
    // `pressed`/`latched` means this controller already issued start, so always
    // issue the idempotent stop rather than trusting a stale `idle` phase.
    const shouldStop = this.state === 'pressed' || this.state === 'latched';
    this.state = 'idle';
    return shouldStop ? 'stop' : null;
  }

  reset(): void {
    this.state = 'idle';
  }
}

let shortcutCaptureDepth = 0;

/** Prevent a composer behind the Settings sheet from hearing the keys being
 * tested by the picker. The returned disposer makes nested/aborted captures
 * balance correctly. */
export function beginDictationShortcutCapture(): () => void {
  shortcutCaptureDepth += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    shortcutCaptureDepth = Math.max(0, shortcutCaptureDepth - 1);
  };
}

export function dictationShortcutCaptureActive(): boolean {
  return shortcutCaptureDepth > 0;
}
