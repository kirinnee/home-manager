import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, sessionDir, type KTeamPaths } from './paths';
import {
  PinStore,
  applyCaps,
  dedupePins,
  isSafeSessionId,
  parsePin,
  parsePinFile,
  pinFile,
  serializeSnapshot,
  toPreview,
  validateNoteText,
} from './pins-store';
import {
  MAX_AGENT_PINS_PER_SESSION,
  MAX_NOTE_LEN,
  MAX_PINS_PER_SESSION,
  PIN_SCHEMA_VERSION,
  PinError,
  type Pin,
} from './pins-types';

let home: string;
let paths: KTeamPaths;
const SID = 'ms3g6a8p-71542ce1';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-pins-store-'));
  paths = createPaths(home);
  await mkdir(sessionDir(paths, SID), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const note = (over: Partial<Extract<Pin, { kind: 'note' }>> = {}): Pin => ({
  id: over.id ?? crypto.randomUUID(),
  kind: 'note',
  text: over.text ?? 'a note',
  at: over.at ?? 1,
  by: over.by ?? 'human',
  createdBy: over.createdBy ?? null,
  createdByName: over.createdByName ?? null,
  ...(over.source ? { source: over.source } : {}),
});
const msg = (over: Partial<Extract<Pin, { kind: 'message' }>> = {}): Pin => ({
  id: over.id ?? crypto.randomUUID(),
  kind: 'message',
  blockId: over.blockId ?? `blk-${crypto.randomUUID()}`,
  blockKind: over.blockKind ?? 'assistant',
  preview: over.preview ?? 'hello',
  at: over.at ?? 1,
  by: over.by ?? 'human',
  createdBy: over.createdBy ?? null,
  createdByName: over.createdByName ?? null,
});

describe('isSafeSessionId', () => {
  test('accepts real ids, rejects path traversal', () => {
    expect(isSafeSessionId('ms3g6a8p-71542ce1')).toBe(true);
    expect(isSafeSessionId('abc_DEF-123')).toBe(true);
    expect(isSafeSessionId('../etc/passwd')).toBe(false);
    expect(isSafeSessionId('a/b')).toBe(false);
    expect(isSafeSessionId('a.b')).toBe(false);
    expect(isSafeSessionId('')).toBe(false);
    expect(isSafeSessionId(42)).toBe(false);
  });
});

describe('parsePin', () => {
  test('parses a message and a note', () => {
    expect(parsePin(msg({ blockId: 'b1' }))?.kind).toBe('message');
    expect(parsePin(note({ text: 'hi' }))?.kind).toBe('note');
  });
  test('malformed degrades to null', () => {
    expect(parsePin(null)).toBeNull();
    expect(parsePin({ id: 'x', kind: 'note' })).toBeNull(); // no at
    expect(parsePin({ id: 'x', at: 1, kind: 'note', text: '   ' })).toBeNull(); // blank note
    expect(parsePin({ id: 'x', at: 1, kind: 'message', blockId: 'b' })).toBeNull(); // no blockKind
  });
  test('over-cap note is refused on read', () => {
    expect(parsePin({ id: 'x', at: 1, kind: 'note', text: 'z'.repeat(MAX_NOTE_LEN + 1) })).toBeNull();
  });
  test('unknown by defaults to human — never invents an agent attribution', () => {
    const p = parsePin({ id: 'x', at: 1, kind: 'note', text: 'hi', by: 'nonsense' });
    expect(p?.by).toBe('human');
  });
  test('carries agent provenance through', () => {
    const p = parsePin({
      id: 'x',
      at: 1,
      kind: 'note',
      text: 'hi',
      by: 'agent',
      createdBy: 'sid',
      createdByName: 'zoe',
    });
    expect(p).toMatchObject({ by: 'agent', createdBy: 'sid', createdByName: 'zoe' });
  });
});

describe('parsePinFile', () => {
  test('wrong version is discarded', () => {
    expect(parsePinFile(JSON.stringify({ v: 999, pins: [note()] }))).toEqual([]);
  });
  test('dedupes ids and message blocks', () => {
    const a = note({ id: 'dup' });
    const b = note({ id: 'dup', text: 'other' });
    const m1 = msg({ blockId: 'same' });
    const m2 = msg({ blockId: 'same' });
    const parsed = parsePinFile(JSON.stringify({ v: PIN_SCHEMA_VERSION, pins: [a, b, m1, m2] }));
    expect(parsed).toHaveLength(2);
  });
  test('garbage → empty', () => {
    expect(parsePinFile('not json')).toEqual([]);
    expect(parsePinFile(null)).toEqual([]);
  });
});

describe('applyCaps', () => {
  test('total cap keeps the newest', () => {
    const many = Array.from({ length: MAX_PINS_PER_SESSION + 5 }, (_, i) => note({ id: `n${i}`, at: i }));
    expect(applyCaps(many)).toHaveLength(MAX_PINS_PER_SESSION);
  });
  test('agent sub-cap drops oldest agent pins but never human pins', () => {
    const humans = Array.from({ length: 8 }, (_, i) => note({ id: `h${i}`, by: 'human' }));
    const agents = Array.from({ length: MAX_AGENT_PINS_PER_SESSION + 4 }, (_, i) =>
      note({ id: `a${i}`, by: 'agent', createdBy: 'sid' }),
    );
    // newest-first: agents in front, humans behind
    const capped = applyCaps([...agents, ...humans]);
    expect(capped.filter(p => p.by === 'agent')).toHaveLength(MAX_AGENT_PINS_PER_SESSION);
    expect(capped.filter(p => p.by === 'human')).toHaveLength(8); // all humans survive
  });
});

test('toPreview single-lines and truncates', () => {
  expect(toPreview('  a\n  b  ')).toBe('a b');
  expect(toPreview('x'.repeat(500)).endsWith('…')).toBe(true);
});

describe('validateNoteText', () => {
  test('blank refused, over-cap refused with length, ok passes through', () => {
    expect(() => validateNoteText('   ')).toThrow(PinError);
    expect(() => validateNoteText('z'.repeat(MAX_NOTE_LEN + 1))).toThrow(/not truncated/);
    expect(validateNoteText('  keep spaces inside ')).toBe('  keep spaces inside ');
  });
});

describe('PinStore', () => {
  test('read is empty when absent', async () => {
    const store = new PinStore(paths, { role: 'daemon' });
    expect(await store.read(SID)).toEqual([]);
  });
  test('reader role refuses writes', async () => {
    const store = new PinStore(paths, { role: 'reader' });
    await expect(store.mutate(SID, () => [note()])).rejects.toThrow(/daemon-owned/);
  });
  test('daemon mutate writes, reads back, and caps', async () => {
    const store = new PinStore(paths, { role: 'daemon' });
    const snap = await store.mutate(SID, () => [note({ text: 'first' })]);
    expect(snap.pins).toHaveLength(1);
    expect(await store.read(SID)).toHaveLength(1);
    // file exists and is versioned
    const onDisk = JSON.parse(await readFile(pinFile(paths, SID), 'utf8'));
    expect(onDisk.v).toBe(PIN_SCHEMA_VERSION);
    expect(onDisk.sessionId).toBe(SID);
  });
  test('path-unsafe session id is refused', async () => {
    const store = new PinStore(paths, { role: 'daemon' });
    await expect(store.mutate('../evil', () => [note()])).rejects.toThrow(PinError);
  });
  test('serialize whitelists fields — a forged extra field cannot persist', async () => {
    const store = new PinStore(paths, { role: 'daemon' });
    await store.mutate(SID, () => [{ ...note(), rogue: 'x' } as unknown as Pin]);
    const onDisk = JSON.parse(await readFile(pinFile(paths, SID), 'utf8'));
    expect(onDisk.pins[0].rogue).toBeUndefined();
  });
  test('concurrent mutates serialise without losing writes', async () => {
    const store = new PinStore(paths, { role: 'daemon' });
    await Promise.all([
      store.mutate(SID, cur => [note({ id: 'x' }), ...cur]),
      store.mutate(SID, cur => [note({ id: 'y' }), ...cur]),
    ]);
    const ids = (await store.read(SID)).map(p => p.id).sort();
    expect(ids).toEqual(['x', 'y']);
  });
});

test('serializeSnapshot round-trips', () => {
  const snap = { v: PIN_SCHEMA_VERSION, sessionId: SID, pins: [note(), msg()], updatedAt: 'now' };
  expect(serializeSnapshot(snap).pins).toHaveLength(2);
  expect(dedupePins(snap.pins)).toHaveLength(2);
});
