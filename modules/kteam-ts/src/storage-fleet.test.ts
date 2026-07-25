import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventStore } from './storage';

// The cross-session feed used to be ordered by a fleet-wide counter the daemon
// handed out under one global lock (an atomic file write per event — 2.8
// events/sec across the whole daemon). The counter is gone. Per-session
// `sequence` is authoritative, and the fleet view is merged by
// (time, session_id, sequence) at read time. These tests pin that:
// per-session replay is exact, the fleet feed is complete and tie-safe, and no
// session's throughput depends on any other session.

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-fleet-replay-test-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

/** Append `count` events with EXPLICIT timestamps so ordering is deterministic
 *  (a real fleet gets these from the clock; a test must not race it). */
async function appendAt(store: EventStore, sessionId: string, times: string[]): Promise<void> {
  for (const [index, time] of times.entries()) {
    await store.append(sessionId, 'test.event', { payload: { index } }, { time });
  }
}

const at = (second: number) => `2026-07-25T00:00:${String(second).padStart(2, '0')}.000Z`;

describe('per-session ordering is authoritative', () => {
  test('each session numbers its own events from 1, independently', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(store, 'session-a', [at(1), at(3), at(5)]);
    await appendAt(store, 'session-b', [at(2), at(4)]);

    expect(store.replay('session-a').map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(store.replay('session-b').map(event => event.sequence)).toEqual([1, 2]);
    store.close();
  });

  test('replay pages by the session’s own sequence, gaplessly', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(
      store,
      'session-a',
      Array.from({ length: 10 }, (_, index) => at(index)),
    );

    const first = store.replay('session-a', { afterSequence: 0, limit: 4 });
    expect(first.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    const second = store.replay('session-a', { afterSequence: 4, limit: 4 });
    expect(second.map(event => event.sequence)).toEqual([5, 6, 7, 8]);
    store.close();
  });

  test('tailSession returns the newest window oldest-first', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(
      store,
      'session-a',
      Array.from({ length: 6 }, (_, index) => at(index)),
    );
    expect(store.tailSession('session-a', 3).map(event => event.sequence)).toEqual([4, 5, 6]);
    store.close();
  });
});

describe('fleet feed merged by time', () => {
  test('interleaved sessions come back in timestamp order', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(store, 'session-a', [at(1), at(3), at(5)]);
    await appendAt(store, 'session-b', [at(2), at(4), at(6)]);

    const page = store.replayFleet(undefined, 10);
    expect(page.events.map(event => `${event.sessionId}#${event.sequence}`)).toEqual([
      'session-a#1',
      'session-b#1',
      'session-a#2',
      'session-b#2',
      'session-a#3',
      'session-b#3',
    ]);
    store.close();
  });

  test('paging with the cursor never drops or repeats an event', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(store, 'session-a', [at(1), at(3), at(5), at(7)]);
    await appendAt(store, 'session-b', [at(2), at(4), at(6), at(8)]);

    const seen: string[] = [];
    let cursor = undefined as ReturnType<typeof store.latestFleetCursor>;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = store.replayFleet(cursor, 3);
      if (page.rows === 0) break;
      cursor = page.cursor;
      seen.push(...page.events.map(event => `${event.sessionId}#${event.sequence}`));
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    store.close();
  });

  test('events sharing a timestamp are tie-broken, not dropped, across a page boundary', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    // Four events on the SAME instant across two sessions — the exact case a
    // time-only cursor would lose.
    await appendAt(store, 'session-a', [at(1), at(1)]);
    await appendAt(store, 'session-b', [at(1), at(1)]);

    const first = store.replayFleet(undefined, 2);
    const second = store.replayFleet(first.cursor, 2);
    const third = store.replayFleet(second.cursor, 2);
    const all = [...first.events, ...second.events].map(event => `${event.sessionId}#${event.sequence}`);
    expect(all).toEqual(['session-a#1', 'session-a#2', 'session-b#1', 'session-b#2']);
    expect(third.rows).toBe(0);
    store.close();
  });

  test('tailFleet returns the newest events across sessions, oldest-first', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(store, 'session-a', [at(1), at(5)]);
    await appendAt(store, 'session-b', [at(2), at(6)]);

    expect(store.tailFleet(3).map(event => `${event.sessionId}#${event.sequence}`)).toEqual([
      'session-b#1',
      'session-a#2',
      'session-b#2',
    ]);
    store.close();
  });

  test('a rewritten journal is re-indexed once and the feed keeps serving', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await appendAt(store, 'session-a', [at(1), at(2)]);
    await appendAt(store, 'session-b', [at(3)]);

    // Rewrite session-a's journal with DIFFERENT byte offsets, invalidating
    // every pointer row the index holds for it.
    const journal = path.join(home, 'session-a', 'events.jsonl');
    const rewritten = [
      JSON.stringify({
        schemaVersion: 1,
        sequence: 1,
        sessionId: 'session-a',
        time: at(1),
        type: 'test.event',
        data: { payload: { index: 0 }, padding: 'x'.repeat(200) },
      }),
      JSON.stringify({
        schemaVersion: 1,
        sequence: 2,
        sessionId: 'session-a',
        time: at(2),
        type: 'test.event',
        data: { payload: { index: 1 } },
      }),
    ].join('\n');
    await writeFile(journal, `${rewritten}\n`);

    const page = store.replayFleet(undefined, 10);
    expect(page.events.map(event => `${event.sessionId}#${event.sequence}`)).toEqual([
      'session-a#1',
      'session-a#2',
      'session-b#1',
    ]);
    store.close();
  });
});

describe('session metadata cache', () => {
  test('listSessions reflects writes without re-reading the database', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await store.writeConfig('session-a', { id: 'session-a', createdAt: at(1), updatedAt: at(1) });
    await store.writeState('session-a', { id: 'session-a', status: 'running' });
    await store.writeConfig('session-b', { id: 'session-b', createdAt: at(2), updatedAt: at(2) });
    await store.writeState('session-b', { id: 'session-b', status: 'completed' });

    // Newest activity first.
    expect(store.listSessions().map(item => item.id)).toEqual(['session-b', 'session-a']);
    expect(store.getSession('session-a')?.status).toBe('running');

    await store.updateState<{ status: string }>('session-a', current => ({ ...current, status: 'completed' }));
    expect(store.getSession('session-a')?.status).toBe('completed');
    store.close();
  });

  test('a removed session leaves neither an index row nor a cache entry', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    await store.writeConfig('session-a', { id: 'session-a' });
    await store.writeState('session-a', { id: 'session-a', status: 'completed' });
    expect(store.getSession('session-a')).toBeDefined();

    store.forgetSession('session-a');
    expect(store.getSession('session-a')).toBeUndefined();
    expect(store.listSessions().map(item => item.id)).toEqual([]);
    store.close();
  });

  test('a reopened store rebuilds the cache from the index', async () => {
    const home = await temporaryHome();
    const first = await EventStore.open({ home });
    await first.writeConfig('session-a', { id: 'session-a', createdAt: at(1) });
    await first.writeState('session-a', { id: 'session-a', status: 'stopped' });
    await appendAt(first, 'session-a', [at(2)]);
    first.close();

    const second = await EventStore.open({ home });
    expect(second.getSession('session-a')?.status).toBe('stopped');
    expect(second.getSession('session-a')?.lastSequence).toBe(1);
    second.close();
  });
});

describe('append is cheap and correct on the warm path', () => {
  test('many appends keep a single monotonic sequence and a well-formed journal', async () => {
    const home = await temporaryHome();
    const store = await EventStore.open({ home });
    for (let index = 0; index < 200; index += 1) {
      await store.append('session-a', 'test.event', { payload: { index } });
    }
    const events = store.replay('session-a', { afterSequence: 0, limit: 500 });
    expect(events).toHaveLength(200);
    expect(events.map(event => event.sequence)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    // The cached journal tail must agree with the file, or the next append
    // would write at a wrong offset and every pointer after it would be stale.
    expect(store.getSession('session-a')?.lastSequence).toBe(200);
    store.close();
  });
});
