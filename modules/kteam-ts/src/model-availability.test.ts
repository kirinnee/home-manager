import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyModelAvailability,
  consentModelFamily,
  findModelUnavailable,
  markModelUnavailable,
  MODEL_UNAVAILABLE_TTL_MS,
  modelAvailabilityFile,
  readModelUnavailable,
} from './model-availability';
import { createPaths } from './paths';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function paths() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-model-availability-'));
  homes.push(home);
  const created = createPaths(home);
  await mkdir(created.daemon, { recursive: true });
  return created;
}

const record = (binary: string, at: string) => ({
  binary,
  family: 'fable',
  model: 'Fable 5.1',
  reason: 'Fable needs usage credits on this account',
  at,
});

describe('model availability cache', () => {
  test('only Fable-family names map to a consent family', () => {
    for (const model of ['fable', 'claude-fable-5-1[1m]', 'Fable 5.1']) expect(consentModelFamily(model)).toBe('fable');
    for (const model of [undefined, 'claude-opus-5-5', 'sonnet']) expect(consentModelFamily(model)).toBeUndefined();
  });

  test('a mark is read back, found per wrapper + family, and replaced rather than duplicated', async () => {
    const p = await paths();
    expect(await readModelUnavailable(p)).toEqual([]);
    await markModelUnavailable(p, record('claude-auto-loge3', new Date(Date.now() - 1_000).toISOString()));
    await markModelUnavailable(p, record('claude-auto-loge3', new Date().toISOString()));
    const records = await readModelUnavailable(p);
    expect(records).toHaveLength(1);
    expect(findModelUnavailable(records, '/Users/x/.kfleet/bin/claude-auto-loge3', 'fable')).toBeDefined();
    expect(findModelUnavailable(records, 'claude-auto-loge3', 'claude-opus-5-5')).toBeUndefined();
    expect(findModelUnavailable(records, 'claude-auto-loge1', 'fable')).toBeUndefined();
  });

  test('marks expire so buying credits heals the account by itself', async () => {
    const p = await paths();
    const old = new Date(Date.now() - MODEL_UNAVAILABLE_TTL_MS - 1_000).toISOString();
    await writeFile(modelAvailabilityFile(p), JSON.stringify([record('claude-auto-loge3', old)]));
    expect(await readModelUnavailable(p)).toEqual([]);
    // A fresh mark also drops the expired neighbour from disk.
    await markModelUnavailable(p, record('claude-auto-loge4', new Date().toISOString()));
    const disk = JSON.parse(await readFile(modelAvailabilityFile(p), 'utf8')) as Array<{ binary: string }>;
    expect(disk.map(item => item.binary)).toEqual(['claude-auto-loge4']);
  });

  test('a corrupt file reads as no marks', async () => {
    const p = await paths();
    await writeFile(modelAvailabilityFile(p), '{not json');
    expect(await readModelUnavailable(p)).toEqual([]);
  });

  test('applyModelAvailability overlays the feed and adds wrappers the feed lacks', () => {
    const records = [record('claude-auto-loge3', new Date().toISOString())];
    const merged = applyModelAvailability([{ binary: 'claude-auto-loge3', weeklyPercent: 10 }], records);
    expect(merged).toEqual([
      { binary: 'claude-auto-loge3', weeklyPercent: 10, fableUnavailable: 'Fable needs usage credits on this account' },
    ]);
    expect(applyModelAvailability([], records)).toEqual([
      { binary: 'claude-auto-loge3', fableUnavailable: 'Fable needs usage credits on this account' },
    ]);
  });
});
