import { describe, expect, test } from 'bun:test';
import {
  matchesTombstone,
  normalizeForMatch,
  observationId,
  parseJsonl,
  recomputeProposal,
  slugify,
  strengthOf,
  titleHash,
  verifyQuote,
} from './learning-store';
import { extractSession, type RawSessionInput } from './learning-extract';
import { applyMinerOutput, type MinerOutput } from './learning-aggregate';
import type { Observation, Proposal, Tombstone } from './learning-types';

describe('verification core (anti-hallucination)', () => {
  const corpus = 'No — run it through direnv exec like I said last time.\nAlways branch first.';

  test('verifies an exact verbatim quote', () => {
    expect(verifyQuote('run it through direnv exec', corpus)).toBe(true);
  });

  test('tolerates whitespace reflow and case', () => {
    expect(verifyQuote('RUN  IT\n THROUGH   direnv EXEC', corpus)).toBe(true);
  });

  test('rejects a fabricated quote', () => {
    expect(verifyQuote('use python for the json munging', corpus)).toBe(false);
  });

  test('rejects a too-short / empty quote', () => {
    expect(verifyQuote('', corpus)).toBe(false);
    expect(verifyQuote('a', corpus)).toBe(false);
  });

  test('observationId is deterministic and content-addressed', () => {
    const a = observationId('s1', 'Run it THROUGH direnv', 'gist here');
    const b = observationId('s1', 'run it through   direnv', 'gist here');
    const c = observationId('s2', 'Run it THROUGH direnv', 'gist here');
    expect(a).toBe(b); // normalized quote/gist
    expect(a).not.toBe(c); // different session
    expect(a.startsWith('obs_')).toBe(true);
  });

  test('normalizeForMatch collapses whitespace and lowercases', () => {
    expect(normalizeForMatch('  Foo\n\tBar  ')).toBe('foo bar');
  });
});

describe('slug / strength / tombstone helpers', () => {
  test('slugify produces a stable kebab identity', () => {
    expect(slugify('Always run project commands through direnv exec!')).toBe(
      'always-run-project-commands-through-direnv-exec',
    );
  });

  test('strengthOf buckets by occurrence count', () => {
    expect(strengthOf(1)).toBe('weak');
    expect(strengthOf(3)).toBe('normal');
    expect(strengthOf(5)).toBe('strong');
    expect(strengthOf(9)).toBe('strong');
  });

  test('matchesTombstone catches identity and near-identical title', () => {
    const tombs: Tombstone[] = [
      { identity: 'direnv-exec-required', titleHash: titleHash('Use direnv exec'), ruleGist: 'x', rejectedAt: 't' },
    ];
    expect(matchesTombstone({ identity: 'direnv-exec-required', title: 'anything' }, tombs)).toBe(true);
    // Different identity but the same normalized title still matches by hash.
    expect(matchesTombstone({ identity: 'other', title: 'use  DIRENV  exec' }, tombs)).toBe(true);
    expect(matchesTombstone({ identity: 'unrelated', title: 'branch first' }, tombs)).toBe(false);
  });

  test('parseJsonl skips blank and corrupt lines', () => {
    const parsed = parseJsonl<{ n: number }>('{"n":1}\n\nnot json\n{"n":2}\n');
    expect(parsed).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('recomputeProposal computes counts from evidence, never trusts them', () => {
  const obs = (id: string, sessionId: string, repo: string, at: string): Observation => ({
    id,
    sessionId,
    mode: 'auto',
    cwd: repo,
    repo,
    at,
    kind: 'correction',
    gist: 'g',
    quote: 'q',
    source: 'human',
    verified: true,
    runId: 'r',
  });

  test('distinct sessions/repos, first/last seen, drops missing ids', () => {
    const index = new Map<string, Observation>([
      ['o1', obs('o1', 's1', '/repo/a', '2026-07-01T00:00:00Z')],
      ['o2', obs('o2', 's1', '/repo/a', '2026-07-03T00:00:00Z')], // same session
      ['o3', obs('o3', 's2', '/repo/b', '2026-07-02T00:00:00Z')],
    ]);
    const proposal: Proposal = {
      id: 'p1',
      category: 'global',
      state: 'pending',
      title: 't',
      ruleText: 'r',
      target: { kind: 'kfleet-claude-md', path: 'kfleet/CLAUDE.md' },
      observationIds: ['o1', 'o2', 'o3', 'missing'],
      occurrences: 999, // LLM lie — must be overwritten
      crossRepoCount: 999,
      firstSeen: 'x',
      lastSeen: 'x',
      identity: 'id',
      history: [],
    };
    const out = recomputeProposal(proposal, index);
    expect(out.occurrences).toBe(2); // s1, s2
    expect(out.crossRepoCount).toBe(2); // /repo/a, /repo/b
    expect(out.observationIds).toEqual(['o1', 'o2', 'o3']); // missing dropped
    expect(out.firstSeen).toBe('2026-07-01T00:00:00Z');
    expect(out.lastSeen).toBe('2026-07-03T00:00:00Z');
  });
});

describe('extractSession signal filter', () => {
  const base: RawSessionInput = {
    sessionId: 's1',
    teammate: 'lacey',
    mode: 'auto',
    cwd: '/repo/a',
    repo: '/repo/a',
    harness: 'claude',
    status: 'completed',
    finishedAt: '2026-07-26T10:00:00Z',
    records: [{ type: 'chat.user', data: { text: 'do the thing' } }],
    turnTexts: ['do the thing'],
    inbox: [],
    interrupts: 0,
  };

  test('a plain completed auto chore has no signal', () => {
    const d = extractSession(base);
    expect(d.hasSignal).toBe(false);
  });

  test('an interactive session always has signal', () => {
    const d = extractSession({ ...base, mode: 'interactive' });
    expect(d.hasSignal).toBe(true);
  });

  test('an interrupt is signal', () => {
    const d = extractSession({ ...base, interrupts: 1 });
    expect(d.hasSignal).toBe(true);
    expect(d.signalReasons.join(' ')).toContain('interrupt');
  });

  test('a lead steer is signal and is labelled teammate', () => {
    const d = extractSession({
      ...base,
      inbox: [{ text: 'no, branch first like I said', from: 'ms0-x', fromName: 'zelda' }],
    });
    expect(d.hasSignal).toBe(true);
    expect(d.teammateSteers).toBe(1);
    expect(d.humanMessages).toBe(0);
  });

  test('corpus contains user + turn + inbox text; excludes assistant', () => {
    const d = extractSession({
      ...base,
      records: [
        { type: 'chat.user', data: { text: 'run it through direnv' } },
        { type: 'chat.assistant.text', data: { text: 'I will use python' } },
      ],
      inbox: [{ text: 'branch first' }],
    });
    expect(verifyQuote('run it through direnv', d.corpus)).toBe(true);
    expect(verifyQuote('branch first', d.corpus)).toBe(true);
    expect(verifyQuote('I will use python', d.corpus)).toBe(false); // assistant excluded
  });

  test('two tool failures count as signal', () => {
    const d = extractSession({
      ...base,
      records: [
        { type: 'chat.user', data: { text: 'go' } },
        { type: 'tool.result', data: { isError: true } },
        { type: 'tool.result', data: { isError: true } },
      ],
    });
    expect(d.toolFailures).toBe(2);
    expect(d.hasSignal).toBe(true);
  });
});

describe('applyMinerOutput — verify, compute, dedup, tombstone', () => {
  const digestsById = new Map([
    [
      's1',
      {
        sessionId: 's1',
        teammate: 'a',
        mode: 'auto' as const,
        cwd: '/repo/a',
        repo: '/repo/a',
        harness: 'claude',
        at: '2026-07-01T00:00:00Z',
        hasSignal: true,
        signalReasons: [],
        corpus: 'no — run it through direnv exec like I said',
        digest: '',
        humanMessages: 1,
        teammateSteers: 0,
        interrupts: 0,
        toolFailures: 0,
      },
    ],
    [
      's2',
      {
        sessionId: 's2',
        teammate: 'b',
        mode: 'interactive' as const,
        cwd: '/repo/b',
        repo: '/repo/b',
        harness: 'claude',
        at: '2026-07-02T00:00:00Z',
        hasSignal: true,
        signalReasons: [],
        corpus: 'always use direnv exec before bun commands',
        digest: '',
        humanMessages: 2,
        teammateSteers: 0,
        interrupts: 0,
        toolFailures: 0,
      },
    ],
  ]);

  const output: MinerOutput = {
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
        sessionId: 's2',
        kind: 'preference',
        gist: 'use direnv',
        quote: 'use direnv exec before bun',
        source: 'human',
      },
      // Fabricated quote — must be dropped.
      { key: 'o3', sessionId: 's1', kind: 'correction', gist: 'x', quote: 'never use direnv at all', source: 'human' },
    ],
    proposals: [
      {
        identity: 'direnv-exec-required',
        title: 'Run project commands through direnv exec',
        ruleText: 'Run project commands through `direnv exec`.',
        target: 'claude-md',
        observationKeys: ['o1', 'o2', 'o3'],
      },
    ],
  };

  test('drops fabricated quote, computes cross-repo occurrences', () => {
    const res = applyMinerOutput([], [], output, digestsById, new Map(), 'run1', '2026-07-03T00:00:00Z');
    expect(res.stats.observationsVerified).toBe(2);
    expect(res.stats.rejectedQuotes).toBe(1);
    expect(res.proposals).toHaveLength(1);
    const p = res.proposals[0]!;
    expect(p.occurrences).toBe(2); // s1, s2
    expect(p.crossRepoCount).toBe(2); // /repo/a, /repo/b
    expect(p.observationIds).toHaveLength(2); // o3 dropped
    expect(p.state).toBe('pending');
  });

  test('a proposal whose evidence all fails verification is not created', () => {
    const bad: MinerOutput = {
      observations: [
        { key: 'x', sessionId: 's1', kind: 'correction', gist: 'g', quote: 'totally made up text', source: 'human' },
      ],
      proposals: [{ identity: 'ghost', title: 'Ghost rule', ruleText: 'x', observationKeys: ['x'] }],
    };
    const res = applyMinerOutput([], [], bad, digestsById, new Map(), 'run1', 't');
    expect(res.stats.observationsVerified).toBe(0);
    expect(res.proposals).toHaveLength(0);
  });

  test('a tombstoned identity is suppressed', () => {
    const tombs: Tombstone[] = [
      { identity: 'direnv-exec-required', titleHash: titleHash('x'), ruleGist: 'x', rejectedAt: 't' },
    ];
    const res = applyMinerOutput([], tombs, output, digestsById, new Map(), 'run1', 't');
    expect(res.stats.proposalsSuppressedByTombstone).toBe(1);
    expect(res.proposals).toHaveLength(0);
  });

  test('re-running the same output strengthens (no duplicate) by identity', () => {
    const first = applyMinerOutput([], [], output, digestsById, new Map(), 'run1', 't');
    const known = new Map(first.observations.map(o => [o.id, o]));
    const second = applyMinerOutput(first.proposals, [], output, digestsById, known, 'run2', 't2');
    expect(second.proposals).toHaveLength(1); // merged, not multiplied
    expect(second.proposals[0]!.occurrences).toBe(2);
  });
});
