import { ApiError, HAS_TOKEN, TOKEN } from './api';
import type { NotifyPrefs } from './notify';

export interface PushDeviceView {
  id: string;
  deviceName: string;
  createdAt: string;
  updatedAt: string;
  expirationTime: number | null;
  prefs: Pick<NotifyPrefs, 'events' | 'interactiveOnly'>;
}

interface VapidResponse {
  publicKey: string;
}

interface DeviceListResponse {
  devices: PushDeviceView[];
}

async function pushRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!HAS_TOKEN) {
    throw new ApiError(
      401,
      'Real Web Push enrollment needs an authenticated daemon session; this remote view is read-only.',
      'push_auth_required',
    );
  }
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body) headers.set('content-type', 'application/json');
  if ((init?.method ?? 'GET') !== 'GET') headers.set('x-kteam-request-id', crypto.randomUUID());
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.code);
  }
  return (await response.json()) as T;
}

export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(publicKey)) throw new Error('the daemon returned an invalid VAPID public key');
  const padded = `${publicKey.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (publicKey.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength !== 65) throw new Error('the daemon returned a VAPID public key with the wrong length');
  return bytes;
}

export function subscriptionJson(subscription: PushSubscription): {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
} {
  const encoded = subscription.toJSON();
  const p256dh = encoded.keys?.p256dh;
  const auth = encoded.keys?.auth;
  if (!encoded.endpoint || !p256dh || !auth) throw new Error('the browser returned an incomplete push subscription');
  return {
    endpoint: encoded.endpoint,
    expirationTime: encoded.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

export const pushApi = {
  vapid: async (): Promise<string> => (await pushRequest<VapidResponse>('/v1/push/vapid')).publicKey,
  list: async (): Promise<PushDeviceView[]> =>
    (await pushRequest<DeviceListResponse>('/v1/push/subscriptions')).devices,
  register: (subscription: PushSubscription, deviceName: string, prefs: NotifyPrefs): Promise<PushDeviceView> =>
    pushRequest<PushDeviceView>('/v1/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        subscription: subscriptionJson(subscription),
        deviceName,
        prefs: { events: prefs.events, interactiveOnly: prefs.interactiveOnly },
      }),
    }),
  revoke: (id: string): Promise<PushDeviceView> =>
    pushRequest<PushDeviceView>(`/v1/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
