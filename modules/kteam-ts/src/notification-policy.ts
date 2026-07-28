// The boundary between persistent attention records and session-addressed OS
// notifications. This module deliberately presents nothing. Notification
// identity, title, tag, grouping, foreground suppression and delivery stay in
// the existing ui/lib/notify + push-notifier + service-worker core.

import type { PushNotificationKind } from './push-types';
import type { AttentionSource } from './attention-types';

export interface AttentionNotificationPolicy {
  /** Whether this source's existing SESSION transition is eligible to notify.
   * The attention.updated event itself must never be a second presenter. */
  notifyViaSessionTransition: boolean;
  kind: PushNotificationKind | null;
}

/** Quiet by default for durable board changes. Questions and permission prompts
 * already have a canonical session transition and reuse that exact event key /
 * per-session tag. Task blockers and explicit agent requests badge the fleet
 * but do not buzz merely because the durable record was written. */
export function notificationPolicyForAttention(source: AttentionSource): AttentionNotificationPolicy {
  switch (source) {
    case 'question':
      return { notifyViaSessionTransition: true, kind: 'question' };
    case 'permission':
      return { notifyViaSessionTransition: true, kind: 'attention' };
    case 'task':
    case 'agent-raised':
      return { notifyViaSessionTransition: false, kind: null };
  }
}

/** Informational notification classes prove the inverse boundary: completion
 * and failure may notify, but do not create a persistent attention item. A
 * generic ready prompt may notify as attention in the existing policy while
 * still not inventing a durable item without one of the four explicit sources. */
export function notificationCreatesAttention(kind: PushNotificationKind): boolean {
  return kind === 'question';
}
