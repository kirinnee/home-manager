import { describe, expect, test } from 'bun:test';
import { SessionManager, peerPreamble } from './session-manager';
import { detectAnomalies } from './warden-detect';
import type { SessionConfig, SessionState } from './types';

// PEER MESSAGING: one kteam session addressing another by name.
//
// Names already resolved fleet-wide, so `kteam send <teammate>` reached the
// right pane — but the message arrived indistinguishable from the human lead's
// own words, and a sender that wanted an ANSWER had nothing to do but poll
// (which the reflex layer reads as a stall). These tests pin the three things
// that make it a real pattern:
//
//   1. attribution — the receiver can tell a peer from the lead;
//   2. request/response — the asker parks, and the reply itself un-parks it;
//   3. the park is HEALTHY to every supervision layer, except when the peer
//      can no longer answer at all.

type Loose = Record<string, unknown>;

const bare = () => Object.create(SessionManager.prototype) as Loose;

const cfg = (over: Partial<SessionConfig> = {}): SessionConfig =>
  ({ id: 's1', turn: 1, teammate: 'mordecai', ...over }) as SessionConfig;

describe('peer attribution (the preamble a teammate actually reads)', () => {
  test('names the sender and says explicitly that it is NOT the human lead', () => {
    const text = peerPreamble({ config: cfg({ id: 'sX', teammate: 'wilhelmina' }) }, false);
    expect(text).toContain('wilhelmina');
    expect(text).toContain('sX');
    expect(text).toContain('not from the human lead');
  });

  test('fire-and-forget does NOT demand a reply', () => {
    const text = peerPreamble({ config: cfg({ teammate: 'archie' }) }, false);
    expect(text).toContain('No reply is required');
    expect(text).not.toContain('PARKED');
  });

  test('request/response states the sender is blocked AND the exact reply command', () => {
    // The addressing rule is the step teammates get wrong, so the banner spells
    // the whole command out rather than saying "reply to archie".
    const text = peerPreamble({ config: cfg({ teammate: 'archie' }) }, true);
    expect(text).toContain('PARKED');
    expect(text).toContain('kteam send archie');
  });

  test('falls back to the session id when a peer has no callsign', () => {
    const text = peerPreamble({ config: cfg({ id: 'raw-id', teammate: undefined }) }, true);
    expect(text).toContain('raw-id');
    expect(text).toContain('kteam send raw-id');
  });
});

describe('declaring a peer wait', () => {
  interface Harness {
    manager: Loose;
    transitions: Array<{ patch: Partial<SessionState>; event: string }>;
    events: Array<{ type: string; data: Record<string, unknown> }>;
  }

  function harness(peers: Record<string, { config: SessionConfig; state: SessionState }>): Harness {
    const transitions: Array<{ patch: Partial<SessionState>; event: string }> = [];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const manager = bare();
    manager.resolveRef = (ref: string) => Object.values(peers).find(p => p.config.teammate === ref)?.config.id ?? ref;
    manager.get = async (id: string) => {
      const found = peers[id];
      if (!found) throw new Error(`unknown kteam session ${id}`);
      return { ...found, directory: `/tmp/${id}` };
    };
    manager.transition = async (_id: string, patch: Partial<SessionState>, event: string) => {
      transitions.push({ patch, event });
    };
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
    };
    return { manager, transitions, events };
  }

  const declare = (h: Harness, view: unknown, options: Record<string, unknown>) =>
    (
      h.manager as unknown as {
        applyWaitingSignal: (v: unknown, k: string, m: string | undefined, o: unknown) => Promise<unknown>;
      }
    ).applyWaitingSignal(view, 'waiting', undefined, options);

  const self = {
    config: cfg({ id: 's1', teammate: 'wilhelmina' }),
    state: { id: 's1', status: 'running' } as SessionState,
  };
  const peer = {
    config: cfg({ id: 's2', teammate: 'archie' }),
    state: { id: 's2', status: 'running' } as SessionState,
  };

  test('records the peer id AND its callsign, resolved from a name', async () => {
    const h = harness({ s1: self, s2: peer });
    await declare(h, { ...self, directory: '/tmp/s1' }, { peer: 'archie' });

    const [t] = h.transitions;
    expect(t!.event).toBe('session.waiting');
    expect(t!.patch.status).toBe('waiting');
    expect(t!.patch.waiting?.peer).toBe('s2');
    expect(t!.patch.waiting?.peerName).toBe('archie');
    // The reason line names who is expected to unblock it — the fact a lead
    // reading `ps` needs.
    expect(t!.patch.reason).toContain('reply from archie');
  });

  test('an UNKNOWN peer is refused, not parked on', async () => {
    // Parking on a typo would suspend the reflex layer waiting for a reply that
    // can never arrive: the 4h backstop would wake it eventually, but hours
    // late and with no explanation. Fail while the teammate can still fix it.
    const h = harness({ s1: self, s2: peer });
    await expect(declare(h, { ...self, directory: '/tmp/s1' }, { peer: 'nobody' })).rejects.toThrow(
      'unknown kteam session',
    );
    expect(h.transitions).toHaveLength(0);
  });

  test('a session cannot park on its own reply', async () => {
    const h = harness({ s1: self });
    await expect(declare(h, { ...self, directory: '/tmp/s1' }, { peer: 'wilhelmina' })).rejects.toThrow(
      'cannot wait on a reply from itself',
    );
    expect(h.transitions).toHaveLength(0);
  });
});

describe('endPeerWait (the reply is what un-parks the asker)', () => {
  function harness(recipient: SessionState) {
    const cleared: Array<{ id: string; reason: string }> = [];
    const manager = bare();
    manager.get = async (id: string) => ({ config: cfg({ id }), state: recipient, directory: `/tmp/${id}` });
    manager.clearWaiting = async (id: string, reason: string) => {
      cleared.push({ id, reason });
    };
    return { manager, cleared };
  }

  const end = (m: Loose, recipientId: string, senderId: string) =>
    (m as unknown as { endPeerWait: (r: string, s: string) => Promise<void> }).endPeerWait(recipientId, senderId);

  test('ends a park that was declared on THIS sender', async () => {
    const h = harness({
      id: 's1',
      status: 'waiting',
      turn: 1,
      waiting: { since: '2026-07-25T00:00:00.000Z', peer: 's2', peerName: 'archie' },
    } as SessionState);
    await end(h.manager, 's1', 's2');
    expect(h.cleared).toEqual([{ id: 's1', reason: 'archie replied' }]);
  });

  test('leaves a park declared on a DIFFERENT peer outstanding', async () => {
    // An unrelated peer chiming in must not release a wait whose real answer is
    // still owed — that would resume a teammate without the fact it asked for.
    const h = harness({
      id: 's1',
      status: 'waiting',
      turn: 1,
      waiting: { since: '2026-07-25T00:00:00.000Z', peer: 's9', peerName: 'julie' },
    } as SessionState);
    await end(h.manager, 's1', 's2');
    expect(h.cleared).toEqual([]);
  });

  test('is a no-op for a session that is not parked at all', async () => {
    const h = harness({ id: 's1', status: 'running', turn: 1 } as SessionState);
    await end(h.manager, 's1', 's2');
    expect(h.cleared).toEqual([]);
  });
});

// The supervision layers must read a peer park as HEALTHY — that is the whole
// point of declaring it. The one exception is a peer that can never answer.
describe('the warden treats a peer wait as legitimate', () => {
  const nowMs = Date.parse('2026-07-25T12:00:00.000Z');
  const options = {
    unattendedMs: 30 * 60_000,
    terminalWindowMs: 60 * 60_000,
    susThinkingSeconds: 900,
    susSubprocessSeconds: 900,
  };

  const waiter = (peerId: string, sinceIso = '2026-07-25T11:00:00.000Z') => ({
    config: {
      id: 's1',
      teammate: 'wilhelmina',
      mode: 'auto',
      createdAt: '2026-07-25T10:00:00.000Z',
      updatedAt: sinceIso,
    } as SessionConfig,
    state: {
      id: 's1',
      status: 'waiting',
      turn: 1,
      lastActivityAt: sinceIso,
      waiting: { since: sinceIso, peer: peerId, peerName: 'archie' },
    } as SessionState,
    hasLiveMonitor: true,
  });

  const peerIn = (status: SessionState['status']) => ({
    config: { id: 's2', teammate: 'archie', mode: 'auto', createdAt: '2026-07-25T10:00:00.000Z' } as SessionConfig,
    state: { id: 's2', status, turn: 1 } as SessionState,
    hasLiveMonitor: status === 'running',
  });

  test('a session parked on a LIVE peer is not an anomaly, however long it has idled', () => {
    // An hour of silence with no life-signs is exactly what awaiting a reply
    // looks like. Without the declared wait this is `unattended_question`.
    const found = detectAnomalies([waiter('s2'), peerIn('running')], nowMs, options);
    expect(found.anomalies.filter(a => a.sessionId === 's1')).toEqual([]);
  });

  test('a peer that COMPLETED can never reply — flag it immediately', () => {
    const found = detectAnomalies([waiter('s2'), peerIn('completed')], nowMs, options);
    const anomaly = found.anomalies.find(a => a.sessionId === 's1');
    expect(anomaly?.kind).toBe('peer_wait_unanswerable');
    expect(anomaly?.detail).toContain('archie');
    expect(anomaly?.detail).toContain('completed');
    // Judgement is required (re-ask, continue without, or stop), so this gets
    // its own assigned warden rather than a mechanical retry.
    expect(anomaly?.assignedWarden).toBe(true);
  });

  test('a terminal peer stays honestly terminal when the detector receives only live sweep rows', () => {
    const found = detectAnomalies([waiter('s2')], nowMs, options, [waiter('s2'), peerIn('completed')]);
    const anomaly = found.anomalies.find(a => a.sessionId === 's1');
    expect(anomaly?.kind).toBe('peer_wait_unanswerable');
    expect(anomaly?.detail).toContain('completed');
    expect(anomaly?.detail).not.toContain('not a known session');
  });

  test('a peer that no longer exists is flagged as unanswerable too', () => {
    const found = detectAnomalies([waiter('ghost')], nowMs, options);
    const anomaly = found.anomalies.find(a => a.sessionId === 's1');
    expect(anomaly?.kind).toBe('peer_wait_unanswerable');
    expect(anomaly?.detail).toContain('not a known session');
  });

  test('the waiter being terminal itself is finished history, not an anomaly', () => {
    const stopped = waiter('s2');
    stopped.state = { ...stopped.state, status: 'stopped' };
    const found = detectAnomalies([stopped, peerIn('failed')], nowMs, options);
    expect(found.anomalies.filter(a => a.sessionId === 's1')).toEqual([]);
  });
});
