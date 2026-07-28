import type { InteractionMode, SessionStatus } from './types';

export type PushNotificationKind = 'needsYou' | 'question' | 'failed' | 'completed';

export const PUSH_NOTIFICATION_KINDS: readonly PushNotificationKind[] = ['needsYou', 'question', 'failed', 'completed'];

export interface PushPreferences {
  events: Record<PushNotificationKind, boolean>;
  interactiveOnly: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  events: { needsYou: true, question: true, failed: true, completed: true },
  interactiveOnly: false,
};

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface RegisterPushDeviceInput {
  deviceName: string;
  subscription: BrowserPushSubscription;
  prefs: PushPreferences;
}

/** Full record kept only in the daemon's mode-0600 store. The API never returns
 * the endpoint or key material: a device is managed by its opaque id. */
export interface PushDeviceRecord extends RegisterPushDeviceInput {
  id: string;
  /** Monotonic store revision. A 404/410 may delete this record only when the
   * browser subscription has not been refreshed since that send began. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PushDeviceView {
  id: string;
  deviceName: string;
  createdAt: string;
  updatedAt: string;
  expirationTime: number | null;
  prefs: PushPreferences;
}

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

/** The only bytes sent through a browser vendor's push service. Bodies are
 * deliberately ephemeral: they are never part of the subscription store or a
 * disk-backed retry queue. */
export interface PushNotificationPayload {
  version: 1;
  eventKey: string;
  title: string;
  /** Latest line only. The service worker appends "+N more" from count. */
  body: string;
  tag: string;
  url: string;
  count: number;
  sessionId?: string;
  kind?: PushNotificationKind;
}

export type PushErrorCode = 'invalid' | 'corrupt_store' | 'not_found';

export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PushError('invalid', 'expected an object');
  return value as Record<string, unknown>;
};

const base64UrlBytes = (value: unknown, label: string, expectedBytes: number): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PushError('invalid', `${label} must be unpadded base64url`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw new PushError('invalid', `${label} is not valid base64url`);
  }
  if (decoded.byteLength !== expectedBytes) {
    throw new PushError('invalid', `${label} must decode to ${expectedBytes} bytes`);
  }
  return value;
};

const boundedText = (value: unknown, label: string, fallback?: string): string => {
  const text = typeof value === 'string' ? value.trim() : (fallback ?? '');
  if (!text) throw new PushError('invalid', `${label} is required`);
  if (text.length > 80) throw new PushError('invalid', `${label} is too long`);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new PushError('invalid', `${label} contains control characters`);
  return text;
};

export function parsePushPreferences(value: unknown): PushPreferences {
  if (value === undefined) return structuredClone(DEFAULT_PUSH_PREFERENCES);
  const raw = object(value);
  const rawEvents = object(raw['events']);
  const events = {} as Record<PushNotificationKind, boolean>;
  for (const kind of PUSH_NOTIFICATION_KINDS) {
    const enabled = rawEvents[kind];
    if (typeof enabled !== 'boolean') throw new PushError('invalid', `prefs.events.${kind} must be boolean`);
    events[kind] = enabled;
  }
  if (typeof raw['interactiveOnly'] !== 'boolean') {
    throw new PushError('invalid', 'prefs.interactiveOnly must be boolean');
  }
  return { events, interactiveOnly: raw['interactiveOnly'] };
}

export function parseBrowserPushSubscription(value: unknown): BrowserPushSubscription {
  const raw = object(value);
  if (typeof raw['endpoint'] !== 'string' || raw['endpoint'].length > 4_096) {
    throw new PushError('invalid', 'subscription.endpoint must be a bounded HTTPS URL');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw['endpoint']);
  } catch {
    throw new PushError('invalid', 'subscription.endpoint must be a valid HTTPS URL');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !endpoint.hostname) {
    throw new PushError('invalid', 'subscription.endpoint must be an HTTPS push-service URL');
  }
  const expiration = raw['expirationTime'];
  if (expiration !== undefined && expiration !== null && (!Number.isFinite(expiration) || Number(expiration) < 0)) {
    throw new PushError('invalid', 'subscription.expirationTime must be null or a non-negative number');
  }
  const keys = object(raw['keys']);
  return {
    endpoint: endpoint.href,
    expirationTime: expiration === undefined || expiration === null ? null : Number(expiration),
    keys: {
      // RFC 8291 subscriptions carry an uncompressed P-256 point and a
      // 16-byte authentication secret.
      p256dh: base64UrlBytes(keys['p256dh'], 'subscription.keys.p256dh', 65),
      auth: base64UrlBytes(keys['auth'], 'subscription.keys.auth', 16),
    },
  };
}

export function parseRegisterPushDevice(value: unknown): RegisterPushDeviceInput {
  const raw = object(value);
  return {
    deviceName: boundedText(raw['deviceName'], 'deviceName', 'Browser device'),
    subscription: parseBrowserPushSubscription(raw['subscription']),
    prefs: parsePushPreferences(raw['prefs']),
  };
}

export function parseStoredPushDevice(value: unknown): PushDeviceRecord {
  const raw = object(value);
  const registration = parseRegisterPushDevice(raw);
  const id = boundedText(raw['id'], 'device id');
  if (!/^push-[0-9a-f-]{36}$/u.test(id)) throw new PushError('invalid', 'stored push device id is invalid');
  const revision = raw['revision'];
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new PushError('invalid', 'stored push device revision is invalid');
  }
  const createdAt = boundedText(raw['createdAt'], 'createdAt');
  const updatedAt = boundedText(raw['updatedAt'], 'updatedAt');
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new PushError('invalid', 'stored push device timestamps are invalid');
  }
  return { id, revision: Number(revision), createdAt, updatedAt, ...registration };
}

export function pushDeviceView(record: PushDeviceRecord): PushDeviceView {
  return {
    id: record.id,
    deviceName: record.deviceName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expirationTime: record.subscription.expirationTime,
    prefs: structuredClone(record.prefs),
  };
}

export function pushKindForStatus(status: SessionStatus): PushNotificationKind | null {
  if (status === 'awaiting_question') return 'question';
  if (status === 'awaiting_user') return 'needsYou';
  if (status === 'failed' || status === 'stalled' || status === 'kill_failed') return 'failed';
  if (status === 'completed') return 'completed';
  return null;
}

export function deviceWantsNotification(
  prefs: PushPreferences,
  kind: PushNotificationKind,
  mode: InteractionMode,
): boolean {
  return prefs.events[kind] && (!prefs.interactiveOnly || mode === 'interactive');
}
