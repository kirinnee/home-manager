import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_PUSH_DEVICES, PushSubscriptionStore } from './push-subscriptions';
import { DEFAULT_PUSH_PREFERENCES, parseRegisterPushDevice, type RegisterPushDeviceInput } from './push-types';

const roots: string[] = [];
const b64 = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString('base64url');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function harness(): Promise<{ file: string; store: PushSubscriptionStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-push-subscriptions-'));
  roots.push(root);
  const file = path.join(root, 'daemon', 'push-subscriptions.json');
  await mkdir(path.dirname(file), { recursive: true });
  return { file, store: new PushSubscriptionStore(file) };
}

function registration(endpoint = 'https://push.example.test/device/one', name = 'Phone'): RegisterPushDeviceInput {
  return {
    deviceName: name,
    subscription: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: b64(65, 1), auth: b64(16, 2) },
    },
    prefs: structuredClone(DEFAULT_PUSH_PREFERENCES),
  };
}

describe('push registration validation', () => {
  test('accepts the browser subscription shape and rejects non-HTTPS or malformed keys', () => {
    expect(parseRegisterPushDevice(registration()).subscription.endpoint).toStartWith('https://');
    expect(() =>
      parseRegisterPushDevice({
        ...registration(),
        subscription: { ...registration().subscription, endpoint: 'http://127.0.0.1/internal' },
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      parseRegisterPushDevice({
        ...registration(),
        subscription: { ...registration().subscription, keys: { p256dh: 'bad', auth: 'bad' } },
      }),
    ).toThrow(/base64url|decode/);
  });
});

describe('PushSubscriptionStore', () => {
  test('persists private material at 0600 but returns redacted per-device views', async () => {
    const { file, store } = await harness();
    const added = await store.register(registration());
    expect(added.id).toMatch(/^push-/);
    expect(JSON.stringify(added)).not.toContain('endpoint');
    expect(JSON.stringify(added)).not.toContain('p256dh');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const disk = await readFile(file, 'utf8');
    expect(disk).toContain('https://push.example.test/device/one');
    expect((await store.list()).map(device => device.id)).toEqual([added.id]);
  });

  test('same endpoint upserts the device while different endpoints remain individually revocable', async () => {
    const { store } = await harness();
    const phone = await store.register(registration());
    const renamed = await store.register(registration(undefined, 'My iPhone'));
    expect(renamed.id).toBe(phone.id);
    expect(renamed.deviceName).toBe('My iPhone');
    const tablet = await store.register(registration('https://push.example.test/device/two', 'Tablet'));
    expect((await store.list()).map(device => device.id)).toEqual([phone.id, tablet.id]);
    await store.revoke(phone.id);
    expect((await store.list()).map(device => device.id)).toEqual([tablet.id]);
    await expect(store.revoke(phone.id)).rejects.toThrow(/unknown push device/);
  });

  test('permanent push-service rejection can drop devices idempotently', async () => {
    const { store } = await harness();
    const first = await store.register(registration());
    const second = await store.register(registration('https://push.example.test/device/two'));
    const records = await store.subscriptions();
    const firstRevision = records.find(record => record.id === first.id)!.revision;
    expect(
      await store.removeMany(
        new Map([
          [first.id, firstRevision],
          ['missing', 1],
        ]),
      ),
    ).toBe(1);
    expect(await store.removeMany(new Map([[first.id, firstRevision]]))).toBe(0);
    expect((await store.list()).map(device => device.id)).toEqual([second.id]);
  });

  test('a late 410 cannot delete a subscription refreshed after the send began', async () => {
    const { store } = await harness();
    const first = await store.register(registration());
    const sentRevision = (await store.subscriptions())[0]!.revision;
    await store.register(registration(undefined, 'Refreshed Phone'));
    expect(await store.removeMany(new Map([[first.id, sentRevision]]))).toBe(0);
    expect((await store.list())[0]).toMatchObject({ id: first.id, deviceName: 'Refreshed Phone' });
  });

  test('device enrollment is bounded while an existing endpoint can still refresh', async () => {
    const { store } = await harness();
    for (let index = 0; index < MAX_PUSH_DEVICES; index += 1) {
      await store.register(registration(`https://push.example.test/device/${index}`, `Device ${index}`));
    }
    await expect(store.register(registration('https://push.example.test/device/overflow'))).rejects.toThrow(
      /device limit/,
    );
    await expect(
      store.register(registration('https://push.example.test/device/0', 'Refreshed')),
    ).resolves.toMatchObject({
      deviceName: 'Refreshed',
    });
  });

  test('corrupt storage fails closed and is not overwritten by a later registration', async () => {
    const { file, store } = await harness();
    await writeFile(file, '{ torn json', { mode: 0o600 });
    await expect(store.list()).rejects.toThrow(/could not read push subscription store/);
    await expect(store.register(registration())).rejects.toThrow(/could not read push subscription store/);
    expect(await readFile(file, 'utf8')).toBe('{ torn json');
  });
});
