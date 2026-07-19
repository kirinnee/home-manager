import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './session-manager';
import type { SessionView } from './service';

// Fixture-level tests over prototype instances: the real SessionManager wires a
// daemon, tmux, and event store — these tests exercise the control-path logic
// (F4 auto-revive, F5 queued-send delivery) with the collaborators mocked.

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;

function bareManager(): Loose {
  return Object.create(SessionManager.prototype) as Loose;
}

describe('withAutoRevive (F4)', () => {
  const view = { config: { tmuxSession: 'kteam-x-agent' } } as SessionView;

  test('dead pane after a failed control action triggers exactly one revive and emits control.autorevive', async () => {
    const manager = bareManager();
    const events: string[] = [];
    let revives = 0;
    manager.get = async () => view;
    manager.tmux = { state: async () => ({ alive: false, dead: true, promptReady: false }) };
    manager.emit = async (_id: string, type: string) => {
      events.push(type);
    };
    manager.resume = async () => {
      revives++;
      return view;
    };
    const result = await (
      manager as unknown as {
        withAutoRevive: (id: string, action: string, op: () => Promise<SessionView>) => Promise<SessionView>;
      }
    ).withAutoRevive('x', 'interrupt', async () => {
      throw new Error('harness exited');
    });
    expect(result).toBe(view);
    expect(revives).toBe(1);
    expect(events).toEqual(['control.autorevive']);
  });

  test('live pane after a failed control action rethrows without reviving', async () => {
    const manager = bareManager();
    let revives = 0;
    manager.get = async () => view;
    manager.tmux = { state: async () => ({ alive: true, dead: false, promptReady: true }) };
    manager.emit = async () => undefined;
    manager.resume = async () => {
      revives++;
      return view;
    };
    await expect(
      (
        manager as unknown as {
          withAutoRevive: (id: string, action: string, op: () => Promise<SessionView>) => Promise<SessionView>;
        }
      ).withAutoRevive('x', 'answer', async () => {
        throw new Error('question not visible');
      }),
    ).rejects.toThrow('question not visible');
    expect(revives).toBe(0);
  });
});

describe('deliverPendingSends (F5)', () => {
  async function sessionDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kteam-f5-'));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, 'channel'), { recursive: true });
    return directory;
  }

  function managerWith(sends: Array<{ message: string; attachmentIds?: string[] }>): Loose {
    const manager = bareManager();
    manager.emit = async () => undefined;
    manager.send = async (_id: string, request: { message: string; attachmentIds?: string[] }) => {
      sends.push(request);
      return {} as SessionView;
    };
    return manager;
  }

  test('queued messages deliver exactly once, combined, and are marked delivered', async () => {
    const directory = await sessionDirectory();
    const pending = path.join(directory, 'channel', 'pending-sends.jsonl');
    await writeFile(
      pending,
      `${JSON.stringify({ id: '1', at: 't', message: 'first steer' })}\n${JSON.stringify({ id: '2', at: 't', message: 'second steer', attachmentIds: ['a1'] })}\n`,
    );
    const sends: Array<{ message: string; attachmentIds?: string[] }> = [];
    const manager = managerWith(sends);
    const call = manager as unknown as { deliverPendingSends: (id: string, dir: string) => Promise<boolean> };

    expect(await call.deliverPendingSends('x', directory)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toBe('first steer\n\n---\n\nsecond steer');
    expect(sends[0]!.attachmentIds).toEqual(['a1']);
    expect(await readFile(pending, 'utf8')).toBe('');
    const delivered = await readFile(path.join(directory, 'channel', 'delivered-sends.jsonl'), 'utf8');
    expect(delivered.trim().split('\n')).toHaveLength(2);

    // Second sweep: nothing left — at-most-once.
    expect(await call.deliverPendingSends('x', directory)).toBe(false);
    expect(sends).toHaveLength(1);
  });

  test('no queue file means no delivery', async () => {
    const directory = await sessionDirectory();
    const sends: Array<{ message: string }> = [];
    const manager = managerWith(sends);
    const call = manager as unknown as { deliverPendingSends: (id: string, dir: string) => Promise<boolean> };
    expect(await call.deliverPendingSends('x', directory)).toBe(false);
    expect(sends).toEqual([]);
  });
});
