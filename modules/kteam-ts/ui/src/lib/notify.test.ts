// Tests for the notification core: prefs parsing, transition classification,
// dedup, payloads, planning (including the burst summary), and the watch
// controller over stub surfaces. No DOM and no Notification global — the
// browser wiring in hooks/useNotifications.ts is deliberately thin.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { SessionStatus, SessionView } from '../types';
import {
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_BURST_LIMIT,
  NOTIFY_COOLDOWN_MS,
  NOTIFY_GROUP_WINDOW_MS,
  NOTIFY_KINDS,
  NotifyLedger,
  SUMMARY_TAG,
  buildNotification,
  classifyTransition,
  fleetNotificationEventKey,
  getNotifyPrefs,
  parseNotifyPrefs,
  planNotifications,
  resetNotifyPrefsForTest,
  setNotifyPrefs,
  startNotificationWatch,
  subscribeNotifyPrefs,
  summaryNotification,
  notificationEventKey,
  type NotificationSpec,
  type NotifyPrefs,
} from './notify';

function view(id: string, status: SessionStatus, overrides: Partial<SessionView['config']> = {}): SessionView {
  return {
    config: {
      id,
      name: `Task ${id}`,
      teammate: undefined,
      binary: 'claude-auto-loge',
      harness: 'claude',
      modelHint: '',
      mode: 'auto',
      cwd: '/tmp',
      createdAt: '2026-07-27T00:00:00Z',
      updatedAt: '2026-07-27T00:00:00Z',
      turn: 1,
      harnessSessionId: 'x',
      tmuxSession: 'x',
      watcherSession: 'x',
      intervalSeconds: 1,
      stallSeconds: 1,
      timeoutSeconds: 1,
      maxSnapshots: 1,
      systemPromptFile: '',
      originalPromptFile: '',
      ...overrides,
    },
    state: { id, status, turn: 1 },
    directory: `/home/user/.kteam/${id}`,
  };
}

const enabledPrefs: NotifyPrefs = {
  ...DEFAULT_NOTIFY_PREFS,
  enabled: true,
};

describe('parseNotifyPrefs', () => {
  test('null, garbage and non-JSON all read as the quiet default', () => {
    expect(parseNotifyPrefs(null)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(parseNotifyPrefs('not json')).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(parseNotifyPrefs('42')).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test('the default is OFF — quiet until the human opts in', () => {
    expect(DEFAULT_NOTIFY_PREFS.enabled).toBe(false);
  });

  test('one malformed field degrades to its default without poisoning the rest', () => {
    const parsed = parseNotifyPrefs(
      JSON.stringify({ enabled: 'yes', onlyWhenHidden: false, events: { failed: false, question: 'x' } }),
    );
    expect(parsed.enabled).toBe(false); // malformed → default
    expect(parsed.onlyWhenHidden).toBe(false); // valid → kept
    expect(parsed.events.failed).toBe(false); // valid → kept
    expect(parsed.events.question).toBe(true); // malformed → default
    expect(parsed.events.attention).toBe(true); // absent → default
  });

  test('unknown fields are ignored', () => {
    const parsed = parseNotifyPrefs(JSON.stringify({ enabled: true, futureThing: 1 }));
    expect(parsed.enabled).toBe(true);
  });

  test('legacy stored event preference migrates to attention without changing its value', () => {
    const parsed = parseNotifyPrefs(JSON.stringify({ events: { needsYou: false } }));
    expect(parsed.events.attention).toBe(false);
    expect(Object.hasOwn(parsed.events, 'needsYou')).toBe(false);
  });
});

describe('prefs store', () => {
  beforeEach(() => resetNotifyPrefsForTest());

  test('setNotifyPrefs merges events rather than replacing the record', () => {
    setNotifyPrefs({ events: { ...getNotifyPrefs().events, completed: false } });
    const prefs = getNotifyPrefs();
    expect(prefs.events.completed).toBe(false);
    expect(prefs.events.attention).toBe(true);
  });

  test('subscribers hear a write and can unsubscribe', () => {
    let calls = 0;
    const off = subscribeNotifyPrefs(() => calls++);
    setNotifyPrefs({ enabled: true });
    expect(calls).toBe(1);
    off();
    setNotifyPrefs({ enabled: false });
    expect(calls).toBe(1);
  });
});

describe('classifyTransition', () => {
  test('first sight never fires — enabling must not buzz per already-waiting session', () => {
    expect(classifyTransition(undefined, 'awaiting_user')).toBeNull();
    expect(classifyTransition(undefined, 'failed')).toBeNull();
  });

  test('no change never fires', () => {
    expect(classifyTransition('awaiting_user', 'awaiting_user')).toBeNull();
  });

  test('the four notifying transitions map to their kinds', () => {
    expect(classifyTransition('running', 'awaiting_user')).toBe('attention');
    expect(classifyTransition('running', 'awaiting_question')).toBe('question');
    expect(classifyTransition('running', 'failed')).toBe('failed');
    expect(classifyTransition('running', 'stalled')).toBe('failed');
    expect(classifyTransition('running', 'kill_failed')).toBe('failed');
    expect(classifyTransition('running', 'completed')).toBe('completed');
  });

  test('silent statuses fire nothing', () => {
    for (const next of ['running', 'thinking', 'tool_running', 'waiting', 'stopped', 'retrying'] as const) {
      expect(classifyTransition('awaiting_user', next)).toBeNull();
    }
  });

  test('stopped is silent — the human did it themselves', () => {
    expect(classifyTransition('running', 'stopped')).toBeNull();
  });
});

describe('NotifyLedger', () => {
  test('same (session, kind) inside the cooldown is one firing', () => {
    const ledger = new NotifyLedger();
    expect(ledger.shouldFire('s1', 'attention', 1_000)).toBe(true);
    expect(ledger.shouldFire('s1', 'attention', 11_000)).toBe(false); // the brief's 10s case
    expect(ledger.shouldFire('s1', 'attention', 1_000 + NOTIFY_COOLDOWN_MS)).toBe(true);
  });

  test('a genuinely new event key may update the session inside the cooldown', () => {
    const ledger = new NotifyLedger();
    expect(ledger.shouldFire('s1', 'attention', 1_000, 'turn-1')).toBe(true);
    expect(ledger.shouldFire('s1', 'attention', 2_000, 'turn-2')).toBe(true);
    expect(ledger.shouldFire('s1', 'attention', 3_000, 'turn-2')).toBe(false);
  });

  test('group count rolls within the window and resets after quiet', () => {
    const ledger = new NotifyLedger();
    expect(ledger.nextGroupCount('s1', 1_000)).toBe(1);
    expect(ledger.nextGroupCount('s1', 2_000)).toBe(2);
    expect(ledger.nextGroupCount('s1', 2_000 + NOTIFY_GROUP_WINDOW_MS + 1)).toBe(1);
  });

  test('different kinds and different sessions do not share a cooldown', () => {
    const ledger = new NotifyLedger();
    expect(ledger.shouldFire('s1', 'attention', 1_000)).toBe(true);
    expect(ledger.shouldFire('s1', 'question', 1_000)).toBe(true);
    expect(ledger.shouldFire('s2', 'attention', 1_000)).toBe(true);
  });

  test('prune drops sessions that left the fleet', () => {
    const ledger = new NotifyLedger();
    ledger.setStatus('gone', 'running');
    ledger.shouldFire('gone', 'attention', 1_000);
    ledger.prune(new Set(['other']));
    expect(ledger.status('gone')).toBeUndefined();
    // The cooldown entry was dropped too — a same-id future session starts clean.
    expect(ledger.shouldFire('gone', 'attention', 1_001)).toBe(true);
  });
});

describe('buildNotification', () => {
  test('deep-link, tag, and title come from the session', () => {
    const spec = buildNotification(view('ms1abc-12', 'awaiting_user', { teammate: 'zelda' }), 'attention');
    expect(spec.url).toBe('/session/ms1abc-12');
    expect(spec.tag).toBe('kteam-ms1abc-12');
    expect(spec.title).toBe('[Zelda] Task ms1abc-12');
    expect(spec.body).toBe('Waiting for you at the prompt.');
    expect(spec.eventKey).toBe(
      notificationEventKey(view('ms1abc-12', 'awaiting_user', { teammate: 'zelda' }), 'attention'),
    );
  });

  test('question body previews the pending question and truncates long ones', () => {
    const v = view('s1', 'awaiting_question');
    v.state.pendingQuestion = {
      toolUseId: 't1',
      questions: [{ question: 'x'.repeat(300) }],
    };
    const spec = buildNotification(v, 'question');
    expect(spec.body.length).toBeLessThanOrEqual(120);
    expect(spec.body.endsWith('…')).toBe(true);
  });

  test('failed body carries the daemon reason when present', () => {
    const v = view('s1', 'failed');
    v.state.reason = 'pane died';
    expect(buildNotification(v, 'failed').body).toBe('Failed — pane died');
    v.state.status = 'stalled';
    expect(buildNotification(v, 'failed').body).toBe('Stalled — pane died');
  });

  test('an already-composed title is preserved verbatim', () => {
    const spec = buildNotification(
      view('s1', 'completed', { teammate: 'zelda', name: '[Zelda] Fixes Scrolling' }),
      'completed',
    );
    expect(spec.title).toBe('[Zelda] Fixes Scrolling');
  });
});

describe('planNotifications', () => {
  test('first pass baselines silently, second pass fires the real change', () => {
    const ledger = new NotifyLedger();
    expect(planNotifications([view('s1', 'awaiting_user')], ledger, enabledPrefs, 1_000)).toHaveLength(0);
    expect(planNotifications([view('s1', 'running')], ledger, enabledPrefs, 2_000)).toHaveLength(0);
    const fired = planNotifications([view('s1', 'awaiting_user')], ledger, enabledPrefs, 3_000);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.kind).toBe('attention');
  });

  test('disabled master switch or a disabled kind is silent but still advances the baseline', () => {
    const ledger = new NotifyLedger();
    const muted: NotifyPrefs = { ...enabledPrefs, events: { ...enabledPrefs.events, completed: false } };
    planNotifications([view('s1', 'running')], ledger, muted, 1_000);
    expect(planNotifications([view('s1', 'completed')], ledger, muted, 2_000)).toHaveLength(0);
    // Baseline advanced: flipping the pref later does not retro-fire the old change.
    expect(planNotifications([view('s1', 'completed')], ledger, enabledPrefs, 3_000)).toHaveLength(0);
  });

  test('interactiveOnly skips auto sessions', () => {
    const ledger = new NotifyLedger();
    const prefs: NotifyPrefs = { ...enabledPrefs, interactiveOnly: true };
    planNotifications([view('a', 'running'), view('i', 'running', { mode: 'interactive' })], ledger, prefs, 1_000);
    const fired = planNotifications(
      [view('a', 'awaiting_user'), view('i', 'awaiting_user', { mode: 'interactive' })],
      ledger,
      prefs,
      2_000,
    );
    expect(fired.map(s => s.sessionId)).toEqual(['i']);
  });

  test('sequential lines in one session replace under one tag and carry a count', () => {
    const ledger = new NotifyLedger();
    const running = view('s1', 'running', { teammate: 'noel', name: 'Diene Exec' });
    planNotifications([running], ledger, enabledPrefs, 1_000);
    const first = { ...running, state: { ...running.state, status: 'awaiting_user' as const, turn: 1 } };
    const one = planNotifications([first], ledger, enabledPrefs, 2_000)[0]!;
    const resumed = { ...running, state: { ...running.state, status: 'running' as const, turn: 2 } };
    planNotifications([resumed], ledger, enabledPrefs, 2_100);
    const second = { ...running, state: { ...running.state, status: 'awaiting_user' as const, turn: 2 } };
    const two = planNotifications([second], ledger, enabledPrefs, 2_200)[0]!;
    expect(one.tag).toBe('kteam-s1');
    expect(two.tag).toBe(one.tag);
    expect(two.eventKey).not.toBe(one.eventKey);
    expect(two.count).toBe(2);
    expect(two.title).toBe('[Noel] Diene Exec');
  });

  test('a burst beyond the limit collapses into one summary pointing at the dashboard', () => {
    const ledger = new NotifyLedger();
    const many = Array.from({ length: NOTIFY_BURST_LIMIT + 2 }, (_, i) => view(`s${i}`, 'running'));
    planNotifications(many, ledger, enabledPrefs, 1_000);
    const flipped = many.map(v => ({ ...v, state: { ...v.state, status: 'awaiting_user' as const } }));
    const fired = planNotifications(flipped, ledger, enabledPrefs, 2_000);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.tag).toBe(SUMMARY_TAG);
    expect(fired[0]!.url).toBe('/');
    expect(fired[0]!.body).toContain(String(NOTIFY_BURST_LIMIT + 2));
  });

  test('at the limit exactly, individual notifications still go out', () => {
    const ledger = new NotifyLedger();
    const some = Array.from({ length: NOTIFY_BURST_LIMIT }, (_, i) => view(`s${i}`, 'running'));
    planNotifications(some, ledger, enabledPrefs, 1_000);
    const flipped = some.map(v => ({ ...v, state: { ...v.state, status: 'failed' as const } }));
    expect(planNotifications(flipped, ledger, enabledPrefs, 2_000)).toHaveLength(NOTIFY_BURST_LIMIT);
  });

  test('summaryNotification names the count', () => {
    expect(summaryNotification(7).body).toBe('7 sessions need your attention.');
  });

  test('fleet summary identity is stable across ordering and transport implementations', () => {
    const keys = ['s1:attention:awaiting_user:1:', 's2:failed:failed:2:'];
    expect(fleetNotificationEventKey(keys)).toBe('fleet:dc9a97bd');
    expect(fleetNotificationEventKey([...keys].reverse())).toBe('fleet:dc9a97bd');
  });

  test('every notify kind is coverable by prefs toggles', () => {
    for (const kind of NOTIFY_KINDS) expect(typeof enabledPrefs.events[kind]).toBe('boolean');
  });
});

describe('startNotificationWatch', () => {
  interface Harness {
    fire: () => void;
    setSessions: (views: SessionView[] | null) => void;
    shown: NotificationSpec[];
    env: { hidden: boolean; foreground: string | null; prefs: NotifyPrefs; now: number };
    stop: () => void;
  }

  function harness(prefs: NotifyPrefs = enabledPrefs): Harness {
    let sessions: SessionView[] | null = null;
    const listeners = new Set<() => void>();
    const shown: NotificationSpec[] = [];
    const env = { hidden: true, foreground: null as string | null, prefs, now: 1_000 };
    const stop = startNotificationWatch(
      {
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sessions: () => sessions,
      },
      {
        prefs: () => env.prefs,
        hidden: () => env.hidden,
        foregroundSession: () => env.foreground,
        show: spec => shown.push(spec),
        now: () => env.now,
      },
    );
    return {
      fire: () => {
        for (const listener of listeners) listener();
      },
      setSessions: views => {
        sessions = views;
      },
      shown,
      env,
      stop,
    };
  }

  test('baseline → change → notification; unsubscribe stops the flow', () => {
    const h = harness();
    h.setSessions([view('s1', 'running')]);
    h.fire();
    expect(h.shown).toHaveLength(0);
    h.setSessions([view('s1', 'awaiting_user')]);
    h.env.now = 2_000;
    h.fire();
    expect(h.shown).toHaveLength(1);
    h.stop();
    h.setSessions([view('s1', 'failed')]);
    h.env.now = 3_000;
    h.fire();
    expect(h.shown).toHaveLength(1);
  });

  test('a null (unhydrated) snapshot is skipped, not treated as an empty fleet', () => {
    const h = harness();
    h.fire(); // sessions still null
    h.setSessions([view('s1', 'awaiting_user')]);
    h.fire(); // FIRST real snapshot = baseline, silent
    expect(h.shown).toHaveLength(0);
  });

  test('visible app + onlyWhenHidden stays quiet, and the baseline still advances', () => {
    const h = harness();
    h.setSessions([view('s1', 'running')]);
    h.fire();
    h.env.hidden = false;
    h.setSessions([view('s1', 'awaiting_user')]);
    h.env.now = 2_000;
    h.fire();
    expect(h.shown).toHaveLength(0);
    // Back to hidden: the change was consumed while visible; no late replay.
    h.env.hidden = true;
    h.fire();
    expect(h.shown).toHaveLength(0);
  });

  test('with onlyWhenHidden off, a visible app still never buzzes about the session on screen', () => {
    const h = harness({ ...enabledPrefs, onlyWhenHidden: false });
    h.setSessions([view('s1', 'running'), view('s2', 'running')]);
    h.fire();
    h.env.hidden = false;
    h.env.foreground = 's1';
    h.setSessions([view('s1', 'awaiting_user'), view('s2', 'awaiting_user')]);
    h.env.now = 2_000;
    h.fire();
    expect(h.shown.map(s => s.sessionId)).toEqual(['s2']);
  });

  test('while hidden, the foreground suppression does not apply', () => {
    const h = harness({ ...enabledPrefs, onlyWhenHidden: false });
    h.setSessions([view('s1', 'running')]);
    h.fire();
    h.env.hidden = true;
    h.env.foreground = 's1'; // stale foreground from before backgrounding
    h.setSessions([view('s1', 'awaiting_user')]);
    h.env.now = 2_000;
    h.fire();
    expect(h.shown).toHaveLength(1);
  });
});
