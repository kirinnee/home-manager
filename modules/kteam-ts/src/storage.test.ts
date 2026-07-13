import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
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
