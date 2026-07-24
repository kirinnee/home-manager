import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventStore } from './storage';

// The fleet-wide event feed used to be answered by loading EVERY session's
// journal into memory, mapping it, and sorting it before returning ≤ limit
// events (2026-07-23: one UI connect wedged the daemon for minutes and grew
// its heap into the gigabytes). These tests pin the index-bounded replacement:
// the window comes out of SQLite, only the selected records are read, and the
// migration that made it possible heals an older index in place.

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-global-replay-test-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

/** Append `count` events to `sessionId`, stamping the shared fleet counter. */
async function appendFleetEvents(
  store: EventStore,
  sessionId: string,
  count: number,
  counter: { value: number },
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    counter.value += 1;
    await store.append(sessionId, 'test.event', { globalSequence: counter.value, payload: { index } });
  }
}

const globalOf = (event: { data: unknown }) => (event.data as { globalSequence: number }).globalSequence;

/** replayGlobal returns a PAGE (events + row count); these tests assert events. */
const replayed = (store: EventStore, after: number, limit: number, sessionId?: string) =>
  store.replayGlobal(after, limit, sessionId).events;

describe('bounded cross-session replay', () => {
  test('interleaved sessions come back in global order, capped at the limit', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const counter = { value: 0 };
    // Interleave so per-session sequence and global sequence disagree.
    for (let round = 0; round < 5; round += 1) {
      await appendFleetEvents(store, 'session-a', 1, counter);
      await appendFleetEvents(store, 'session-b', 2, counter);
    }

    const first = replayed(store, 0, 4);
    expect(first.map(globalOf)).toEqual([1, 2, 3, 4]);
    expect(first.map(event => event.sessionId)).toEqual(['session-a', 'session-b', 'session-b', 'session-a']);

    const next = replayed(store, 4, 4);
    expect(next.map(globalOf)).toEqual([5, 6, 7, 8]);
    // Paging never revisits: the cursor is the global sequence itself.
    expect(replayed(store, 15, 100)).toEqual([]);
    expect(store.latestGlobalSequence()).toBe(15);
    store.close();
  });

  test('tailGlobal returns the newest window oldest-first, per fleet and per session', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const counter = { value: 0 };
    await appendFleetEvents(store, 'session-a', 3, counter);
    await appendFleetEvents(store, 'session-b', 3, counter);

    expect(store.tailGlobal(2).map(globalOf)).toEqual([5, 6]);
    expect(store.tailGlobal(2, 'session-a').map(globalOf)).toEqual([2, 3]);
    // A tail larger than the journal is simply the whole journal.
    expect(store.tailGlobal(50).map(globalOf)).toEqual([1, 2, 3, 4, 5, 6]);
    store.close();
  });

  test('a rewritten journal is re-indexed instead of wedging the feed', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const counter = { value: 0 };
    await appendFleetEvents(store, 'session-a', 2, counter);
    await appendFleetEvents(store, 'session-b', 2, counter);

    // Rewrite session-a's journal so every recorded byte offset is wrong.
    const journal = path.join(home, 'session-a', 'events.jsonl');
    const rewritten = [1, 2]
      .map(sequence =>
        JSON.stringify({
          schemaVersion: 1,
          sequence,
          sessionId: 'session-a',
          time: '2026-07-23T00:00:00.000Z',
          type: 'test.event',
          data: { globalSequence: sequence, payload: { index: sequence - 1 }, padding: 'x'.repeat(64) },
        }),
      )
      .join('\n');
    await writeFile(journal, `${rewritten}\n`);

    const events = replayed(store, 0, 10);
    expect(events.map(event => event.sessionId)).toEqual(['session-a', 'session-a', 'session-b', 'session-b']);
    expect(events.map(globalOf)).toEqual([1, 2, 3, 4]);
    store.close();
  });

  test('an unreadable journal degrades to skipped rows, never a thrown feed', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const counter = { value: 0 };
    await appendFleetEvents(store, 'session-a', 2, counter);
    await appendFleetEvents(store, 'session-b', 2, counter);
    await rm(path.join(home, 'session-a', 'events.jsonl'), { force: true });

    expect(replayed(store, 0, 10).map(event => event.sessionId)).toEqual(['session-b', 'session-b']);
    store.close();
  });
});

describe('global-sequence index migration', () => {
  /** Build a pre-migration (v2) index: same tables, no global_sequence column. */
  async function legacyIndex(home: string, databasePath: string): Promise<void> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const session = 'session-legacy';
    const directory = path.join(home, session);
    await mkdir(directory, { recursive: true });
    const lines = [1, 2, 3].map(sequence =>
      JSON.stringify({
        schemaVersion: 1,
        sequence,
        sessionId: session,
        time: '2026-07-22T00:00:00.000Z',
        type: 'test.event',
        data: { globalSequence: 100 + sequence, payload: {} },
      }),
    );
    const journal = path.join(directory, 'events.jsonl');
    await writeFile(journal, `${lines.join('\n')}\n`);

    const database = new Database(databasePath, { create: true });
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, directory TEXT NOT NULL, status TEXT, created_at TEXT, updated_at TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0, config_json TEXT, state_json TEXT,
        journal_size INTEGER, journal_mtime_ms INTEGER, indexed_at TEXT NOT NULL
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL, sequence INTEGER NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL,
        byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 2;
    `);
    database
      .query('INSERT INTO sessions (id, directory, last_sequence, indexed_at) VALUES (?, ?, ?, ?)')
      .run(session, directory, 3, '2026-07-22T00:00:00.000Z');
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      database
        .query(
          'INSERT INTO events (session_id, sequence, time, type, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(session, index + 1, '2026-07-22T00:00:00.000Z', 'test.event', offset, Buffer.byteLength(line, 'utf8'));
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    database.close();
  }

  test('opening an older index adds the column and backfills without a rebuild demand', async () => {
    const home = await temporaryHome();
    const databasePath = path.join(home, 'daemon', 'kteam.sqlite');
    await legacyIndex(home, databasePath);

    // The daemon opens WITHOUT importing (bind first, index after listen).
    const store = await EventStore.open({ home, databasePath, importExisting: false });
    expect(store.sessionNeedsGlobalBackfill('session-legacy')).toBe(true);
    // Pre-backfill the rows are invisible to the fleet feed — that is exactly
    // why the migration is a bootstrap phase and not a lazy hope.
    expect(replayed(store, 0, 10)).toEqual([]);

    expect(store.nextSessionNeedingGlobalBackfill()).toBe('session-legacy');
    await store.backfillGlobalSequence('session-legacy');

    expect(store.sessionNeedsGlobalBackfill('session-legacy')).toBe(false);
    expect(store.nextSessionNeedingGlobalBackfill()).toBeUndefined();
    expect(replayed(store, 0, 10).map(globalOf)).toEqual([101, 102, 103]);
    // Per-session replay never depended on the column and still works.
    expect(store.replay('session-legacy', { afterSequence: 0 })).toHaveLength(3);
    store.close();
  });

  test('backfill terminates even when the journal no longer holds the indexed events', async () => {
    const home = await temporaryHome();
    const databasePath = path.join(home, 'daemon', 'kteam.sqlite');
    await legacyIndex(home, databasePath);
    await rm(path.join(home, 'session-legacy', 'events.jsonl'), { force: true });

    const store = await EventStore.open({ home, databasePath, importExisting: false });
    await store.backfillGlobalSequence('session-legacy');
    expect(store.nextSessionNeedingGlobalBackfill()).toBeUndefined();
    store.close();
  });
});

describe('paging over a damaged journal', () => {
  test('a page reports the ROWS it covered, so a skipped row is not read as end-of-backlog', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    const counter = { value: 0 };
    await appendFleetEvents(store, 'session-a', 4, counter);
    // Truncate the journal: the later rows' pointers now read past EOF.
    await writeFile(path.join(home, 'session-a', 'events.jsonl'), '');

    const page = store.replayGlobal(0, 4);
    expect(page.events).toEqual([]); // nothing resolved…
    expect(page.rows).toBe(4); // …but four index rows were covered
    expect(page.cursor).toBe(4); // and the cursor advanced past them
    store.close();
  });
});
