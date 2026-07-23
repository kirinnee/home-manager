import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultFsService, paths } from '../deps';
import { clearStatusCache, materialize } from './materialize';

// Verifies the mtime-keyed cache: a repeat materialize with an unchanged events.jsonl
// reuses the cached fold, and appending an event invalidates it (new event picked up).

let home: string;
const runId = 'cacherun';

function eventLine(o: Record<string, unknown>): string {
  return `${JSON.stringify(o)}\n`;
}

describe('materialize mtime cache', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kloop-mat-'));
    process.env.KLOOP_HOME = home;
    clearStatusCache();
    mkdirSync(paths.runPath(runId), { recursive: true });
    writeFileSync(
      paths.runEvents(runId),
      eventLine({ type: 'run_start', timestamp: '2026-01-01T00:00:00.000Z', config: {} }) +
        eventLine({ type: 'loop_start', timestamp: '2026-01-01T00:00:01.000Z', loop: 1, implementer: 'claude-auto-x' }),
      'utf-8',
    );
  });
  afterEach(() => {
    delete process.env.KLOOP_HOME;
    clearStatusCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns identical status on a cache hit (unchanged events)', async () => {
    const a = await materialize(runId, defaultFsService, paths);
    const b = await materialize(runId, defaultFsService, paths);
    expect(b.status).toBe(a.status);
    expect(b.loops.length).toBe(a.loops.length);
    expect(b.lastEventIndex).toBe(a.lastEventIndex);
  });

  it('does not share object identity between calls (clone isolates the cache)', async () => {
    const a = await materialize(runId, defaultFsService, paths);
    const b = await materialize(runId, defaultFsService, paths);
    expect(b).not.toBe(a); // fresh clone each call — pid/terminal mutations never poison the cache
  });

  it('picks up a newly appended event (mtime/size invalidates)', async () => {
    const first = await materialize(runId, defaultFsService, paths);
    expect(first.loops.length).toBe(1);
    // Append a second loop; the (mtime,size) fingerprint changes → cache miss → replay.
    // Bump the file so mtime resolution can never alias the previous value.
    await new Promise(r => setTimeout(r, 5));
    appendFileSync(
      paths.runEvents(runId),
      eventLine({ type: 'loop_start', timestamp: '2026-01-01T00:00:02.000Z', loop: 2, implementer: 'claude-auto-x' }),
      'utf-8',
    );
    const second = await materialize(runId, defaultFsService, paths);
    expect(second.loops.length).toBe(2);
  });
});
