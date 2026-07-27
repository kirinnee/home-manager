import { afterEach, describe, expect, test } from 'bun:test';
import { blockIdOfSelection, pinSelection, truncateSelection } from './pin-selection';
import { MAX_NOTE_LEN, pinsStore, sessionPins } from './pins';
import { clearForegroundSession, setForegroundSession } from './pin-bridge';

describe('truncateSelection', () => {
  test('empty or whitespace-only yields an empty string', () => {
    expect(truncateSelection('')).toBe('');
    expect(truncateSelection('   \n\t ')).toBe('');
  });

  test('trims the ends but keeps interior text as selected', () => {
    expect(truncateSelection('  kteam daemon status  ')).toBe('kteam daemon status');
    expect(truncateSelection('one\ntwo')).toBe('one\ntwo');
  });

  test('text at exactly the cap is kept whole', () => {
    const exact = 'x'.repeat(MAX_NOTE_LEN);
    expect(truncateSelection(exact)).toBe(exact);
    expect(truncateSelection(exact).length).toBe(MAX_NOTE_LEN);
  });

  test('over-cap is truncated with an ellipsis, never longer than the cap', () => {
    const long = 'y'.repeat(MAX_NOTE_LEN + 50);
    const out = truncateSelection(long);
    expect(out.length).toBe(MAX_NOTE_LEN);
    expect(out.endsWith('…')).toBe(true);
  });

  test('a small cap is honoured (parameterised for tests)', () => {
    expect(truncateSelection('abcdef', 4)).toBe('abc…');
  });

  test('does not leave a dangling space before the ellipsis', () => {
    // Cut lands right after a space: the space is trimmed before the ellipsis.
    expect(truncateSelection('ab cdef', 4)).toBe('ab…');
  });
});

describe('blockIdOfSelection', () => {
  test('returns null without nodes or a root (SSR / no selection)', () => {
    expect(blockIdOfSelection(null, null, null)).toBeNull();
  });
});

describe('pinSelection — foreground note write', () => {
  const SID = 'pin-selection-test-session';
  afterEach(() => {
    clearForegroundSession(SID);
    // leave the store as-is between tests; each test uses a fresh session id
  });

  test('an empty selection is a no-op with reason "empty"', () => {
    setForegroundSession(SID);
    expect(pinSelection('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(sessionPins(pinsStore.getSnapshot(), SID)).toHaveLength(0);
  });

  test('with no foreground transcript it reports "no-session"', () => {
    clearForegroundSession(SID);
    setForegroundSession(null);
    expect(pinSelection('something')).toEqual({ ok: false, reason: 'no-session' });
  });

  test('stores a note carrying the source blockId for the foreground session', () => {
    const sid = `${SID}-ok`;
    setForegroundSession(sid);
    expect(pinSelection('a highlighted snippet', 'a-1234')).toEqual({ ok: true });
    const pins = sessionPins(pinsStore.getSnapshot(), sid);
    expect(pins).toHaveLength(1);
    const [pin] = pins;
    expect(pin?.kind).toBe('note');
    if (pin?.kind === 'note') {
      expect(pin.text).toBe('a highlighted snippet');
      expect(pin.source).toEqual({ blockId: 'a-1234' });
    }
    clearForegroundSession(sid);
  });

  test('a selection with no source block stores a plain note (no source)', () => {
    const sid = `${SID}-nosrc`;
    setForegroundSession(sid);
    expect(pinSelection('loose text')).toEqual({ ok: true });
    const [pin] = sessionPins(pinsStore.getSnapshot(), sid);
    if (pin?.kind === 'note') expect(pin.source).toBeUndefined();
    clearForegroundSession(sid);
  });
});
