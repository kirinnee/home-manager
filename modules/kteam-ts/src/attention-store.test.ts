import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, sessionDir, type KTeamPaths } from './paths';
import {
  AttentionStore,
  isSafeAttentionSessionId,
  attentionFile,
  parseAttentionFile,
  parseAttentionItem,
  serializeAttentionFile,
} from './attention-store';
import {
  MAX_ATTENTION_PER_SESSION,
  ATTENTION_SCHEMA_VERSION,
  AttentionError,
  type AttentionId,
  type AttentionItem,
  type ResolvedAttentionItem,
} from './attention-types';

let home: string;
let paths: KTeamPaths;
const SID = 'ms3g6a8p-71542ce1';

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: over.id ?? 'A1',
  source: over.source ?? 'agent-raised',
  sourceRef: over.sourceRef ?? null,
  ...(over.sourceSeq === undefined ? {} : { sourceSeq: over.sourceSeq }),
  subject: over.subject ?? 'Choose a deployment window',
  why: over.why ?? 'The release cannot proceed without it.',
  waitingSince: over.waitingSince ?? '2026-07-28T00:00:00.000Z',
  howToResolve: over.howToResolve ?? 'Reply with a deployment window.',
  raisedBy: over.raisedBy ?? 'human',
  raisedBySession: over.raisedBySession ?? null,
  raisedByName: over.raisedByName ?? null,
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-attention-store-'));
  paths = createPaths(home);
  await mkdir(sessionDir(paths, SID), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('path and item parsing', () => {
  test('accepts real ids and rejects traversal', () => {
    expect(isSafeAttentionSessionId(SID)).toBe(true);
    expect(isSafeAttentionSessionId('../evil')).toBe(false);
    expect(isSafeAttentionSessionId('a/b')).toBe(false);
    expect(isSafeAttentionSessionId('a.b')).toBe(false);
  });

  test('optional context round-trips, tolerates absence and rejects a non-string', () => {
    expect(parseAttentionItem(item())?.context).toBeUndefined();
    const withContext = { ...item(), context: 'Background for a reader new to this session.' };
    expect(parseAttentionItem(withContext)?.context).toBe('Background for a reader new to this session.');
    // Stored null is legacy-equivalent to absent.
    expect(parseAttentionItem({ ...item(), context: null })?.context).toBeUndefined();
    expect(parseAttentionItem({ ...item(), context: 42 })).toBeNull();
    expect(parseAttentionItem({ ...item(), context: 'x'.repeat(2_049) })).toBeNull();
  });

  test('parses every required field and rejects malformed provenance', () => {
    expect(parseAttentionItem(item())?.subject).toContain('deployment');
    expect(parseAttentionItem({ ...item(), subject: '' })).toBeNull();
    expect(parseAttentionItem({ ...item(), waitingSince: 'not-a-date' })).toBeNull();
    expect(parseAttentionItem({ ...item(), raisedBy: 'agent', raisedBySession: null })).toBeNull();
    expect(parseAttentionItem(item({ sourceSeq: 7 }))?.sourceSeq).toBe(7);
    for (const sourceSeq of [0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseAttentionItem({ ...item(), sourceSeq })).toBeNull();
    }
  });
});

describe('parseAttentionFile', () => {
  test('sorts active items oldest first regardless of disk order', () => {
    const parsed = parseAttentionFile(
      JSON.stringify({
        v: ATTENTION_SCHEMA_VERSION,
        sessionId: SID,
        nextId: 3,
        items: [
          item({ id: 'A2', waitingSince: '2026-07-28T02:00:00.000Z' }),
          item({ id: 'A1', waitingSince: '2026-07-28T01:00:00.000Z' }),
        ],
        resolved: [],
        count: 2,
        updatedAt: '2026-07-28T03:00:00.000Z',
      }),
      SID,
    );
    expect(parsed.file.items.map(entry => entry.id)).toEqual(['A1', 'A2']);
  });

  test('surfaces a malformed entry/count and makes whole-file failures fatal', () => {
    const partial = parseAttentionFile(
      JSON.stringify({
        v: 1,
        sessionId: SID,
        nextId: 2,
        items: [item({ id: 'A1' }), { id: 'bad' }],
        resolved: [],
        count: 99,
        updatedAt: '2026-07-28T03:00:00.000Z',
      }),
      SID,
    );
    expect(partial.file.items.map(entry => entry.id)).toEqual(['A1']);
    expect(partial.parseErrors).toBe(2);
    expect(partial.fatal).toBe(false);
    expect(parseAttentionFile('not-json', SID).fatal).toBe(true);
    expect(parseAttentionFile(JSON.stringify({ v: 999 }), SID).fatal).toBe(true);
  });

  test('rejects an allocator that could reuse an existing id', () => {
    const parsed = parseAttentionFile(
      JSON.stringify({
        v: 1,
        sessionId: SID,
        nextId: 1,
        items: [item({ id: 'A1' })],
        resolved: [],
        count: 1,
        updatedAt: '2026-07-28T03:00:00.000Z',
      }),
      SID,
    );
    expect(parsed.parseErrorIds).toContain('<nextId>');
  });

  test('keeps legacy watermarks readable until explicit compaction and never rematerialises them', async () => {
    const resolved: ResolvedAttentionItem = {
      ...item({ source: 'agent-raised', sourceRef: 'task-reopened:F31' }),
      resolvedAt: '2026-07-28T04:00:00.000Z',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: 'Reviewed.',
    };
    const parsed = parseAttentionFile(
      JSON.stringify({
        v: 1,
        sessionId: SID,
        nextId: 2,
        items: [],
        resolved: [resolved],
        reopenResolvedAt: { F31: '2026-07-28T04:00:00.000Z' },
        count: 0,
        updatedAt: '2026-07-28T04:00:00.000Z',
      }),
      SID,
    );
    expect(parsed.parseErrors).toBe(0);
    expect(parsed.file.reopenResolvedAt).toEqual({ F31: '2026-07-28T04:00:00.000Z' });

    const withoutMap = parseAttentionFile(
      JSON.stringify(serializeAttentionFile({ ...parsed.file, reopenResolvedAt: undefined })),
      SID,
    );
    expect(withoutMap.parseErrors).toBe(0);
    expect(withoutMap.file.reopenResolvedAt).toBeUndefined();

    await writeFile(attentionFile(paths, SID), JSON.stringify(serializeAttentionFile(parsed.file)));
    const store = new AttentionStore(paths, { role: 'daemon' });
    expect((await store.compactLegacyReopenWatermarks(SID)).changed).toBe(true);
    const compacted = JSON.parse(await readFile(attentionFile(paths, SID), 'utf8'));
    expect(compacted.reopenResolvedAt).toBeUndefined();
    expect((await store.snapshot(SID)).reopenResolvedAt).toBeUndefined();
    expect((await store.compactLegacyReopenWatermarks(SID)).changed).toBe(false);
  });
});

describe('AttentionStore', () => {
  test('reader role refuses writes', async () => {
    const store = new AttentionStore(paths);
    await expect(store.mutate(SID, current => current)).rejects.toThrow(/daemon-owned/);
  });

  test('serialises concurrent mutations without losing either item', async () => {
    const store = new AttentionStore(paths, { role: 'daemon' });
    await Promise.all([
      store.mutate(SID, current => {
        const id = `A${current.nextId}` as AttentionId;
        return { ...current, nextId: current.nextId + 1, items: [...current.items, item({ id })] };
      }),
      store.mutate(SID, current => {
        const id = `A${current.nextId}` as AttentionId;
        return { ...current, nextId: current.nextId + 1, items: [...current.items, item({ id })] };
      }),
    ]);
    expect((await store.snapshot(SID)).items.map(entry => entry.id)).toEqual(['A1', 'A2']);
    expect(await store.count(SID)).toBe(2);
  });

  test('persists a top-level count and whitelists fields', async () => {
    const store = new AttentionStore(paths, { role: 'daemon' });
    await store.mutate(SID, current => ({
      ...current,
      nextId: 2,
      items: [...current.items, { ...item({ id: 'A1', sourceSeq: 9 }), rogue: 'no' } as AttentionItem],
    }));
    const raw = JSON.parse(await readFile(attentionFile(paths, SID), 'utf8'));
    expect(raw.count).toBe(1);
    expect(raw.items[0].rogue).toBeUndefined();
    expect(raw.items[0].sourceSeq).toBe(9);
  });

  test('never evicts active items at capacity', async () => {
    const store = new AttentionStore(paths, { role: 'daemon' });
    const full = Array.from({ length: MAX_ATTENTION_PER_SESSION }, (_, index) =>
      item({ id: `A${index + 1}` as AttentionId }),
    );
    await store.mutate(SID, current => ({ ...current, nextId: MAX_ATTENTION_PER_SESSION + 1, items: full }));
    await expect(
      store.mutate(SID, current => ({
        ...current,
        nextId: current.nextId + 1,
        items: [...current.items, item({ id: `A${current.nextId}` as AttentionId })],
      })),
    ).rejects.toMatchObject({ code: 'full' });
    expect((await store.snapshot(SID)).items).toHaveLength(MAX_ATTENTION_PER_SESSION);
  });

  test('refuses to overwrite readable corruption instead of hiding it', async () => {
    const filename = attentionFile(paths, SID);
    await writeFile(
      filename,
      JSON.stringify({
        v: 1,
        sessionId: SID,
        nextId: 2,
        items: [item({ id: 'A1' }), { id: 'damaged' }],
        resolved: [],
        count: 2,
        updatedAt: '2026-07-28T03:00:00.000Z',
      }),
    );
    const store = new AttentionStore(paths, { role: 'daemon' });
    await expect(store.mutate(SID, current => current)).rejects.toMatchObject({ code: 'corrupt' });
    expect(await readFile(filename, 'utf8')).toContain('damaged');
  });

  test('unsafe session id is rejected', async () => {
    await expect(new AttentionStore(paths, { role: 'daemon' }).snapshot('../evil')).rejects.toThrow(AttentionError);
  });
});

test('serializeAttentionFile derives count from items', () => {
  const file = serializeAttentionFile({
    v: 1,
    sessionId: SID,
    nextId: 2,
    items: [item()],
    resolved: [],
    count: 99,
    updatedAt: '2026-07-28T00:00:00.000Z',
  });
  expect(file.count).toBe(1);
});
