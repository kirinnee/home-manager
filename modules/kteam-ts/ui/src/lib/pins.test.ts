// What is left to test client-side after the daemon took over pin policy:
// the defensive parses (the legacy localStorage payload read for migration,
// and the server snapshot), the synchronous note validation the sheet needs
// before a round-trip, the pure readers, and the PR-link recogniser. The
// mutation policy (caps, dedupe, ordering, provenance) is the daemon's and is
// asserted in src/pins-store.test.ts / src/pins-service.test.ts.

import { describe, expect, test } from 'bun:test';
import {
  MAX_NOTE_LEN,
  MAX_PINS_PER_SESSION,
  PINS_VERSION,
  emptyStore,
  isMessagePinned,
  parseGithubPr,
  parsePin,
  parsePinStore,
  parseServerPins,
  sessionPins,
  validateNote,
  type MessagePin,
  type NotePin,
  type PinStore,
} from './pins';

describe('parsePinStore — defensive (legacy localStorage, migration source)', () => {
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

  test('an over-long legacy session is capped on read', () => {
    const many = Array.from({ length: MAX_PINS_PER_SESSION + 5 }, (_, i) => ({
      id: `n${i}`,
      kind: 'note',
      text: `note ${i}`,
      at: i + 1,
    }));
    const raw = JSON.stringify({ v: PINS_VERSION, sessions: { s1: { at: 1, pins: many } } });
    expect(parsePinStore(raw).sessions['s1']!.pins).toHaveLength(MAX_PINS_PER_SESSION);
  });
});

describe('parseServerPins (daemon snapshot → clean list)', () => {
  test('reads a snapshot body, keeps provenance, and drops malformed pins', () => {
    const body = {
      v: 1,
      sessionId: 's',
      updatedAt: 'now',
      pins: [
        { id: 'a', kind: 'note', text: 'human note', at: 1 },
        { id: 'b', kind: 'note', text: 'agent note', at: 2, by: 'agent', createdBy: 'sid', createdByName: 'zoe' },
        { id: 'bad', kind: 'note' }, // no at → dropped
      ],
    };
    const pins = parseServerPins(body);
    expect(pins.map(p => p.id)).toEqual(['a', 'b']);
    expect(pins[0]!.by).toBeUndefined(); // absent ⇒ treated as human at render
    expect(pins[1]).toMatchObject({ by: 'agent', createdBy: 'sid', createdByName: 'zoe' });
  });
  test('garbage or a missing pins array degrades to empty', () => {
    expect(parseServerPins(null)).toEqual([]);
    expect(parseServerPins({})).toEqual([]);
    expect(parseServerPins({ pins: 'nope' })).toEqual([]);
  });
  test('de-duplicates by id', () => {
    const pins = parseServerPins({
      pins: [
        { id: 'x', kind: 'note', text: 'a', at: 1 },
        { id: 'x', kind: 'note', text: 'b', at: 2 },
      ],
    });
    expect(pins).toHaveLength(1);
  });
});

describe('parsePin', () => {
  test('reads optional provenance', () => {
    const p = parsePin({ id: 'a', kind: 'note', text: 'hi', at: 1, by: 'agent', createdBy: 's', createdByName: 'zoe' });
    expect(p).toMatchObject({ by: 'agent', createdBy: 's', createdByName: 'zoe' });
    const q = parsePin({ id: 'a', kind: 'note', text: 'hi', at: 1, by: 'bogus' });
    expect((q as NotePin).by).toBeUndefined();
  });
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
  test('keeps a note source only when it is a well-formed { blockId }', () => {
    const ok = parsePin({ id: 'a', kind: 'note', text: 'snip', at: 1, source: { blockId: 'u-1' } });
    expect((ok as NotePin).source).toEqual({ blockId: 'u-1' });
    // malformed sources degrade to a plain note, never a throw or a bogus jump
    for (const bad of [{ blockId: 5 }, { blockId: '' }, {}, 'x', null]) {
      const p = parsePin({ id: 'a', kind: 'note', text: 'snip', at: 1, source: bad });
      expect((p as NotePin).source).toBeUndefined();
    }
  });
});

describe("validateNote — the sheet's synchronous feedback", () => {
  test('empty/whitespace is refused silently', () => {
    expect(validateNote('   ')).toEqual({ ok: false, reason: 'empty' });
  });
  test('over-cap is refused loudly (never truncated)', () => {
    expect(validateNote('x'.repeat(MAX_NOTE_LEN + 1))).toEqual({ ok: false, reason: 'too-long' });
  });
  test('exactly the cap is accepted', () => {
    expect(validateNote('x'.repeat(MAX_NOTE_LEN))).toEqual({ ok: true });
  });
});

describe('readers over a cached snapshot', () => {
  const store: PinStore = {
    v: PINS_VERSION,
    sessions: {
      s1: {
        at: 1,
        pins: [
          { id: 'm1', kind: 'message', blockId: 'u-abc', blockKind: 'assistant', preview: 'hello', at: 1 },
          { id: 'n1', kind: 'note', text: 'a note', at: 2 },
        ],
      },
    },
  };
  test('sessionPins returns the cached list in order, [] for unknown sessions', () => {
    expect(sessionPins(store, 's1').map(p => p.id)).toEqual(['m1', 'n1']);
    expect(sessionPins(store, 'nope')).toEqual([]);
  });
  test('isMessagePinned matches by block id, message pins only', () => {
    expect(isMessagePinned(store, 's1', 'u-abc')).toBe(true);
    expect(isMessagePinned(store, 's1', 'u-other')).toBe(false);
    expect(isMessagePinned(store, 'nope', 'u-abc')).toBe(false);
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
