import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventStore, readJsonFile, writeJsonAtomic } from './storage';

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-storage-test-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe('atomic JSON documents', () => {
  test('replace config and state documents without leaving temporary files', async () => {
    const home = await temporaryHome();
    const file = path.join(home, 'session-a', 'state.json');
    await writeJsonAtomic(file, { status: 'starting' });
    await writeJsonAtomic(file, { status: 'running', turn: 1 });

    expect(await readJsonFile<{ status: string; turn: number }>(file)).toEqual({ status: 'running', turn: 1 });
    expect((await readdir(path.dirname(file))).filter(name => name.includes('.tmp.'))).toEqual([]);
  });

  test('serializes concurrent read-modify-write state updates', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await store.writeState('session-a', { id: 'session-a', count: 0, status: 'running' });
    await Promise.all(
      Array.from({ length: 25 }, () =>
        store.updateState<{
          id: string;
          count: number;
          status: string;
        }>('session-a', current => ({ ...current, count: current.count + 1 })),
      ),
    );
    expect(await store.readState<{ count: number }>('session-a')).toMatchObject({ count: 25 });
    store.close();
  });
});

describe('event journal', () => {
  test('serializes concurrent appends into a monotonic, durable JSONL journal', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await store.writeConfig('session-a', {
      id: 'session-a',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    });
    await store.writeState('session-a', { id: 'session-a', status: 'running' });

    const appended = await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.append('session-a', 'test.event', { index })),
    );
    expect(appended.map(event => event.sequence)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));

    const lines = (await readFile(path.join(home, 'session-a', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as { sequence: number; data: { index: number } });
    expect(lines.map(event => event.sequence)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(lines.map(event => event.data.index)).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(store.replay('session-a', { afterSequence: 35 }).map(event => event.sequence)).toEqual([36, 37, 38, 39, 40]);
    expect(store.getSession('session-a')).toMatchObject({ status: 'running', lastSequence: 40 });
    store.close();
  });

  test('keeps different session queues independent', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => store.append('alpha', 'alpha.event', { index })),
      ...Array.from({ length: 8 }, (_, index) => store.append('beta', 'beta.event', { index })),
    ]);
    expect(store.replay('alpha').map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.replay('beta').map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    store.close();
  });
});

describe('filesystem import and SQLite rebuild', () => {
  test('rebuilds session metadata and replay from files after deleting SQLite', async () => {
    const home = await temporaryHome();
    let store = await EventStore.open({ home });
    await store.writeConfig('recover-me', {
      id: 'recover-me',
      createdAt: '2026-07-11T01:00:00.000Z',
      updatedAt: '2026-07-11T02:00:00.000Z',
      binary: 'claude-auto-mm3',
    });
    await store.writeState('recover-me', { id: 'recover-me', status: 'waiting' });
    await store.append('recover-me', 'session.created', { mode: 'interactive' });
    await store.append('recover-me', 'interaction.question', { question: 'Which framework?' });
    store.close();

    await rm(path.join(home, 'daemon'), { recursive: true, force: true });
    store = await EventStore.open({ home, rebuild: true });

    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession('recover-me')).toMatchObject({
      id: 'recover-me',
      status: 'waiting',
      createdAt: '2026-07-11T01:00:00.000Z',
      updatedAt: '2026-07-11T02:00:00.000Z',
      lastSequence: 2,
    });
    expect(store.replay('recover-me', { afterSequence: 1 })).toMatchObject([
      { sequence: 2, type: 'interaction.question' },
    ]);
    store.close();
  });

  test('imports hand-created session directories and reports malformed journal records', async () => {
    const home = await temporaryHome();
    const directory = path.join(home, 'imported');
    await writeJsonAtomic(path.join(directory, 'config.json'), {
      id: 'imported',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:05:00.000Z',
    });
    await writeJsonAtomic(path.join(directory, 'state.json'), { id: 'imported', status: 'stopped' });
    const first = {
      schemaVersion: 1,
      sequence: 1,
      sessionId: 'imported',
      time: '2026-07-11T00:01:00.000Z',
      type: 'session.started',
      data: {},
    };
    const second = {
      schemaVersion: 1,
      sequence: 2,
      sessionId: 'imported',
      time: '2026-07-11T00:02:00.000Z',
      type: 'session.stopped',
      data: { reason: 'requested' },
    };
    await writeFile(
      path.join(directory, 'events.jsonl'),
      `${JSON.stringify(first)}\ncrash-truncated-json\n${JSON.stringify(second)}\n`,
    );

    const store = await EventStore.open({ home, importExisting: false });
    const imported = await store.importFromDisk();
    expect(imported).toMatchObject({ sessionCount: 1, eventCount: 2 });
    expect(imported.problems).toHaveLength(1);
    expect(store.replay('imported').map(event => event.sequence)).toEqual([1, 2]);

    const next = await store.append('imported', 'session.resumed', {});
    expect(next.sequence).toBe(3);
    expect(store.replay('imported').map(event => event.sequence)).toEqual([1, 2, 3]);
    store.close();
  });
});

describe('pointer index (A2)', () => {
  test('sqlite stores byte offsets, never event payloads', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const payload = { marker: 'payload-must-not-live-in-sqlite', blob: 'x'.repeat(5_000) };
    await store.append('session-a', 'tool.result', payload);
    expect(store.replay('session-a')).toMatchObject([{ sequence: 1, type: 'tool.result', data: payload }]);
    store.close();

    const raw = await readFile(path.join(home, 'daemon', 'kteam.sqlite'));
    expect(raw.includes('payload-must-not-live-in-sqlite')).toBe(false);
    const db = new Database(path.join(home, 'daemon', 'kteam.sqlite'), { readonly: true });
    const row = db.query("SELECT byte_offset, byte_length FROM events WHERE session_id = 'session-a'").get() as {
      byte_offset: number;
      byte_length: number;
    };
    db.close();
    const journal = await readFile(path.join(home, 'session-a', 'events.jsonl'), 'utf8');
    const line = journal.slice(row.byte_offset, row.byte_offset + row.byte_length);
    expect(JSON.parse(line)).toMatchObject({ sequence: 1, data: payload });
  });

  test('warm reopen skips unchanged journals (incremental import)', async () => {
    const home = await temporaryHome();
    let store = await EventStore.open({ home });
    await store.append('session-a', 'session.created', { n: 1 });
    await store.append('session-a', 'chat.message', { n: 2 });
    await store.append('session-b', 'session.created', { n: 1 });
    store.close();

    // Reopen with untouched journals: import must scan zero events.
    store = await EventStore.open({ home, importExisting: false });
    const warm = await store.importFromDisk();
    expect(warm).toMatchObject({ sessionCount: 2, eventCount: 0 });
    expect(store.replay('session-a').map(event => event.sequence)).toEqual([1, 2]);

    // Externally-appended tail: only the delta is scanned.
    const journal = path.join(home, 'session-a', 'events.jsonl');
    const extra = {
      schemaVersion: 1,
      sequence: 3,
      sessionId: 'session-a',
      time: '2026-07-22T00:00:00.000Z',
      type: 'chat.message',
      data: { n: 3 },
    };
    await writeFile(journal, `${await readFile(journal, 'utf8')}${JSON.stringify(extra)}\n`);
    const delta = await store.importFromDisk();
    expect(delta).toMatchObject({ eventCount: 1 });
    expect(store.replay('session-a').map(event => event.sequence)).toEqual([1, 2, 3]);
    store.close();
  });

  test('refuses a database from another schema generation (fresh-slate ship: no auto-migration)', async () => {
    const home = await temporaryHome();
    const databasePath = path.join(home, 'daemon', 'kteam.sqlite');
    await mkdir(path.dirname(databasePath), { recursive: true });
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, time TEXT NOT NULL,
        type TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (session_id, sequence));
    `);
    legacy.close();
    expect(EventStore.open({ home })).rejects.toThrow(/schema generation 0, expected 2.*delete the old database/s);
  });

  test('replay detects a rewritten journal (valid-but-different events) and re-indexes instead of serving them', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await store.append('session-a', 'chat.message', { n: 1 });
    await store.append('session-a', 'chat.message', { n: 2 });
    // Rewrite the journal IN PLACE while the store serves: same shape, valid
    // JSON, but different events at the recorded offsets (compaction shifted
    // everything). No reopen, no importFromDisk — replay itself must notice.
    const journal = path.join(home, 'session-a', 'events.jsonl');
    const rewritten = [
      {
        schemaVersion: 1,
        sequence: 1,
        sessionId: 'session-a',
        time: '2026-07-22T00:00:00.000Z',
        type: 'chat.message',
        data: { rewritten: 'one' },
      },
      {
        schemaVersion: 1,
        sequence: 2,
        sessionId: 'session-a',
        time: '2026-07-22T00:00:01.000Z',
        type: 'chat.message',
        data: { rewritten: 'two-with-a-much-longer-payload' },
      },
    ];
    await writeFile(journal, rewritten.map(event => JSON.stringify(event)).join('\n') + '\n');
    const replayed = store.replay('session-a');
    expect(replayed).toMatchObject([
      { sequence: 1, data: { rewritten: 'one' } },
      { sequence: 2, data: { rewritten: 'two-with-a-much-longer-payload' } },
    ]);
    // And appends continue cleanly after the self-heal.
    const next = await store.append('session-a', 'chat.message', { n: 3 });
    expect(next.sequence).toBe(3);
    store.close();
  });

  test('replay degrades to empty when the journal file is gone (archived session)', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await store.writeConfig('session-a', { id: 'session-a', createdAt: '2026-07-22T00:00:00.000Z' });
    await store.append('session-a', 'session.created', {});
    await rm(path.join(home, 'session-a', 'events.jsonl'), { force: true });
    expect(store.replay('session-a')).toEqual([]);
    // Metadata stays browsable even without the journal.
    expect(store.getSession('session-a')).toMatchObject({ id: 'session-a' });
    store.close();
  });

  test('appends after a truncated (no trailing newline) journal still index correctly', async () => {
    const home = await temporaryHome();
    let store = await EventStore.open({ home });
    await store.append('session-a', 'session.created', { n: 1 });
    store.close();
    const journal = path.join(home, 'session-a', 'events.jsonl');
    const raw = await readFile(journal, 'utf8');
    await writeFile(journal, raw.trimEnd()); // simulate torn trailing newline
    store = await EventStore.open({ home });
    await store.append('session-a', 'chat.message', { n: 2 });
    expect(store.replay('session-a').map(event => [event.sequence, event.type])).toEqual([
      [1, 'session.created'],
      [2, 'chat.message'],
    ]);
    store.close();
  });

  test('a rewritten (shrunk) journal triggers a full rescan, not a stale tail', async () => {
    const home = await temporaryHome();
    let store = await EventStore.open({ home });
    await store.append('session-a', 'session.created', { n: 1 });
    await store.append('session-a', 'chat.message', { n: 2 });
    store.close();
    const journal = path.join(home, 'session-a', 'events.jsonl');
    const one = {
      schemaVersion: 1,
      sequence: 1,
      sessionId: 'session-a',
      time: '2026-07-22T00:00:00.000Z',
      type: 'session.created',
      data: { rewritten: true },
    };
    await writeFile(journal, `${JSON.stringify(one)}\n`);
    store = await EventStore.open({ home });
    expect(store.replay('session-a')).toMatchObject([{ sequence: 1, data: { rewritten: true } }]);
    expect((await stat(journal)).size).toBeGreaterThan(0);
    store.close();
  });
});
