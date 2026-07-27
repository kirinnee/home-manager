import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, type KTeamPaths } from './paths';
import { LearningStore } from './learning-store';
import { LearningManager, type LearningDeps } from './learning';
import { defaultLearningConfig } from './learning-types';
import type { Observation, Proposal } from './learning-types';
import type { SessionView } from './service';

let home: string;
let paths: KTeamPaths;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-learning-'));
  paths = createPaths(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// A minimal SessionView; casts keep the fixture readable (the manager only reads
// config.{id,teammate,mode,cwd,harness,label} and state.{status,finishedAt}).
function view(over: {
  id: string;
  status?: string;
  mode?: 'auto' | 'interactive';
  finishedAt?: string;
  label?: string;
  cwd?: string;
}): SessionView {
  return {
    config: {
      id: over.id,
      teammate: over.id,
      mode: over.mode ?? 'auto',
      cwd: over.cwd ?? home,
      harness: 'claude',
      label: over.label,
    },
    state: { id: over.id, status: over.status ?? 'completed', finishedAt: over.finishedAt ?? '2026-07-26T10:00:00Z' },
    directory: path.join(home, over.id),
  } as unknown as SessionView;
}

async function seedSessionDir(id: string, brief: string, inbox: string[] = []): Promise<void> {
  const dir = path.join(home, id);
  await mkdir(path.join(dir, 'turns'), { recursive: true });
  await writeFile(path.join(dir, 'turns', 'turn-001.md'), brief);
  await mkdir(path.join(dir, 'channel'), { recursive: true });
  await writeFile(
    path.join(dir, 'channel', 'inbox.jsonl'),
    inbox.map(m => JSON.stringify({ type: 'message', message: m })).join('\n'),
  );
}

describe('LearningStore', () => {
  test('append dedupes by content-hash id and survives reload', async () => {
    const store = new LearningStore(paths);
    const obs = (id: string): Observation => ({
      id,
      sessionId: 's',
      mode: 'auto',
      cwd: '/r',
      repo: '/r',
      at: 't',
      kind: 'correction',
      gist: 'g',
      quote: 'q',
      source: 'human',
      verified: true,
      runId: 'r',
    });
    const first = await store.appendObservations([obs('a'), obs('b')]);
    expect(first).toHaveLength(2);
    const second = await store.appendObservations([obs('b'), obs('c')]); // b is dup
    expect(second.map(o => o.id)).toEqual(['c']);
    const all = await store.readObservations();
    expect(all.map(o => o.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('proposals + tombstones + state roundtrip', async () => {
    const store = new LearningStore(paths);
    await store.saveState({ watermarkId: 's9', watermarkAt: '2026-07-01T00:00:00Z' });
    expect((await store.loadState()).watermarkId).toBe('s9');
    await store.saveTombstones([{ identity: 'x', titleHash: 'h', ruleGist: 'g', rejectedAt: 't' }]);
    expect(await store.loadTombstones()).toHaveLength(1);
  });
});

function stubDeps(views: SessionView[], recordsById: Record<string, unknown[]>): LearningDeps & { started: unknown[] } {
  const started: unknown[] = [];
  return {
    started,
    list: async () => views,
    chatHistory: async (id: string) => ({ total: 0, offset: 0, records: recordsById[id] ?? [] }),
    start: async req => {
      started.push(req);
      return view({ id: `miner-${started.length}`, label: 'kteam-learning' });
    },
  };
}

describe('LearningManager service surface', () => {
  test('accept / edit / reject(tombstone) transition proposals', async () => {
    const store = new LearningStore(paths);
    await store.ensureDir();
    const proposal: Proposal = {
      id: 'p1',
      category: 'global',
      state: 'pending',
      title: 'Use direnv',
      ruleText: 'Use direnv exec.',
      target: { kind: 'kfleet-claude-md', path: 'kfleet/CLAUDE.md' },
      observationIds: [],
      occurrences: 3,
      crossRepoCount: 2,
      firstSeen: 't',
      lastSeen: 't',
      identity: 'use-direnv',
      history: [],
    };
    await store.saveProposals([proposal]);

    const mgr = new LearningManager(paths, defaultLearningConfig(), stubDeps([], {}));

    const edited = await mgr.learningAct('p1', { action: 'edit', ruleText: 'Always use direnv exec.' });
    expect(edited?.ruleText).toBe('Always use direnv exec.');

    const rejected = await mgr.learningAct('p1', { action: 'reject', note: 'not general enough' });
    expect(rejected?.state).toBe('rejected');
    expect(await store.loadTombstones()).toHaveLength(1); // permanent tombstone written

    expect(await mgr.learningAct('missing', { action: 'accept' })).toBeUndefined();
  });

  test('learningPatch renders rule + verified evidence into a file', async () => {
    const store = new LearningStore(paths);
    await store.ensureDir();
    await store.appendObservations([
      {
        id: 'o1',
        sessionId: 's1',
        teammate: 'lacey',
        mode: 'auto',
        cwd: '/repo/a',
        repo: '/repo/a',
        at: 't',
        kind: 'correction',
        gist: 'g',
        quote: 'run it through direnv exec',
        source: 'human',
        verified: true,
        runId: 'r',
      },
    ]);
    await store.saveProposals([
      {
        id: 'p1',
        category: 'global',
        state: 'accepted',
        title: 'Use direnv',
        ruleText: 'Use direnv exec.',
        target: { kind: 'kfleet-claude-md', path: 'kfleet/CLAUDE.md', anchor: '## Agent rules' },
        observationIds: ['o1'],
        occurrences: 1,
        crossRepoCount: 1,
        firstSeen: 't',
        lastSeen: 't',
        identity: 'use-direnv',
        history: [],
      },
    ]);
    const mgr = new LearningManager(paths, defaultLearningConfig(), stubDeps([], {}));
    const { path: file, contents } = await mgr.learningPatch('p1');
    expect(contents).toContain('Use direnv exec.');
    expect(contents).toContain('run it through direnv exec');
    expect(contents).toContain('kfleet/CLAUDE.md');
    expect(await readFile(file, 'utf8')).toBe(contents);
  });
});

describe('LearningManager end-to-end: scan → spawn → ingest', () => {
  test('a signalful session is mined and a verified proposal appears', async () => {
    // Two sessions: one interactive with a correction (signal), one plain auto
    // chore (no signal, filtered out).
    await seedSessionDir('s1', 'Fix the thing', ['no — run it through direnv exec like I said']);
    await seedSessionDir('s2', 'Chore: bump a version');

    const views = [
      view({ id: 's1', mode: 'interactive', finishedAt: '2026-07-26T10:00:00Z', cwd: '/repo/a' }),
      view({ id: 's2', mode: 'auto', finishedAt: '2026-07-26T11:00:00Z', cwd: '/repo/b' }),
    ];
    const deps = stubDeps(views, {
      s1: [{ type: 'chat.user', data: { text: 'no — run it through direnv exec like I said' } }],
      s2: [{ type: 'chat.user', data: { text: 'bump a version' } }],
    });
    const config = { ...defaultLearningConfig(), enabled: true, batchSize: 25 };
    const mgr = new LearningManager(paths, config, deps);

    // Force a spawn pass.
    const manifest = await mgr.learningRun(true);
    expect(manifest.sessionsScanned).toBe(2);
    expect(manifest.sessionsWithSignal).toBe(1); // s2 filtered
    expect(deps.started).toHaveLength(1); // one miner spawned

    // Locate the run dir the miner would write to and simulate its output: one
    // real quote + one fabricated quote (which must be dropped).
    const store = new LearningStore(paths);
    const runIds = await readdir(store.runsDir);
    expect(runIds.length).toBeGreaterThanOrEqual(1);
    const runId = runIds.sort().find(r => r !== manifest.runId || true)!;
    // Prefer the batch run dir that has digests.json.
    let target: string | undefined;
    for (const r of runIds) {
      const dir = store.runDir(r);
      try {
        await readFile(path.join(dir, 'digests.json'), 'utf8');
        target = r;
      } catch {
        /* skip */
      }
    }
    expect(target).toBeDefined();
    await writeFile(
      path.join(store.runDir(target!), 'observations.json'),
      JSON.stringify({
        observations: [
          {
            key: 'o1',
            sessionId: 's1',
            kind: 'correction',
            gist: 'use direnv',
            quote: 'run it through direnv exec',
            source: 'human',
          },
          {
            key: 'o2',
            sessionId: 's1',
            kind: 'correction',
            gist: 'x',
            quote: 'delete the whole repo',
            source: 'human',
          },
        ],
        proposals: [
          {
            identity: 'direnv-exec-required',
            title: 'Run project commands through direnv exec',
            ruleText: 'Run project commands through `direnv exec`.',
            target: 'claude-md',
            observationKeys: ['o1', 'o2'],
          },
        ],
      }),
    );
    void runId;

    // Ingest (no spawn).
    await mgr.learningRun(false);

    const proposals = await mgr.learningProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.occurrences).toBe(1);
    expect(proposals[0]!.evidence).toHaveLength(1); // fabricated "delete the whole repo" dropped
    expect(proposals[0]!.evidence[0]!.quote).toBe('run it through direnv exec');
    expect(proposals[0]!.evidence[0]!.repo).toBe('/repo/a');

    const status = await mgr.learningStatus();
    expect(status.pending.total).toBe(1);
    expect(status.totals.observations).toBe(1);
    expect(status.lastRun?.rejectedQuotes).toBe(1);
  });

  test('watermark excludes already-scanned + learning-labelled sessions', async () => {
    await seedSessionDir('s1', 'brief', ['no do it differently']);
    const store = new LearningStore(paths);
    await store.ensureDir();
    // Watermark past s1 already.
    await store.saveState({ watermarkAt: '2026-07-26T10:00:00Z', watermarkId: 's1' });
    const views = [
      view({ id: 's1', mode: 'interactive', finishedAt: '2026-07-26T10:00:00Z' }),
      view({ id: 'miner-x', mode: 'auto', finishedAt: '2026-07-27T10:00:00Z', label: 'kteam-learning' }),
    ];
    const mgr = new LearningManager(paths, { ...defaultLearningConfig(), enabled: true }, stubDeps(views, {}));
    const manifest = await mgr.learningRun(true);
    // s1 is at/below the watermark, miner-x is excluded by label → nothing new.
    expect(manifest.sessionsScanned).toBe(0);
  });
});
