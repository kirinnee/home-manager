import { describe, expect, test } from 'bun:test';
import { PUSH_SEND_CONCURRENCY, PUSH_SEND_TIMEOUT_MS, PushSender, pushTopic, type WebPushOptions } from './push-sender';
import { DEFAULT_PUSH_PREFERENCES, type PushDeviceRecord, type PushNotificationPayload } from './push-types';

const b64 = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString('base64url');

function device(id: string): PushDeviceRecord {
  return {
    id,
    revision: 1,
    deviceName: id,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    subscription: {
      endpoint: `https://push.example.test/${id}`,
      expirationTime: null,
      keys: { p256dh: b64(65, 1), auth: b64(16, 2) },
    },
    prefs: structuredClone(DEFAULT_PUSH_PREFERENCES),
  };
}

const payload: PushNotificationPayload = {
  version: 1,
  eventKey: 's1:attention:awaiting_user:1:',
  title: '[Noel] Diene Exec',
  body: 'Waiting for you at the prompt.',
  tag: 'kteam-s1',
  url: '/session/s1',
  count: 1,
  sessionId: 's1',
  kind: 'attention',
};

const vapid = { publicKey: b64(65, 3), privateKey: b64(32, 4), createdAt: '2026-07-28T00:00:00.000Z' };

describe('PushSender', () => {
  test('hands encryption/signing to web-push with bounded delivery options', async () => {
    const calls: Array<{ endpoint: string; encoded: string; options: WebPushOptions }> = [];
    const sender = new PushSender(async (subscription, encoded, options) => {
      calls.push({ endpoint: subscription.endpoint, encoded, options });
    });
    const result = await sender.deliver([{ device: device('one'), payload }], vapid);
    expect(result.delivered).toBe(1);
    expect(JSON.parse(calls[0]!.encoded)).toEqual(payload);
    expect(calls[0]!.options.vapidDetails).toEqual({
      subject: 'mailto:push@kteam.local',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    });
    expect(calls[0]!.options.TTL).toBe(300);
    expect(calls[0]!.options.timeout).toBe(PUSH_SEND_TIMEOUT_MS);
    expect(calls[0]!.options.contentEncoding).toBe('aes128gcm');
    expect(calls[0]!.options.topic.length).toBeLessThanOrEqual(32);
  });

  test('404/410 are permanent expiry; network/5xx stay retryable on a future event without an internal retry', async () => {
    const attempts: string[] = [];
    const sender = new PushSender(async subscription => {
      attempts.push(subscription.endpoint);
      if (subscription.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (subscription.endpoint.endsWith('server')) throw Object.assign(new Error('server'), { statusCode: 503 });
      throw new Error('offline');
    });
    const result = await sender.deliver(
      ['gone', 'server', 'offline'].map(id => ({ device: device(id), payload })),
      vapid,
    );
    expect(attempts).toHaveLength(3);
    expect([...result.expiredDeviceRevisions]).toEqual([['gone', 1]]);
    expect(result.failed).toBe(2);
    expect(result.failureStatuses).toEqual([503, 'network']);
  });

  test('fan-out never exceeds the bounded sender concurrency', async () => {
    let active = 0;
    let highest = 0;
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const sender = new PushSender(async () => {
      active += 1;
      highest = Math.max(highest, active);
      if (active === PUSH_SEND_CONCURRENCY) markStarted();
      await gate;
      active -= 1;
    });
    const delivery = sender.deliver(
      Array.from({ length: PUSH_SEND_CONCURRENCY + 5 }, (_, index) => ({ device: device(`device-${index}`), payload })),
      vapid,
    );
    await started;
    expect(highest).toBe(PUSH_SEND_CONCURRENCY);
    release();
    expect((await delivery).delivered).toBe(PUSH_SEND_CONCURRENCY + 5);
  });

  test('topic is stable per tag and differs across sessions', () => {
    expect(pushTopic('kteam-s1')).toBe(pushTopic('kteam-s1'));
    expect(pushTopic('kteam-s1')).not.toBe(pushTopic('kteam-s2'));
    expect(pushTopic('kteam-s1')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
