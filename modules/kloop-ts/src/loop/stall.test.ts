import { describe, test, expect } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StallMonitor, classifyPane, endsAtPrompt, extractDialogText, paneHash } from './stall';
import { parseRawConfig } from '../types';

// ============================================================================
// Stall detection tests — fake tmux via injected spawn, fake clock via now().
// The tick() method is driven directly (no interval waiting).
// ============================================================================

const CONFIRM_DIALOG = [
  ' Dangerous rm operation on possibly-empty variable path',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel',
].join('\n');

const WORKING_PANE_1 = ['⏺ Reading 1 file…', '✢ Zesting… (9m 6s · ↓ 30.6k tokens)', '❯ '].join('\n');
const WORKING_PANE_2 = ['⏺ Reading 1 file…', '✢ Zesting… (9m 21s · ↓ 31.2k tokens)', '❯ '].join('\n');

/** Fake tmux: capture-pane returns scripted text; send-keys is recorded. */
function fakeSpawn(paneRef: { text: string | null }, sent: string[][]) {
  return ((cmd: string[]) => {
    const isCapture = cmd[1] === 'capture-pane';
    const isSend = cmd[1] === 'send-keys';
    if (isSend) sent.push(cmd);
    const ok = !isCapture || paneRef.text != null;
    return {
      exited: Promise.resolve(ok ? 0 : 1),
      stdout: new Response(isCapture && paneRef.text != null ? paneRef.text : '').body,
    };
  }) as unknown as typeof Bun.spawn;
}

function makeMonitor(opts: {
  pane: { text: string | null };
  sent: string[][];
  events: Record<string, unknown>[];
  dir: string;
  autoAnswer?: 'off' | 'safe' | 'all';
  now: () => number;
}) {
  return new StallMonitor({
    runId: 'testrun',
    loop: 2,
    tmuxSession: 'kloop-testrun-2-impl',
    activityFiles: [],
    activityDirs: [opts.dir],
    config: {
      enabled: true,
      idleThresholdSec: 600,
      checkIntervalSec: 60,
      autoAnswer: opts.autoAnswer ?? 'off',
    },
    writeEvent: async e => {
      opts.events.push(e);
    },
    spawn: fakeSpawn(opts.pane, opts.sent),
    now: opts.now,
  });
}

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'kloop-stall-test-'));
}

describe('classifyPane', () => {
  test('recognizes Claude Code confirm dialogs', () => {
    expect(classifyPane(CONFIRM_DIALOG)).toBe('confirm-dialog');
    expect(classifyPane('blah\nDo you want to proceed?\n1. Yes')).toBe('confirm-dialog');
    expect(classifyPane('❯ 1. Yes')).toBe('confirm-dialog');
  });

  test('everything else is idle', () => {
    expect(classifyPane(WORKING_PANE_1)).toBe('idle');
    expect(classifyPane('')).toBe('idle');
  });

  test('dialog text buried above the tail window does not match', () => {
    const oldDialog = CONFIRM_DIALOG;
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(classifyPane(`${oldDialog}\n${filler}`)).toBe('idle');
  });
});

describe('paneHash / endsAtPrompt / extractDialogText', () => {
  test('hash changes when the pane tail changes', () => {
    expect(paneHash(WORKING_PANE_1)).not.toBe(paneHash(WORKING_PANE_2));
    expect(paneHash(WORKING_PANE_1)).toBe(paneHash(WORKING_PANE_1));
  });

  test('endsAtPrompt matches a bare prompt line', () => {
    expect(endsAtPrompt('some output\n❯')).toBe(true);
    expect(endsAtPrompt('some output\n❯   ')).toBe(true);
    expect(endsAtPrompt('mid-sentence text')).toBe(false);
  });

  test('extractDialogText returns the non-empty tail', () => {
    const text = extractDialogText(CONFIRM_DIALOG);
    expect(text).toContain('Do you want to proceed?');
  });
});

describe('StallMonitor', () => {
  test('acceptance: frozen confirm dialog → stall event with reason=confirm-dialog', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: CONFIRM_DIALOG };
    const sent: string[][] = [];
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent, events, dir, now: () => clock });

    // Tick 1 establishes the baseline hash (pane "changed" from '' → dialog).
    await mon.tick();
    expect(events.length).toBe(0);

    // Advance past the idle threshold with an unchanged pane and no file writes.
    clock += 11 * 60 * 1000;
    await mon.tick();

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('implementer_stall');
    expect(events[0].reason).toBe('confirm-dialog');
    expect(events[0].dialogText).toContain('Do you want to proceed?');
    expect(events[0].idleMs).toBeGreaterThanOrEqual(600_000);
    // Detection only: nothing sent to the pane.
    expect(sent.length).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('acceptance: quiet log but CHANGING pane → no stall (pane-hash heartbeat)', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: WORKING_PANE_1 };
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent: [], events, dir, now: () => clock });

    await mon.tick(); // baseline
    // 30 min of "no log writes" but the pane keeps changing every tick.
    for (let i = 0; i < 30; i++) {
      clock += 60 * 1000;
      pane.text = pane.text === WORKING_PANE_1 ? WORKING_PANE_2 : WORKING_PANE_1;
      await mon.tick();
    }
    expect(events.length).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('log mtime activity also counts (pane frozen but files being written)', async () => {
    const dir = await tmpDir();
    let clock = Date.now(); // real clock base — mtimes are real
    const pane = { text: CONFIRM_DIALOG }; // pane never changes
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent: [], events, dir, now: () => clock });

    await mon.tick(); // baseline
    clock += 11 * 60 * 1000;
    // A file write lands just before the next tick.
    await fs.writeFile(path.join(dir, 'log'), 'streamed output');
    await mon.tick();
    expect(events.length).toBe(0); // mtime advanced → activity
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('acceptance: autoAnswer=safe sends "1", logs implementer_stall_autoanswered with dialog text, ends the stall', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: CONFIRM_DIALOG };
    const sent: string[][] = [];
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent, events, dir, autoAnswer: 'safe', now: () => clock });

    await mon.tick(); // baseline
    clock += 11 * 60 * 1000;
    await mon.tick();

    const types = events.map(e => e.type);
    expect(types).toContain('implementer_stall');
    expect(types).toContain('implementer_stall_autoanswered');
    expect(types).toContain('implementer_stall_end');
    const answered = events.find(e => e.type === 'implementer_stall_autoanswered')!;
    expect(answered.answer).toBe('1');
    expect(String(answered.dialogText)).toContain('Do you want to proceed?');
    const ended = events.find(e => e.type === 'implementer_stall_end')!;
    expect(ended.resolution).toBe('autoanswer');
    // "1" sent literally + a submitting Enter.
    expect(sent.some(c => c.includes('-l') && c.includes('1'))).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('autoAnswer=safe does NOT answer a generic idle prompt (only `all` does)', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: 'some output\n❯' };
    const sent: string[][] = [];
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent, events, dir, autoAnswer: 'safe', now: () => clock });

    await mon.tick();
    clock += 11 * 60 * 1000;
    await mon.tick();

    expect(events.map(e => e.type)).toContain('implementer_stall');
    expect(events.find(e => e.type === 'implementer_stall')!.reason).toBe('idle');
    expect(sent.length).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('stall clears when activity resumes (resolution=activity)', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: CONFIRM_DIALOG };
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent: [], events, dir, now: () => clock });

    await mon.tick();
    clock += 11 * 60 * 1000;
    await mon.tick(); // stall fires
    expect(events.map(e => e.type)).toContain('implementer_stall');

    // The human answers in tmux; the pane changes again.
    clock += 60 * 1000;
    pane.text = WORKING_PANE_1;
    await mon.tick();
    const end = events.find(e => e.type === 'implementer_stall_end');
    expect(end).toBeDefined();
    expect(end!.resolution).toBe('activity');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('stop() closes an open stall as agent-exit', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: CONFIRM_DIALOG };
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent: [], events, dir, now: () => clock });

    await mon.tick();
    clock += 11 * 60 * 1000;
    await mon.tick();
    await mon.stop();
    const end = events.find(e => e.type === 'implementer_stall_end');
    expect(end).toBeDefined();
    expect(end!.resolution).toBe('agent-exit');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('acceptance: feature off → start() is a no-op, no events ever', async () => {
    const dir = await tmpDir();
    const events: Record<string, unknown>[] = [];
    const mon = new StallMonitor({
      runId: 'r',
      loop: 1,
      tmuxSession: 's',
      activityFiles: [],
      activityDirs: [dir],
      config: { enabled: false, idleThresholdSec: 600, checkIntervalSec: 60, autoAnswer: 'off' },
      writeEvent: async e => {
        events.push(e);
      },
      spawn: fakeSpawn({ text: CONFIRM_DIALOG }, []),
    });
    mon.start(); // no interval armed
    await mon.stop();
    expect(events.length).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('dead tmux session (capture fails) does not count as pane activity or crash the tick', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    const pane = { text: null as string | null };
    const events: Record<string, unknown>[] = [];
    const mon = makeMonitor({ pane, sent: [], events, dir, now: () => clock });

    await mon.tick();
    clock += 11 * 60 * 1000;
    await mon.tick(); // still fires an idle stall (no activity anywhere)
    expect(events.length).toBe(1);
    expect(events[0].reason).toBe('idle');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('materialize: stall events', () => {
  async function materializeEvents(events: Record<string, unknown>[]) {
    const { materialize } = await import('../status/materialize');
    const dir = await tmpDir();
    const runId = 'stall-mat-test';
    const runDir = path.join(dir, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const fakeFs = {
      mkdir: async (d: string) => {
        await fs.mkdir(d, { recursive: true });
      },
      readFile: (p: string) => fs.readFile(p, 'utf-8'),
      readJson: async () => null,
      writeFile: (p: string, c: string) => fs.writeFile(p, c),
      writeJson: async () => {},
      unlink: (p: string) => fs.unlink(p),
      exists: async (p: string) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      readdir: (p: string) => fs.readdir(p),
      rm: async (p: string, o?: { recursive?: boolean }) => {
        await fs.rm(p, { recursive: o?.recursive, force: true });
      },
    };
    const fakePaths = {
      runStatus: (id: string) => path.join(dir, id, 'status.yaml'),
      runEvents: (id: string) => path.join(dir, id, 'events.jsonl'),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = await materialize(runId, fakeFs as any, fakePaths as any);
    await fs.rm(dir, { recursive: true, force: true });
    return status;
  }

  const T = (offsetSec: number) => new Date(1_700_000_000_000 + offsetSec * 1000).toISOString();
  const base = [
    { type: 'run_start', timestamp: T(0), config: { implementers: { claude: 1 } } },
    { type: 'loop_start', timestamp: T(1), loop: 1, implementer: 'claude' },
    { type: 'implementer_start', timestamp: T(2), loop: 1, binary: 'claude' },
  ];

  test('implementer_stall sets stalled + reason + dialog; stall_end clears', async () => {
    const stalled = await materializeEvents([
      ...base,
      {
        type: 'implementer_stall',
        timestamp: T(700),
        loop: 1,
        reason: 'confirm-dialog',
        idleMs: 600000,
        dialogText: 'Do you want to proceed?',
      },
    ]);
    expect(stalled.stalled).toBe(true);
    expect(stalled.stallReason).toBe('confirm-dialog');
    expect(stalled.stallDialogText).toBe('Do you want to proceed?');
    expect(stalled.stalledSinceMs).toBe(new Date(T(700)).getTime());

    const cleared = await materializeEvents([
      ...base,
      { type: 'implementer_stall', timestamp: T(700), loop: 1, reason: 'confirm-dialog', idleMs: 600000 },
      { type: 'implementer_stall_end', timestamp: T(800), loop: 1, resolution: 'activity', stalledForMs: 100000 },
    ]);
    expect(cleared.stalled).toBe(false);
    expect(cleared.stallReason).toBeUndefined();
  });

  test('implementer_end clears a dangling stall (SIGKILLed monitor backstop)', async () => {
    const status = await materializeEvents([
      ...base,
      { type: 'implementer_stall', timestamp: T(700), loop: 1, reason: 'idle', idleMs: 600000 },
      { type: 'implementer_end', timestamp: T(900), loop: 1, binary: 'claude', exitCode: 0, durationMs: 898000 },
    ]);
    expect(status.stalled).toBe(false);
  });

  test('terminal events clear a dangling stall (cancelled run never shows STALLED)', async () => {
    const status = await materializeEvents([
      ...base,
      {
        type: 'implementer_stall',
        timestamp: T(700),
        loop: 1,
        reason: 'confirm-dialog',
        idleMs: 600000,
        dialogText: 'x',
      },
      { type: 'cancel', timestamp: T(900), reason: 'user' },
    ]);
    expect(status.status).toBe('cancelled');
    expect(status.stalled).toBe(false);
    expect(status.stallDialogText).toBeUndefined();
  });
});

describe('stall config parsing', () => {
  test('existing configs without stall are unaffected (defaults off)', () => {
    const config = parseRawConfig({ implementers: { claude: 1 } });
    expect(config.stall.enabled).toBe(false);
    expect(config.stall.idleThresholdSec).toBe(600);
    expect(config.stall.checkIntervalSec).toBe(60);
    expect(config.stall.autoAnswer).toBe('off');
  });

  test('nested settings.stall block parses', () => {
    const config = parseRawConfig({
      implementers: { claude: 1 },
      settings: { stall: { enabled: true, idleThresholdSec: 300, autoAnswer: 'safe' } },
    });
    expect(config.stall.enabled).toBe(true);
    expect(config.stall.idleThresholdSec).toBe(300);
    expect(config.stall.autoAnswer).toBe('safe');
  });

  test('YAML-1.1 bare `off` (boolean false) is accepted as autoAnswer off', () => {
    const config = parseRawConfig({
      implementers: { claude: 1 },
      stall: { enabled: true, autoAnswer: false },
    });
    expect(config.stall.autoAnswer).toBe('off');
  });
});
