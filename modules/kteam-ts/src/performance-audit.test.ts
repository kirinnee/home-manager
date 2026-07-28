import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultDaemonConfig } from './daemon-config';
import { compactFleetSession } from './api-server';
import { parseClaudeTranscriptLine } from './claude-transcript';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';
import { chatEventFingerprint, EventStore } from './storage';
import type { KTeamEvent } from './types';

const homes: string[] = [];
async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-performance-audit-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function managerOptions() {
  const config = defaultDaemonConfig();
  return {
    healthIntervalSeconds: config.healthIntervalSeconds,
    quotaUrl: config.quotaUrl,
    transcriptReconcileSeconds: config.transcriptReconcileSeconds,
    publicUrl: config.publicUrl,
    projectRoots: config.projectRoots,
    remoteControl: config.remoteControl,
    warden: config.warden,
    scratch: { ...config.scratch, enabled: false },
  };
}

describe('measured cold/warm boot regressions', () => {
  test('fleet responses omit the private O(fleet²) Codex discovery baseline', () => {
    const view = {
      config: { id: 'session-a', harnessSessionBaseline: ['old-a', 'old-b'] },
      state: { status: 'completed' },
      directory: '/tmp/session-a',
    } as unknown as Parameters<typeof compactFleetSession>[0];
    expect(compactFleetSession(view).config.harnessSessionBaseline).toBeUndefined();
    expect(view.config.harnessSessionBaseline).toEqual(['old-a', 'old-b']);
  });

  test('aligned monitor ticks share one git fingerprint per checkout', async () => {
    const home = await temporaryHome();
    const manager = await SessionManager.create(createPaths(home), managerOptions());
    const internals = manager as unknown as {
      gitFingerprint: (cwd: string) => Promise<string>;
      computeGitFingerprint: (cwd: string) => Promise<string>;
      close: () => Promise<void>;
    };
    let calls = 0;
    internals.computeGitFingerprint = async () => {
      calls += 1;
      await Bun.sleep(10);
      return 'same';
    };
    expect(await Promise.all(Array.from({ length: 20 }, () => internals.gitFingerprint(home)))).toEqual(
      Array(20).fill('same'),
    );
    expect(calls).toBe(1);
    await internals.close();
  });

  test('terminal frames stay live and bounded without entering the durable journal', async () => {
    const home = await temporaryHome();
    const manager = await SessionManager.create(createPaths(home), managerOptions());
    const internals = manager as unknown as {
      emit: (id: string, type: string, payload: unknown, source: 'watcher') => Promise<unknown>;
      liveFrames: Map<string, unknown[]>;
      store: EventStore;
      close: () => Promise<void>;
    };
    let delivered = 0;
    const unsubscribe = manager.subscribe(event => {
      if (event.type === 'terminal.frame') delivered += 1;
    });
    for (let frame = 0; frame < 75; frame += 1) {
      await internals.emit('session-a', 'terminal.frame', { frame }, 'watcher');
    }
    expect(delivered).toBe(75);
    expect(internals.liveFrames.get('session-a')).toHaveLength(50);
    expect(internals.store.replay('session-a')).toEqual([]);
    unsubscribe();
    await internals.close();
  });

  // A live chat frame carries sequence 0 (it is not in the journal), so its
  // TIMESTAMP and its harness record identity are the only things a consumer can
  // dedupe on. Stamping it with the broadcast instant made every live frame a
  // record history would later re-deliver under a different time — the UI then
  // showed the tail twice on reconnect, and could not tell live from replayed.
  test('live chat frames carry the harness record time and identity, not the broadcast instant', async () => {
    const home = await temporaryHome();
    const manager = await SessionManager.create(createPaths(home), managerOptions());
    const internals = manager as unknown as {
      broadcastChat: (
        id: string,
        event: { type: string; data: unknown; timestamp?: string; recordUuid?: string; blockIndex?: number },
        turn: number,
        source: 'claude' | 'codex',
      ) => void;
      store: EventStore;
      close: () => Promise<void>;
    };
    const seen: KTeamEvent[] = [];
    const unsubscribe = manager.subscribe(event => seen.push(event));
    internals.broadcastChat(
      'session-a',
      {
        type: 'chat.assistant.text',
        data: { text: 'hello' },
        timestamp: '2026-07-25T02:13:45.543Z',
        recordUuid: '65d2fd61-d985-4fd5-8302-dd63a3d05140',
        blockIndex: 1,
      },
      3,
      'claude',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sequence: 0,
      time: '2026-07-25T02:13:45.543Z',
      type: 'chat.assistant.text',
      turn: 3,
      recordUuid: '65d2fd61-d985-4fd5-8302-dd63a3d05140',
      blockIndex: 1,
    });
    // Still never journalled — this class lives in the harness transcript.
    expect(internals.store.replay('session-a')).toEqual([]);

    // A record with no identity of its own still broadcasts (older transcripts).
    internals.broadcastChat('session-a', { type: 'tool.use', data: { toolUseId: 't1' } }, 1, 'claude');
    expect(seen[1]).toMatchObject({ sequence: 0, type: 'tool.use' });
    expect(seen[1]!.recordUuid).toBeUndefined();
    unsubscribe();
    await internals.close();
  });

  test('the additive v3 → current migration preserves the existing event index', async () => {
    const home = await temporaryHome();
    let store = await EventStore.open({ home, importExisting: false });
    await store.writeConfig('session-a', { id: 'session-a', createdAt: '2026-07-25T00:00:00.000Z' });
    await store.writeState('session-a', { status: 'completed' });
    await store.append('session-a', 'session.completed', { payload: 'kept' });
    store.close();

    const databaseFile = path.join(home, 'daemon', 'kteam.sqlite');
    const old = new Database(databaseFile);
    old.exec('DROP TABLE chat_sources; DROP TABLE chat_pointers; PRAGMA user_version = 3');
    old.close();

    store = await EventStore.open({ home, importExisting: false });
    expect(store.replay('session-a').map(event => event.type)).toEqual(['session.completed']);
    const migrated = new Database(databaseFile, { readonly: true });
    expect(migrated.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(5);
    expect(
      migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'chat_pointers'").get()?.name,
    ).toBe('chat_pointers');
    migrated.close();
    store.close();
  });

  test('health stays degraded until import, recovery, and warden arming finish', async () => {
    const home = await temporaryHome();
    const manager = await SessionManager.create(createPaths(home), managerOptions());
    expect(await manager.health()).toMatchObject({ ok: false, bootstrapping: true });
    await manager.bootstrap();
    expect(await manager.health()).toMatchObject({ ok: true, bootstrapping: false, wardenTimerArmed: true });
    await manager.close();
  });

  test('recovery skips absent terminal panes but freshly probes every active session', async () => {
    const home = await temporaryHome();
    const manager = await SessionManager.create(createPaths(home), managerOptions());
    const internals = manager as unknown as {
      list: () => Promise<unknown[]>;
      tmux: { listSessions: () => Promise<Set<string>> };
      recoverSession: (session: unknown) => Promise<void>;
      recover: () => Promise<void>;
      close: () => Promise<void>;
    };
    const session = (id: string, status: string, tmuxSession: string) => ({
      config: { id, tmuxSession },
      state: { status },
      directory: path.join(home, id),
    });
    const absentTerminal = session('terminal-absent', 'completed', 'tmux-a');
    const presentTerminal = session('terminal-present', 'failed', 'tmux-b');
    const active = session('active-race-safe', 'running', 'tmux-c');
    const probed: string[] = [];
    internals.list = async () => [absentTerminal, presentTerminal, active];
    internals.tmux = { listSessions: async () => new Set(['tmux-b']) };
    internals.recoverSession = async candidate => {
      probed.push((candidate as typeof active).config.id);
    };

    await internals.recover();
    expect(probed).toEqual(['terminal-present', 'active-race-safe']);
    await internals.close();
  });

  test('a lost disposable chat index is rebuilt lazily from the harness transcript', async () => {
    const home = await temporaryHome();
    const transcript = path.join(home, 'harness.jsonl');
    const record = (id: string, text: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid: id,
        parentUuid: null,
        sessionId: 'e8b1f0a2-1111-4222-8333-444455556666',
        timestamp: '2026-07-25T00:00:00.000Z',
        message: { id, role: 'assistant', stop_reason: null, content: [{ type: 'text', text }] },
      });
    const first = record('m1', 'first');
    const second = record('m2', 'restored');
    await writeFile(transcript, `${first}\n${second}\n`);

    let manager = await SessionManager.create(createPaths(home), managerOptions());
    let store = (manager as unknown as { store: EventStore }).store;
    await store.writeConfig('session-a', {
      id: 'session-a',
      harness: 'claude',
      transcriptFile: transcript,
      turn: 1,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    });
    await store.writeState('session-a', { status: 'completed', turn: 1 });
    // Simulate the rollout boundary: the live watcher indexed a NEW tail event
    // before anybody requested history. The full lazy pass must replace that
    // unverified partial order, not append the old prefix after the tail.
    const normalizedSecond = parseClaudeTranscriptLine(second)[0]!;
    store.appendChatPointers('session-a', [
      {
        time: '2026-07-25T00:00:00.000Z',
        type: normalizedSecond.type,
        turn: 1,
        sourceFile: transcript,
        byteOffset: Buffer.byteLength(first) + 1,
        byteLength: Buffer.byteLength(second),
        recordIndex: 0,
        fingerprint: chatEventFingerprint(normalizedSecond),
      },
    ]);
    const firstRead = await manager.chatHistory('session-a');
    expect(firstRead.records.map(value => (value as { data: { text: string } }).data.text)).toEqual([
      'first',
      'restored',
    ]);
    store.forgetChatPointers('session-a');
    await manager.close();

    // A new daemon has no in-memory "already checked" latch. Even though the
    // SQLite pointer table is empty and chat.jsonl never held a copy, history
    // comes back from the authoritative harness bytes.
    manager = await SessionManager.create(createPaths(home), managerOptions());
    store = (manager as unknown as { store: EventStore }).store;
    const rebuilt = await manager.chatHistory('session-a');
    expect(rebuilt.total).toBe(2);
    expect((rebuilt.records[1] as { data: { text: string } }).data.text).toBe('restored');
    expect(store.chatPointerCount('session-a')).toBe(2);
    await manager.close();
  });
});
