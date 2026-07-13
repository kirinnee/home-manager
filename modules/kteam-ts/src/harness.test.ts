import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCodexSession } from './harness';
import type { SessionConfig } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Codex rollout discovery', () => {
  test('correlates concurrent same-cwd rollouts with the unique kteam directory', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-codex-discovery-'));
    temporaryDirectories.push(home);
    const sessions = path.join(home, 'sessions', '2026', '07', '11');
    await mkdir(sessions, { recursive: true });
    const cwd = path.join(home, 'repo');
    const wantedId = '11111111-1111-4111-8111-111111111111';
    const otherId = '22222222-2222-4222-8222-222222222222';
    const directory = path.join(home, 'session-a');
    const wanted = path.join(sessions, `rollout-a-${wantedId}.jsonl`);
    const other = path.join(sessions, `rollout-b-${otherId}.jsonl`);
    const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
    await writeFile(
      wanted,
      `${meta(wantedId)}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Read ${directory}/turns/turn-001.md` }],
        },
      })}\n`,
    );
    await Bun.sleep(5);
    await writeFile(other, `${meta(otherId)}\n`);

    const config: SessionConfig = {
      id: 'session-a',
      name: 'test',
      binary: 'codex-auto-test',
      harness: 'codex',
      modelHint: 'test',
      mode: 'auto',
      cwd,
      createdAt: '',
      updatedAt: '',
      turn: 1,
      harnessSessionId: '',
      harnessHome: home,
      harnessSessionBaseline: [],
      tmuxSession: 'agent',
      watcherSession: 'watch',
      intervalSeconds: 5,
      stallSeconds: 900,
      timeoutSeconds: 7200,
      maxSnapshots: 20,
      systemPromptFile: path.join(directory, 'system.md'),
      originalPromptFile: path.join(directory, 'prompt.md'),
    };

    expect(await discoverCodexSession(config)).toEqual({ id: wantedId, file: wanted });
    expect(await discoverCodexSession(config, [wantedId])).toBeUndefined();
  });

  test('matches rollout cwd metadata across a filesystem symlink', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-codex-symlink-'));
    temporaryDirectories.push(home);
    const realCwd = path.join(home, 'real-repo');
    const linkedCwd = path.join(home, 'linked-repo');
    const sessions = path.join(home, 'sessions');
    await Promise.all([mkdir(realCwd), mkdir(sessions)]);
    await symlink(realCwd, linkedCwd);
    const id = '33333333-3333-4333-8333-333333333333';
    const directory = path.join(home, 'session-b');
    const file = path.join(sessions, `rollout-${id}.jsonl`);
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id, cwd: realCwd } }),
        JSON.stringify({ type: 'response_item', payload: { text: `${directory}/turns/turn-001.md` } }),
      ].join('\n'),
    );
    const config: SessionConfig = {
      id: 'session-b',
      name: 'test',
      binary: 'codex-auto-test',
      harness: 'codex',
      modelHint: 'test',
      mode: 'auto',
      cwd: linkedCwd,
      createdAt: '',
      updatedAt: '',
      turn: 1,
      harnessSessionId: '',
      harnessHome: home,
      harnessSessionBaseline: [],
      tmuxSession: 'agent',
      watcherSession: 'watch',
      intervalSeconds: 5,
      stallSeconds: 900,
      timeoutSeconds: 7200,
      maxSnapshots: 20,
      systemPromptFile: path.join(directory, 'system.md'),
      originalPromptFile: path.join(directory, 'prompt.md'),
    };
    expect(await discoverCodexSession(config)).toEqual({ id, file });
  });
});
