import { createHash } from 'node:crypto';
import * as webPush from 'web-push';
import type { PushDeviceRecord, PushNotificationPayload, VapidKeyPair } from './push-types';

export interface PushDelivery {
  device: PushDeviceRecord;
  payload: PushNotificationPayload;
}

export interface PushDeliveryResult {
  delivered: number;
  failed: number;
  /** Permanent browser-vendor rejection (404/410): remove, never retry. */
  expiredDeviceRevisions: Map<string, number>;
  /** Aggregate-only diagnostics. No endpoint or notification body is logged. */
  failureStatuses: Array<number | 'network'>;
}

export interface WebPushOptions {
  TTL: number;
  timeout: number;
  contentEncoding: 'aes128gcm';
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  topic: string;
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}

export type SendWebPush = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: WebPushOptions,
) => Promise<unknown>;

const defaultSend: SendWebPush = (subscription, payload, options) =>
  webPush.sendNotification(subscription, payload, options);

export const PUSH_SEND_CONCURRENCY = 4;
export const PUSH_SEND_TIMEOUT_MS = 10_000;

/** RFC 8030 Topic is limited to 32 URL-safe characters. It lets the vendor
 * retain only the latest pending payload per session while a phone is offline;
 * the payload's rolling count preserves the "+N more" context. */
export function pushTopic(tag: string): string {
  return `kt-${createHash('sha256').update(tag).digest('base64url').slice(0, 28)}`;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/** Thin wrapper around the established `web-push` package. It owns RFC 8291
 * aes128gcm encryption and VAPID signing; kteam never hand-rolls either. A
 * failed outbound request is attempted once and forgotten (no body-on-disk
 * retry queue). The next status transition naturally tries the device again. */
export class PushSender {
  constructor(private readonly send: SendWebPush = defaultSend) {}

  async deliver(deliveries: readonly PushDelivery[], keys: VapidKeyPair): Promise<PushDeliveryResult> {
    const result: PushDeliveryResult = {
      delivered: 0,
      failed: 0,
      expiredDeviceRevisions: new Map(),
      failureStatuses: [],
    };
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < deliveries.length) {
        const delivery = deliveries[cursor++];
        if (!delivery) return;
        const { device, payload } = delivery;
        try {
          await this.send(
            {
              endpoint: device.subscription.endpoint,
              keys: { ...device.subscription.keys },
            },
            JSON.stringify(payload),
            {
              TTL: 5 * 60,
              timeout: PUSH_SEND_TIMEOUT_MS,
              contentEncoding: 'aes128gcm',
              urgency: payload.kind === 'completed' ? 'normal' : 'high',
              topic: pushTopic(payload.tag),
              // `mailto:` avoids Safari's documented BadJwtToken behaviour for
              // a `https://localhost` subject. It is self-identification only;
              // no mailbox/account/signup exists or is required.
              vapidDetails: {
                subject: 'mailto:push@kteam.local',
                publicKey: keys.publicKey,
                privateKey: keys.privateKey,
              },
            },
          );
          result.delivered += 1;
        } catch (error) {
          const status = statusCode(error);
          if (status === 404 || status === 410) result.expiredDeviceRevisions.set(device.id, device.revision);
          else {
            result.failed += 1;
            result.failureStatuses.push(status ?? 'network');
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_SEND_CONCURRENCY, deliveries.length) }, () => worker()));
    return result;
  }
}
