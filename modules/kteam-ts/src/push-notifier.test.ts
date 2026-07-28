import { describe, expect, test } from 'bun:test';
import {
  PushNotifier,
  buildPushNotification,
  pushNotificationEventKey,
  summaryPushNotification,
} from './push-notifier';
import type { PushDelivery, PushDeliveryResult } from './push-sender';
import { DEFAULT_PUSH_PREFERENCES, type PushDeviceRecord, type VapidKeyPair } from './push-types';
import type { KTeamEvent, SessionStatus } from './types';
import type { SessionView } from './service';

const b64 = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString('base64url');
const keys: VapidKeyPair = {
  publicKey: b64(65, 3),
  privateKey: b64(32, 4),
  createdAt: '2026-07-28T00:00:00.000Z',
};

function view(id: string, status: SessionStatus = 'running', teammate = 'noel'): SessionView {
  return {
    config: {
      id,
      name: 'Diene Exec',
      teammate,
      binary: 'codex-auto-loge',
      harness: 'codex',
      modelHint: '',
      mode: 'auto',
      cwd: '/tmp',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      turn: 1,
      harnessSessionId: 'h',
      tmuxSession: 't',
      watcherSession: 'w',
      intervalSeconds: 1,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 3,
      systemPromptFile: '/tmp/system',
      originalPromptFile: '/tmp/prompt',
    },
    state: { id, status, turn: 1 },
    directory: `/tmp/${id}`,
  };
}

function device(overrides: Partial<PushDeviceRecord> = {}): PushDeviceRecord {
  return {
    id: 'push-00000000-0000-4000-8000-000000000000',
    revision: 1,
    deviceName: 'Phone',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    subscription: {
      endpoint: 'https://push.example.test/phone',
      expirationTime: null,
      keys: { p256dh: b64(65, 1), auth: b64(16, 2) },
    },
    prefs: structuredClone(DEFAULT_PUSH_PREFERENCES),
    ...overrides,
  };
}

class Sessions {
  readonly views = new Map<string, SessionView>();
  readonly listeners = new Set<(event: KTeamEvent) => void>();
  list = async () => [...this.views.values()];
  get = async (id: string) => {
    const found = this.views.get(id);
    if (!found) throw new Error('missing');
    return found;
  };
  subscribe = (listener: (event: KTeamEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(id: string, status: SessionStatus, extra: Record<string, unknown> = {}, turn = 1): void {
    const current = this.views.get(id)!;
    current.state = { ...current.state, status, turn, ...extra };
    const event: KTeamEvent = {
      sequence: turn,
      time: new Date(Date.parse('2026-07-28T00:00:00.000Z') + turn * 1000).toISOString(),
      sessionId: id,
      turn,
      type: 'test.transition',
      source: 'daemon',
      data: { status, ...extra },
    };
    for (const listener of this.listeners) listener(event);
  }
}

class Sender {
  deliveries: PushDelivery[] = [];
  result: PushDeliveryResult = {
    delivered: 0,
    failed: 0,
    expiredDeviceRevisions: new Map(),
    failureStatuses: [],
  };
  deliver = async (deliveries: readonly PushDelivery[]) => {
    this.deliveries.push(...deliveries);
    return { ...this.result, expiredDeviceRevisions: new Map(this.result.expiredDeviceRevisions) };
  };
}

async function notifierHarness(devices = [device()]) {
  const sessions = new Sessions();
  const sender = new Sender();
  const removed: Map<string, number>[] = [];
  const logs: string[] = [];
  const notifier = new PushNotifier(
    sessions,
    {
      subscriptions: async () => devices,
      removeMany: async revisions => {
        removed.push(new Map(revisions));
        return revisions.size;
      },
    },
    { keys: async () => keys },
    sender,
    message => logs.push(message),
  );
  return { sessions, sender, removed, logs, notifier };
}

describe('push payload contract', () => {
  test('uses Telegram-style title, one tag per session, and a deterministic transport dedup key', () => {
    const session = view('s1', 'awaiting_user');
    const payload = buildPushNotification(session, 'needsYou');
    expect(payload.title).toBe('[Noel] Diene Exec');
    expect(payload.tag).toBe('kteam-s1');
    expect(payload.url).toBe('/session/s1');
    expect(payload.eventKey).toBe(pushNotificationEventKey(session, 'needsYou'));
  });

  test('fleet summary identity matches the browser transport implementation', () => {
    const first = {
      ...buildPushNotification(view('s1', 'awaiting_user'), 'needsYou'),
      eventKey: 's1:needsYou:awaiting_user:1:',
    };
    const second = { ...buildPushNotification(view('s2', 'failed'), 'failed'), eventKey: 's2:failed:failed:2:' };
    expect(summaryPushNotification([second, first]).eventKey).toBe('fleet:3a8fc189');
  });
});

describe('PushNotifier', () => {
  test('baselines silently, then sends the real transition', async () => {
    const h = await notifierHarness();
    h.sessions.views.set('s1', view('s1'));
    await h.notifier.start();
    h.sessions.emit('s1', 'awaiting_user');
    await h.notifier.close();
    expect(h.sender.deliveries).toHaveLength(1);
    expect(h.sender.deliveries[0]!.payload).toMatchObject({ title: '[Noel] Diene Exec', kind: 'needsYou', count: 1 });
  });

  test('sequential events in one session keep the latest line and a collapsed count', async () => {
    const h = await notifierHarness();
    h.sessions.views.set('s1', view('s1'));
    await h.notifier.start();
    h.sessions.emit('s1', 'awaiting_user', {}, 1);
    h.sessions.emit('s1', 'running', {}, 2);
    h.sessions.emit(
      's1',
      'awaiting_question',
      { pendingQuestion: { toolUseId: 'q2', questions: [{ question: 'Use the new release?' }] } },
      2,
    );
    await h.notifier.close();
    expect(h.sender.deliveries).toHaveLength(1);
    expect(h.sender.deliveries[0]!.payload).toMatchObject({ kind: 'question', body: 'Use the new release?', count: 2 });
  });

  test('more than three distinct sessions becomes one fleet summary after per-session grouping', async () => {
    const h = await notifierHarness();
    for (let index = 0; index < 4; index += 1) h.sessions.views.set(`s${index}`, view(`s${index}`));
    await h.notifier.start();
    for (let index = 0; index < 4; index += 1) h.sessions.emit(`s${index}`, 'awaiting_user');
    await h.notifier.close();
    expect(h.sender.deliveries).toHaveLength(1);
    expect(h.sender.deliveries[0]!.payload).toMatchObject({
      tag: 'kteam-summary',
      body: '4 sessions need your attention.',
    });
  });

  test('device prefs filter independently and 410 cleanup removes only the rejected device', async () => {
    const muted = device({
      id: 'push-11111111-1111-4111-8111-111111111111',
      prefs: {
        ...structuredClone(DEFAULT_PUSH_PREFERENCES),
        events: { ...DEFAULT_PUSH_PREFERENCES.events, failed: false },
      },
    });
    const live = device();
    const h = await notifierHarness([muted, live]);
    h.sender.result.expiredDeviceRevisions.set(live.id, live.revision);
    h.sessions.views.set('s1', view('s1'));
    await h.notifier.start();
    h.sessions.emit('s1', 'failed', { reason: 'pane died' });
    await h.notifier.close();
    expect(h.sender.deliveries.map(item => item.device.id)).toEqual([live.id]);
    expect([...h.removed[0]!]).toEqual([[live.id, live.revision]]);
  });

  test('outbound failures log aggregate status only, never notification bodies', async () => {
    const h = await notifierHarness();
    h.sender.result = {
      delivered: 0,
      failed: 1,
      expiredDeviceRevisions: new Map(),
      failureStatuses: ['network'],
    };
    h.sessions.views.set('s1', view('s1'));
    await h.notifier.start();
    h.sessions.emit('s1', 'awaiting_user');
    await h.notifier.close();
    expect(h.logs.join('\n')).toContain('network');
    expect(h.logs.join('\n')).not.toContain('Waiting for you');
    expect(h.logs.join('\n')).not.toContain('Diene Exec');
  });
});
