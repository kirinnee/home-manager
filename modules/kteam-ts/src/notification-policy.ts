// The boundary between persistent attention records and session-addressed OS
// notifications. This module deliberately presents nothing. Notification
// identity, title, tag, grouping, foreground suppression and delivery stay in
// the existing ui/lib/notify + push-notifier + service-worker core; the
// attention-path presenter is attention-notifier.ts.

import type { PushNotificationKind } from './push-types';
import type { AttentionSource } from './attention-types';

export interface AttentionNotificationPolicy {
  /** Whether this source's existing SESSION transition is eligible to notify.
   * The attention.updated event itself must never be a second presenter. */
  notifyViaSessionTransition: boolean;
  /** Whether a genuinely NEW durable item on this source pushes through the
   * attention path (&F140: anything needing attention notifies automatically).
   * Exactly one of the two paths presents, so an item never buzzes twice. */
  notifyOnNewItem: boolean;
  kind: PushNotificationKind | null;
}

/** Questions already have a canonical session transition and reuse that exact
 * event key / per-session tag, so their durable record stays quiet. Every
 * other source notifies when its durable item is CREATED — dedupes and
 * in-place refreshes stay silent (see AttentionDeps.notifyNewItem). */
export function notificationPolicyForAttention(source: AttentionSource): AttentionNotificationPolicy {
  switch (source) {
    case 'question':
      return { notifyViaSessionTransition: true, notifyOnNewItem: false, kind: 'question' };
    case 'task':
    case 'agent-raised':
      return { notifyViaSessionTransition: false, notifyOnNewItem: true, kind: 'attention' };
  }
}

/** Informational notification classes prove the inverse boundary: completion
 * and failure may notify, but do not create a persistent attention item. A
 * generic ready prompt may notify as attention in the existing policy while
 * still not inventing a durable item without one of the explicit sources. */
export function notificationCreatesAttention(kind: PushNotificationKind): boolean {
  return kind === 'question';
}
