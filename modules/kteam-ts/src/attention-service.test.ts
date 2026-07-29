import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, sessionDir, type KTeamPaths } from './paths';
import { AttentionService } from './attention-service';
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

const service = () => new AttentionService(paths, deps, { role: 'daemon' });
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
  test('allocates stable monotonic ids and accepts the ? reference sigil', async () => {
    const s = service();
    const first = await s.add(SID, explicit('first'), AGENT);
    expect(first.items[0]!.id).toBe('A1');
    await s.resolve(SID, '?A1', 'done', HUMAN);
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
  test('agent may resolve any item in its own session and the clear is visible', async () => {
    const s = service();
    const added = await s.addFromSource(SID, {
      source: 'question',
      sourceRef: 'tool-1',
      subject: 'Choose',
      why: 'Waiting',
      howToResolve: 'Answer',
    });
    const resolved = await s.resolve(SID, added.items[0]!.id, 'Answered yes', AGENT);
    expect(resolved.count).toBe(0);
    expect(resolved.resolved[0]).toMatchObject({
      resolvedBy: 'agent',
      resolvedBySession: SID,
      resolvedByName: 'zoe',
      resolutionNote: 'Answered yes',
    });
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

  test('resolving shipped-reopen Attention stamps a durable per-task watermark', async () => {
    const s = service();
    await s.addFromSource(SID, {
      ...explicit('Shipped task reopened'),
      sourceRef: 'task-reopened:F31',
      waitingSince: '2026-07-28T01:00:00.000Z',
    });
    const resolved = await s.resolveFromSource(
      SID,
      'agent-raised',
      'task-reopened:F31',
      'The human reviewed it.',
      HUMAN,
    );
    expect(resolved.reopenResolvedAt?.['F31']).toBe(resolved.resolved[0]!.resolvedAt);
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
