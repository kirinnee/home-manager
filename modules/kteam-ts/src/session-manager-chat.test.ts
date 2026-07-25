import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseClaudeTranscriptLine } from './claude-transcript';
import { SessionManager } from './session-manager';
import { chatEventFingerprint, EventStore } from './storage';

// Service-layer regression for the empty-transcript bug (dixie / ms025va9):
// GET .../chat returned records:[] while reporting total>0 for EVERY window.
// The count came from the raw chat_pointers row count; the content came from
// resolving those pointers against the on-disk transcript. When the harness
// rewrites/compacts a rollout file in place, every stored byte offset shifts,
// so the identity check rejects all of them â a non-zero count over zero
// resolvable records. chatHistory must (a) self-heal by rebuilding THIS ONE
// session's pointers from the current file, and (b) refuse to serve a
// valid-looking empty page when it still cannot resolve. These pin both.

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-chat-service-test-'));
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
const fingerprint = (line: string) => chatEventFingerprint(normalize(line)[0]);
const texts = (records: unknown[]) => records.map(record => (record as { data: { text: string } }).data.text);

// A plain loose bag (as the launch test does): SessionManager's private fields
// make an intersection type collapse to `never`, so we cast to Record instead.
type Loose = Record<string, unknown>;
type ChatPage = { total: number; offset: number; records: unknown[]; degraded?: number };

/** A SessionManager with only the collaborators chatHistory touches wired up:
 *  a REAL EventStore + on-disk transcript, so pointer resolution, the rebuild
 *  path, and the lazy indexer all run for real. `get`/`resolveRef` are stubbed
 *  because a full daemon (tmux, git monitors) is irrelevant to this contract. */
function bareManager(store: EventStore, view: { config: Record<string, unknown> }): Loose {
  const manager = Object.create(SessionManager.prototype) as Loose;
  manager.store = store;
  manager.chatIndexChecks = new Map();
  manager.resolveRef = (id: string) => id;
  manager.get = async () => view;
  return manager;
}

const chatHistory = (manager: Loose, id: string): Promise<ChatPage> =>
  (manager.chatHistory as (id: string) => Promise<ChatPage>)(id);

const pointer = (extent: { offset: number; length: number; line: string }) => ({
  time: '2026-07-25T00:00:00.000Z',
  type: 'chat.assistant.text',
  turn: 1,
  sourceFile: '',
  byteOffset: extent.offset,
  byteLength: extent.length,
  recordIndex: 0,
  fingerprint: fingerprint(extent.line),
});

describe('chatHistory service layer', () => {
  test('lazily indexes and serves a healthy transcript', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    await writeTranscript(file, [assistantRecord('alpha', 'm1'), assistantRecord('beta', 'm2')]);
    const manager = bareManager(store, {
      config: { id: 'session-ok', harness: 'claude', turn: 1, transcriptFile: file },
    });

    const page = await chatHistory(manager, 'session-ok');

    expect(page.total).toBe(2);
    expect(texts(page.records)).toEqual(['alpha', 'beta']);
    store.close();
  });

  test('self-heals stale byte offsets after the harness rewrites the file in place', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'harness.jsonl');
    const id = 'session-heal';

    // Pointers were indexed against the ORIGINAL layout.
    const original = await writeTranscript(file, [assistantRecord('alpha', 'm1'), assistantRecord('beta', 'm2')]);
    store.appendChatPointers(
      id,
      original.map(extent => ({ ...pointer(extent), sourceFile: file })),
    );

    // The harness compacts/rewrites the rollout in place: the SAME records now
    // live at DIFFERENT offsets (a leading record shifted everything). Every
    // stored offset is now wrong.
    await writeTranscript(file, [
      assistantRecord('decoy', 'd0'),
      assistantRecord('alpha', 'm1'),
      assistantRecord('beta', 'm2'),
    ]);
    // Stale source bookkeeping wrongly reports the index as current â the real
    // trigger, which makes ensureChatIndex skip the rescan so the served window
    // is built entirely from the now-stale rows.
    store.markChatSource(id, file, await stat(file));

    // The exact bug state: the count is non-zero but nothing resolves.
    expect(store.chatPointerCount(id)).toBe(2);
    expect(store.resolveChatPointers(store.chatPointers(id, 0, 10), normalize).records).toEqual([]);

    const manager = bareManager(store, { config: { id, harness: 'claude', turn: 1, transcriptFile: file } });
    const page = await chatHistory(manager, id);

    // Rebuilt from the current file: real records, no silent empty page.
    expect(page.records.length).toBeGreaterThan(0);
    expect(texts(page.records)).toEqual(['decoy', 'alpha', 'beta']);
    store.close();
  });

  test('THROWS instead of serving a silent empty page when the index cannot be rebuilt', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const file = path.join(home, 'gone.jsonl');
    const id = 'session-broken';

    const extents = await writeTranscript(file, [assistantRecord('alpha', 'm1')]);
    store.appendChatPointers(id, [{ ...pointer(extents[0]!), sourceFile: file }]);
    // The harness deleted its transcript, and this session has no transcriptFile
    // recorded to rebuild from â pointers exist, none resolve, nothing to rescan.
    await rm(file, { force: true });

    const manager = bareManager(store, { config: { id, harness: 'claude', turn: 1, transcriptFile: undefined } });

    expect(store.chatPointerCount(id)).toBe(1);
    await expect(chatHistory(manager, id)).rejects.toThrow(/silent empty transcript/i);
    store.close();
  });
});
