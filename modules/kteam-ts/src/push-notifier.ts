import { harnessDisplayName } from './core';
import type { KTeamService, SessionView } from './service';
import type { InteractionMode, KTeamEvent, PendingQuestion, SessionState, SessionStatus } from './types';
import {
  deviceWantsNotification,
  pushKindForStatus,
  type PushDeviceRecord,
  type PushNotificationKind,
  type PushNotificationPayload,
  type VapidKeyPair,
} from './push-types';
import type { PushDelivery, PushDeliveryResult } from './push-sender';

export const PUSH_BURST_LIMIT = 3;
export const PUSH_BATCH_MS = 300;
export const PUSH_GROUP_WINDOW_MS = 15 * 60_000;
const MAX_GROUP_COUNT = 100;
const BODY_LIMIT = 180;

export interface PushNotifierStore {
  subscriptions(): Promise<PushDeviceRecord[]>;
  removeMany(revisions: ReadonlyMap<string, number>): Promise<number>;
}

export interface PushNotifierVapid {
  keys(): Promise<VapidKeyPair>;
}

export interface PushNotifierSender {
  deliver(deliveries: readonly PushDelivery[], keys: VapidKeyPair): Promise<PushDeliveryResult>;
}

export type PushNotifierSessions = Pick<KTeamService, 'list' | 'get' | 'subscribe'>;

function truncate(value: string, max = BODY_LIMIT): string {
  const singleLine = value.replace(/\s+/gu, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function bodyFor(view: SessionView, kind: PushNotificationKind): string {
  switch (kind) {
    case 'question': {
      const question = view.state.pendingQuestion?.questions[0]?.question;
      return question ? truncate(question, 120) : 'Asked you a question.';
    }
    case 'attention':
      return 'Waiting for you at the prompt.';
    case 'failed': {
      const label =
        view.state.status === 'stalled' ? 'Stalled' : view.state.status === 'kill_failed' ? 'Kill failed' : 'Failed';
      return view.state.reason ? truncate(`${label} — ${view.state.reason}`) : `${label}.`;
    }
    case 'completed':
      return 'Finished its task.';
  }
}

/** Shared deterministic identity with the UI core. Whichever transport wins
 * the race stores this in Notification.data; the other sees the same key and
 * skips instead of presenting a duplicate. */
export function pushNotificationEventKey(view: SessionView, kind: PushNotificationKind): string {
  const question = kind === 'question' ? (view.state.pendingQuestion?.toolUseId ?? '') : '';
  return [view.config.id, kind, view.state.status, String(view.state.turn), question].join(':');
}

export function buildPushNotification(
  view: SessionView,
  kind: PushNotificationKind,
  count = 1,
): PushNotificationPayload {
  const id = view.config.id;
  return {
    version: 1,
    eventKey: pushNotificationEventKey(view, kind),
    title: truncate(harnessDisplayName(view.config) ?? view.config.name ?? id, 120),
    body: bodyFor(view, kind),
    tag: `kteam-${id}`,
    url: `/session/${encodeURIComponent(id)}`,
    count: Math.max(1, Math.min(MAX_GROUP_COUNT, Math.floor(count))),
    sessionId: id,
    kind,
  };
}

export function summaryPushNotification(items: readonly PushNotificationPayload[]): PushNotificationPayload {
  let hash = 0x811c9dc5;
  const joined = items
    .map(item => item.eventKey)
    .sort()
    .join('\n');
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const eventKey = `fleet:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  return {
    version: 1,
    eventKey,
    title: 'kteam',
    body: `${items.length} sessions need your attention.`,
    tag: 'kteam-summary',
    url: '/',
    count: 1,
  };
}

function statusPatch(data: unknown): Partial<SessionState> & { status?: SessionStatus } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const raw = data as Record<string, unknown>;
  if (typeof raw['status'] !== 'string') return {};
  return {
    status: raw['status'] as SessionStatus,
    ...(typeof raw['health'] === 'string' ? { health: raw['health'] as SessionState['health'] } : {}),
    ...(typeof raw['reason'] === 'string' ? { reason: raw['reason'] } : {}),
    ...(raw['pendingQuestion'] && typeof raw['pendingQuestion'] === 'object'
      ? { pendingQuestion: raw['pendingQuestion'] as PendingQuestion }
      : {}),
  };
}

/** Status-event subscriber + short microbatcher. Grouping happens in this
 * order: newest event per session first; then, for each device, >3 distinct
 * sessions becomes one fleet summary. This reconciles the old burst rule with
 * Telegram-style conversations without a second competing summary system. */
export class PushNotifier {
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly groups = new Map<string, { count: number; at: number }>();
  private readonly pending = new Map<string, { view: SessionView; payload: PushNotificationPayload }>();
  private readonly chains = new Map<string, Promise<void>>();
  private dispatchTail: Promise<void> = Promise.resolve();
  private queuedWhileSeeding: KTeamEvent[] = [];
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seeding = false;
  private closed = false;

  constructor(
    private readonly sessions: PushNotifierSessions,
    private readonly store: PushNotifierStore,
    private readonly vapid: PushNotifierVapid,
    private readonly sender: PushNotifierSender,
    private readonly log: (message: string) => void = message => console.error(message),
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.seeding = true;
    this.unsubscribe = this.sessions.subscribe(event => {
      if (this.closed) return;
      if (this.seeding) this.queuedWhileSeeding.push(event);
      else this.enqueue(event, false);
    });
    for (const view of await this.sessions.list()) this.statuses.set(view.config.id, view.state.status);
    this.seeding = false;
    const queued = this.queuedWhileSeeding;
    this.queuedWhileSeeding = [];
    // These events happened after subscription but may already be reflected by
    // list(); force only their notifiable edge so the startup race loses none.
    for (const event of queued) this.enqueue(event, true);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.chains.values());
    await this.dispatchTail.catch(() => undefined);
    if (this.pending.size > 0) await this.flush();
  }

  private enqueue(event: KTeamEvent, force: boolean): void {
    const previous = this.chains.get(event.sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handle(event, force))
      .catch(error => this.log(`kteamd push event handling failed (${error instanceof Error ? error.name : 'error'})`));
    this.chains.set(event.sessionId, next);
    void next.finally(() => {
      if (this.chains.get(event.sessionId) === next) this.chains.delete(event.sessionId);
    });
  }

  private async handle(event: KTeamEvent, force: boolean): Promise<void> {
    if (event.type === 'session.deleted') {
      this.statuses.delete(event.sessionId);
      this.groups.delete(event.sessionId);
      this.pending.delete(event.sessionId);
      return;
    }
    const patch = statusPatch(event.data);
    if (!patch.status) return;
    const previous = this.statuses.get(event.sessionId);
    this.statuses.set(event.sessionId, patch.status);
    const kind = pushKindForStatus(patch.status);
    if (!kind || (!force && (previous === undefined || previous === patch.status))) return;
    const original = await this.sessions.get(event.sessionId).catch(() => undefined);
    if (!original) return;
    const view: SessionView = {
      ...original,
      state: {
        ...original.state,
        ...patch,
        status: patch.status,
        turn: event.turn || original.state.turn,
      },
    };
    const at = Number.isFinite(Date.parse(event.time)) ? Date.parse(event.time) : Date.now();
    const group = this.groups.get(event.sessionId);
    const count = !group || at - group.at > PUSH_GROUP_WINDOW_MS ? 1 : Math.min(MAX_GROUP_COUNT, group.count + 1);
    this.groups.set(event.sessionId, { count, at });
    this.pending.set(event.sessionId, { view, payload: buildPushNotification(view, kind, count) });
    this.scheduleFlush();
  }

  /** Direct, unbatched delivery for the attention/notify path (&F140). The
   * caller supplies finished payloads; this method only applies the per-device
   * preference filter and the shared expiry pruning. Returns the number of
   * successful deliveries. */
  async deliverDirect(items: readonly { payload: PushNotificationPayload; mode: InteractionMode }[]): Promise<number> {
    const eligible = items.filter(item => item.payload.kind !== undefined);
    if (eligible.length === 0) return 0;
    const devices = await this.store.subscriptions();
    if (devices.length === 0) return 0;
    const deliveries: PushDelivery[] = [];
    for (const device of devices) {
      for (const item of eligible) {
        if (deviceWantsNotification(device.prefs, item.payload.kind!, item.mode)) {
          deliveries.push({ device, payload: item.payload });
        }
      }
    }
    if (deliveries.length === 0) return 0;
    const result = await this.sender.deliver(deliveries, await this.vapid.keys());
    if (result.expiredDeviceRevisions.size > 0) await this.store.removeMany(result.expiredDeviceRevisions);
    if (result.failed > 0) {
      const statuses = [...new Set(result.failureStatuses)].join(', ');
      this.log(`kteamd push: ${result.failed} direct delivery attempt(s) failed (${statuses}; no retry queued)`);
    }
    return result.delivered;
  }

  private scheduleFlush(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Keep batches ordered. Otherwise a slow earlier POST can finish after a
      // later one and put an older line back on the phone despite Topic.
      const attempt = this.dispatchTail.then(() => this.flush());
      this.dispatchTail = attempt.catch(error =>
        this.log(`kteamd push dispatch failed (${error instanceof Error ? error.name : 'error'}; no retry queued)`),
      );
    }, PUSH_BATCH_MS);
  }

  private async flush(): Promise<void> {
    const items = [...this.pending.values()];
    this.pending.clear();
    if (items.length === 0) return;
    const devices = await this.store.subscriptions();
    if (devices.length === 0) return;
    const deliveries: PushDelivery[] = [];
    for (const device of devices) {
      const selected = items.filter(
        item => item.payload.kind && deviceWantsNotification(device.prefs, item.payload.kind, item.view.config.mode),
      );
      if (selected.length > PUSH_BURST_LIMIT) {
        deliveries.push({ device, payload: summaryPushNotification(selected.map(item => item.payload)) });
      } else {
        for (const item of selected) deliveries.push({ device, payload: item.payload });
      }
    }
    if (deliveries.length === 0) return;
    const result = await this.sender.deliver(deliveries, await this.vapid.keys());
    if (result.expiredDeviceRevisions.size > 0) await this.store.removeMany(result.expiredDeviceRevisions);
    if (result.failed > 0) {
      const statuses = [...new Set(result.failureStatuses)].join(', ');
      this.log(`kteamd push: ${result.failed} delivery attempt(s) failed (${statuses}); retained for the next event`);
    }
  }
}
