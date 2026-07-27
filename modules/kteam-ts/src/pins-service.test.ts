import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, sessionDir, type KTeamPaths } from './paths';
import { PinService } from './pins-service';
import type { KTeamEvent } from './types';
import { MAX_AGENT_PINS_PER_SESSION, PinError, type PinActor, type Pin } from './pins-types';

let home: string;
let paths: KTeamPaths;
const SID = 'ms3g6a8p-71542ce1';
const OTHER = 'ms2bkdxy-c845508e';

const HUMAN: PinActor = { actor: 'user', actorName: 'user' };
const AGENT: PinActor = { actor: SID, actorName: 'zoe' };

/** deps stub: both known sessions exist. */
const deps = { has: async (id: string) => id === SID || id === OTHER };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-pins-svc-'));
  paths = createPaths(home);
  await mkdir(sessionDir(paths, SID), { recursive: true });
  await mkdir(sessionDir(paths, OTHER), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const svc = () => new PinService(paths, deps, { role: 'daemon' });

describe('provenance', () => {
  test('a human note is by human with no attribution', async () => {
    const snap = await svc().add(SID, { kind: 'note', text: 'PR link' }, HUMAN);
    expect(snap.pins[0]).toMatchObject({ by: 'human', createdBy: null, createdByName: null });
  });
  test('an agent note is by agent with session id + callsign', async () => {
    const snap = await svc().add(SID, { kind: 'note', text: 'built it' }, AGENT);
    expect(snap.pins[0]).toMatchObject({ by: 'agent', createdBy: SID, createdByName: 'zoe' });
  });
  test('provenance is NOT taken from the body — an agent cannot forge human', async () => {
    // The body has no by/createdBy fields for add anyway, but confirm the service
    // stamps from the actor regardless.
    const snap = await svc().add(SID, { kind: 'note', text: 'x' } as never, AGENT);
    expect(snap.pins[0]!.by).toBe('agent');
  });
});

describe('scope-to-self', () => {
  test('an agent may only pin to its own session', async () => {
    await expect(svc().add(OTHER, { kind: 'note', text: 'x' }, AGENT)).rejects.toThrow(/own session/);
  });
  test('the human may pin to any session', async () => {
    const snap = await svc().add(OTHER, { kind: 'note', text: 'x' }, HUMAN);
    expect(snap.pins).toHaveLength(1);
  });
  test('unknown session is not-found', async () => {
    await expect(svc().add('nope', { kind: 'note', text: 'x' }, HUMAN)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('idempotent add', () => {
  test('the same block pinned twice is one pin', async () => {
    const s = svc();
    await s.add(SID, { kind: 'message', blockId: 'b1', blockKind: 'assistant', preview: 'hi' }, HUMAN);
    const snap = await s.add(SID, { kind: 'message', blockId: 'b1', blockKind: 'assistant', preview: 'hi' }, HUMAN);
    expect(snap.pins.filter(p => p.kind === 'message')).toHaveLength(1);
  });
  test('an identical note is not re-added (loop guard)', async () => {
    const s = svc();
    await s.add(SID, { kind: 'note', text: 'same' }, AGENT);
    const snap = await s.add(SID, { kind: 'note', text: 'same' }, AGENT);
    expect(snap.pins).toHaveLength(1);
  });
});

describe('agent sub-cap', () => {
  test('an agent cannot exceed its sub-cap, and never evicts human pins', async () => {
    const s = svc();
    await s.add(SID, { kind: 'note', text: 'human pin' }, HUMAN);
    for (let i = 0; i < MAX_AGENT_PINS_PER_SESSION + 5; i += 1) {
      await s.add(SID, { kind: 'note', text: `agent ${i}` }, AGENT);
    }
    const snap = await s.list(SID);
    expect(snap.pins.filter(p => p.by === 'agent')).toHaveLength(MAX_AGENT_PINS_PER_SESSION);
    expect(snap.pins.filter(p => p.by === 'human')).toHaveLength(1);
  });
});

describe('ownership on edit/remove', () => {
  test('an agent may not remove a human pin', async () => {
    const s = svc();
    const snap = await s.add(SID, { kind: 'note', text: 'humans only' }, HUMAN);
    await expect(s.remove(SID, snap.pins[0]!.id, AGENT)).rejects.toMatchObject({ code: 'forbidden' });
  });
  test('the human may remove an agent pin', async () => {
    const s = svc();
    const snap = await s.add(SID, { kind: 'note', text: 'agent pin' }, AGENT);
    const after = await s.remove(SID, snap.pins[0]!.id, HUMAN);
    expect(after.pins).toHaveLength(0);
  });
  test('an agent may edit only its own note', async () => {
    const s = svc();
    const mine = await s.add(SID, { kind: 'note', text: 'mine' }, AGENT);
    const edited = await s.edit(SID, mine.pins[0]!.id, 'mine v2', AGENT);
    expect((edited.pins[0] as Extract<Pin, { kind: 'note' }>).text).toBe('mine v2');
    const humans = await s.add(SID, { kind: 'note', text: 'theirs' }, HUMAN);
    const humanId = humans.pins.find(p => p.by === 'human')!.id;
    await expect(s.edit(SID, humanId, 'hijack', AGENT)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('import (migration)', () => {
  test('only the human may import, and pins are re-stamped human', async () => {
    const s = svc();
    const incoming: Pin[] = [
      { id: 'p1', kind: 'note', text: 'from browser', at: 1, by: 'agent', createdBy: 'x', createdByName: 'y' },
    ];
    await expect(s.importPins(SID, incoming, AGENT)).rejects.toMatchObject({ code: 'forbidden' });
    const snap = await s.importPins(SID, incoming, HUMAN);
    expect(snap.pins[0]).toMatchObject({ by: 'human', createdBy: null });
  });
  test('double import is safe (dedupe by id)', async () => {
    const s = svc();
    const incoming: Pin[] = [
      { id: 'p1', kind: 'note', text: 'once', at: 1, by: 'human', createdBy: null, createdByName: null },
    ];
    await s.importPins(SID, incoming, HUMAN);
    const snap = await s.importPins(SID, incoming, HUMAN);
    expect(snap.pins).toHaveLength(1);
  });
});

describe('live events', () => {
  test('a mutation emits pins.updated with the snapshot', async () => {
    const s = svc();
    const events: KTeamEvent[] = [];
    s.subscribe(e => events.push(e));
    await s.add(SID, { kind: 'note', text: 'watch me' }, AGENT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'pins.updated', sessionId: SID, sequence: 0, source: `peer:${SID}` });
    const data = events[0]!.data as { pins: Pin[] };
    const first = data.pins[0]!;
    expect(first.kind === 'note' && first.text).toBe('watch me');
  });
  test('a human mutation is sourced client', async () => {
    const s = svc();
    const events: KTeamEvent[] = [];
    s.subscribe(e => events.push(e));
    await s.add(SID, { kind: 'note', text: 'hi' }, HUMAN);
    expect(events[0]!.source).toBe('client');
  });
});

test('list on a valid but empty session is an empty snapshot', async () => {
  const snap = await svc().list(SID);
  expect(snap.pins).toEqual([]);
  expect(snap.sessionId).toBe(SID);
});

test('list rejects an unsafe session id', async () => {
  await expect(svc().list('../evil')).rejects.toThrow(PinError);
});
