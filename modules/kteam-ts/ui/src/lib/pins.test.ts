import { describe, expect, test } from 'bun:test';
import {
  MAX_NOTE_LEN,
  MAX_PINS_PER_SESSION,
  MAX_PIN_SESSIONS,
  PINS_VERSION,
  PREVIEW_LEN,
  addNote,
  editNote,
  emptyStore,
  evictLru,
  insertPinAt,
  isMessagePinned,
  parseGithubPr,
  parsePin,
  parsePinStore,
  removePin,
  sessionPins,
  toPreview,
  toggleMessagePin,
  type MessagePin,
  type NotePin,
  type PinStore,
} from './pins';

const S = 'sess-1';

function withNote(text: string, at = 1): PinStore {
  const r = addNote(emptyStore(), S, text, 'n1', at);
  if (!r.ok) throw new Error('expected ok');
  return r.store;
}

describe('parsePinStore — defensive', () => {
  test('null / empty / malformed JSON degrade to an empty store', () => {
    expect(parsePinStore(null)).toEqual(emptyStore());
    expect(parsePinStore('')).toEqual(emptyStore());
    expect(parsePinStore('not json{')).toEqual(emptyStore());
    expect(parsePinStore('42')).toEqual(emptyStore());
    expect(parsePinStore('"a string"')).toEqual(emptyStore());
    expect(parsePinStore('null')).toEqual(emptyStore());
  });

  test('a wrong version is discarded rather than read', () => {
    const raw = JSON.stringify({
      v: PINS_VERSION + 1,
      sessions: { s1: { at: 1, pins: [{ id: 'a', kind: 'note', text: 'hi', at: 1 }] } },
    });
    expect(parsePinStore(raw)).toEqual(emptyStore());
  });

  test('valid pins survive; malformed ones are dropped field-by-field', () => {
    const raw = JSON.stringify({
      v: PINS_VERSION,
      sessions: {
        s1: {
          at: 10,
          pins: [
            { id: 'good-note', kind: 'note', text: 'keep me', at: 5 },
            { kind: 'note', text: 'no id', at: 5 },
            { id: 'no-at', kind: 'note', text: 'no timestamp' },
            { id: 'empty', kind: 'note', text: '   ', at: 5 },
            { id: 'msg', kind: 'message', blockId: 'u-1', blockKind: 'user', preview: 'hey', at: 6 },
            { id: 'msg-bad-kind', kind: 'message', blockId: 'x-1', blockKind: 'weird', preview: 'p', at: 6 },
            { id: 'msg-no-block', kind: 'message', blockKind: 'user', preview: 'p', at: 6 },
          ],
        },
        empty: { at: 1, pins: [] },
        badAt: { at: Number.NaN, pins: [{ id: 'z', kind: 'note', text: 'x', at: 1 }] },
      },
    });
    const store = parsePinStore(raw);
    expect(Object.keys(store.sessions)).toEqual(['s1']);
    const pins = store.sessions['s1']!.pins;
    expect(pins.map(p => p.id)).toEqual(['good-note', 'msg']);
  });

  test('a payload with an oversized note drops that note (refuse-not-truncate on read)', () => {
    const raw = JSON.stringify({
      v: PINS_VERSION,
      sessions: { s1: { at: 1, pins: [{ id: 'big', kind: 'note', text: 'x'.repeat(MAX_NOTE_LEN + 1), at: 1 }] } },
    });
    expect(parsePinStore(raw)).toEqual(emptyStore());
  });

  test('duplicate ids and duplicate message blocks are de-duplicated', () => {
    const raw = JSON.stringify({
      v: PINS_VERSION,
      sessions: {
        s1: {
          at: 1,
          pins: [
            { id: 'a', kind: 'message', blockId: 'u-1', blockKind: 'user', preview: 'one', at: 1 },
            { id: 'a', kind: 'note', text: 'dup id', at: 1 },
            { id: 'b', kind: 'message', blockId: 'u-1', blockKind: 'user', preview: 'dup block', at: 1 },
          ],
        },
      },
    });
    const pins = parsePinStore(raw).sessions['s1']!.pins;
    expect(pins.map(p => p.id)).toEqual(['a']);
  });
});

describe('parsePin', () => {
  test('rejects non-objects and unknown kinds', () => {
    expect(parsePin(null)).toBeNull();
    expect(parsePin('x')).toBeNull();
    expect(parsePin({ id: 'a', kind: 'other', at: 1 })).toBeNull();
  });
  test('keeps an optional message ts only when present and a string', () => {
    const p = parsePin({
      id: 'a',
      kind: 'message',
      blockId: 'u-1',
      blockKind: 'user',
      preview: 'p',
      at: 1,
      ts: '2026',
    });
    expect((p as MessagePin).ts).toBe('2026');
    const q = parsePin({ id: 'a', kind: 'message', blockId: 'u-1', blockKind: 'user', preview: 'p', at: 1, ts: 5 });
    expect('ts' in (q as object)).toBe(false);
  });
});

describe('addNote — caps and refusal', () => {
  test('empty/whitespace is refused silently', () => {
    expect(addNote(emptyStore(), S, '   ', 'n', 1)).toEqual({ ok: false, reason: 'empty' });
  });
  test('over-cap is refused loudly (never truncated)', () => {
    expect(addNote(emptyStore(), S, 'x'.repeat(MAX_NOTE_LEN + 1), 'n', 1)).toEqual({ ok: false, reason: 'too-long' });
  });
  test('exactly the cap is accepted', () => {
    const r = addNote(emptyStore(), S, 'x'.repeat(MAX_NOTE_LEN), 'n', 1);
    expect(r.ok).toBe(true);
  });
  test('newest note goes to the front', () => {
    let store = withNote('first', 1);
    const r = addNote(store, S, 'second', 'n2', 2);
    if (!r.ok) throw new Error('ok');
    store = r.store;
    expect(sessionPins(store, S).map(p => (p as NotePin).text)).toEqual(['second', 'first']);
  });
});

describe('editNote', () => {
  test('edits in place keeping position; a no-op edit returns the same store', () => {
    const store = withNote('hello', 1);
    const same = editNote(store, S, 'n1', 'hello', 2);
    expect(same.ok && same.store).toBe(store);
    const changed = editNote(store, S, 'n1', 'goodbye', 2);
    if (!changed.ok) throw new Error('ok');
    expect(sessionPins(changed.store, S)[0]).toMatchObject({ text: 'goodbye', at: 2 });
  });
  test('refuses empty and over-cap edits', () => {
    const store = withNote('hello', 1);
    expect(editNote(store, S, 'n1', '  ', 2)).toEqual({ ok: false, reason: 'empty' });
    expect(editNote(store, S, 'n1', 'x'.repeat(MAX_NOTE_LEN + 1), 2)).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('toggleMessagePin', () => {
  const input = { id: 'm1', blockId: 'u-abc', blockKind: 'assistant' as const, preview: 'hello world', ts: '2026' };
  test('pins to the front and stores a single-lined preview', () => {
    const store = toggleMessagePin(emptyStore(), S, { ...input, preview: '  a\n\n  b  ' }, 1);
    const pin = sessionPins(store, S)[0] as MessagePin;
    expect(pin).toMatchObject({
      kind: 'message',
      blockId: 'u-abc',
      blockKind: 'assistant',
      preview: 'a b',
      ts: '2026',
    });
  });
  test('toggling an already-pinned block unpins it', () => {
    const on = toggleMessagePin(emptyStore(), S, input, 1);
    expect(isMessagePinned(on, S, 'u-abc')).toBe(true);
    const off = toggleMessagePin(on, S, { ...input, id: 'm2' }, 2);
    expect(isMessagePinned(off, S, 'u-abc')).toBe(false);
  });
});

describe('caps and LRU', () => {
  test('per-session pin cap drops the oldest when exceeded', () => {
    let store = emptyStore();
    for (let i = 0; i < MAX_PINS_PER_SESSION + 5; i++) {
      const r = addNote(store, S, `note ${i}`, `n${i}`, i + 1);
      if (!r.ok) throw new Error('ok');
      store = r.store;
    }
    const pins = sessionPins(store, S);
    expect(pins.length).toBe(MAX_PINS_PER_SESSION);
    // Newest at the front; the very first notes fell off the end.
    expect((pins[0] as NotePin).text).toBe(`note ${MAX_PINS_PER_SESSION + 4}`);
  });

  test('session LRU keeps the most-recently-touched sessions', () => {
    let store = emptyStore();
    for (let i = 0; i < MAX_PIN_SESSIONS + 3; i++) {
      const r = addNote(store, `s${i}`, 'x', `n${i}`, i + 1);
      if (!r.ok) throw new Error('ok');
      store = r.store;
    }
    expect(Object.keys(store.sessions).length).toBe(MAX_PIN_SESSIONS);
    expect(store.sessions['s0']).toBeUndefined();
    expect(store.sessions[`s${MAX_PIN_SESSIONS + 2}`]).toBeDefined();
  });

  test('evictLru is a no-op under the cap', () => {
    const store = withNote('x', 1);
    expect(evictLru(store)).toBe(store);
  });
});

describe('removePin / insertPinAt (undo)', () => {
  test('remove returns the same reference when nothing matched', () => {
    const store = withNote('x', 1);
    expect(removePin(store, S, 'missing', 2)).toBe(store);
  });
  test('remove then insert at the old index restores order', () => {
    let store = withNote('a', 1);
    for (const [t, id] of [
      ['b', 'n2'],
      ['c', 'n3'],
    ] as const) {
      const r = addNote(store, S, t, id, 2);
      if (!r.ok) throw new Error('ok');
      store = r.store;
    }
    // order: c, b, a
    const removed = sessionPins(store, S)[1] as NotePin; // 'b' at index 1
    const after = removePin(store, S, removed.id, 3);
    expect(sessionPins(after, S).map(p => (p as NotePin).text)).toEqual(['c', 'a']);
    const restored = insertPinAt(after, S, removed, 1, 4);
    expect(sessionPins(restored, S).map(p => (p as NotePin).text)).toEqual(['c', 'b', 'a']);
  });
  test('removing the last pin drops the session entirely', () => {
    const store = withNote('only', 1);
    const after = removePin(store, S, 'n1', 2);
    expect(after.sessions[S]).toBeUndefined();
  });
});

describe('toPreview', () => {
  test('collapses whitespace and caps length', () => {
    expect(toPreview('  hello   world \n\t next ')).toBe('hello world next');
    const long = 'x'.repeat(PREVIEW_LEN + 50);
    const p = toPreview(long);
    expect(p.length).toBe(PREVIEW_LEN + 1); // + the ellipsis
    expect(p.endsWith('…')).toBe(true);
  });
});

describe('parseGithubPr', () => {
  test('recognises a bare PR URL', () => {
    expect(parseGithubPr('https://github.com/atomi/nitroso/pull/42')).toEqual({
      org: 'atomi',
      repo: 'nitroso',
      number: 42,
      url: 'https://github.com/atomi/nitroso/pull/42',
    });
  });
  test('tolerates a trailing slash, query, or fragment', () => {
    expect(parseGithubPr('https://github.com/o/r/pull/7/files')?.number).toBe(7);
    expect(parseGithubPr('http://www.github.com/o/r/pull/7?w=1')?.number).toBe(7);
  });
  test('rejects a URL with trailing prose or a non-PR URL', () => {
    expect(parseGithubPr('see https://github.com/o/r/pull/7')).toBeNull();
    expect(parseGithubPr('https://github.com/o/r/issues/7')).toBeNull();
    expect(parseGithubPr('https://example.com/o/r/pull/7')).toBeNull();
    expect(parseGithubPr('just a note')).toBeNull();
  });
});
