import { describe, expect, test } from 'bun:test';
import { PushApi, isPushPath, pushWardenDenial, type PushApiService } from './push-api';
import { DEFAULT_PUSH_PREFERENCES, PushError, type PushDeviceView } from './push-types';

const b64 = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString('base64url');
const view: PushDeviceView = {
  id: 'push-00000000-0000-4000-8000-000000000000',
  deviceName: 'Phone',
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
  expirationTime: null,
  prefs: structuredClone(DEFAULT_PUSH_PREFERENCES),
};

function service(): PushApiService {
  return {
    publicKey: async () => b64(65, 3),
    listDevices: async () => [view],
    registerDevice: async input => ({ ...view, deviceName: input.deviceName }),
    revokeDevice: async id => {
      if (id !== view.id) throw new PushError('not_found', `unknown push device ${id}`);
      return view;
    },
  };
}

const request = (method: string, pathname: string, body?: unknown) => ({
  method,
  url: new URL(pathname, 'https://kteam.example.test'),
  body,
});

describe('PushApi', () => {
  test('recognises only the dedicated surface and denies it to the warden token for every method', () => {
    expect(isPushPath('/v1/push/vapid')).toBe(true);
    expect(isPushPath('/v1/sessions/s1')).toBe(false);
    expect(pushWardenDenial('GET', '/v1/push/vapid')).toContain('read push');
    expect(pushWardenDenial('POST', '/v1/push/subscriptions')).toContain('manage push');
    expect(pushWardenDenial('GET', '/v1/sessions')).toBeNull();
  });

  test('serves the public key, redacted device list, registration, and individual revoke', async () => {
    const api = new PushApi(service());
    expect((await api.handle(request('GET', '/v1/push/vapid')))?.status).toBe(200);
    const listed = await api.handle(request('GET', '/v1/push/subscriptions'));
    expect(JSON.stringify(listed?.body)).not.toContain('endpoint');
    const registered = await api.handle(
      request('POST', '/v1/push/subscriptions', {
        deviceName: 'Tablet',
        subscription: {
          endpoint: 'https://push.example.test/tablet',
          expirationTime: null,
          keys: { p256dh: b64(65, 1), auth: b64(16, 2) },
        },
        prefs: DEFAULT_PUSH_PREFERENCES,
      }),
    );
    expect(registered).toMatchObject({ status: 201, body: { deviceName: 'Tablet' } });
    expect((await api.handle(request('DELETE', `/v1/push/subscriptions/${view.id}`)))?.status).toBe(200);
  });

  test('invalid bodies are 400 and unknown devices are 404', async () => {
    const api = new PushApi(service());
    expect((await api.handle(request('POST', '/v1/push/subscriptions', {})))?.status).toBe(400);
    expect((await api.handle(request('DELETE', '/v1/push/subscriptions/push-missing')))?.status).toBe(404);
    expect((await api.handle(request('DELETE', '/v1/push/subscriptions/%E0%A4%A')))?.status).toBe(400);
  });
});
