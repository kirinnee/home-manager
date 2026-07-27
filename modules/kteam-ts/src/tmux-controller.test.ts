import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from './paths';
import {
  anyQuestionVisible,
  blockBindsOptions,
  composerEvidence,
  composerHolds,
  exactHeaderRowVisible,
  exactOptionRowVisible,
  freeformComposerLine,
  freeTextPageShowsQuestion,
  freeTextQuestionRegion,
  liveMenuBlock,
  questionRowIndex,
  paneShowsModelSelector,
  contextPercentUsed,
  distinctiveOptionFragment,
  optionVisibleOnPane,
  paneShowsActiveWork,
  paneShowsFreeformComposer,
  paneWorkCounters,
  parsePaneMetadata,
  resolveVisibleQuestion,
  resumeMenuAction,
  startupDialogAction,
  STRUCTURED_ANSWER_NOT_VISIBLE,
  StructuredQuestionDriveError,
  structuredAnswerRefusal,
  structuredMenuVisible,
  structuredQuestionPaneMatch,
  TmuxController,
  visibleMultiSelectState,
  visibleQuestionIndex,
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

describe('inject() consumption outcomes are exactly-once', () => {
  const paths = createPaths('/tmp/kteam-inject-outcome-test');
  const input = '/status';
  const idle = ['› ', '', '  gpt-5.6-sol high · Context 0% used'].join('\n');
  const filled = ['› /status', '', '  gpt-5.6-sol high · Context 0% used'].join('\n');

  interface StateFixture {
    pane: string;
    promptReady: boolean;
  }

  class InjectionController extends TmuxController {
    readonly sent: string[][] = [];
    protected readonly composerPollMs = 0;
    protected readonly injectionPollMs = 0;
    private captureIndex = 0;
    private stateIndex = 0;

    constructor(
      private readonly captureFrames: string[],
      private readonly stateFrames: StateFixture[],
    ) {
      super(paths, 'http://127.0.0.1:7337');
    }

    override async captureVisible(): Promise<string> {
      const index = Math.min(this.captureIndex++, this.captureFrames.length - 1);
      return this.captureFrames[index]!;
    }

    override async state() {
      const index = Math.min(this.stateIndex++, this.stateFrames.length - 1);
      const fixture = this.stateFrames[index]!;
      return {
        alive: true,
        dead: false,
        promptReady: fixture.promptReady,
        pane: fixture.pane,
        visiblePane: fixture.pane,
      };
    }

    protected override async keys(_name: string, ...keys: string[]) {
      this.sent.push(keys);
      return { code: 0, stdout: '', stderr: '' };
    }

    get injectionCount(): number {
      return this.sent.filter(keys => keys[0] === '-l').length;
    }

    get submitCount(): number {
      return this.sent.filter(keys => keys[0] === 'Enter').length;
    }
  }

  test('input consumed with a model turn starts once', async () => {
    const active = ['• Working (1s • Esc to interrupt)', '', '› '].join('\n');
    const controller = new InjectionController([idle, filled], [{ pane: active, promptReady: false }]);

    expect(await controller.inject('kteam-x-agent', input)).toBe('turn-started');
    expect(controller.injectionCount).toBe(1);
    expect(controller.submitCount).toBe(1);
  });

  test('input consumed without a model turn is handled locally once', async () => {
    // The local result deliberately echoes the exact command in scrollback.
    // A ready empty composer is stronger evidence than that broad text match.
    const localResult = ['Account status for /status', '', '› ', '', '  gpt-5.6-sol high · Context 0% used'].join('\n');
    const controller = new InjectionController([idle, filled], [{ pane: localResult, promptReady: true }]);

    expect(await controller.inject('kteam-x-agent', input)).toBe('handled-local');
    expect(controller.injectionCount).toBe(1);
    expect(controller.submitCount).toBe(1);
  });

  test.each([
    'Select Model and Effort',
    'Select Reasoning Level for gpt-5.5',
    'Select Reasoning Level for future-model-with-an-unknown-suffix',
  ])('Codex model selector %s is handled locally after exactly one Enter', async heading => {
    // Codex retains the submitted command above the selector. That makes the
    // broad text probe true even though the composer no longer holds `/model`;
    // the selector heading is the stronger consumption evidence.
    const picker = ['› /model', '', heading, '  1. gpt-5.6-sol', '  2. gpt-5.5'].join('\n');
    const modelFilled = ['› /model', '', '  gpt-5.6-sol high · Context 0% used'].join('\n');
    expect(composerHolds(picker, '/model', 'chars')).toBe(true);
    expect(paneShowsModelSelector(picker)).toBe(true);
    const controller = new InjectionController([idle, modelFilled], [{ pane: picker, promptReady: false }]);

    expect(await controller.inject('kteam-x-agent', '/model')).toBe('handled-local');
    expect(controller.injectionCount).toBe(1);
    expect(controller.submitCount).toBe(1);
  });

  test('input that never lands retries text entry, then fails', async () => {
    const controller = new InjectionController([idle], []);

    await expect(controller.inject('kteam-x-agent', input)).rejects.toThrow(
      /text did not land in the interactive input box/,
    );
    expect(controller.injectionCount).toBe(3);
    expect(controller.submitCount).toBe(0);
  });

  test('a busy composer retries Enter but never retypes the landed input', async () => {
    const controller = new InjectionController([idle, filled], [{ pane: filled, promptReady: false }]);

    await expect(controller.inject('kteam-x-agent', input)).rejects.toThrow(
      /remained in the interactive input box after submit retries/,
    );
    expect(controller.injectionCount).toBe(1);
    expect(controller.submitCount).toBe(3);
  });

  // /clear and /compact use this same exactly-once injection path.
  test('/clear consumed as a local wipe is handled once, never retyped', async () => {
    const clearFilled = ['› /clear', '', '  gpt-5.6-sol high · Context 0% used'].join('\n');
    const cleared = ['  Welcome back', '', '› ', '', '  Context 0% used'].join('\n');
    const controller = new InjectionController([idle, clearFilled], [{ pane: cleared, promptReady: true }]);

    expect(await controller.inject('kteam-x-agent', '/clear')).toBe('handled-local');
    expect(controller.injectionCount).toBe(1);
    expect(controller.submitCount).toBe(1);
  });

  test('/compact consumed as a real model turn starts once, never retyped', async () => {
    const compactFilled = ['› /compact', '', '  gpt-5.6-sol high · Context 24% used'].join('\n');
    const compacting = ['✻ Compacting conversation… (16s)', '  ▰▰▰▱▱▱ 17%', '', '› '].join('\n');
    const controller = new InjectionController([idle, compactFilled], [{ pane: compacting, promptReady: false }]);

    expect(await controller.inject('kteam-x-agent', '/compact')).toBe('turn-started');
    expect(controller.injectionCount).toBe(1);
    expect(controller.submitCount).toBe(1);
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
    override async inject(_name: string, text: string) {
      this.injected = text;
      return 'turn-started' as const;
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

describe('structured-answer visibility matcher', () => {
  // The daemon drives the interactive question menu by INDEX over its stored
  // options; this matcher is the sanity gate that the right question + option
  // are genuinely on screen before it types. The hard rule under test: it must
  // NEVER let a keystroke answer the wrong option, but it MUST answer an option
  // whose label wrapped across two TUI lines or was ellipsis-truncated.
  const QUESTION = 'Which naming theme should the fleet use?';
  const OPTIONS = ['Plain role names (Recommended)', 'East Asian mythical', 'Norse', 'Chemistry'];

  // Happy path: every label rendered contiguously on its own numbered row.
  // Rows are numbered because that is the only shape the daemon can drive — the
  // navigation origin is a `❯ N.` cursor row — and only a numbered cluster can
  // form a live menu block for evidence to be bound to.
  const happyPane = [
    `? ${QUESTION}`,
    '❯ 1. Plain role names (Recommended)',
    '  2. East Asian mythical',
    '  3. Norse',
    '  4. Chemistry',
    '  ↑/↓ to move · enter to select',
  ].join('\n');

  // The live bug: the picked label wraps, and a right-column panel prints
  // BETWEEN the two fragments, so the full whitespace-stripped label is never a
  // contiguous substring of the pane — but "Plain role names" alone is.
  const wrappingPane = [
    `? ${QUESTION}`,
    '❯ 1. Plain role names        │ recent activity',
    '     (Recommended)           │  - built ui',
    '  2. East Asian mythical     │  - ran tests',
    '  3. Norse                   │',
    '  4. Chemistry               │',
  ].join('\n');

  test('happy path: a contiguous label is visible and answerable', () => {
    expect(
      structuredAnswerRefusal({
        pane: happyPane,
        question: QUESTION,
        options: OPTIONS,
        selected: ['East Asian mythical'],
        promptReady: false,
      }),
    ).toBeNull();
  });

  test('wrapping label (panel text between the fragments) is answerable — the bug fix', () => {
    // Regression guard: the old full-label contiguous match refused this.
    const normalized = wrappingPane.replace(/\s+/g, '').toLowerCase();
    expect(normalized.includes('plainrolenames(recommended)')).toBe(false); // full label NOT contiguous
    expect(
      structuredAnswerRefusal({
        pane: wrappingPane,
        question: QUESTION,
        options: OPTIONS,
        selected: ['Plain role names (Recommended)'],
        promptReady: false,
      }),
    ).toBeNull();
  });

  test('ellipsis-truncated long label is answerable', () => {
    const options = ['Blue-green with automatic rollback on health-check failure', 'Canary', 'Recreate'];
    const pane = [
      '? Pick a deployment strategy',
      '❯ 1. Blue-green with automatic rollback on health-che…',
      '  2. Canary',
      '  3. Recreate',
    ].join('\n');
    expect(
      structuredAnswerRefusal({
        pane,
        question: 'Pick a deployment strategy',
        options,
        selected: ['Blue-green with automatic rollback on health-check failure'],
        promptReady: false,
      }),
    ).toBeNull();
  });

  test('ambiguous prefix pair REFUSES rather than guess the wrong option', () => {
    const options = ['Enable feature', 'Enable feature flags'];
    // "Enable feature" wraps, so its full label is not contiguous; the only
    // contiguous evidence ("enablefeature") also lives inside the sibling
    // "Enable feature flags", so no fragment can distinguish them → refuse.
    const pane = [
      '? Toggle behaviour',
      '❯ 1. Enable            │ note',
      '     feature           │ note',
      '  2. Enable feature flags',
    ].join('\n');
    expect(distinctiveOptionFragment('Enable feature', options)).toBeNull();
    expect(
      structuredAnswerRefusal({
        pane,
        question: 'Toggle behaviour',
        options,
        selected: ['Enable feature'],
        promptReady: false,
      }),
    ).toBe(STRUCTURED_ANSWER_NOT_VISIBLE);
  });

  test('an ambiguous-prefix option is safe when its complete numbered row is visible (live repro)', () => {
    const options = ['Enable feature', 'Enable feature flags'];
    const pane = [
      '? Which rollout should we use?',
      '❯ 1. Enable feature',
      '     Turn it on directly.',
      '  2. Enable feature flags',
      '     Roll it out gradually.',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    expect(distinctiveOptionFragment('Enable feature', options)).toBeNull();
    expect(exactOptionRowVisible(pane, 'Enable feature')).toBe(true);
    expect(exactOptionRowVisible(pane, 'Enable feature flags')).toBe(true);
    expect(
      structuredQuestionPaneMatch({
        pane,
        question: 'Which rollout should we use?',
        options,
        selected: ['Enable feature'],
        promptReady: false,
      }),
    ).toMatchObject({ ok: true, reason: undefined });
  });

  test('an UNNUMBERED line equal to a label is not a menu row', () => {
    // A description, a wrapped continuation and plain scrollback all render
    // without an ordinal. Granting them exact-row evidence let old prose
    // masquerade as the live menu — the strongest signal the matcher has.
    const pane = [
      '? Which rollout should we use?',
      '  Enable feature',
      '  ○ Enable feature',
      '     Enable feature — as discussed above.',
    ].join('\n');
    expect(exactOptionRowVisible(pane, 'Enable feature')).toBe(false);
  });

  test('numbered rows keep working across the real menu and checkbox shapes', () => {
    const menu = ['❯ 1. Alpha', '  2) Beta', '  3. Gamma — roll it out gradually'].join('\n');
    expect(exactOptionRowVisible(menu, 'Alpha')).toBe(true);
    expect(exactOptionRowVisible(menu, 'Beta')).toBe(true);
    expect(exactOptionRowVisible(menu, 'Gamma')).toBe(true);
    const checkboxes = ['❯ 1. ☑ Alpha', '  2. ☐ Beta', '  3. ◉ Gamma', '  4. [x] Delta'].join('\n');
    expect(exactOptionRowVisible(checkboxes, 'Alpha')).toBe(true);
    expect(exactOptionRowVisible(checkboxes, 'Beta')).toBe(true);
    expect(exactOptionRowVisible(checkboxes, 'Gamma')).toBe(true);
    expect(exactOptionRowVisible(checkboxes, 'Delta')).toBe(true);
    // Right-hand panel content is still discarded before comparison.
    expect(exactOptionRowVisible('  1. Alpha              │ some panel note', 'Alpha')).toBe(true);
  });

  test('a header counts only as its own whole row, never as substring prose', () => {
    expect(exactHeaderRowVisible(['? Which one?', 'Frontend', '❯ 1. Same'].join('\n'), 'Frontend')).toBe(true);
    expect(exactHeaderRowVisible('  Applies to the Frontend too.', 'Frontend')).toBe(false);
    expect(exactHeaderRowVisible('? Which one?\n❯ 1. Same', 'Frontend')).toBe(false);
  });

  test('a genuinely absent question is refused (question text not on the pane)', () => {
    expect(
      structuredAnswerRefusal({
        pane: '❯ \n? for shortcuts\n',
        question: QUESTION,
        options: OPTIONS,
        selected: ['Norse'],
        promptReady: true,
      }),
    ).toBe(STRUCTURED_ANSWER_NOT_VISIBLE);
  });

  test('an idle prompt is refused even if the question text lingers in scrollback', () => {
    expect(
      structuredAnswerRefusal({
        pane: happyPane,
        question: QUESTION,
        options: OPTIONS,
        selected: ['Norse'],
        promptReady: true,
      }),
    ).toBe(STRUCTURED_ANSWER_NOT_VISIBLE);
  });

  test('an option that is simply not on screen is refused', () => {
    // Question visible, but the selected option row scrolled off entirely.
    const pane = [`? ${QUESTION}`, '❯ 1. Plain role names (Recommended)', '  2. East Asian mythical'].join('\n');
    expect(
      structuredAnswerRefusal({
        pane,
        question: QUESTION,
        options: OPTIONS,
        selected: ['Norse'],
        promptReady: false,
      }),
    ).toBe(STRUCTURED_ANSWER_NOT_VISIBLE);
  });

  test('freeform-only answers (no selected labels) skip the option check', () => {
    expect(
      structuredAnswerRefusal({
        pane: happyPane,
        question: QUESTION,
        options: OPTIONS,
        selected: [],
        promptReady: false,
      }),
    ).toBeNull();
  });

  test('distinctiveOptionFragment yields a unique, non-sibling fragment', () => {
    const fragment = distinctiveOptionFragment('Plain role names (Recommended)', OPTIONS);
    expect(fragment).not.toBeNull();
    // Distinctive: no OTHER option contains it.
    for (const other of OPTIONS.filter(o => o !== 'Plain role names (Recommended)')) {
      expect(other.replace(/\s+/g, '').toLowerCase().includes(fragment!)).toBe(false);
    }
  });

  test('optionVisibleOnPane matches a wrapped fragment but not a sibling-only fragment', () => {
    const normalized = wrappingPane.replace(/\s+/g, '').toLowerCase();
    expect(optionVisibleOnPane(normalized, 'Plain role names (Recommended)', OPTIONS)).toBe(true);
    expect(optionVisibleOnPane(normalized, 'Norse', OPTIONS)).toBe(true);
  });
});

describe('structured answers are verified after driving the pane', () => {
  const paths = createPaths('/tmp/kteam-structured-answer-test');
  const questionPane = [
    '? Which rollout should we use?',
    '❯ 1. Enable feature',
    '  2. Enable feature flags',
    'Enter to select · Esc to cancel',
  ].join('\n');
  const activePane = ['• Working (1s • Esc to interrupt)', '', '❯ '].join('\n');
  const readyPane = ['Answer cancelled', '', '❯ ', '? for shortcuts'].join('\n');
  const pending = {
    toolUseId: 'tool-q',
    questions: [
      {
        question: 'Which rollout should we use?',
        options: [{ label: 'Enable feature' }, { label: 'Enable feature flags' }],
        multiSelect: false,
      },
    ],
  };
  const config = {
    id: 's',
    tmuxSession: 'kteam-s-agent',
    harness: 'claude',
    mode: 'interactive',
    maxSnapshots: 5,
  } as SessionConfig;

  class QuestionController extends TmuxController {
    readonly sent: string[][] = [];
    readonly copyModeExits: string[] = [];
    protected override readonly questionPollMs = 0;
    protected override readonly questionConfirmationPolls = 3;
    private frame = 0;

    constructor(
      private readonly frames: Array<{ pane: string; promptReady?: boolean; alive?: boolean; dead?: boolean }>,
      private readonly failKey = false,
    ) {
      super(paths, 'http://127.0.0.1:7337');
    }

    override async state() {
      const frame = this.frames[Math.min(this.frame++, this.frames.length - 1)]!;
      return {
        alive: frame.alive ?? true,
        dead: frame.dead ?? false,
        promptReady: frame.promptReady ?? false,
        pane: frame.pane,
        visiblePane: frame.pane,
      };
    }

    protected override async keys(_name: string, ...keys: string[]) {
      this.sent.push(keys);
      return this.failKey ? { code: 1, stdout: '', stderr: 'send-keys refused' } : { code: 0, stdout: '', stderr: '' };
    }

    protected override async exitCopyMode(name: string) {
      this.copyModeExits.push(name);
      return { code: 0, stdout: '', stderr: '' };
    }
  }

  test('the live ambiguous-prefix choice is answered once and confirmed by turn start', async () => {
    const controller = new QuestionController([{ pane: questionPane }, { pane: activePane }]);
    const result = await controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Enable feature']);
    expect(result).toMatchObject({
      toolUseId: 'tool-q',
      startedAtQuestion: 0,
      answeredQuestions: 1,
      confirmedBy: 'turn-started',
    });
    expect(controller.sent).toEqual([['Enter']]);
  });

  test('a native cursor left on “Chat about this” is navigated from its real row', async () => {
    const chatSelected = questionPane
      .replace('❯ 1. Enable feature', '  1. Enable feature')
      .replace(
        'Enter to select · Esc to cancel',
        '  3. Type something.\n❯ 4. Chat about this\nEnter to select · Esc to cancel',
      );
    const controller = new QuestionController([{ pane: chatSelected }, { pane: activePane }]);
    await controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Enable feature']);
    expect(controller.sent).toEqual([['Up'], ['Up'], ['Up'], ['Enter']]);
  });

  test('a swallowed Enter is an honest failure and is never retyped', async () => {
    const controller = new QuestionController([
      { pane: questionPane },
      { pane: questionPane },
      { pane: questionPane },
      { pane: questionPane },
    ]);
    await expect(
      controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Enable feature']),
    ).rejects.toThrow(/did not advance.*no success was recorded/);
    expect(controller.sent).toEqual([['Enter']]);
  });

  test('a failed tmux key is surfaced before any success can be claimed', async () => {
    const controller = new QuestionController([{ pane: questionPane }], true);
    await expect(
      controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Enable feature']),
    ).rejects.toBeInstanceOf(StructuredQuestionDriveError);
    expect(controller.sent).toEqual([['Enter']]);
  });

  test('a scrolled/missing frame gets one copy-mode restore before retrying', async () => {
    const controller = new QuestionController([
      { pane: 'copy mode: old output' },
      { pane: questionPane },
      { pane: activePane },
    ]);
    expect(
      await controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Enable feature']),
    ).toMatchObject({ confirmedBy: 'turn-started' });
    expect(controller.copyModeExits).toEqual(['kteam-s-agent']);
  });

  test('explicit abandon sends Escape once and requires a ready/advanced pane', async () => {
    const controller = new QuestionController([
      { pane: questionPane },
      { pane: questionPane },
      { pane: readyPane, promptReady: true },
    ]);
    const result = await controller.cancelQuestion(config, { pendingQuestion: pending } as never);
    expect(result.confirmedBy).toBe('prompt-ready');
    expect(controller.sent).toEqual([['Escape']]);
  });

  test('abandon refuses with ZERO keys when the frame is not a recognizable menu', async () => {
    // Mid-repaint: the question text is on the pane (so promptReady is false and
    // there is no active work) but no menu row is rendered. The old gate checked
    // only promptReady/active-work and would have sent Escape into this frame —
    // at an idle Codex prompt that quits the TUI.
    const repaint = ['? Which rollout should we use?', '  …', ''].join('\n');
    const controller = new QuestionController([{ pane: repaint }, { pane: repaint }, { pane: repaint }]);
    await expect(controller.cancelQuestion(config, { pendingQuestion: pending } as never)).rejects.toThrow(
      /does not show this question as a live menu/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('a frame with no menu cursor row refuses instead of navigating from an assumed origin', async () => {
    // Options are whole-row visible (the safety gate passes) but no `❯ N.`
    // cursor row was captured, so `Down`×n has no known starting point.
    const noCursor = questionPane.replace('❯ 1. Enable feature', '  1. Enable feature');
    const controller = new QuestionController([{ pane: noCursor }, { pane: noCursor }]);
    await expect(
      controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Enable feature flags']),
    ).rejects.toThrow(/menu cursor row is not visible/);
    expect(controller.sent).toEqual([]);
  });
});

describe('duplicate question text cannot drive the wrong menu', () => {
  const paths = createPaths('/tmp/kteam-duplicate-question-test');
  const config = {
    id: 's',
    tmuxSession: 'kteam-s-agent',
    harness: 'claude',
    mode: 'interactive',
    maxSnapshots: 5,
  } as SessionConfig;

  /** The dangerous real shape: one set asking the SAME question twice with
   * DIFFERENT options — so a wrong ordinal picks a real but wrong answer. */
  const duplicateSet = {
    toolUseId: 'tool-dup',
    questions: [
      {
        question: 'Which one?',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
        multiSelect: false,
      },
      {
        question: 'Which one?',
        options: [{ label: 'Gamma' }, { label: 'Delta' }],
        multiSelect: false,
      },
    ],
  };

  class DriveController extends TmuxController {
    readonly sent: string[][] = [];
    protected override readonly questionPollMs = 0;
    protected override readonly questionConfirmationPolls = 3;
    private frame = 0;

    constructor(private readonly frames: Array<{ pane: string; promptReady?: boolean }>) {
      super(paths, 'http://127.0.0.1:7337');
    }

    override async state() {
      const frame = this.frames[Math.min(this.frame++, this.frames.length - 1)]!;
      return {
        alive: true,
        dead: false,
        promptReady: frame.promptReady ?? false,
        pane: frame.pane,
        visiblePane: frame.pane,
      };
    }

    protected override async keys(_name: string, ...keys: string[]) {
      this.sent.push(keys);
      return { code: 0, stdout: '', stderr: '' };
    }

    protected override async exitCopyMode() {
      return { code: 0, stdout: '', stderr: '' };
    }
  }

  /** The set that stays INHERENTLY ambiguous under block binding: identical
   * wording AND identical options, so both ordinals bind to the one live block
   * and nothing on screen can tell them apart. */
  const identicalSet = {
    toolUseId: 'tool-same',
    questions: [
      { question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
      { question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
    ],
  };
  const identicalPane = ['? Confirm?', '  1. Yes', '  2. No', '? Confirm?', '❯ 1. Yes', '  2. No'].join('\n');

  test('an answered menu in scrollback no longer clouds the live ordinal', () => {
    // Question 1 was answered and scrolled up; question 2 is live. The text is
    // identical, so text position alone cannot tell them apart — the old matcher
    // resolved the tie by luck, and the previous pane-global rule then refused
    // because BOTH ordinals' option rows were somewhere on the capture.
    // Block binding reads only the live block: it renders Gamma/Delta, which
    // ordinal 1 alone owns, so ordinal 0 is not even a candidate.
    const pane = ['? Which one?', '  1. Alpha', '  2. Beta', '? Which one?', '❯ 1. Gamma', '  2. Delta'].join('\n');
    const resolution = resolveVisibleQuestion(pane, duplicateSet.questions);
    expect(resolution.candidates).toEqual([1]);
    expect(resolution.index).toBe(1);
    expect(resolution.reason).toBeUndefined();
    // …and the block it read is the LIVE one, not the scrollback copy.
    expect(resolution.block).toMatchObject({ startLine: 3, endLine: 5, rows: 2 });
  });

  test('the ambiguous case sends ZERO keys and refuses, naming the candidates', async () => {
    // Both ordinals bind to the SAME live block (same wording, same options), so
    // the frame genuinely cannot say which is on screen.
    const controller = new DriveController([{ pane: identicalPane }, { pane: identicalPane }]);
    await expect(
      controller.answerQuestion(config, { pendingQuestion: identicalSet } as never, ['Yes']),
    ).rejects.toThrow(/identically-worded questions is on screen \(candidates 0, 1\)/);
    expect(controller.sent).toEqual([]);
  });

  test('the refusal diagnostics explain the ambiguity without quoting pane text', async () => {
    const controller = new DriveController([{ pane: identicalPane }, { pane: identicalPane }]);
    const error = await controller
      .answerQuestion(config, { pendingQuestion: identicalSet } as never, ['Yes'])
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as StructuredQuestionDriveError);
    expect(error).toBeInstanceOf(StructuredQuestionDriveError);
    expect(error!.diagnostics).toMatchObject({ reason: 'ambiguous_question', candidates: [0, 1] });
    // Booleans and ordinals only — no pane content beyond what existing
    // diagnostics already carried.
    expect(JSON.stringify(error!.diagnostics)).not.toContain('Gamma');
    expect(JSON.stringify(error!.diagnostics)).not.toContain('Which one?');
  });

  test('a partial retry PROCEEDS when the live page options disambiguate the ordinal', async () => {
    // Question 1 was already answered in the TUI; only page 2's own options are
    // on screen, so ordinal 1 is the unique candidate and the retry is safe.
    const page2 = ['? Which one?', '❯ 1. Gamma', '  2. Delta', 'Enter to select · Esc to cancel'].join('\n');
    const working = ['• Working (1s • Esc to interrupt)', '', '❯ '].join('\n');
    const controller = new DriveController([{ pane: page2 }, { pane: working }]);
    const result = await controller.answerQuestion(config, { pendingQuestion: duplicateSet } as never, ['Delta']);
    expect(result).toMatchObject({ startedAtQuestion: 1, answeredQuestions: 1, confirmedBy: 'turn-started' });
    // Cursor observed on row 1 → exactly one Down to reach "Delta", then Enter.
    expect(controller.sent).toEqual([['Down'], ['Enter']]);
  });

  test('distinct HEADERS disambiguate two identically-worded questions', () => {
    const headered = [
      { question: 'Which one?', header: 'Backend', options: [{ label: 'Same' }] },
      { question: 'Which one?', header: 'Frontend', options: [{ label: 'Same' }] },
    ];
    const pane = ['? Which one?', '  Same', '? Which one?', 'Frontend', '❯ 1. Same'].join('\n');
    const resolution = resolveVisibleQuestion(pane, headered);
    expect(resolution.index).toBe(1);
    expect(resolution.evidence.find(item => item.index === 1)?.headerDistinct).toBe(true);
  });

  test('inherent ambiguity (same question, same options, no header) refuses rather than guessing', async () => {
    const identical = {
      toolUseId: 'tool-same',
      questions: [
        { question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
        { question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
      ],
    };
    const pane = ['? Confirm?', '  1. Yes', '  2. No', '? Confirm?', '❯ 1. Yes', '  2. No'].join('\n');
    const controller = new DriveController([{ pane }, { pane }]);
    await expect(controller.answerQuestion(config, { pendingQuestion: identical } as never, ['Yes'])).rejects.toThrow(
      /identically-worded questions is on screen/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('a single-question set keeps its existing exact-row/unique-prefix behavior', () => {
    const single = [{ question: 'Which rollout should we use?', options: [{ label: 'Enable feature' }] }];
    const pane = ['? Which rollout should we use?', '❯ 1. Enable feature'].join('\n');
    expect(resolveVisibleQuestion(pane, single)).toMatchObject({ index: 0, candidates: [0] });
    expect(visibleQuestionIndex(pane, single)).toBe(0);
    expect(anyQuestionVisible(pane, single)).toBe(true);
    expect(structuredMenuVisible(pane, single)).toBe(true);
    expect(visibleQuestionIndex('❯ \n? for shortcuts', single)).toBe(-1);
    expect(anyQuestionVisible('❯ \n? for shortcuts', single)).toBe(false);
  });

  test('an ambiguous frame exposes NO ordinal but still reads as “a question is up”', () => {
    // The two consumers want different things and now get different functions:
    // drivers must never see a guessed ordinal, while the self-heal/cancel gates
    // must not read an ambiguous frame as "no question on screen" or they would
    // clear live state.
    expect(visibleQuestionIndex(identicalPane, identicalSet.questions)).toBe(-1);
    expect(anyQuestionVisible(identicalPane, identicalSet.questions)).toBe(true);
    expect(structuredMenuVisible(identicalPane, identicalSet.questions)).toBe(true);
  });

  test('a header that only appears inside a DESCRIPTION cannot identify an ordinal', () => {
    // "Frontend" is quoted by ordinal 0's description line, never rendered as
    // its own header row — substring evidence would hand ordinal 1's identity to
    // whichever question happened to mention it.
    const headered = [
      { question: 'Which one?', header: 'Backend', options: [{ label: 'Same' }] },
      { question: 'Which one?', header: 'Frontend', options: [{ label: 'Same' }] },
    ];
    const pane = ['? Which one?', '  1. Same', '     Applies to the Frontend too.', '? Which one?', '❯ 1. Same'].join(
      '\n',
    );
    const resolution = resolveVisibleQuestion(pane, headered);
    expect(resolution.index).toBe(-1);
    expect(resolution.reason).toBe('ambiguous');
    expect(resolution.evidence.find(item => item.index === 1)?.headerDistinct).toBe(false);
  });

  test('an option label that only appears as prose cannot identify an ordinal', () => {
    // Ordinal 1's live rows are on screen, but ordinal 0's "Alpha" survives only
    // as an unnumbered scrollback line. Under the old `includes` fallback that
    // line made ordinal 0 look equally identified and the drive refused; the
    // structural rule ignores it, so the live ordinal resolves cleanly and
    // ordinal 0 never even becomes a candidate.
    const pane = ['? Which one?', '  Alpha was chosen earlier.', '? Which one?', '❯ 1. Gamma', '  2. Delta'].join('\n');
    const resolution = resolveVisibleQuestion(pane, duplicateSet.questions);
    expect(resolution.index).toBe(1);
    expect(resolution.candidates).toEqual([1]);
  });
});

describe('multi-select reconciles the checkbox state actually on screen', () => {
  test('preselected boxes are read, and only mismatched rows are toggled', () => {
    const pane = ['? Pick some', '❯ 1. ☑ Alpha', '  2. ☐ Beta', '  3. ☑ Gamma'].join('\n');
    expect(visibleMultiSelectState(pane, ['Alpha', 'Beta', 'Gamma'])).toEqual([true, false, true]);
  });

  test('an unreadable or duplicated row reports undefined so the caller refuses', () => {
    const pane = ['? Pick some', '  1. Alpha', '  2. ☐ Beta', '  3. ☐ Beta'].join('\n');
    // No marker on Alpha's row, and Beta appears twice → both unknowable.
    expect(visibleMultiSelectState(pane, ['Alpha', 'Beta'])).toEqual([undefined, undefined]);
  });

  test('a human-preselected pane refuses to blind-toggle and never sends a Space', async () => {
    const paths = createPaths('/tmp/kteam-multiselect-test');
    const config = {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness: 'claude',
      mode: 'interactive',
      maxSnapshots: 5,
    } as SessionConfig;
    const multi = {
      toolUseId: 'tool-multi',
      questions: [{ question: 'Pick some', options: [{ label: 'Alpha' }, { label: 'Beta' }], multiSelect: true }],
    };
    class MultiController extends TmuxController {
      readonly sent: string[][] = [];
      protected override readonly questionPollMs = 0;
      protected override readonly questionConfirmationPolls = 2;
      constructor(private readonly pane: string) {
        super(paths, 'http://127.0.0.1:7337');
      }
      override async state() {
        return { alive: true, dead: false, promptReady: false, pane: this.pane, visiblePane: this.pane };
      }
      protected override async keys(_name: string, ...keys: string[]) {
        this.sent.push(keys);
        return { code: 0, stdout: '', stderr: '' };
      }
      protected override async exitCopyMode() {
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    // Beta's row carries no recognizable marker → the current set is unknowable.
    const controller = new MultiController(['? Pick some', '❯ 1. ☑ Alpha', '  2. Beta'].join('\n'));
    await expect(controller.answerQuestion(config, { pendingQuestion: multi } as never, ['Alpha'])).rejects.toThrow(
      /checkbox selection is not readable/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('a READABLE preselected frame drives end to end: only mismatches toggle', async () => {
    const paths = createPaths('/tmp/kteam-multiselect-drive-test');
    const config = {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness: 'claude',
      mode: 'interactive',
      maxSnapshots: 5,
    } as SessionConfig;
    const multi = {
      toolUseId: 'tool-multi-ok',
      questions: [
        {
          question: 'Pick some',
          options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
          multiSelect: true,
        },
      ],
    };
    // A human already ticked Alpha and Gamma at the pane. The requested answer
    // is Alpha+Beta, so Alpha must be LEFT ALONE, Beta ticked and Gamma cleared.
    // The native cursor sits on row 2, so movement is counted from THERE — the
    // whole point of reading the origin instead of assuming row 1.
    const menu = [
      '? Pick some',
      '  1. ☑ Alpha',
      '❯ 2. ☐ Beta',
      '  3. ☑ Gamma',
      'Space to toggle · Enter to submit · Esc to cancel',
    ].join('\n');
    const working = ['• Working (1s • Esc to interrupt)', '', '❯ '].join('\n');
    class DrivenController extends TmuxController {
      readonly sent: string[][] = [];
      protected override readonly questionPollMs = 0;
      protected override readonly questionConfirmationPolls = 3;
      private frame = 0;
      constructor() {
        super(paths, 'http://127.0.0.1:7337');
      }
      override async state() {
        const pane = this.frame++ === 0 ? menu : working;
        return { alive: true, dead: false, promptReady: false, pane, visiblePane: pane };
      }
      protected override async keys(_name: string, ...keys: string[]) {
        this.sent.push(keys);
        return { code: 0, stdout: '', stderr: '' };
      }
      protected override async exitCopyMode() {
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    const controller = new DrivenController();
    const result = await controller.answerQuestion(config, { pendingQuestion: multi } as never, ['Alpha', 'Beta']);
    // Beta is already under the cursor → Space with no movement. Gamma is one
    // row below → a single Down, then Space. Alpha never receives a key.
    expect(controller.sent).toEqual([['Space'], ['Down'], ['Space'], ['Enter']]);
    expect(result).toMatchObject({ startedAtQuestion: 0, answeredQuestions: 1, confirmedBy: 'turn-started' });
  });

  test('a STALE cursor row in scrollback does not become the navigation origin', async () => {
    const paths = createPaths('/tmp/kteam-stale-cursor-test');
    const config = {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness: 'claude',
      mode: 'interactive',
      maxSnapshots: 5,
    } as SessionConfig;
    const single = {
      toolUseId: 'tool-stale-cursor',
      questions: [
        {
          question: 'Which one?',
          options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
          multiSelect: false,
        },
      ],
    };
    // An earlier answered menu is still in scrollback with its cursor frozen on
    // row 3; the LIVE menu below sits on row 1. Taking the first cursor glyph
    // read the origin as row 3, so asking for "Gamma" moved nothing and Enter
    // submitted whatever the live cursor was actually on — Alpha.
    const pane = [
      '? Which one?',
      '  1. Alpha',
      '  2. Beta',
      '❯ 3. Gamma',
      '',
      '? Which one?',
      '❯ 1. Alpha',
      '  2. Beta',
      '  3. Gamma',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const working = ['• Working (1s • Esc to interrupt)', '', '❯ '].join('\n');
    class StaleCursorController extends TmuxController {
      readonly sent: string[][] = [];
      protected override readonly questionPollMs = 0;
      protected override readonly questionConfirmationPolls = 3;
      private frame = 0;
      constructor() {
        super(paths, 'http://127.0.0.1:7337');
      }
      override async state() {
        const visible = this.frame++ === 0 ? pane : working;
        return { alive: true, dead: false, promptReady: false, pane: visible, visiblePane: visible };
      }
      protected override async keys(_name: string, ...keys: string[]) {
        this.sent.push(keys);
        return { code: 0, stdout: '', stderr: '' };
      }
      protected override async exitCopyMode() {
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    const controller = new StaleCursorController();
    const result = await controller.answerQuestion(config, { pendingQuestion: single } as never, ['Gamma']);
    // Origin is the LIVE row 1 → two Downs to reach Gamma. The stale row-3
    // reading would have sent zero movement keys.
    expect(controller.sent).toEqual([['Down'], ['Down'], ['Enter']]);
    expect(result).toMatchObject({ startedAtQuestion: 0, answeredQuestions: 1, confirmedBy: 'turn-started' });
  });
});

describe('freeform answers wait for the free-text page', () => {
  test('paneShowsFreeformComposer needs an empty composer row or a type-your-answer hint', () => {
    expect(paneShowsFreeformComposer(['? Which one?', '❯ 1. Alpha', '  2. Other'].join('\n'))).toBe(false);
    expect(paneShowsFreeformComposer(['Type your answer', '', '│ ❯ │'].join('\n'))).toBe(true);
    expect(paneShowsFreeformComposer(['╭──────╮', '│ ❯    │', '╰──────╯'].join('\n'))).toBe(true);
  });

  test('a menu that never pages to the composer refuses before typing into it', async () => {
    const paths = createPaths('/tmp/kteam-freeform-test');
    const config = {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness: 'claude',
      mode: 'interactive',
      maxSnapshots: 5,
    } as SessionConfig;
    const single = {
      toolUseId: 'tool-free',
      questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }], multiSelect: false }],
    };
    const menuOnly = ['? Which one?', '❯ 1. Alpha', '  2. Other', 'Enter to select'].join('\n');
    class FreeformController extends TmuxController {
      readonly sent: string[][] = [];
      readonly filled: string[] = [];
      protected override readonly questionPollMs = 0;
      protected override readonly questionConfirmationPolls = 2;
      constructor() {
        super(paths, 'http://127.0.0.1:7337');
      }
      override async state() {
        return { alive: true, dead: false, promptReady: false, pane: menuOnly, visiblePane: menuOnly };
      }
      protected override async keys(_name: string, ...keys: string[]) {
        this.sent.push(keys);
        return { code: 0, stdout: '', stderr: '' };
      }
      protected override async fillComposer(_name: string, text: string) {
        this.filled.push(text);
        return 'chars' as const;
      }
      protected override async exitCopyMode() {
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    const controller = new FreeformController();
    await expect(
      controller.answerQuestion(config, { pendingQuestion: single } as never, [], 'my own answer'),
    ).rejects.toThrow(/free-text page did not open/);
    // The Other row was selected, but NOTHING was typed into the menu.
    expect(controller.filled).toEqual([]);
  });

  test('a STALE composer hint above a live menu does not authorize typing', async () => {
    const paths = createPaths('/tmp/kteam-freeform-stale-test');
    const config = {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness: 'claude',
      mode: 'interactive',
      maxSnapshots: 5,
    } as SessionConfig;
    const single = {
      toolUseId: 'tool-free-stale',
      questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }], multiSelect: false }],
    };
    // An earlier free-text page left its hint and empty composer row in
    // scrollback; the menu we just pressed Enter on is still live underneath.
    // Composer evidence alone would authorize typing here — and every character
    // would land on the MENU as a shortcut instead of in a text box.
    const staleHintOverMenu = [
      'Type your answer',
      '> ',
      '? Which one?',
      '❯ 1. Alpha',
      '  2. Other',
      'Enter to select · Esc to cancel',
    ].join('\n');
    expect(paneShowsFreeformComposer(staleHintOverMenu)).toBe(true);
    expect(structuredMenuVisible(staleHintOverMenu, single.questions)).toBe(true);
    class StaleHintController extends TmuxController {
      readonly sent: string[][] = [];
      readonly filled: string[] = [];
      protected override readonly questionPollMs = 0;
      protected override readonly questionConfirmationPolls = 2;
      constructor() {
        super(paths, 'http://127.0.0.1:7337');
      }
      override async state() {
        return {
          alive: true,
          dead: false,
          promptReady: false,
          pane: staleHintOverMenu,
          visiblePane: staleHintOverMenu,
        };
      }
      protected override async keys(_name: string, ...keys: string[]) {
        this.sent.push(keys);
        return { code: 0, stdout: '', stderr: '' };
      }
      protected override async fillComposer(_name: string, text: string) {
        this.filled.push(text);
        return 'chars' as const;
      }
      protected override async exitCopyMode() {
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    const controller = new StaleHintController();
    await expect(
      controller.answerQuestion(config, { pendingQuestion: single } as never, [], 'my own answer'),
    ).rejects.toThrow(/free-text page did not open/);
    expect(controller.filled).toEqual([]);
  });
});

describe('all evidence is bound to ONE live menu block', () => {
  const paths = createPaths('/tmp/kteam-live-block-test');
  const config = {
    id: 's',
    tmuxSession: 'kteam-s-agent',
    harness: 'claude',
    mode: 'interactive',
    maxSnapshots: 5,
  } as SessionConfig;

  /** The pending set the daemon is holding. */
  const pending = {
    toolUseId: 'tool-block',
    questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }], multiSelect: false }],
  };

  /** THE dangerous real shape: the pending question and its own numbered rows
   * are still in scrollback, and an UNRELATED selector is live below them with
   * the only cursor row on the pane. Pane-global evidence combined the stale
   * question above with the live cursor below and drove keys into a menu that
   * belongs to somebody else. */
  const crossMenuPane = [
    '? Which one?',
    '  1. Alpha',
    '  2. Beta',
    'Enter to select · Esc to cancel',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No',
    'Enter to select · Esc to cancel',
  ].join('\n');

  /** The same danger without even a stale menu: the pending question's PHRASE
   * appears in ordinary output prose above an unrelated live selector. */
  const prosePane = [
    '⏺ Earlier I asked: Which one? — and then moved on to the deploy.',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No',
    'Enter to select · Esc to cancel',
  ].join('\n');

  class BlockController extends TmuxController {
    readonly sent: string[][] = [];
    readonly filled: string[] = [];
    protected override readonly questionPollMs = 0;
    protected override readonly questionConfirmationPolls = 2;
    private frame = 0;
    constructor(private readonly frames: string[]) {
      super(paths, 'http://127.0.0.1:7337');
    }
    override async state() {
      const pane = this.frames[Math.min(this.frame++, this.frames.length - 1)]!;
      return { alive: true, dead: false, promptReady: false, pane, visiblePane: pane };
    }
    protected override async keys(_name: string, ...keys: string[]) {
      this.sent.push(keys);
      return { code: 0, stdout: '', stderr: '' };
    }
    protected override async fillComposer(_name: string, text: string) {
      this.filled.push(text);
      return 'chars' as const;
    }
    protected override async exitCopyMode() {
      return { code: 0, stdout: '', stderr: '' };
    }
  }

  test('the block is the BOTTOM numbered cluster, not the stale one above it', () => {
    const block = liveMenuBlock(crossMenuPane);
    expect(block).not.toBeNull();
    // Lines 4..8: the unrelated selector's own intro, rows and footer. The stale
    // question at line 0 and its rows at 1–2 are outside the boundary, and the
    // footer at line 3 is exactly what stops the intro walk from reaching them.
    expect(block).toMatchObject({ startLine: 4, endLine: 8, cursorRow: 0 });
    expect(block!.rows.map(row => row.text)).toEqual(['Yes', 'No']);
    expect(block!.intro.trim()).toBe('Do you want to proceed?');
    expect(block!.intro).not.toContain('Which one?');
    expect(block!.text).not.toContain('Alpha');
  });

  test('ANSWER refuses across menus and sends exactly zero keys', async () => {
    const controller = new BlockController([crossMenuPane, crossMenuPane]);
    await expect(controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Alpha'])).rejects.toThrow(
      /not visible after restoring the pane|not this question’s menu/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('CANCEL refuses across menus and sends exactly zero keys', async () => {
    const controller = new BlockController([crossMenuPane, crossMenuPane, crossMenuPane]);
    await expect(controller.cancelQuestion(config, { pendingQuestion: pending } as never)).rejects.toThrow(
      /does not show this question as a live menu/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('a question PHRASE in unrelated prose authorizes nothing — answer or cancel', async () => {
    // The phrase lands inside the live block's intro, but only as prose — never
    // as a question ROW — so candidacy fails before the option set is even
    // consulted. (Its options disagree too; see the same-option-set pane below
    // for the case where option binding cannot help.)
    const resolution = resolveVisibleQuestion(prosePane, pending.questions);
    expect(resolution.reason).toBe('no_candidate');
    expect(resolution.candidates).toEqual([]);
    expect(structuredMenuVisible(prosePane, pending.questions)).toBe(false);
    expect(blockBindsOptions(liveMenuBlock(prosePane)!, ['Alpha', 'Beta'])).toBe(false);

    const answering = new BlockController([prosePane, prosePane]);
    await expect(answering.answerQuestion(config, { pendingQuestion: pending } as never, ['Alpha'])).rejects.toThrow(
      /not visible after restoring the pane/,
    );
    expect(answering.sent).toEqual([]);

    const cancelling = new BlockController([prosePane, prosePane, prosePane]);
    await expect(cancelling.cancelQuestion(config, { pendingQuestion: pending } as never)).rejects.toThrow(
      /does not show this question as a live menu/,
    );
    expect(cancelling.sent).toEqual([]);
  });

  test('a FREEFORM answer never fills a composer that sits above a live selector', async () => {
    const single = {
      toolUseId: 'tool-block-free',
      questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }], multiSelect: false }],
    };
    const ourMenu = ['? Which one?', '❯ 1. Alpha', '  2. Other', 'Enter to select · Esc to cancel'].join('\n');
    // Our menu paged away, but the composer hint it left is ABOVE an unrelated
    // selector that now owns the keyboard. "Composer present + our menu gone"
    // was satisfied here; only the positional rule catches it.
    const staleAboveOther = [
      'Type your answer',
      '> ',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      'Enter to select · Esc to cancel',
    ].join('\n');
    expect(paneShowsFreeformComposer(staleAboveOther)).toBe(true);
    expect(structuredMenuVisible(staleAboveOther, single.questions)).toBe(false);
    expect(freeformComposerLine(staleAboveOther)).toBe(1);
    expect(liveMenuBlock(staleAboveOther)!.endLine).toBe(5);

    const controller = new BlockController([ourMenu, staleAboveOther]);
    await expect(
      controller.answerQuestion(config, { pendingQuestion: single } as never, [], 'my own answer'),
    ).rejects.toThrow(/free-text page did not open/);
    // The Other row was selected, then the drive stopped: NOTHING was typed.
    expect(controller.filled).toEqual([]);
    expect(controller.sent).toEqual([['Down'], ['Enter']]);
  });

  test('the real Claude shape — header, blanks, descriptions, separator, footer — binds and drives', async () => {
    const live = {
      toolUseId: 'tool-real',
      questions: [
        {
          question: 'Which rollout should we use?',
          header: 'Deployment',
          options: [{ label: 'Enable feature' }, { label: 'Enable feature flags' }],
          multiSelect: false,
        },
      ],
    };
    const pane = [
      '⏺ Some earlier tool output',
      '  1. an old numbered line',
      'Enter to select · Esc to cancel',
      '',
      'Deployment',
      '',
      '? Which rollout should we use?',
      '❯ 1. Enable feature',
      '     Turn it on directly.',
      '  2. Enable feature flags',
      '     Roll it out gradually.',
      '  3. Type something.',
      '────────────────────────────',
      '  4. Chat about this',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const block = liveMenuBlock(pane);
    // Intro stops at the earlier footer (line 2), so the old numbered line at 1
    // is outside the block; descriptions and the separator rule stay inside.
    expect(block).toMatchObject({ startLine: 3, endLine: 14, cursorRow: 0 });
    expect(block!.rows.map(row => row.ordinal)).toEqual([1, 2, 3, 4]);
    expect(block!.intro).toContain('Deployment');
    expect(block!.intro).toContain('Which rollout should we use?');
    expect(resolveVisibleQuestion(pane, live.questions)).toMatchObject({ index: 0, candidates: [0] });

    const working = ['• Working (1s • Esc to interrupt)', '', '❯ '].join('\n');
    const controller = new BlockController([pane, working]);
    const result = await controller.answerQuestion(config, { pendingQuestion: live } as never, [
      'Enable feature flags',
    ]);
    expect(result).toMatchObject({ startedAtQuestion: 0, answeredQuestions: 1, confirmedBy: 'turn-started' });
    expect(controller.sent).toEqual([['Down'], ['Enter']]);
  });

  /** The hardest shape: an unrelated live selector whose option set is EXACTLY
   * the pending one, with our question quoted in the prose above it. Option
   * binding cannot help here — only the question-row rule can. */
  const sameOptionsProsePane = [
    'Earlier transcript: “Which one?” was discussed.',
    'Continue deployment?',
    '❯ 1. Alpha',
    '  2. Beta',
    'Enter to select · Esc to cancel',
  ].join('\n');

  test('a prose quote cannot claim a selector that shares the SAME option set', () => {
    const block = liveMenuBlock(sameOptionsProsePane)!;
    // Everything except the question agrees: same labels, same order, live cursor.
    expect(blockBindsOptions(block, ['Alpha', 'Beta'])).toBe(true);
    expect(block.cursorRow).toBe(0);
    // The phrase IS in the intro — a substring probe accepted exactly this.
    expect(block.intro).toContain('Which one?');
    // …and it still refuses, because the quote is not a question ROW.
    expect(questionRowIndex(block.intro, 'Which one?')).toBe(-1);
    expect(resolveVisibleQuestion(sameOptionsProsePane, pending.questions)).toMatchObject({
      index: -1,
      candidates: [],
      reason: 'no_candidate',
    });
    expect(structuredMenuVisible(sameOptionsProsePane, pending.questions)).toBe(false);
    expect(anyQuestionVisible(sameOptionsProsePane, pending.questions)).toBe(false);
  });

  test('SAME-option-set prose: ANSWER sends exactly zero keys', async () => {
    const controller = new BlockController([sameOptionsProsePane, sameOptionsProsePane]);
    await expect(controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Alpha'])).rejects.toThrow(
      /not visible after restoring the pane/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('SAME-option-set prose: CANCEL sends exactly zero keys', async () => {
    const controller = new BlockController([sameOptionsProsePane, sameOptionsProsePane, sameOptionsProsePane]);
    await expect(controller.cancelQuestion(config, { pendingQuestion: pending } as never)).rejects.toThrow(
      /does not show this question as a live menu/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('questionRowIndex needs the WHOLE question, not a shared opening clause', () => {
    // Two different questions sharing their first 40 characters: a probe-prefix
    // rule would let the longer anchored row answer for the shorter pending one.
    const longer = '? Should we roll out the new deploy path to every region tonight?';
    expect(questionRowIndex(longer, 'Should we roll out the new deploy path?')).toBe(-1);
    expect(questionRowIndex(longer, 'Should we roll out the new deploy path to every region tonight?')).toBe(0);
    // An ellipsis the harness itself printed is the one accepted clipping.
    expect(questionRowIndex('? Should we roll out the new deploy…', 'Should we roll out the new deploy path?')).toBe(0);
    // A bare standalone row gets no clipping leniency at all.
    expect(questionRowIndex('Should we roll out the new deploy…', 'Should we roll out the new deploy path?')).toBe(-1);
  });

  test('the free-text marker must be its own row, not prose near an idle prompt', () => {
    // Forged shape: ordinary output mentioning the hint, a few lines above the
    // ordinary idle prompt, with the pending question quoted above it.
    const forged = ['Which one?', 'You can type your answer later if you prefer.', '', '❯ ', '? for shortcuts'].join(
      '\n',
    );
    expect(freeTextQuestionRegion(forged)).toBeNull();
    expect(anyQuestionVisible(forged, pending.questions)).toBe(false);
    expect(freeTextPageShowsQuestion(forged, 'Which one?')).toBe(false);
    // The genuine hint row still reads as one.
    const genuine = ['Which one?', 'Type your answer', '❯ '].join('\n');
    expect(freeTextQuestionRegion(genuine)).toMatchObject({ markerLine: 1, composerLine: 2 });
    expect(anyQuestionVisible(genuine, pending.questions)).toBe(true);
  });

  test('a genuine question row over the WRONG option set is `unbound`, not `no_candidate`', async () => {
    // Our question really is the live block's question row, but the rows below
    // it are somebody else's. The distinct reason keeps the report honest —
    // "this is not your menu", not "your question scrolled away".
    const swapped = ['? Which one?', '❯ 1. Yes', '  2. No', 'Enter to select · Esc to cancel'].join('\n');
    expect(resolveVisibleQuestion(swapped, pending.questions)).toMatchObject({
      index: -1,
      candidates: [],
      reason: 'unbound',
    });
    const controller = new BlockController([swapped, swapped]);
    await expect(controller.answerQuestion(config, { pendingQuestion: pending } as never, ['Alpha'])).rejects.toThrow(
      /not this question’s menu/,
    );
    expect(controller.sent).toEqual([]);
  });

  test('a real question ROW is still accepted, wrapped across lines and all', () => {
    const wrapped = [
      '? Which rollout should we use when the deploy',
      '  window is short?',
      '❯ 1. Alpha',
      '  2. Beta',
      'Enter to select · Esc to cancel',
    ].join('\n');
    const set = [
      {
        question: 'Which rollout should we use when the deploy window is short?',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      },
    ];
    expect(questionRowIndex(liveMenuBlock(wrapped)!.intro, set[0]!.question)).toBe(0);
    expect(resolveVisibleQuestion(wrapped, set)).toMatchObject({ index: 0, candidates: [0] });
  });

  test('a clipped lower menu is never stitched to a stale row above an old footer', () => {
    // Row 1 of the live menu has scrolled off. The stale menu above ends in its
    // own footer and carries its own cursor glyph. Treating that footer as an
    // ordinary gap line built one "block" spanning both menus, with two cursors.
    const stitched = [
      '? Old question',
      '❯ 1. Stale choice',
      'Enter to select · Esc to cancel',
      '? Live question',
      '  2. Live second choice',
      'Enter to select · Esc to cancel',
    ].join('\n');
    const block = liveMenuBlock(stitched)!;
    expect(block.rows.map(row => row.ordinal)).toEqual([2]);
    expect(block.rows.map(row => row.text)).toEqual(['Live second choice']);
    expect(block.intro.trim()).toBe('? Live question');
    expect(block.cursorRow).toBeUndefined();
    // Two cursor glyphs inside one cluster is itself a refusal.
    const twoCursors = ['? Q', '❯ 1. A', '❯ 2. B', 'Enter to select'].join('\n');
    expect(liveMenuBlock(twoCursors)).toBeNull();
  });

  test('the free-text page keeps PRESENCE without authorizing any key', () => {
    // The "Other" page replaces the numbered rows with a composer, so there is
    // no block and nothing may be driven. It is still the question, though: the
    // self-heal monitor must not clear it while a human types into it. Presence
    // says yes; every key-authorizing gate says no.
    const otherPage = ['Which one?', 'Type your answer', '❯ '].join('\n');
    expect(liveMenuBlock(otherPage)).toBeNull();
    expect(anyQuestionVisible(otherPage, pending.questions)).toBe(true);
    expect(visibleQuestionIndex(otherPage, pending.questions)).toBe(-1);
    expect(structuredMenuVisible(otherPage, pending.questions)).toBe(false);
    // …and an unrelated composer with none of this question's text is not it.
    expect(anyQuestionVisible(['Type your answer', '❯ '].join('\n'), pending.questions)).toBe(false);
  });

  test('PRESENCE is false for a stale question in scrollback above an idle prompt', () => {
    // The interaction closed; the question and its rows are scrollback and the
    // bottom of the pane is the ordinary idle prompt. Reading this as presence
    // pinned the pending question forever — self-heal could never clear it,
    // while every key path correctly refused to drive it.
    const staleMenuAtIdle = [
      '? Which one?',
      '❯ 1. Alpha',
      '  2. Beta',
      '⏺ Answer recorded',
      '',
      '❯ ',
      '? for shortcuts',
    ].join('\n');
    // The composer BELOW the rows is what disqualifies the block.
    expect(liveMenuBlock(staleMenuAtIdle)).toBeNull();
    expect(anyQuestionVisible(staleMenuAtIdle, pending.questions)).toBe(false);
    expect(structuredMenuVisible(staleMenuAtIdle, pending.questions)).toBe(false);

    // Same shape, free-text flavour: the hint is scrollback and the bottom
    // composer is the idle prompt, with real output in between.
    const staleFreeTextAtIdle = [
      'Which one?',
      'Type your answer',
      'Use the guarded rollout.',
      '⏺ Answer recorded',
      '',
      '❯ ',
      '? for shortcuts',
    ].join('\n');
    expect(freeTextQuestionRegion(staleFreeTextAtIdle)).toBeNull();
    expect(anyQuestionVisible(staleFreeTextAtIdle, pending.questions)).toBe(false);
  });

  test('PRESENCE is false for a stale free-text page above an unrelated composer or menu', () => {
    const aboveComposer = [
      'Which one?',
      'Type your answer',
      '❯ ',
      '⏺ Ran tests: 12 passed',
      '',
      '❯ ',
      '? for shortcuts',
    ].join('\n');
    // The bottom composer is the live one and carries no marker of its own.
    expect(freeTextQuestionRegion(aboveComposer)).toBeNull();
    expect(anyQuestionVisible(aboveComposer, pending.questions)).toBe(false);

    const aboveMenu = [
      'Which one?',
      'Type your answer',
      '❯ ',
      '⏺ Ran tests: 12 passed',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      'Enter to select · Esc to cancel',
    ].join('\n');
    expect(freeTextQuestionRegion(aboveMenu)).toBeNull();
    expect(anyQuestionVisible(aboveMenu, pending.questions)).toBe(false);
    expect(structuredMenuVisible(aboveMenu, pending.questions)).toBe(false);
  });

  test('a FREEFORM answer is never typed into a bare idle prompt', async () => {
    // The Other selection unexpectedly returned the pane to rest. A bare `❯` is
    // indistinguishable from an idle prompt, so accepting it would post the
    // freeform answer as a brand-new message to the session.
    const single = {
      toolUseId: 'tool-idle-free',
      questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }], multiSelect: false }],
    };
    const ourMenu = ['? Which one?', '❯ 1. Alpha', '  2. Other', 'Enter to select · Esc to cancel'].join('\n');
    const idle = ['⏺ Answer recorded', '', '❯ ', '? for shortcuts'].join('\n');
    const controller = new BlockController([ourMenu, idle]);
    await expect(
      controller.answerQuestion(config, { pendingQuestion: single } as never, [], 'my own answer'),
    ).rejects.toThrow(/free-text page did not open/);
    expect(controller.filled).toEqual([]);
    // Only the two keys that selected the Other row — nothing extra.
    expect(controller.sent).toEqual([['Down'], ['Enter']]);
  });

  test('a FREEFORM answer IS typed once the real free-text page renders', async () => {
    const single = {
      toolUseId: 'tool-free-ok',
      questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }], multiSelect: false }],
    };
    const ourMenu = ['? Which one?', '❯ 1. Alpha', '  2. Other', 'Enter to select · Esc to cancel'].join('\n');
    const freeTextPage = ['? Which one?', 'Type your answer', '❯ '].join('\n');
    const working = ['• Working (1s • Esc to interrupt)', '', '❯ '].join('\n');
    const controller = new BlockController([ourMenu, freeTextPage, working]);
    const result = await controller.answerQuestion(config, { pendingQuestion: single } as never, [], 'my own answer');
    expect(controller.filled).toEqual(['my own answer']);
    expect(controller.sent).toEqual([['Down'], ['Enter'], ['Enter']]);
    expect(result).toMatchObject({ answeredQuestions: 1, confirmedBy: 'turn-started' });
  });

  test('no numbered cluster at all means no block, and every gate refuses', () => {
    const prompt = ['Answer cancelled', '', '❯ ', '? for shortcuts'].join('\n');
    expect(liveMenuBlock(prompt)).toBeNull();
    expect(resolveVisibleQuestion(prompt, pending.questions)).toMatchObject({ reason: 'no_block', candidates: [] });
    expect(structuredMenuVisible(prompt, pending.questions)).toBe(false);
    expect(anyQuestionVisible(prompt, pending.questions)).toBe(false);
    expect(visibleMultiSelectState(prompt, ['Alpha'])).toEqual([undefined]);
    expect(
      structuredQuestionPaneMatch({
        pane: prompt,
        question: 'Which one?',
        options: ['Alpha', 'Beta'],
        selected: ['Alpha'],
        promptReady: false,
      }),
    ).toMatchObject({ ok: false, reason: 'block_missing', block: null });
  });
});
