import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from './paths';
import { parsePaneMetadata, startupDialogAction, TmuxController } from './tmux-controller';
import type { SessionConfig } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('tmux prompt detection', () => {
  const controller = new TmuxController(createPaths('/tmp/kteam-prompt-test'), 'http://127.0.0.1:7337');

  test('requires a current input row rather than an old prompt in scrollback', () => {
    expect(controller.promptReady('welcome\n>\n')).toBe(true);
    expect(controller.promptReady('>\nreceived task\nstill thinking\n')).toBe(false);
    expect(controller.promptReady('output\n❯\n────────\n? for shortcuts\n')).toBe(true);
    expect(controller.promptReady('output\n⠋ thinking\n')).toBe(false);
  });

  test('recognizes the real Codex placeholder prompt using the cursor row', () => {
    const pane = ['', '› Implement {feature}', '', '  gpt-5.6-sol high · Context 0% used', ''].join('\n');
    expect(controller.promptReady(pane, 1, 2)).toBe(true);
    expect(controller.promptReady(pane, 3, 2)).toBe(false);
    expect(controller.promptReady(pane, 1, 18)).toBe(false);
  });

  test('recognizes the real Claude prompt despite its rich footer', () => {
    const pane = [
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  👤 user │ 🤖 deepseek-v4-flash',
      '  📊 context remaining',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    expect(controller.promptReady(pane, 1)).toBe(true);
  });

  test('does not mistake startup or structured-choice selectors for an input prompt', () => {
    const trust = [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
      'Press enter to continue',
    ].join('\n');
    expect(controller.promptReady(trust, 1)).toBe(false);
    expect(controller.promptReady('Choose one\n❯ 1. Red\n  2. Blue\n', 1)).toBe(false);
  });

  test('does not report a placeholder editor as idle while the harness is working', () => {
    const pane = [
      '• Working (15s • esc to interrupt) · 1 background terminal running',
      '',
      '› Explain this codebase',
      '',
      '  gpt-5.6-sol high · Context 2% used',
    ].join('\n');
    expect(controller.promptReady(pane, 2, 2)).toBe(false);
  });
});

describe('startup dialog handling', () => {
  test('accepts Codex and Claude trust dialogs when yes is selected', () => {
    expect(
      startupDialogAction(
        [
          'Do you trust the contents of this directory?',
          '› 1. Yes, continue',
          '  2. No, quit',
          'Press enter to continue',
        ].join('\n'),
      ),
    ).toEqual({ kind: 'codex-trust', keys: ['Enter'] });
    expect(
      startupDialogAction(
        [
          'Quick safety check: Is this a project you created or one you trust?',
          '❯ 1. Yes, I trust this folder',
          '  2. No, exit',
        ].join('\n'),
      ),
    ).toEqual({ kind: 'claude-trust', keys: ['Enter'] });
    expect(
      startupDialogAction(['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'].join('\n')),
    ).toEqual({ kind: 'claude-trust', keys: ['Enter'] });
  });

  test('navigates from a negative selection to the known affirmative choice', () => {
    expect(startupDialogAction(['Warning', '  1. Yes, I accept', '❯ 2. No, exit'].join('\n'))).toEqual({
      kind: 'permission-bypass',
      keys: ['Up', 'Enter'],
    });
  });

  test('does not answer unknown dialogs', () => {
    expect(startupDialogAction('Proceed with deleting everything?\n› 1. Yes\n  2. No')).toBeUndefined();
  });
});

describe('tmux metadata parsing', () => {
  test('retains fields after an empty pane exit status', () => {
    expect(parsePaneMetadata('0||2|18|50|160\n')).toEqual({
      dead: false,
      exitCode: undefined,
      cursorX: 2,
      cursorY: 18,
      paneHeight: 50,
      paneWidth: 160,
    });
  });
});

describe('snapshot retention', () => {
  test('keeps last-snapshot plus only the configured number of timestamped snapshots', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-snapshot-test-'));
    temporaryDirectories.push(home);
    const paths = createPaths(home);
    const controller = new TmuxController(paths, 'http://127.0.0.1:7337');
    let frame = 0;
    controller.capture = async () => `frame ${++frame}\n`;
    const config: SessionConfig = {
      id: 'session-a',
      name: 'test',
      binary: 'claude-auto-test',
      harness: 'claude',
      modelHint: 'test',
      mode: 'auto',
      cwd: home,
      createdAt: '',
      updatedAt: '',
      turn: 1,
      harnessSessionId: '11111111-1111-4111-8111-111111111111',
      tmuxSession: 'agent',
      watcherSession: 'watch',
      intervalSeconds: 5,
      stallSeconds: 900,
      timeoutSeconds: 7200,
      maxSnapshots: 2,
      systemPromptFile: path.join(home, 'session-a', 'system.md'),
      originalPromptFile: path.join(home, 'session-a', 'prompt.md'),
    };
    await controller.snapshot(config);
    await Bun.sleep(2);
    await controller.snapshot(config);
    await Bun.sleep(2);
    await controller.snapshot(config, true);
    const files = (await readdir(path.join(home, 'session-a', 'snapshots'))).filter(name => name.endsWith('.txt'));
    expect(files).toHaveLength(2);
    expect(await Bun.file(path.join(home, 'session-a', 'last-snapshot.txt')).text()).toBe('frame 3\n');
  });
});
