import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseClaudeTranscriptLine } from './claude-transcript';
import { chatEventFingerprint, EventStore } from './storage';

// kteam used to store ~14 MB of derived copies (events.jsonl + chat.jsonl) of a
// 9.6 MB harness transcript it already had on disk. Chat records are now
// INDEXED where the harness wrote them and transformed on READ. These tests pin
// the resolution contract and, above all, the degradation contract: the harness
// owns those files and may compact, rotate or delete them.

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-chat-pointer-test-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

const assistantRecord = (text: string, id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid: id,
    parentUuid: null,
    sessionId: 'e8b1f0a2-1111-4222-8333-444455556666',
    timestamp: '2026-07-25T00:00:00.000Z',
    message: { id, role: 'assistant', stop_reason: null, content: [{ type: 'text', text }] },
  });

/** Write a harness-shaped JSONL file and return each line's byte extent. */
async function writeTranscript(
  file: string,
  lines: string[],
): Promise<Array<{ offset: number; length: number; line: string }>> {
  const extents: Array<{ offset: number; length: number; line: string }> = [];
  let offset = 0;
  for (const line of lines) {
    const length = Buffer.byteLength(line, 'utf8');
    extents.push({ offset, length, line });
    offset += length + 1;
  }
  await writeFile(file, `${lines.join('\n')}\n`);
  return extents;
}

const normalize = (line: string) => parseClaudeTranscriptLine(line) as unknown[];
const fingerprint = (line: string, recordIndex = 0) => chatEventFingerprint(normalize(line)[recordIndex]);

describe('chat pointers into the harness transcript', () => {
  test('resolve back into the same normalized records the watcher produced', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const extents = await writeTranscript(file, [assistantRecord('first', 'm1'), assistantRecord('second', 'm2')]);

    store.appendChatPointers(
      'session-a',
      extents.map((extent, index) => ({
        time: '2026-07-25T00:00:00.000Z',
        type: 'chat.assistant.text',
        turn: 1,
        sourceFile: file,
        byteOffset: extent.offset,
        byteLength: extent.length,
        recordIndex: 0,
        fingerprint: fingerprint(extent.line),
      })),
    );

    expect(store.chatPointerCount('session-a')).toBe(2);
    const rows = store.chatPointers('session-a', 0, 10);
    const { records, skipped } = store.resolveChatPointers(rows, normalize);
    expect(skipped).toBe(0);
    expect(records.map(record => (record as { data: { text: string } }).data.text)).toEqual(['first', 'second']);
    store.close();
  });

  test('kteam writes NO bytes of its own for an indexed chat record', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const extents = await writeTranscript(file, [assistantRecord('only', 'm1')]);
    store.appendChatPointers('session-a', [
      {
        time: '2026-07-25T00:00:00.000Z',
        type: 'chat.assistant.text',
        turn: 1,
        sourceFile: file,
        byteOffset: extents[0]!.offset,
        byteLength: extents[0]!.length,
        recordIndex: 0,
        fingerprint: fingerprint(extents[0]!.line),
      },
    ]);
    // The session's own journal stays empty: nothing was copied into it.
    expect(store.replay('session-a')).toEqual([]);
    store.close();
  });

  test('ordinals are per-session and monotonic across batches', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const extents = await writeTranscript(file, [assistantRecord('a', 'm1'), assistantRecord('b', 'm2')]);
    const entry = (index: number) => ({
      time: '2026-07-25T00:00:00.000Z',
      type: 'chat.assistant.text',
      turn: 1,
      sourceFile: file,
      byteOffset: extents[index]!.offset,
      byteLength: extents[index]!.length,
      recordIndex: 0,
      fingerprint: fingerprint(extents[index]!.line),
    });
    store.appendChatPointers('session-a', [entry(0)]);
    store.appendChatPointers('session-a', [entry(1)]);
    store.appendChatPointers('session-b', [entry(0)]);

    expect(store.chatPointers('session-a', 0, 10).map(row => row.ordinal)).toEqual([1, 2]);
    expect(store.chatPointers('session-b', 0, 10).map(row => row.ordinal)).toEqual([1]);
    store.close();
  });

  test('a replayed watcher batch is identity-deduped instead of duplicating history', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const extents = await writeTranscript(file, [assistantRecord('once', 'm1'), assistantRecord('next', 'm2')]);
    const entry = (index: number) => ({
      time: '2026-07-25T00:00:00.000Z',
      type: 'chat.assistant.text',
      turn: 1,
      sourceFile: file,
      byteOffset: extents[index]!.offset,
      byteLength: extents[index]!.length,
      recordIndex: 0,
      fingerprint: fingerprint(extents[index]!.line),
    });
    store.appendChatPointers('session-a', [entry(0)]);
    store.appendChatPointers('session-a', [entry(0)]);
    store.appendChatPointers('session-a', [entry(1)]);

    expect(store.chatPointerCount('session-a')).toBe(2);
    expect(store.chatPointers('session-a', 0, 10).map(row => row.ordinal)).toEqual([1, 2]);
    store.close();
  });

  test('one record with several content blocks is indexed by record_index', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const multi = JSON.stringify({
      type: 'assistant',
      uuid: 'm1',
      parentUuid: null,
      sessionId: 'e8b1f0a2-1111-4222-8333-444455556666',
      timestamp: '2026-07-25T00:00:00.000Z',
      message: {
        id: 'm1',
        role: 'assistant',
        stop_reason: null,
        content: [
          { type: 'text', text: 'block one' },
          { type: 'text', text: 'block two' },
        ],
      },
    });
    const extents = await writeTranscript(file, [multi]);
    store.appendChatPointers(
      'session-a',
      [0, 1].map(recordIndex => ({
        time: '2026-07-25T00:00:00.000Z',
        type: 'chat.assistant.text',
        turn: 1,
        sourceFile: file,
        byteOffset: extents[0]!.offset,
        byteLength: extents[0]!.length,
        recordIndex,
        fingerprint: fingerprint(extents[0]!.line, recordIndex),
      })),
    );
    const { records } = store.resolveChatPointers(store.chatPointers('session-a', 0, 10), normalize);
    expect(records.map(record => (record as { data: { text: string } }).data.text)).toEqual(['block one', 'block two']);
    store.close();
  });

  test('v4 migrates in place and makes an unchanged source stale exactly once', async () => {
    const home = await temporaryHome();
    const file = path.join(home, 'harness.jsonl');
    const extent = (await writeTranscript(file, [assistantRecord('first', 'm1')]))[0]!;
    const sourceInfo = await stat(file);
    let store = await EventStore.open({ home });
    store.appendChatPointers('session-versioned', [
      {
        time: '2026-07-25T00:00:00.000Z',
        type: 'chat.assistant.text',
        turn: 1,
        sourceFile: file,
        byteOffset: extent.offset,
        byteLength: extent.length,
        recordIndex: 0,
        fingerprint: fingerprint(extent.line),
      },
    ]);
    store.markChatSource('session-versioned', file, sourceInfo);
    expect(store.chatSourceCurrent('session-versioned', file, sourceInfo)).toBe(true);
    store.close();

    const database = new Database(path.join(home, 'daemon', 'kteam.sqlite'));
    database.exec('ALTER TABLE chat_sources DROP COLUMN normalizer_version');
    database.exec('PRAGMA user_version = 4');
    database.close();

    store = await EventStore.open({ home });
    expect(store.chatPointerCount('session-versioned')).toBe(1);
    expect(store.chatSourceCurrent('session-versioned', file, sourceInfo)).toBe(false);
    store.markChatSource('session-versioned', file, sourceInfo);
    expect(store.chatSourceCurrent('session-versioned', file, sourceInfo)).toBe(true);
    store.close();
  });
});

describe('degradation when the harness rewrites its own file', () => {
  async function indexed(): Promise<{ store: EventStore; file: string }> {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const extents = await writeTranscript(file, [assistantRecord('first', 'm1'), assistantRecord('second', 'm2')]);
    store.appendChatPointers(
      'session-a',
      extents.map(extent => ({
        time: '2026-07-25T00:00:00.000Z',
        type: 'chat.assistant.text',
        turn: 1,
        sourceFile: file,
        byteOffset: extent.offset,
        byteLength: extent.length,
        recordIndex: 0,
        fingerprint: fingerprint(extent.line),
      })),
    );
    return { store, file };
  }

  test('a deleted transcript degrades to empty, and SAYS how much it lost', async () => {
    const { store, file } = await indexed();
    await rm(file, { force: true });
    const { records, skipped } = store.resolveChatPointers(store.chatPointers('session-a', 0, 10), normalize);
    expect(records).toEqual([]);
    expect(skipped).toBe(2);
    store.close();
  });

  test('a truncated transcript serves what survives and skips the rest', async () => {
    const { store, file } = await indexed();
    await writeFile(file, `${assistantRecord('first', 'm1')}\n`);
    const { records, skipped } = store.resolveChatPointers(store.chatPointers('session-a', 0, 10), normalize);
    expect(records.map(record => (record as { data: { text: string } }).data.text)).toEqual(['first']);
    expect(skipped).toBe(1);
    store.close();
  });

  test('a COMPACTED file with a different-but-valid record at the offset is refused, not served', async () => {
    const { store, file } = await indexed();
    // Same byte extents, entirely different content — the silent-corruption
    // case. The identity check must reject rather than serve someone else's
    // message as this session's history.
    const decoy = JSON.stringify({
      type: 'user',
      uuid: 'x1',
      parentUuid: null,
      sessionId: 'e8b1f0a2-1111-4222-8333-444455556666',
      timestamp: '2026-07-25T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'unrelated' }] },
    });
    await writeFile(file, `${decoy}\n${decoy}\n`);
    const { records, skipped } = store.resolveChatPointers(store.chatPointers('session-a', 0, 10), normalize);
    // The recorded type was chat.assistant.text; these normalize to chat.user.
    expect(records).toEqual([]);
    expect(skipped).toBe(2);
    store.close();
  });

  test('compaction to a different event of the SAME type and byte length is still refused', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const original = assistantRecord('first', 'm1');
    const extent = (await writeTranscript(file, [original]))[0]!;
    store.appendChatPointers('session-a', [
      {
        time: '2026-07-25T00:00:00.000Z',
        type: 'chat.assistant.text',
        turn: 1,
        sourceFile: file,
        byteOffset: extent.offset,
        byteLength: extent.length,
        recordIndex: 0,
        fingerprint: fingerprint(original),
      },
    ]);
    const sameShape = assistantRecord('other', 'z1');
    expect(Buffer.byteLength(sameShape)).toBe(Buffer.byteLength(original));
    await writeFile(file, `${sameShape}\n`);

    const { records, skipped } = store.resolveChatPointers(store.chatPointers('session-a', 0, 10), normalize);
    expect(records).toEqual([]);
    expect(skipped).toBe(1);
    store.close();
  });

  test('forgetChatPointers clears the index so a re-scan can rebuild it', async () => {
    const { store } = await indexed();
    store.forgetChatPointers('session-a');
    expect(store.chatPointerCount('session-a')).toBe(0);
    store.close();
  });

  test('removing a session drops its chat pointers too', async () => {
    const { store } = await indexed();
    store.forgetSession('session-a');
    expect(store.chatPointerCount('session-a')).toBe(0);
    store.close();
  });
});
