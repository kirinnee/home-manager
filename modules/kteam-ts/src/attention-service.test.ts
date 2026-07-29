import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, sessionDir, type KTeamPaths } from './paths';
import { AttentionService, type AttentionDeps } from './attention-service';
import { MAX_AGENT_ATTENTION_PER_SESSION, MAX_ATTENTION_PER_SESSION, type AttentionActor } from './attention-types';
import type { KTeamEvent } from './types';

let home: string;
let paths: KTeamPaths;
const SID = 'ms3g6a8p-71542ce1';
const OTHER = 'ms2bkdxy-c845508e';
const HUMAN: AttentionActor = { actor: 'user' };
const AGENT: AttentionActor = { actor: SID, actorName: 'zoe' };
const deps = {
  resolve: async (ref: string) => {
    if (ref === SID || ref === 'zoe') return { id: SID, name: 'zoe' };
    if (ref === OTHER) return { id: OTHER, name: 'other' };
    return null;
  },
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-attention-service-'));
  paths = createPaths(home);
  await mkdir(sessionDir(paths, SID), { recursive: true });
  await mkdir(sessionDir(paths, OTHER), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const service = (over: Partial<AttentionDeps> = {}) =>
  new AttentionService(paths, { ...deps, ...over }, { role: 'daemon' });
const explicit = (subject: string) => ({
  source: 'agent-raised' as const,
  subject,
  why: `${subject} blocks progress`,
  howToResolve: `Reply about ${subject}`,
});

describe('provenance and scope', () => {
  test('stamps human, agent and daemon from the resolved actor', async () => {
    const s = service();
    expect((await s.add(SID, explicit('human request'), HUMAN)).items[0]).toMatchObject({
      raisedBy: 'human',
      raisedBySession: null,
    });
    expect(
      (await s.add(SID, explicit('agent request'), AGENT)).items.find(item => item.subject === 'agent request'),
    ).toMatchObject({
      raisedBy: 'agent',
      raisedBySession: SID,
      raisedByName: 'zoe',
    });
    expect(
      (
        await s.addFromSource(SID, {
          source: 'task',
          sourceRef: 'F31',
          subject: 'Blocked task',
          why: 'Needs a decision',
          howToResolve: 'Decide',
        })
      ).items.find(item => item.source === 'task'),
    ).toMatchObject({ raisedBy: 'daemon' });
  });

  test('an agent may mutate only its own session; human and trusted sources may target known sessions', async () => {
    const s = service();
    await expect(s.add(OTHER, explicit('cross'), AGENT)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await s.add(OTHER, explicit('human'), HUMAN)).count).toBe(1);
    expect((await s.addFromSource(OTHER, { ...explicit('daemon'), source: 'permission' })).count).toBe(2);
    await expect(s.add(SID, explicit('forged daemon'), { actor: 'daemon' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(s.add('missing', explicit('x'), HUMAN)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('a client cannot forge an automatic source or backdate itself', async () => {
    const s = service();
    await expect(s.add(SID, { ...explicit('forged'), source: 'question' }, AGENT)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      s.add(SID, { ...explicit('forged reopen'), sourceRef: 'task-reopened:F31' }, AGENT),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const snap = await s.add(SID, { ...explicit('dated'), waitingSince: '2000-01-01T00:00:00.000Z' }, AGENT);
    expect(snap.items[0]!.waitingSince).not.toBe('2000-01-01T00:00:00.000Z');
    const untrustedSeq = await s.add(SID, { ...explicit('untrusted seq'), sourceSeq: 99 }, AGENT);
    expect(untrustedSeq.items.find(item => item.subject === 'untrusted seq')?.sourceSeq).toBeUndefined();
    const ordinaryDaemon = await s.addFromSource(SID, {
      ...explicit('ordinary daemon source'),
      source: 'task',
      sourceRef: 'F31',
      sourceSeq: 99,
    });
    expect(ordinaryDaemon.items.find(item => item.sourceRef === 'F31')?.sourceSeq).toBeUndefined();
    await expect(
      s.addFromSource(SID, {
        ...explicit('invalid reopen seq'),
        sourceRef: 'task-reopened:F31',
        sourceSeq: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  test('subject is the ask: a multi-line subject is refused with guidance', async () => {
    const s = service();
    await expect(
      s.add(SID, { ...explicit('the ask'), subject: 'the ask\nplus a paragraph of backstory' }, AGENT),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  test('context is stored, deduped and refreshed like the other detail fields', async () => {
    const s = service();
    const withContext = {
      ...explicit('needs background'),
      context: 'A **warden** is the fleet supervisor; it flagged this session.',
    };
    const first = await s.add(SID, withContext, AGENT);
    expect(first.items[0]!.context).toBe(withContext.context);
    const deduped = await s.add(SID, withContext, AGENT);
    expect(deduped.updatedAt).toBe(first.updatedAt);
    // Same text with different context is a different request, not a dupe.
    const different = await s.add(SID, { ...withContext, context: 'Different background.' }, AGENT);
    expect(different.items).toHaveLength(2);
    // A stable source refreshes context in place, and can drop it again.
    const stable = await s.addFromSource(SID, { ...explicit('stable'), source: 'task', sourceRef: 'F31' });
    const refreshed = await s.addFromSource(SID, {
      ...explicit('stable'),
      source: 'task',
      sourceRef: 'F31',
      context: 'Now with background.',
    });
    const item = refreshed.items.find(entry => entry.sourceRef === 'F31');
    expect(item).toMatchObject({ id: stable.items.find(entry => entry.sourceRef === 'F31')!.id });
    expect(item?.context).toBe('Now with background.');
    const dropped = await s.addFromSource(SID, { ...explicit('stable'), source: 'task', sourceRef: 'F31' });
    expect(dropped.items.find(entry => entry.sourceRef === 'F31')?.context).toBeUndefined();
    // Round-trips through the durable file.
    expect((await s.list(SID)).items.find(entry => entry.subject === 'needs background')?.context).toBe(
      withContext.context,
    );
  });

  test('aliases always persist under the canonical session directory', async () => {
    const s = service();
    const snapshot = await s.add('zoe', explicit('via alias'), HUMAN);
    expect(snapshot.sessionId).toBe(SID);
    expect((await s.list(SID)).count).toBe(1);
    expect(existsSync(s.attention.file('zoe'))).toBe(false);
  });
});

describe('ordering, dedupe and capacity', () => {
  test('allocates stable monotonic ids and accepts the ! reference sigil', async () => {
    const s = service();
    const first = await s.add(SID, explicit('first'), AGENT);
    expect(first.items[0]!.id).toBe('A1');
    await s.resolve(SID, '!A1', 'done', HUMAN);
    const second = await s.add(SID, explicit('second'), AGENT);
    expect(second.items[0]!.id).toBe('A2');
    expect(second.resolved[0]!.id).toBe('A1');
  });

  test('daemon waitingSince controls oldest-first order', async () => {
    const s = service();
    await s.addFromSource(SID, { ...explicit('new'), waitingSince: '2026-07-28T02:00:00.000Z' });
    const snap = await s.addFromSource(SID, {
      ...explicit('old'),
      waitingSince: '2026-07-28T01:00:00.000Z',
    });
    expect(snap.items.map(item => item.subject)).toEqual(['old', 'new']);
  });

  test('stable sourceRef updates in place while identical free-form adds dedupe', async () => {
    const s = service();
    await s.add(SID, explicit('same'), AGENT);
    await s.add(SID, explicit('same'), AGENT);
    const first = await s.addFromSource(SID, {
      source: 'task',
      sourceRef: 'F31',
      subject: 'first',
      why: 'x',
      howToResolve: 'y',
      waitingSince: '2026-07-28T01:00:00.000Z',
    });
    const snap = await s.addFromSource(SID, {
      source: 'task',
      sourceRef: 'F31',
      subject: 'changed display',
      why: 'z',
      howToResolve: 'q',
      waitingSince: '2026-07-28T03:00:00.000Z',
    });
    expect(snap.items).toHaveLength(2);
    expect(snap.items.find(item => item.sourceRef === 'F31')).toMatchObject({
      id: first.items.find(item => item.sourceRef === 'F31')?.id,
      subject: 'changed display',
      why: 'z',
      howToResolve: 'q',
      waitingSince: '2026-07-28T01:00:00.000Z',
    });
  });

  test('shipped-reopen refresh never regresses a generation and updates text with a newer seq', async () => {
    const s = service();
    const base = {
      ...explicit('generation two'),
      sourceRef: 'task-reopened:F31',
      sourceSeq: 2,
      waitingSince: '2026-07-28T01:00:00.000Z',
    };
    const first = await s.addFromSource(SID, base);
    const stale = await s.addFromSource(SID, {
      ...base,
      subject: 'stale generation one',
      why: 'stale reason',
      sourceSeq: 1,
    });
    expect(stale.updatedAt).toBe(first.updatedAt);
    expect(stale.items[0]).toMatchObject({ subject: 'generation two', sourceSeq: 2 });

    const newer = await s.addFromSource(SID, {
      ...base,
      subject: 'generation three',
      why: 'new reason',
      howToResolve: 'review generation three',
      sourceSeq: 3,
    });
    expect(newer.items).toHaveLength(1);
    expect(newer.items[0]).toMatchObject({
      id: first.items[0]?.id,
      subject: 'generation three',
      why: 'new reason',
      howToResolve: 'review generation three',
      sourceSeq: 3,
      waitingSince: '2026-07-28T01:00:00.000Z',
    });
  });

  test('resolved shipped-reopen generation ignores stale redelivery but permits a newer generation', async () => {
    const s = service();
    const generationR = {
      ...explicit('generation R'),
      sourceRef: 'task-reopened:F31',
      sourceSeq: 7,
    };
    const raised = await s.addFromSource(SID, generationR);
    const resolved = await s.resolve(SID, raised.items[0]!.id, 'Reviewed generation R.', HUMAN);

    const stale = await s.addFromSource(SID, {
      ...generationR,
      subject: 'queued duplicate generation R',
    });
    expect(stale.updatedAt).toBe(resolved.updatedAt);
    expect(stale.items).toHaveLength(0);
    expect(stale.resolved).toHaveLength(1);

    const newer = await s.addFromSource(SID, {
      ...generationR,
      subject: 'generation M',
      why: 'A newer shipped regression needs review.',
      sourceSeq: 9,
    });
    expect(newer.items).toContainEqual(expect.objectContaining({ subject: 'generation M', sourceSeq: 9 }));
  });

  test('active cap refuses rather than evicting the oldest', async () => {
    const s = service();
    for (let index = 0; index < MAX_ATTENTION_PER_SESSION; index += 1) {
      await s.addFromSource(SID, { ...explicit(`daemon ${index}`), sourceRef: `d${index}` });
    }
    await expect(s.addFromSource(SID, { ...explicit('overflow'), sourceRef: 'overflow' })).rejects.toMatchObject({
      code: 'full',
    });
    const snapshot = await s.list(SID);
    expect(snapshot.items).toHaveLength(MAX_ATTENTION_PER_SESSION);
    expect(snapshot.items.some(item => item.subject === 'daemon 0')).toBe(true);
  });

  test('agent sub-cap does not consume daemon/human capacity', async () => {
    const s = service();
    for (let index = 0; index < MAX_AGENT_ATTENTION_PER_SESSION; index += 1) {
      await s.add(SID, explicit(`agent ${index}`), AGENT);
    }
    await expect(s.add(SID, explicit('agent overflow'), AGENT)).rejects.toMatchObject({ code: 'full' });
    const snap = await s.addFromSource(SID, { ...explicit('daemon still fits'), sourceRef: 'daemon' });
    expect(snap.items.filter(item => item.raisedBy === 'agent')).toHaveLength(MAX_AGENT_ATTENTION_PER_SESSION);
    expect(snap.items.some(item => item.raisedBy === 'daemon')).toBe(true);
  });
});

describe('explicit resolution audit', () => {
  test('agent may retract only an item it raised itself and the clear is visible', async () => {
    const s = service();
    const own = await s.add(SID, explicit('own request'), AGENT);
    const resolved = await s.resolve(SID, own.items[0]!.id, 'No longer needed', AGENT);
    expect(resolved.count).toBe(0);
    expect(resolved.resolved[0]).toMatchObject({
      resolvedBy: 'agent',
      resolvedBySession: SID,
      resolvedByName: 'zoe',
      resolutionNote: 'No longer needed',
    });
  });

  test('agent may not dismiss an item raised by the daemon, the human, or another agent', async () => {
    const s = service();
    const daemonRaised = await s.addFromSource(SID, {
      source: 'question',
      sourceRef: 'tool-1',
      subject: 'Choose',
      why: 'Waiting',
      howToResolve: 'Answer',
    });
    await expect(s.resolve(SID, daemonRaised.items[0]!.id, 'agent clears it', AGENT)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const humanRaised = await s.add(SID, explicit('human ask'), HUMAN);
    const humanItem = humanRaised.items.find(item => item.raisedBy === 'human')!;
    await expect(s.resolve(SID, humanItem.id, 'agent clears it', AGENT)).rejects.toMatchObject({
      code: 'forbidden',
    });
    // The human can always dismiss anything, including daemon-raised items.
    const cleared = await s.resolve(SID, daemonRaised.items[0]!.id, 'Human reviewed it.', HUMAN);
    expect(cleared.resolved[0]).toMatchObject({ resolvedBy: 'human' });
    // Everything an agent could not dismiss is still on the board.
    expect((await s.list(SID)).items.some(item => item.id === humanItem.id)).toBe(true);
  });

  test('retried resolve preserves the original resolver', async () => {
    const s = service();
    const id = (await s.add(SID, explicit('once'), AGENT)).items[0]!.id;
    await s.resolve(SID, id, 'agent did it', AGENT);
    const retried = await s.resolve(SID, id, 'human retry', HUMAN);
    expect(retried.resolved[0]).toMatchObject({ resolvedBy: 'agent', resolutionNote: 'agent did it' });
  });

  test('resolved source may be genuinely re-raised and source resolution is explicit', async () => {
    const s = service();
    const input = {
      source: 'task' as const,
      sourceRef: 'F31',
      subject: 'Task',
      why: 'Blocked',
      howToResolve: 'Decide',
    };
    await s.addFromSource(SID, input);
    await s.resolveFromSource(SID, 'task', 'F31', 'Task moved', HUMAN);
    const reraised = await s.addFromSource(SID, input);
    expect(reraised.count).toBe(1);
    expect(reraised.resolved).toHaveLength(1);
  });

  test('resolving acknowledges the item generation task-first for both resolver paths', async () => {
    const calls: Array<{ sessionId: string; taskId: string; seq: number; actor: AttentionActor; note?: string }> = [];
    const s = service({
      ackReopen: async (sessionId, taskId, seq, actor, note) => {
        calls.push({ sessionId, taskId, seq, actor, ...(note === undefined ? {} : { note }) });
      },
    });
    const first = await s.addFromSource(SID, {
      ...explicit('Shipped task reopened'),
      sourceRef: 'task-reopened:F31',
      sourceSeq: 7,
      waitingSince: '2026-07-28T01:00:00.000Z',
    });
    const resolved = await s.resolve(SID, first.items[0]!.id, 'The human reviewed it.', HUMAN);
    expect(calls).toEqual([
      {
        sessionId: SID,
        taskId: 'F31',
        seq: 7,
        actor: { actor: 'user' },
        note: 'The human reviewed it.',
      },
    ]);
    expect(resolved.reopenResolvedAt).toBeUndefined();

    await s.addFromSource(SID, {
      ...explicit('Shipped task reopened again'),
      sourceRef: 'task-reopened:F31',
      sourceSeq: 9,
    });
    await s.resolveFromSource(SID, 'agent-raised', 'task-reopened:F31', 'Agent handled it.', AGENT);
    expect(calls[1]).toEqual({
      sessionId: SID,
      taskId: 'F31',
      seq: 9,
      actor: { actor: SID, actorName: 'zoe' },
      note: 'Agent handled it.',
    });

    await s.addFromSource(SID, {
      ...explicit('Legacy shipped reopen'),
      sourceRef: 'task-reopened:F32',
    });
    await s.resolveFromSource(SID, 'agent-raised', 'task-reopened:F32', 'Legacy reviewed.', HUMAN);
    expect(calls).toHaveLength(2);
  });

  test('acknowledgement failure aborts resolution and leaves the item visible', async () => {
    const s = service({
      ackReopen: async () => {
        throw new Error('task write failed');
      },
    });
    const added = await s.addFromSource(SID, {
      ...explicit('Shipped task reopened'),
      sourceRef: 'task-reopened:F31',
      sourceSeq: 7,
    });
    await expect(s.resolve(SID, added.items[0]!.id, 'reviewed', HUMAN)).rejects.toThrow('task write failed');
    await s.addFromSource(SID, {
      ...explicit('Another shipped task reopened'),
      sourceRef: 'task-reopened:F32',
      sourceSeq: 8,
    });
    await expect(s.resolveFromSource(SID, 'agent-raised', 'task-reopened:F32', 'reviewed', HUMAN)).rejects.toThrow(
      'task write failed',
    );
    const snapshot = await s.list(SID);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.resolved).toHaveLength(0);
  });

  test('trusted source resolution records a cross-session lead without opening a general write path', async () => {
    const s = service();
    await s.addFromSource(SID, {
      source: 'question',
      sourceRef: 'q-lead',
      subject: 'Choose',
      why: 'Waiting',
      howToResolve: 'Answer',
    });
    const resolved = await s.resolveFromSource(SID, 'question', 'q-lead', 'Lead answered.', {
      actor: OTHER,
      actorName: 'forged name',
    });
    expect(resolved.resolved[0]).toMatchObject({
      resolvedBy: 'agent',
      resolvedBySession: OTHER,
      resolvedByName: 'other',
    });
    await expect(s.add(SID, explicit('cross write'), { actor: OTHER })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('live convergence and cheap count', () => {
  test('each mutation emits a whole attention.updated snapshot', async () => {
    const s = service();
    const events: KTeamEvent[] = [];
    s.subscribe(event => events.push(event));
    const added = await s.add(SID, explicit('watch'), AGENT);
    await s.resolve(SID, added.items[0]!.id, null, HUMAN);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sequence: 0, sessionId: SID, type: 'attention.updated', source: `peer:${SID}` });
    expect((events[1]!.data as { count: number }).count).toBe(0);
  });

  test('dedupe and retried resolution do not rewrite or emit', async () => {
    const s = service();
    const events: KTeamEvent[] = [];
    s.subscribe(event => events.push(event));
    const first = await s.add(SID, explicit('once'), AGENT);
    const deduped = await s.add(SID, explicit('once'), AGENT);
    expect(deduped.updatedAt).toBe(first.updatedAt);
    await s.resolve(SID, first.items[0]!.id, null, HUMAN);
    await s.resolve(SID, first.items[0]!.id, null, HUMAN);
    expect(events).toHaveLength(2);
  });

  test('count reads the persisted scalar', async () => {
    const s = service();
    expect(await s.count(SID)).toBe(0);
    await s.add(SID, explicit('one'), AGENT);
    expect(await s.count(SID)).toBe(1);
  });
});
