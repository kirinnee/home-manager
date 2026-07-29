// Notifications as their own feature (&F140), on the existing web-push path.
//
// Two producers share this module and one delivery surface:
//  1. AUTOMATIC — a genuinely NEW durable attention item pushes to the phone
//     (wired through AttentionDeps.notifyNewItem, so dedupes and in-place
//     refreshes stay silent). Question items keep their canonical
//     session-transition presenter; the policy decides, never this module.
//  2. DIRECT — an agent may notify about anything else (a completion, a build
//     result) via `kteam attention notify`. A notification is NOT an attention
//     item: nothing durable is written and nothing needs resolution.

import { harnessDisplayName } from './core';
import type { KTeamService } from './service';
import type { InteractionMode } from './types';
import { notificationPolicyForAttention } from './notification-policy';
import type { PushNotificationKind, PushNotificationPayload } from './push-types';
import { AttentionError, type AttentionActor, type AttentionItem } from './attention-types';

export const MAX_NOTIFY_TITLE_LEN = 120;
export const MAX_NOTIFY_BODY_LEN = 500;

/** Direct notifications gate on the informational device preferences, never on
 * `question`/`attention` (those belong to real waiting states). */
export const DIRECT_NOTIFICATION_KINDS = ['completed', 'failed'] as const;
export type DirectNotificationKind = (typeof DIRECT_NOTIFICATION_KINDS)[number];

export interface DirectNotificationInput {
  body: string;
  title?: string;
  kind?: DirectNotificationKind;
}

export function parseDirectNotificationBody(value: unknown): DirectNotificationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttentionError('invalid', 'notify needs a JSON object body');
  }
  const raw = value as Record<string, unknown>;
  const body = raw['body'] ?? raw['message'];
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new AttentionError('invalid', 'notify needs a non-blank body (the notification text)');
  }
  if (body.length > MAX_NOTIFY_BODY_LEN) {
    throw new AttentionError(
      'too-long',
      `notify body is ${body.length} characters; the maximum is ${MAX_NOTIFY_BODY_LEN}`,
    );
  }
  const title = raw['title'];
  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    throw new AttentionError('invalid', 'notify title must be a non-blank string when given');
  }
  if (typeof title === 'string' && title.length > MAX_NOTIFY_TITLE_LEN) {
    throw new AttentionError(
      'too-long',
      `notify title is ${title.length} characters; the maximum is ${MAX_NOTIFY_TITLE_LEN}`,
    );
  }
  const kind = raw['kind'];
  if (kind !== undefined && !(DIRECT_NOTIFICATION_KINDS as readonly unknown[]).includes(kind)) {
    throw new AttentionError('invalid', `notify kind must be one of ${DIRECT_NOTIFICATION_KINDS.join(', ')}`);
  }
  return {
    body,
    ...(typeof title === 'string' ? { title } : {}),
    ...(kind === undefined ? {} : { kind: kind as DirectNotificationKind }),
  };
}

/** Delivery surface implemented by PushNotifier.deliverDirect: filter devices
 * by their per-kind preferences and send, returning the delivered count. */
export interface AttentionPushDelivery {
  deliverDirect(items: readonly { payload: PushNotificationPayload; mode: InteractionMode }[]): Promise<number>;
}

export type AttentionNotifierSessions = Pick<KTeamService, 'get'>;

function truncate(value: string, max: number): string {
  const singleLine = value.replace(/\s+/gu, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function payloadBase(
  sessionId: string,
  config: { teammate?: string; name?: string },
  kind: PushNotificationKind,
  eventKey: string,
  title: string,
  body: string,
): PushNotificationPayload {
  return {
    version: 1,
    eventKey,
    title: truncate(title || (harnessDisplayName(config) ?? config.name ?? sessionId), MAX_NOTIFY_TITLE_LEN),
    body: truncate(body, 180),
    tag: `kteam-${sessionId}`,
    url: `/session/${encodeURIComponent(sessionId)}`,
    count: 1,
    sessionId,
    kind,
  };
}

export class AttentionNotifier {
  constructor(
    private readonly sessions: AttentionNotifierSessions,
    private readonly delivery: AttentionPushDelivery,
    private readonly log: (message: string) => void = message => console.error(message),
  ) {}

  /** Automatic path: called by AttentionService only when a mutation CREATED
   * an item. Fire-and-forget — a delivery failure never affects the write. */
  notifyNewItem(sessionId: string, item: AttentionItem): void {
    const policy = notificationPolicyForAttention(item.source);
    if (!policy.notifyOnNewItem || policy.kind === null) return;
    const kind = policy.kind;
    void (async () => {
      const view = await this.sessions.get(sessionId).catch(() => undefined);
      if (!view) return;
      await this.delivery.deliverDirect([
        {
          payload: payloadBase(
            view.config.id,
            view.config,
            kind,
            // One notification per item generation; a re-raise after a resolve
            // allocates a new id and therefore a new key.
            `attention:${view.config.id}:${item.id}`,
            '',
            item.subject,
          ),
          mode: view.config.mode,
        },
      ]);
    })().catch(error =>
      this.log(
        `kteamd attention notification failed for ${sessionId} (${error instanceof Error ? error.name : 'error'})`,
      ),
    );
  }

  /** Direct path (CLI/API). The actor is server-resolved by the API layer; an
   * agent may only notify from its own session, mirroring attention writes. */
  async notifyDirect(
    sessionRef: string,
    input: DirectNotificationInput,
    actor: AttentionActor,
  ): Promise<{ delivered: number }> {
    const view = await this.sessions.get(sessionRef).catch(() => undefined);
    if (!view) throw new AttentionError('not-found', `no such session ${sessionRef}`);
    const raw = typeof actor.actor === 'string' ? actor.actor.trim() : '';
    if (raw === 'daemon') throw new AttentionError('forbidden', 'daemon is a reserved in-process attention actor');
    if (raw !== '' && raw !== 'user') {
      const actorView = await this.sessions.get(raw).catch(() => undefined);
      if (!actorView || actorView.config.id !== view.config.id) {
        throw new AttentionError('forbidden', 'an agent may only send notifications from its own session');
      }
    }
    const delivered = await this.delivery.deliverDirect([
      {
        payload: payloadBase(
          view.config.id,
          view.config,
          input.kind ?? 'completed',
          `notify:${view.config.id}:${crypto.randomUUID()}`,
          input.title ?? '',
          input.body,
        ),
        mode: view.config.mode,
      },
    ]);
    return { delivered };
  }
}
