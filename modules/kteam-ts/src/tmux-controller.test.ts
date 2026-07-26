import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from './paths';
import {
  composerEvidence,
  composerHolds,
  contextPercentUsed,
  paneShowsActiveWork,
  paneWorkCounters,
  parsePaneMetadata,
  resumeMenuAction,
  startupDialogAction,
  TmuxController,
  workCountersAdvanced,
} from './tmux-controller';
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

  test('recognizes the codex-auto-loge ready frame (» prompt glyph + warning banner lines)', async () => {
    // Captured live from ~/.kfleet/bin/codex-auto-loge (Codex v0.145.0): the
    // loge flavor renders its prompt with » (U+00BB) instead of ›/❯ and prints
    // two ⚠ warning lines (hook trust bypass, unadvertised service tier) above
    // the composer. The old glyph class rejected this frame forever —
    // "promptReady=false, cursor=2:18" launch failures (2026-07-22).
    const pane = await Bun.file(path.join(import.meta.dir, 'fixtures', 'codex-loge-ready.txt')).text();
    expect(controller.promptReady(pane, 18, 2)).toBe(true);
    // Fallback path (no cursor metadata): trailing blank rows and the codex
    // footer statusline must not hide the composer from the tail window.
    expect(controller.promptReady(pane)).toBe(true);
    expect(paneShowsActiveWork(pane)).toBe(false);
    // A numbered selector rendered with » must still not read as an input row.
    expect(controller.promptReady('choose\n» 1. Yes, continue\n  2. No, quit\n', 1, 2)).toBe(false);
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

  test('treats spinner/token evidence above an idle input box as busy', () => {
    const slowModel = ['✻ Lollygagging… (34s · 2.1k tokens)', '', '❯ ', '────────'].join('\n');
    expect(controller.promptReady(slowModel, 2)).toBe(false);
    const codexClipped = ['• Working (6m52s', '', '› ', ''].join('\n');
    expect(controller.promptReady(codexClipped, 2)).toBe(false);
  });
});

describe('pane active-work detection', () => {
  test('detects both harness spinner and counter styles', () => {
    expect(paneShowsActiveWork('• Working (6m52s • Esc to interrupt)')).toBe(true);
    expect(paneShowsActiveWork('• Working (12s')).toBe(true);
    expect(paneShowsActiveWork('✻ Lollygagging… (34s · 2.1k tokens)')).toBe(true);
    expect(paneShowsActiveWork('· Mustering… (5s · esc to interrupt)')).toBe(true);
    expect(paneShowsActiveWork('✳ Reticulating…')).toBe(true);
    expect(paneShowsActiveWork('1.2k tokens · thinking')).toBe(true);
  });

  test('does not fire on idle panes or plain output', () => {
    expect(paneShowsActiveWork('❯ \n────────\n? for shortcuts')).toBe(false);
    expect(paneShowsActiveWork('Done. Wrote 3 files.\n> ')).toBe(false);
    expect(paneShowsActiveWork('  gpt-5.6-sol high · Context 2% used')).toBe(false);
  });

  test('background terminal footer alone is NOT busy evidence (F3)', () => {
    const idleWithFooter = ['› ', '', '1 background terminal running', '  Context 12% used'].join('\n');
    expect(paneShowsActiveWork(idleWithFooter)).toBe(false);
    const controller = new TmuxController(createPaths('/tmp/kteam-f3-test'), 'http://127.0.0.1:7337');
    expect(controller.promptReady(idleWithFooter, 0, 2)).toBe(true);
  });

  test('codex interrupted banner counts as promptReady (F3)', () => {
    const controller = new TmuxController(createPaths('/tmp/kteam-f3-test'), 'http://127.0.0.1:7337');
    const banner = ['■ Conversation interrupted - tell the model what to do differently', '', '› ', ''].join('\n');
    expect(controller.promptReady(banner)).toBe(true);
    expect(paneShowsActiveWork(banner)).toBe(false);
  });
});

describe('pane work counters (A6 stall liveness)', () => {
  const frame = (name: string) => Bun.file(path.join(import.meta.dir, 'fixtures', name)).text();

  test('parses elapsed clock and token count from a real thinking frame pair', async () => {
    // Captured from a live Fable session WRONGLY stall-killed mid-thinking
    // (2026-07-22): the spinner clock advanced 5m45s → 5m50s while the
    // transcript stayed silent — that advance is full liveness.
    const a = paneWorkCounters(await frame('claude-thinking-frame-a.txt'));
    const b = paneWorkCounters(await frame('claude-thinking-frame-b.txt'));
    expect(a).toEqual({ elapsedSeconds: 345, tokens: 17_200 });
    expect(b).toEqual({ elapsedSeconds: 350, tokens: 17_200 });
    expect(workCountersAdvanced(a, b!)).toBe(true);
  });

  test('parses codex working counters and multi-word claude spinner lines', () => {
    expect(paneWorkCounters('• Working (6m52s • Esc to interrupt)')).toEqual({ elapsedSeconds: 412 });
    expect(paneWorkCounters('✻ Lollygagging… (34s · 2.1k tokens)')).toEqual({ elapsedSeconds: 34, tokens: 2_100 });
    expect(paneShowsActiveWork('✢ Fixing A6 stall detection… (5m 45s · ↓ 17.2k tokens)')).toBe(true);
    expect(paneWorkCounters('✽ Thinking… (23m 38s · ↓ 24.6k tokens · thinking)')).toEqual({
      elapsedSeconds: 1_418,
      tokens: 24_600,
    });
  });

  test('an idle pane yields no counters even when numbers are on screen', () => {
    expect(paneWorkCounters('❯ \n  13% (134k/1M) │ 💰 $0.13\n? for shortcuts')).toBeUndefined();
    expect(paneWorkCounters('Done. Wrote 3 files in 12s.\n> ')).toBeUndefined();
  });

  test('frozen or restarted counters earn no liveness credit', () => {
    const at = (s: number) => ({ elapsedSeconds: s, tokens: 500 });
    expect(workCountersAdvanced(at(60), at(60))).toBe(false); // wedged TUI repaint
    expect(workCountersAdvanced(at(60), at(5))).toBe(false); // new turn restart
    expect(workCountersAdvanced(undefined, at(60))).toBe(false); // first sighting
    expect(workCountersAdvanced(at(60), at(65))).toBe(true);
    expect(workCountersAdvanced({ tokens: 100 }, { tokens: 150 })).toBe(true);
  });
});

describe('safe interrupt (F1/F2)', () => {
  const paths = createPaths('/tmp/kteam-interrupt-test');
  const config = { tmuxSession: 'kteam-x-agent' } as SessionConfig;

  function controllerWith(visiblePane: string, sent: string[][]): TmuxController {
    const controller = new TmuxController(paths, 'http://127.0.0.1:7337');
    (controller as unknown as { state: () => Promise<unknown> }).state = async () => ({
      alive: true,
      dead: false,
      promptReady: !paneShowsActiveWork(visiblePane),
      pane: visiblePane,
      visiblePane,
    });
    (controller as unknown as { waitReady: () => Promise<void> }).waitReady = async () => undefined;
    // Record what actually reaches tmux, so "no keystroke" is asserted rather
    // than assumed.
    (controller as unknown as { keys: (name: string, ...keys: string[]) => Promise<unknown> }).keys = async (
      _name,
      ...keys
    ) => {
      sent.push(keys);
      return { code: 0, stdout: '', stderr: '' };
    };
    return controller;
  }

  test('idle pane: no keystroke is sent (idempotent)', async () => {
    const sent: string[][] = [];
    const controller = controllerWith('❯ \n? for shortcuts', sent);
    await controller.interrupt(config);
    expect(sent).toEqual([]);
  });

  test('interrupted banner: no keystroke is sent (second interrupt is a no-op)', async () => {
    const sent: string[][] = [];
    const controller = controllerWith('■ Conversation interrupted - tell the model what to do differently\n› ', sent);
    await controller.interrupt(config);
    expect(sent).toEqual([]);
  });

  test('busy pane: exactly one Escape', async () => {
    const sent: string[][] = [];
    const controller = controllerWith('✻ Auditing… (2m 14s · esc to interrupt)', sent);
    await controller.interrupt(config);
    expect(sent).toEqual([['Escape']]);
  });

  // The kteam UI's stop button IS the human's Escape key. On an interactive
  // claude pane it must always reach the pane: Escape at an idle claude prompt
  // clears a half-typed composer or closes a menu (harmless), and suppressing it
  // made the control feel dead whenever kteam's status lagged the pane a tick.
  // Codex keeps the strict no-op — keystrokes at its idle prompt are its quit
  // path.
  test('idle INTERACTIVE claude pane: Escape is still sent (the UI stop button)', async () => {
    const sent: string[][] = [];
    const controller = controllerWith('❯ \n? for shortcuts', sent);
    await controller.interrupt({ ...config, mode: 'interactive', harness: 'claude' } as SessionConfig);
    expect(sent).toEqual([['Escape']]);
  });

  test('idle interactive CODEX pane: still no keystroke (Escape is its quit path)', async () => {
    const sent: string[][] = [];
    const controller = controllerWith('› \n? for shortcuts', sent);
    await controller.interrupt({ ...config, mode: 'interactive', harness: 'codex' } as SessionConfig);
    expect(sent).toEqual([]);
  });

  test('the interrupt keystroke is Escape, never C-c', () => {
    const source = TmuxController.prototype.interrupt.toString();
    expect(source).toContain('Escape');
    expect(source).not.toContain('C-c');
  });
});

describe('claude resume-menu gate (turn-018, the lacey wedge)', () => {
  const fixture = () => Bun.file(path.join(import.meta.dir, 'fixtures', 'claude-resume-menu.txt')).text();

  test('detects the real captured gate and answers per the configured choice', async () => {
    const pane = await fixture();
    // Default 'full': option 2 from the ❯-selected option 1 → Down, Enter.
    expect(startupDialogAction(pane)).toEqual({ kind: 'resume-menu', keys: ['Down', 'Enter'] });
    expect(startupDialogAction(pane, { resumeMenuChoice: 'full' })).toEqual({
      kind: 'resume-menu',
      keys: ['Down', 'Enter'],
    });
    // 'summary': option 1 is already selected → just Enter.
    expect(startupDialogAction(pane, { resumeMenuChoice: 'summary' })).toEqual({
      kind: 'resume-menu',
      keys: ['Enter'],
    });
  });

  test("never selects option 3 (Don't ask me again) under any configuration", async () => {
    const pane = await fixture();
    for (const choice of ['full', 'summary'] as const) {
      const action = resumeMenuAction(pane, choice)!;
      // Max travel from option 1 is one Down (to option 2) — never two.
      expect(action.keys.filter(key => key === 'Down').length).toBeLessThanOrEqual(1);
    }
  });

  test('does not fire on frames without the gate', async () => {
    expect(resumeMenuAction('❯ \n? for shortcuts', 'full')).toBeUndefined();
    expect(resumeMenuAction('1. Resume work\n2. Stop', 'full')).toBeUndefined();
    // The loge ready frame must not read as a resume menu.
    const loge = await Bun.file(path.join(import.meta.dir, 'fixtures', 'codex-loge-ready.txt')).text();
    expect(resumeMenuAction(loge, 'full')).toBeUndefined();
  });

  test('navigates back up when the selector sits below the wanted option', () => {
    const pane = [
      'This session is 2h 45m old and 382k tokens.',
      '  1. Resume from summary (recommended)',
      '❯ 2. Resume full session as-is',
      "  3. Don't ask me again",
    ].join('\n');
    expect(resumeMenuAction(pane, 'summary')).toEqual({ kind: 'resume-menu', keys: ['Up', 'Enter'] });
    expect(resumeMenuAction(pane, 'full')).toEqual({ kind: 'resume-menu', keys: ['Enter'] });
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

  test('accepts the custom api key confirmation which defaults to No', () => {
    expect(
      startupDialogAction(
        [
          'Detected a custom API key in your environment',
          'Do you want to use this API key?',
          '  1. Yes',
          '❯ 2. No (recommended)',
        ].join('\n'),
      ),
    ).toEqual({ kind: 'api-key', keys: ['Up', 'Enter'] });
  });
});

describe('context percent parsing', () => {
  test('parses codex, claude-left, and ratio statuslines', () => {
    expect(contextPercentUsed('gpt-5.6-sol high · Context 42% used')).toBe(42);
    expect(contextPercentUsed('❯\n  30% context left')).toBe(70);
    expect(contextPercentUsed('Context left until auto-compact: 8%')).toBe(92);
    expect(contextPercentUsed('97% (194k/200k)')).toBe(97);
    // 1M-context sessions render an M suffix — the k-only pattern missed
    // these, blanking context fleet-wide right after the 1M rollout.
    expect(contextPercentUsed('📊 74% (735k/1M)')).toBe(74);
    expect(contextPercentUsed('12% (118k/1m)')).toBe(12);
    expect(contextPercentUsed('no statusline here')).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Landing verification (the collapsed-paste bug)
//
// Both TUIs replace a large/multi-line paste with a placeholder and render NONE
// of the characters. Verification used to require seeing the characters, so a
// ~1.2k multi-line message reported "text did not land in the busy composer" —
// and every retry pressed C-u first, DESTROYING a message that had landed.
// ---------------------------------------------------------------------------
describe('composer landing evidence', () => {
  const collapsed = () => Bun.file(path.join(import.meta.dir, 'fixtures', 'claude-collapsed-paste.txt')).text();

  test('a captured collapsed-paste frame counts as landing evidence', async () => {
    const frame = await collapsed();
    const payload = `line one\n${'x'.repeat(1200)}`;
    const evidence = composerEvidence(frame, payload);
    // The characters are NOT on screen — this is exactly why the probe failed.
    expect(evidence.chars).toBe(0);
    expect(evidence.placeholders).toBe(1);
    expect(evidence.maxPlaceholderIndex).toBe(1);
    expect(composerHolds(frame, payload, 'placeholder')).toBe(true);
  });

  test('a second paste is new evidence even while the first is still shown', async () => {
    const first = await collapsed();
    const second = first.replace('#1 +16 lines', '#2 +40 lines');
    expect(composerEvidence(second, 'x').maxPlaceholderIndex).toBe(2);
    expect(composerEvidence(first, 'x').maxPlaceholderIndex).toBe(1);
  });

  test('codex placeholder form and other attachment kinds are recognized', () => {
    expect(composerEvidence('› [Pasted Content 4832 chars]', 'x').placeholders).toBe(1);
    expect(composerEvidence('❯ [Image #3]', 'x').maxPlaceholderIndex).toBe(3);
    expect(composerEvidence('❯ [...Truncated text #2]', 'x').placeholders).toBe(1);
  });

  test('ordinary output is not mistaken for a placeholder', () => {
    expect(composerEvidence('● Read src/a.ts [ok]\n  ⎿  array[0] = 1\n❯ ', 'x').placeholders).toBe(0);
  });
});

describe('fillComposer', () => {
  const paths = createPaths('/tmp/kteam-fill-test');
  const IDLE = '❯ \n────────\n? for shortcuts';

  class RecordingController extends TmuxController {
    readonly sent: string[][] = [];
    readonly pastes: string[] = [];
    protected readonly composerPollMs = 1;
    constructor(private readonly frames: string[]) {
      super(paths, 'http://127.0.0.1:7337');
    }
    override async captureVisible(): Promise<string> {
      return this.frames.length > 1 ? this.frames.shift()! : this.frames[0]!;
    }
    protected override async keys(_name: string, ...keys: string[]) {
      this.sent.push(keys);
      return { code: 0, stdout: '', stderr: '' };
    }
    protected override async pasteText(_name: string, text: string) {
      this.pastes.push(text);
      return { code: 0, stdout: '', stderr: '' };
    }
    fill(text: string) {
      return this.fillComposer('kteam-x-agent', text);
    }
  }

  test('a collapsed paste is LANDED: no C-u, no retype, no false failure', async () => {
    const frame = await Bun.file(path.join(import.meta.dir, 'fixtures', 'claude-collapsed-paste.txt')).text();
    const controller = new RecordingController([IDLE, frame]);
    const payload = `SPEC REPLACED — the user simplified this drastically.\n${'detail '.repeat(200)}`;
    expect(await controller.fill(payload)).toBe('placeholder');
    // Bracketed paste for a multi-line payload…
    expect(controller.pastes).toEqual([payload]);
    // …and NOT ONE destructive keystroke: C-u over a delivered paste is what
    // destroyed messages that had already landed.
    expect(controller.sent.flat()).not.toContain('C-u');
    expect(controller.sent).toEqual([]);
  });

  test('short single-line text keeps the character-echo path unchanged', async () => {
    const controller = new RecordingController([IDLE, '❯ continue\n? for shortcuts']);
    expect(await controller.fill('continue')).toBe('chars');
    expect(controller.pastes).toEqual([]);
    expect(controller.sent).toEqual([['-l', 'continue']]);
  });

  test('a genuinely swallowed payload still fails loudly, after clearing and retrying', async () => {
    const controller = new RecordingController([IDLE]);
    await expect(controller.fill('continue')).rejects.toThrow(/did not land in the composer/);
    // Nothing landed, so clearing is safe and retrying is correct: 3 attempts.
    expect(controller.sent.filter(keys => keys[0] === 'C-u')).toHaveLength(2);
    expect(controller.sent.filter(keys => keys[0] === '-l')).toHaveLength(3);
  });

  test('a payload above the paste threshold uses bracketed paste even on one line', async () => {
    const long = 'y'.repeat(400);
    const controller = new RecordingController([IDLE, `❯ ${long}`]);
    expect(await controller.fill(long)).toBe('chars');
    expect(controller.pastes).toEqual([long]);
  });
});

describe('stop() confirms the harness process tree is gone', () => {
  type ProcessRecord = { pid: number; ppid: number };

  class StopHarness extends TmuxController {
    readonly signals: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' }> = [];
    private tmuxAlive = true;

    constructor(private readonly tables: ProcessRecord[][]) {
      super(createPaths('/tmp/kteam-stop-test'), 'http://127.0.0.1:7337');
    }

    override async alive(): Promise<boolean> {
      return this.tmuxAlive;
    }

    protected async panePid(): Promise<number | undefined> {
      return 4_100;
    }

    protected async processTable(): Promise<ProcessRecord[]> {
      return this.tables.shift() ?? [];
    }

    protected async killSession(): Promise<{ code: number; stdout: string; stderr: string }> {
      this.tmuxAlive = false;
      return { code: 0, stdout: '', stderr: '' };
    }

    protected async stopSleep(): Promise<void> {}

    protected async signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
      this.signals.push({ pid, signal });
    }
  }

  const tree = [
    { pid: 4_100, ppid: 1 },
    { pid: 4_101, ppid: 4_100 },
  ];

  test('a normal tmux teardown confirms the captured pane process tree died', async () => {
    const controller = new StopHarness([tree, []]);
    await controller.stop('kteam-a4-normal-test-agent');
    expect(controller.signals).toEqual([]);
  });

  test('a surviving harness escalates child-first through SIGTERM then SIGKILL', async () => {
    const controller = new StopHarness([tree, tree, tree, []]);
    await controller.stop('kteam-a4-escalate-test-agent');
    expect(controller.signals).toEqual([
      { pid: 4_101, signal: 'SIGTERM' },
      { pid: 4_100, signal: 'SIGTERM' },
      { pid: 4_101, signal: 'SIGKILL' },
      { pid: 4_100, signal: 'SIGKILL' },
    ]);
  });

  test('a process tree surviving SIGKILL fails loudly with the surviving pids', async () => {
    const controller = new StopHarness([tree, tree, tree, tree]);
    await expect(controller.stop('kteam-a4-ghost-test-agent')).rejects.toThrow(/survived SIGKILL.*4100.*4101/);
  });
});

describe('send() into an interactive pane whose composer already holds a draft', () => {
  // A human (at the pane, or through the harness's own remote-control surface)
  // leaves text in the composer → promptReady stays false → the readiness gate
  // used to burn its whole timeout and fail with "did not become ready", which
  // reads as kteam REFUSING to type. Interactive sends must land regardless.
  const paths = createPaths('/tmp/kteam-send-draft-test');
  const base = { tmuxSession: 'kteam-x-agent', harness: 'claude' } as SessionConfig;

  class SendController extends TmuxController {
    readonly sent: string[][] = [];
    injected: string | null = null;
    constructor(private readonly frame: string) {
      super(paths, 'http://127.0.0.1:7337');
    }
    override async waitReady(): Promise<void> {
      throw new Error('interactive harness did not become ready within 10s; last frame: promptReady=false');
    }
    override async state() {
      return {
        alive: true,
        dead: false,
        promptReady: false,
        pane: this.frame,
        visiblePane: this.frame,
      };
    }
    protected override async keys(_name: string, ...keys: string[]) {
      this.sent.push(keys);
      return { code: 0, stdout: '', stderr: '' };
    }
    override async inject(_name: string, text: string): Promise<void> {
      this.injected = text;
    }
  }

  test('a stale draft is cleared and the message is typed anyway', async () => {
    const controller = new SendController('❯ half-typed human draft\n? for shortcuts');
    await controller.send({ ...base, mode: 'interactive' }, 'hello from the UI');
    expect(controller.sent).toEqual([['C-u']]);
    expect(controller.injected).toBe('hello from the UI');
  });

  test('a genuinely busy pane is NOT typed over — that is the queue path', async () => {
    const controller = new SendController('✻ Cooking… (12s · esc to interrupt)');
    await expect(controller.send({ ...base, mode: 'interactive' }, 'hello')).rejects.toThrow(/did not become ready/);
    expect(controller.sent).toEqual([]);
    expect(controller.injected).toBeNull();
  });

  test('auto mode keeps the strict gate (no human is at that keyboard)', async () => {
    const controller = new SendController('❯ \n? for shortcuts');
    await expect(controller.send({ ...base, mode: 'auto' }, 'hello')).rejects.toThrow(/did not become ready/);
    expect(controller.sent).toEqual([]);
  });
});
