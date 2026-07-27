import { describe, expect, test } from 'bun:test';
import { decideAssignedWardens, wardenSlotsFree, type LiveWarden } from './warden-concurrency';

const allSuspect = () => true;
const assigned = (targetId: string): LiveWarden => ({ wardenId: `w-${targetId}`, targetId });
const sweepWarden: LiveWarden = { wardenId: 'warden-sweep' };

describe('wardenSlotsFree', () => {
  test('cap minus live count', () => {
    expect(wardenSlotsFree(1, 0)).toBe(1);
    expect(wardenSlotsFree(1, 1)).toBe(0);
    expect(wardenSlotsFree(3, 1)).toBe(2);
  });

  test('clamps cap to >=1 and never returns negative', () => {
    expect(wardenSlotsFree(0, 0)).toBe(1); // 0 cap would wedge the warden
    expect(wardenSlotsFree(-5, 0)).toBe(1);
    expect(wardenSlotsFree(1, 5)).toBe(0); // over cap → no slots, never negative
  });

  test('floors a fractional cap', () => {
    expect(wardenSlotsFree(2.9, 0)).toBe(2);
  });
});

describe('decideAssignedWardens — concurrency cap', () => {
  test('one warden live blocks a second (cap 1): the candidate is queued, not dropped', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [assigned('a')],
      candidates: ['b'],
      queued: [],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual([]);
    expect(out.queue).toEqual(['b']);
    expect(out.dropped).toEqual([]);
  });

  test('a live SWEEP warden fills the cap of 1 — no assigned spawn', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [sweepWarden],
      candidates: ['b'],
      queued: [],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual([]);
    expect(out.queue).toEqual(['b']);
  });

  test('cap 1 with no live warden spawns exactly one and queues the rest', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [],
      candidates: ['a', 'b', 'c'],
      queued: [],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual(['a']);
    expect(out.queue).toEqual(['b', 'c']);
  });

  test('higher cap fills multiple free slots', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 3,
      live: [assigned('x')],
      candidates: ['a', 'b', 'c'],
      queued: [],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual(['a', 'b']); // 3 cap - 1 live = 2 slots
    expect(out.queue).toEqual(['c']);
  });
});

describe('decideAssignedWardens — same-target dedup', () => {
  test('never spawns a second warden for a target already under investigation', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 5, // slots to spare — the block is identity, not capacity
      live: [assigned('a')],
      candidates: ['a', 'b'],
      queued: [],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual(['b']); // 'a' skipped — already investigated
    expect(out.queue).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  test('a queued target that gained a live warden is neither respawned nor re-queued', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 5,
      live: [assigned('a')],
      candidates: [],
      queued: ['a'],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual([]);
    expect(out.queue).toEqual([]);
    expect(out.dropped).toEqual([]); // handled, not recovered
  });
});

describe('decideAssignedWardens — queue drain on completion', () => {
  test('a queued target is picked up once the warden finishes (slot frees)', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [], // the warden that was blocking has finished
      candidates: [],
      queued: ['b'],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual(['b']);
    expect(out.queue).toEqual([]);
  });

  test('queued targets are retried before fresh candidates (FIFO, no starvation)', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 2,
      live: [],
      candidates: ['new'],
      queued: ['old'],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual(['old', 'new']);
  });
});

describe('decideAssignedWardens — recovered targets are dropped', () => {
  test('a queued target that has recovered is dropped, not investigated', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [],
      candidates: [],
      queued: ['gone'],
      isStillSuspect: () => false,
    });
    expect(out.spawn).toEqual([]);
    expect(out.queue).toEqual([]);
    expect(out.dropped).toEqual(['gone']);
  });

  test('recovered queued target is dropped while a still-sus one is picked up', () => {
    const suspect = new Set(['live']);
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [],
      candidates: [],
      queued: ['gone', 'live'],
      isStillSuspect: id => suspect.has(id),
    });
    expect(out.spawn).toEqual(['live']);
    expect(out.dropped).toEqual(['gone']);
    expect(out.queue).toEqual([]);
  });

  test('a fresh candidate that is not suspect is skipped without being reported dropped', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 1,
      live: [],
      candidates: ['ghost'],
      queued: [],
      isStillSuspect: () => false,
    });
    expect(out.spawn).toEqual([]);
    expect(out.queue).toEqual([]);
    expect(out.dropped).toEqual([]); // never queued → nothing to drop
  });
});

describe('decideAssignedWardens — dedup across queue and candidates', () => {
  test('an id present in both queue and candidates collapses to one', () => {
    const out = decideAssignedWardens({
      maxConcurrent: 5,
      live: [],
      candidates: ['dup', 'fresh'],
      queued: ['dup'],
      isStillSuspect: allSuspect,
    });
    expect(out.spawn).toEqual(['dup', 'fresh']); // 'dup' once, queue-first
    expect(out.queue).toEqual([]);
  });
});
