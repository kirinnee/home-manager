import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markModelUnavailable, modelAvailabilityFile } from './model-availability';
import { SessionManager } from './session-manager';
import { ModelConsentRequiredError } from './tmux-controller';

// keelin (muztj9py-3e6527ca, 2026-10-08): `--model fable` on claude-auto-loge3
// opened Claude Code's "Fable 5.1 now uses usage credits" selector on the first
// submit. kteam read its `❯ Switch to …` row as the composer, and the stall
// nudge's keystrokes 183 s later accepted the Sonnet downgrade. These tests pin
// the daemon half: fail the start loudly, mark the account, never nudge into it.

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;
const bareManager = () => Object.create(SessionManager.prototype) as Loose;

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-consent-test-'));
  homes.push(home);
  return home;
}

const consentFrame = () => Bun.file(path.join(import.meta.dir, 'fixtures', 'claude-usage-credits-consent.txt')).text();

async function availability(home: string): Promise<Array<Record<string, string>>> {
  return JSON.parse(await readFile(modelAvailabilityFile({ daemon: home } as never), 'utf8'));
}

describe('a start that hits the usage-credits consent selector', () => {
  test('fails loudly naming the account, marks it Fable-unavailable, and types nothing', async () => {
    const home = await temporaryHome();
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const state: Record<string, unknown> = { id: 's1', status: 'starting', turn: 1 };
    const keys: string[][] = [];
    const manager = bareManager();
    manager.closed = false;
    manager.launching = new Map([['s1', { at: Date.now(), bootstrap: Promise.resolve() }]]);
    manager.paths = { home, sessions: home, daemon: home };
    manager.serializedBootstrap = async (operation: () => Promise<unknown>) => await operation();
    manager.launchWithRetry = async () => undefined;
    manager.promptInstruction = () => 'go';
    manager.tmux = {
      send: async () => {
        throw new ModelConsentRequiredError('Fable 5.1');
      },
      keys: async (...args: string[]) => keys.push(args),
      snapshot: async () => '',
      state: async () => ({ alive: false }),
    };
    manager.store = {
      updateState: async (_id: string, update: (current: Record<string, unknown>) => Record<string, unknown>) =>
        Object.assign(state, update(state)),
    };
    manager.transition = async (_id: string, patch: Record<string, unknown>, type: string) => {
      events.push({ type, data: patch });
      Object.assign(state, patch);
    };
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
    };
    let stopped = 0;
    manager.stopTmuxWithEvidence = async () => {
      stopped++;
    };

    const error = await (manager as unknown as { bootstrapSession: (id: string, config: unknown) => Promise<void> })
      .bootstrapSession('s1', {
        id: 's1',
        binary: '/Users/x/.kfleet/bin/claude-auto-loge3',
        model: 'fable',
        tmuxSession: 'kteam-s1-agent',
      })
      .catch(e => e);

    expect(String(error)).toContain('claude-auto-loge3: Fable needs usage credits on this account');
    expect(state.status).toBe('failed');
    expect(String(state.reason)).toContain('claude-auto-loge3: Fable needs usage credits on this account');
    expect(String(state.reason)).toContain('marked unavailable on claude-auto-loge3');
    expect(stopped).toBe(1);
    expect(keys).toEqual([]);
    expect(events.find(item => item.type === 'session.model_consent_required')?.data).toMatchObject({
      binary: 'claude-auto-loge3',
      model: 'Fable 5.1',
      requestedModel: 'fable',
    });
    expect(await availability(home)).toEqual([
      expect.objectContaining({ binary: 'claude-auto-loge3', family: 'fable', model: 'Fable 5.1' }),
    ]);
  });

  test('a later Fable start on the marked account is refused before launch; others pass', async () => {
    const home = await temporaryHome();
    const manager = bareManager();
    manager.paths = { home, sessions: home, daemon: home };
    await markModelUnavailable(manager.paths as never, {
      binary: 'claude-auto-loge3',
      family: 'fable',
      model: 'Fable 5.1',
      reason: 'Fable needs usage credits on this account (interactive Claude Code asks to buy usage credits)',
      at: new Date().toISOString(),
    });
    const assert = (binary: string, harness: string, model?: string) =>
      (
        manager as unknown as {
          assertModelConsentNotRequired: (binary: string, harness: string, model?: string) => Promise<void>;
        }
      ).assertModelConsentNotRequired(binary, harness, model);
    await expect(assert('claude-auto-loge3', 'claude', 'claude-fable-5-1[1m]')).rejects.toThrow(
      /wrapper claude-auto-loge3: Fable needs usage credits on this account .*pick another account or model/,
    );
    await assert('claude-auto-loge3', 'claude', 'claude-opus-5-5');
    await assert('claude-auto-loge1', 'claude', 'fable');
    await assert('codex-auto-loge3', 'codex', 'fable');
  });
});

// --- the monitor: a selector on the pane is never nudged ---------------------

async function monitorWithFrame(frame: string) {
  const home = await temporaryHome();
  const directory = path.join(home, 's1');
  await mkdir(path.join(directory, 'checks'), { recursive: true });
  await mkdir(path.join(directory, 'turns'), { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const state: Record<string, unknown> = {
    id: 's1',
    status: 'running',
    turn: 1,
    startedAt: old,
    lastTranscriptAt: new Date(Date.parse(old) + 1_000).toISOString(),
    lastPaneAt: old,
    openTools: [],
    turnCompleted: false,
  };
  const config = {
    id: 's1',
    harness: 'claude',
    mode: 'auto',
    binary: 'claude-auto-loge3',
    model: 'fable',
    tmuxSession: 'kteam-s1-agent',
    turn: 1,
    intervalSeconds: 0.01,
    cwd: home,
    createdAt: old,
    timeoutSeconds: 7_200,
    nudgeAfterSeconds: 1,
    killAfterSeconds: 2,
  };
  const manager = bareManager();
  const sends: string[] = [];
  const events: string[] = [];
  let kills = 0;
  manager.closed = false;
  manager.paths = { home, sessions: home, daemon: home };
  manager.monitors = new Map();
  manager.launching = new Map();
  manager.doneDeferred = new Set();
  manager.autoContinued = new Set();
  manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
  manager.options = {
    healthIntervalSeconds: 0.01,
    warden: { susThinkingSeconds: 900, susSubprocessSeconds: 900 },
  };
  manager.get = async () => ({ directory, config, state });
  manager.tmux = {
    state: async () => ({ alive: true, dead: false, pane: frame, visiblePane: frame, promptReady: false }),
    snapshot: async () => '',
    subprocessAlive: async () => false,
    send: async (_config: unknown, text: string) => {
      sends.push(text);
    },
  };
  manager.gitFingerprint = async () => '';
  manager.updateQuota = async () => undefined;
  manager.transition = async (_id: string, patch: Record<string, unknown>, type: string) => {
    events.push(type);
    const applied = { ...patch };
    if (type === 'terminal.frame') delete applied.lastPaneAt;
    Object.assign(state, applied);
  };
  manager.store = {
    updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) =>
      Object.assign(state, mutate(state)),
  };
  manager.stopTmuxWithEvidence = async () => {
    kills += 1;
  };
  manager.emit = async (_id: string, type: string) => {
    events.push(type);
  };
  const abort = new AbortController();
  const fallback = setTimeout(() => abort.abort(), 1_500);
  try {
    await (manager as unknown as { monitorLoop: (id: string, signal: AbortSignal) => Promise<void> }).monitorLoop(
      's1',
      abort.signal,
    );
  } finally {
    clearTimeout(fallback);
  }
  return { home, state, events, sends, kills: () => kills };
}

describe('the stall reflex never keys into a selector', () => {
  test('the consent dialog escalates at once, marks the account, and is never nudged or killed', async () => {
    const run = await monitorWithFrame(await consentFrame());
    expect(run.events).not.toContain('session.nudged');
    expect(run.events).not.toContain('session.stalled');
    expect(run.events).toContain('session.model_consent_required');
    expect(run.sends).toEqual([]);
    expect(run.kills()).toBe(0);
    expect(run.state.needsHumanKind).toBe('model_consent_required');
    expect(String(run.state.needsHuman)).toContain('claude-auto-loge3: Fable needs usage credits on this account');
    expect((await availability(run.home))[0]).toMatchObject({ binary: 'claude-auto-loge3', family: 'fable' });
  });

  test('an unclassified selector withholds the nudge and raises attention instead', async () => {
    const frame = [
      '  Something new to decide',
      '  ❯ Do the thing',
      '    Do the other thing',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const run = await monitorWithFrame(frame);
    expect(run.events).not.toContain('session.nudged');
    expect(run.events.filter(type => type === 'session.nudge_withheld')).toHaveLength(1);
    expect(run.sends).toEqual([]);
    expect(run.kills()).toBe(0);
    expect(run.state.needsHumanKind).toBe('unclassified_modal');
    expect(run.state.nudgedAt).toBeUndefined();
  });

  test('control: a silent pane with no selector is still nudged', async () => {
    const run = await monitorWithFrame('silent static pane');
    expect(run.events).toContain('session.nudged');
    expect(run.state.needsHuman).toBeUndefined();
  });
});
