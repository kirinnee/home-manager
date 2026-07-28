import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildWardenAttentionView,
  WARDEN_ATTENTION_VERDICT_LIMIT,
  WardenAttentionProvider,
  type AttentionBoardInput,
  type FleetSessionLike,
  type WardenAttentionInput,
  type WardenAttentionState,
} from './warden-attention';
import type { AttentionItem } from './attention-types';
import type { WardenAnomaly } from './warden-detect';
import { wardenVerdictSourceRef, type WardenVerdict } from './warden-verdicts';
import type { WardenSpawnProvenance } from './warden-provenance';
import { createPaths, sessionDir, type KTeamPaths } from './paths';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function item(overrides: Partial<AttentionItem> & Pick<AttentionItem, 'id'>): AttentionItem {
  return {
    source: 'question',
    sourceRef: null,
    subject: 'A question is waiting',
    why: 'The teammate asked something and nobody answered.',
    waitingSince: '2026-07-28T11:00:00.000Z',
    howToResolve: 'Answer the question in the session.',
    raisedBy: 'agent',
    raisedBySession: 'sess-1',
    raisedByName: 'ada',
    ...overrides,
  } as AttentionItem;
}

function board(sessionId: string, items: AttentionItem[], parseErrors = 0): AttentionBoardInput {
  return { sessionId, parseErrors, items };
}

function session(id: string, extra: Partial<FleetSessionLike['config']> = {}, status = 'waiting'): FleetSessionLike {
  return { config: { id, name: id, ...extra }, state: { status } };
}

function verdict(overrides: Partial<WardenVerdict> & Pick<WardenVerdict, 'targetSession' | 'verdict'>): WardenVerdict {
  return {
    at: '2026-07-28T11:30:00.000Z',
    reportPath: `/reports/${overrides.targetSession}.md`,
    reason: 'The session is fine.',
    anomalyKind: 'unattended_question',
    ...overrides,
  } as WardenVerdict;
}

function spawn(overrides: Partial<WardenSpawnProvenance> = {}): WardenSpawnProvenance {
  return {
    v: 1,
    at: '2026-07-28T11:30:00.000Z',
    wardenSessionId: 'ward-9',
    wrapper: 'claude-auto-glm52a',
    model: 'glm-5.2',
    modelSource: 'wrapper',
    harness: 'claude',
    policy: 'fallback',
    selection: 'preferred',
    configuredFirst: 'claude-auto-glm52a',
    skipped: {},
    failedOver: false,
    ...overrides,
  };
}

function anomaly(overrides: Partial<WardenAnomaly> & Pick<WardenAnomaly, 'kind' | 'sessionId'>): WardenAnomaly {
  return {
    status: 'stalled',
    detail: 'Something looks off with this session.',
    since: '2026-07-28T10:00:00.000Z',
    ...overrides,
  } as WardenAnomaly;
}

function run(partial: Partial<WardenAttentionInput>): ReturnType<typeof buildWardenAttentionView> {
  return buildWardenAttentionView({
    now: NOW,
    sessions: [],
    boards: [],
    verdicts: [],
    anomalies: [],
    wardenState: { lastSweepAt: '2026-07-28T11:55:00.000Z' },
    ...partial,
  });
}

// ── judgement states ────────────────────────────────────────────────────────

test('judged: a fresh verdict carries kind, reason, reportPath, not stale', () => {
  const view = run({
    sessions: [session('sess-1', { teammate: 'ada' })],
    boards: [board('sess-1', [item({ id: 'A1', waitingSince: '2026-07-28T11:00:00.000Z' })])],
    verdicts: [verdict({ targetSession: 'sess-1', verdict: 'cleared', at: '2026-07-28T11:30:00.000Z' })],
  });
  expect(view.items).toHaveLength(1);
  const j = view.items[0]!.judgement;
  expect(j.state).toBe('judged');
  expect(j.verdict).toBe('cleared');
  expect(j.reason).toBe('The session is fine.');
  expect(j.reportPath).toBe('/reports/sess-1.md');
  expect(j.stale).toBeUndefined();
  expect(view.items[0]!.teammate).toBe('ada');
});

test('none: an item with no verdict yields an explicit none, never absent', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
  });
  const j = view.items[0]!.judgement;
  expect(j.state).toBe('none');
  expect(j.reason).toBe('No matching warden judgement yet.');
  expect(view.verdictCoverage).toEqual({ limit: 100, truncated: false });
});

test('truncated coverage makes an absent exact match explicitly window-bounded', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    verdictCoverage: { limit: 100, truncated: true },
  });
  expect(view.items[0]!.judgement).toEqual({
    state: 'none',
    reason: 'No matching judgement was found in the recent 100-verdict window.',
  });
  expect(view.verdictCoverage).toEqual({ limit: 100, truncated: true });
});

test('failed: an unknown verdict is a failure state, not a silent pass', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    verdicts: [verdict({ targetSession: 'sess-1', verdict: 'unknown', reason: undefined })],
  });
  const j = view.items[0]!.judgement;
  expect(j.state).toBe('failed');
  expect(j.verdict).toBe('unknown');
  expect(j.reason).toContain('could not be classified');
});

test('stale: a verdict that predates the waiting item is flagged stale', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1', waitingSince: '2026-07-28T11:45:00.000Z' })])],
    verdicts: [verdict({ targetSession: 'sess-1', verdict: 'cleared', at: '2026-07-28T11:30:00.000Z' })],
  });
  const j = view.items[0]!.judgement;
  expect(j.state).toBe('judged');
  expect(j.stale).toBe(true);
});

test('task rows never inherit an unrelated same-session warden verdict', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [
      board('sess-1', [
        item({ id: 'A1', source: 'task', sourceRef: 'F31', subject: 'Blocked task', raisedBy: 'daemon' }),
      ]),
    ],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'nudged',
        reportPath: '/reports/subprocess.md',
      }),
    ],
  });
  expect(view.items[0]!.judgement).toEqual({
    state: 'none',
    reason: 'No matching warden judgement applies to this attention item.',
  });
});

test('ordinary board rows do not hide a different anomaly for the same session', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1', source: 'task', sourceRef: 'F31' })])],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' })],
  });
  expect(view.items.map(row => row.id)).toEqual(['anomaly:sus_subprocess:sess-1', 'A1']);
  expect(view.items.find(row => row.fromAnomaly)?.judgement.state).toBe('none');
});

test('question rows select unattended-question verdicts, not newer same-session kinds', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'nudged',
        at: '2026-07-28T11:59:00.000Z',
        reason: 'wrong incident',
      }),
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'unattended_question',
        verdict: 'needs_human',
        at: '2026-07-28T11:30:00.000Z',
        reason: 'answer the exact question',
      }),
    ],
  });
  expect(view.items[0]!.judgement).toMatchObject({
    state: 'judged',
    verdict: 'needs_human',
    reason: 'answer the exact question',
  });
});

test('warden kind references join and deduplicate only that exact anomaly kind', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1', source: 'agent-raised', sourceRef: 'warden:sus_subprocess' })])],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' })],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_thinking',
        verdict: 'cleared',
        at: '2026-07-28T11:59:00.000Z',
        reason: 'wrong incident',
      }),
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        at: '2026-07-28T11:30:00.000Z',
        reason: 'subprocess needs a decision',
      }),
    ],
  });
  expect(view.items).toHaveLength(1);
  expect(view.items[0]!.id).toBe('A1');
  expect(view.items[0]!.judgement).toMatchObject({
    verdict: 'needs_human',
    reason: 'subprocess needs a decision',
  });
});

test('exact report references prefer the needs-human block, deduplicate its kind, and never go stale by milliseconds', () => {
  const reportPath = '/reports/exact.md';
  const view = run({
    sessions: [session('sess-1'), session('sess-2')],
    boards: [
      board('sess-1', [
        item({
          id: 'A1',
          source: 'agent-raised',
          sourceRef: `warden:${reportPath}`,
          waitingSince: '2026-07-28T11:30:00.005Z',
        }),
      ]),
    ],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' })],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_thinking',
        verdict: 'cleared',
        reportPath,
        reason: 'cleared sibling block',
      }),
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        reportPath,
        reason: 'exact needs-human block',
      }),
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'nudged',
        reportPath: `${reportPath}.bak`,
        at: '2026-07-28T11:59:00.000Z',
        reason: 'nearby path',
      }),
      verdict({
        targetSession: 'sess-2',
        anomalyKind: 'sus_subprocess',
        verdict: 'killed',
        reportPath,
        at: '2026-07-28T11:59:00.000Z',
        reason: 'other session',
      }),
    ],
  });
  expect(view.items).toHaveLength(1);
  expect(view.items[0]!.judgement).toMatchObject({
    state: 'judged',
    verdict: 'needs_human',
    reason: 'exact needs-human block',
    reportPath,
  });
  expect(view.items[0]!.judgement.stale).toBeUndefined();
});

test('exact report-block references keep two needs-human kinds on one session distinct', () => {
  const reportPath = '/reports/two-blocks.md';
  const view = run({
    sessions: [session('sess-1')],
    boards: [
      board('sess-1', [
        item({
          id: 'A1',
          source: 'agent-raised',
          sourceRef: wardenVerdictSourceRef(reportPath, 'sus_thinking'),
        }),
        item({
          id: 'A2',
          source: 'agent-raised',
          sourceRef: wardenVerdictSourceRef(reportPath, 'sus_subprocess'),
        }),
      ]),
    ],
    anomalies: [
      anomaly({ kind: 'sus_thinking', sessionId: 'sess-1' }),
      anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' }),
    ],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_thinking',
        verdict: 'needs_human',
        reportPath,
        reason: 'Choose whether thinking should continue.',
      }),
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        reportPath,
        reason: 'Choose whether the subprocess should be interrupted.',
      }),
    ],
  });
  expect(view.items).toHaveLength(2);
  expect(view.items.map(row => [row.id, row.judgement.reason])).toEqual([
    ['A1', 'Choose whether thinking should continue.'],
    ['A2', 'Choose whether the subprocess should be interrupted.'],
  ]);
});

test('a legacy exact-report verdict may judge its row but cannot suppress an unknown anomaly kind', () => {
  const reportPath = '/reports/legacy.md';
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1', source: 'agent-raised', sourceRef: `warden:${reportPath}` })])],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' })],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: undefined,
        verdict: 'needs_human',
        reportPath,
      }),
    ],
  });
  expect(view.items).toHaveLength(2);
  expect(view.items.find(row => row.id === 'A1')?.judgement.verdict).toBe('needs_human');
  expect(view.items.find(row => row.fromAnomaly)?.id).toBe('anomaly:sus_subprocess:sess-1');
});

test('provider references select provider-unavailable and preserve unrelated anomaly kinds', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [
      board('sess-1', [
        item({
          id: 'A1',
          source: 'agent-raised',
          sourceRef: 'provider-unavailable:provider:claude:1',
        }),
      ]),
    ],
    anomalies: [
      anomaly({ kind: 'provider_unavailable', sessionId: 'sess-1', provider: 'claude' }),
      anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' }),
    ],
    verdicts: [
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'sus_thinking',
        verdict: 'nudged',
        at: '2026-07-28T11:59:00.000Z',
        reason: 'wrong incident',
      }),
      verdict({
        targetSession: 'sess-1',
        anomalyKind: 'provider_unavailable',
        verdict: 'needs_human',
        reason: 'provider decision',
      }),
    ],
  });
  expect(view.items).toHaveLength(2);
  expect(view.items.find(row => row.id === 'A1')?.judgement.reason).toBe('provider decision');
  expect(view.items.find(row => row.fromAnomaly)?.id).toBe('anomaly:sus_subprocess:sess-1');
});

test('pending: a live assignment (no verdict) reads as pending', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    wardenState: {
      lastSweepAt: '2026-07-28T11:55:00.000Z',
      assignments: { 'sess-1': { wardenId: 'w1', kinds: ['unattended_question'] } },
    },
  });
  expect(view.items[0]!.judgement.state).toBe('pending');
});

test('queued: a session in the assigned queue reads as queued', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    wardenState: {
      lastSweepAt: '2026-07-28T11:55:00.000Z',
      assignedQueue: [{ sessionId: 'sess-1', kind: 'unattended_question' }],
    },
  });
  expect(view.items[0]!.judgement.state).toBe('queued');
});

test('pending and queued state are keyed by anomaly kind, never just session', () => {
  const view = run({
    sessions: [session('assigned'), session('queued')],
    boards: [
      board('assigned', [item({ id: 'A1', raisedBySession: 'assigned' })]),
      board('queued', [item({ id: 'A1', raisedBySession: 'queued' })]),
    ],
    anomalies: [
      anomaly({ kind: 'sus_subprocess', sessionId: 'assigned' }),
      anomaly({ kind: 'sus_subprocess', sessionId: 'queued' }),
    ],
    wardenState: {
      lastSweepAt: '2026-07-28T11:55:00.000Z',
      assignments: { assigned: { wardenId: 'w1', kinds: ['sus_subprocess'] } },
      assignedQueue: [{ sessionId: 'queued', kind: 'sus_subprocess' }],
    },
  });
  const assignedQuestion = view.items.find(row => row.sessionId === 'assigned' && row.source === 'question');
  const queuedQuestion = view.items.find(row => row.sessionId === 'queued' && row.source === 'question');
  expect(assignedQuestion?.judgement).toMatchObject({ state: 'none' });
  expect(queuedQuestion?.judgement).toMatchObject({ state: 'none' });
  expect(view.items.find(row => row.id === 'anomaly:sus_subprocess:assigned')?.judgement.state).toBe('pending');
  expect(view.items.find(row => row.id === 'anomaly:sus_subprocess:queued')?.judgement.state).toBe('queued');
});

test('a single-kind assigned prompt leaves its same-session sibling unjudged', () => {
  const view = run({
    sessions: [session('sess-1')],
    anomalies: [
      anomaly({ kind: 'sus_thinking', sessionId: 'sess-1' }),
      anomaly({ kind: 'sus_subprocess', sessionId: 'sess-1' }),
    ],
    wardenState: {
      lastSweepAt: '2026-07-28T11:55:00.000Z',
      assignments: { 'sess-1': { wardenId: 'w1', kinds: ['sus_subprocess'] } },
    },
  });
  expect(view.items.find(row => row.id === 'anomaly:sus_subprocess:sess-1')?.judgement.state).toBe('pending');
  expect(view.items.find(row => row.id === 'anomaly:sus_thinking:sess-1')?.judgement.state).toBe('none');
});

test('exhaustion: an unjudged item is failed and the fleet banner is degraded', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    wardenState: { lastSweepAt: '2026-07-28T11:55:00.000Z', exhaustedSince: '2026-07-28T11:40:00.000Z' },
  });
  expect(view.items[0]!.judgement.state).toBe('failed');
  expect(view.items[0]!.judgement.reason).toContain('exhausted');
  expect(view.wardenDegraded?.reason).toContain('exhausted');
  expect(view.wardenDegraded?.since).toBe('2026-07-28T11:40:00.000Z');
});

// ── provenance ───────────────────────────────────────────────────────────────

test('provenance: judgedBy carries warden session, wrapper, model, harness', () => {
  const v = verdict({ targetSession: 'sess-1', verdict: 'nudged', spawn: spawn() });
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    verdicts: [v],
  });
  expect(view.items[0]!.judgement.judgedBy).toEqual({
    wardenSessionId: 'ward-9',
    wrapper: 'claude-auto-glm52a',
    model: 'glm-5.2',
    harness: 'claude',
  });
});

test('provenance: the resolved model + harness carry across a codex warden', () => {
  const v = verdict({
    targetSession: 'sess-1',
    verdict: 'cleared',
    spawn: spawn({
      wardenSessionId: 'ward-c',
      wrapper: 'codex-auto-loge',
      model: 'gpt-5.6-terra',
      modelSource: 'configured',
      harness: 'codex',
    }),
  });
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    verdicts: [v],
  });
  expect(view.items[0]!.judgement.judgedBy).toEqual({
    wardenSessionId: 'ward-c',
    wrapper: 'codex-auto-loge',
    model: 'gpt-5.6-terra',
    harness: 'codex',
  });
});

test('old verdict without provenance still judges — judgedBy simply absent', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    verdicts: [verdict({ targetSession: 'sess-1', verdict: 'cleared' })],
  });
  expect(view.items[0]!.judgement.state).toBe('judged');
  expect(view.items[0]!.judgement.judgedBy).toBeUndefined();
});

// ── anomalies without a board ────────────────────────────────────────────────

test('anomaly-without-board: a flagged, unjudged session is surfaced, not silent', () => {
  const view = run({
    sessions: [session('sess-2', { teammate: 'bob' }, 'stalled')],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-2', detail: 'stuck in a subprocess for 20m' })],
  });
  expect(view.items).toHaveLength(1);
  const row = view.items[0]!;
  expect(row.fromAnomaly).toBe(true);
  expect(row.source).toBe('warden-anomaly');
  expect(row.sessionId).toBe('sess-2');
  expect(row.subject).toBe('Session stuck in a subprocess');
  expect(row.why).toBe('stuck in a subprocess for 20m');
  expect(row.judgement.state).toBe('none');
});

test('anomaly with a confident verdict stays quiet (not silent, warden decided)', () => {
  const view = run({
    sessions: [session('sess-2')],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-2' })],
    verdicts: [
      verdict({
        targetSession: 'sess-2',
        anomalyKind: 'sus_subprocess',
        verdict: 'cleared',
        at: '2026-07-28T11:59:00.000Z',
      }),
    ],
  });
  expect(view.items).toHaveLength(0);
  expect(view.outcome).toBe('clean-sweep');
});

test('needs-human verdict stays visible until its Attention board row lands', () => {
  const view = run({
    sessions: [session('sess-2')],
    anomalies: [anomaly({ kind: 'sus_subprocess', sessionId: 'sess-2' })],
    verdicts: [
      verdict({
        targetSession: 'sess-2',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        at: '2026-07-28T11:59:00.000Z',
      }),
    ],
  });
  expect(view.items).toHaveLength(1);
  expect(view.items[0]).toMatchObject({
    sessionId: 'sess-2',
    fromAnomaly: true,
    judgement: { state: 'judged', verdict: 'needs_human' },
  });
  expect(view.outcome).toBe('items');
});

test('anomaly already covered by a board item is not duplicated', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [item({ id: 'A1' })])],
    anomalies: [anomaly({ kind: 'unattended_question', sessionId: 'sess-1' })],
  });
  expect(view.items).toHaveLength(1);
  expect(view.items[0]!.source).toBe('question');
});

test('provider-wide anomaly expands to every affected session id', () => {
  const view = run({
    sessions: [session('sess-a'), session('sess-b'), session('sess-c')],
    anomalies: [
      anomaly({
        kind: 'provider_unavailable',
        sessionId: 'sess-a',
        affectedSessionIds: ['sess-a', 'sess-b', 'sess-c'],
        provider: 'anthropic',
        detail: 'anthropic is rate-limited',
      }),
    ],
  });
  expect(view.items.map(i => i.sessionId).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
  for (const row of view.items) {
    expect(row.provider).toBe('anthropic');
    expect(row.fromAnomaly).toBe(true);
  }
});

// ── board parse errors ───────────────────────────────────────────────────────

test('parse errors: a corrupt board is surfaced, never dropped', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [], 2)],
  });
  expect(view.boardsWithParseErrors).toEqual([{ sessionId: 'sess-1', parseErrors: 2 }]);
});

test('parse errors block a false clean sweep: no rows + unreadable board = degraded', () => {
  const view = run({
    sessions: [session('sess-1')],
    boards: [board('sess-1', [], 1)], // present but unreadable, no visible items
    wardenState: { lastSweepAt: '2026-07-28T11:55:00.000Z' },
  });
  expect(view.items).toHaveLength(0);
  expect(view.outcome).toBe('degraded'); // NOT clean-sweep — an agent may be hidden
  expect(view.wardenDegraded?.reason).toContain('could not be read');
});

// ── ordering + outcomes ──────────────────────────────────────────────────────

test('oldest waiting first across the whole fleet', () => {
  const view = run({
    sessions: [session('sess-1'), session('sess-2'), session('sess-3')],
    boards: [
      board('sess-1', [item({ id: 'A1', waitingSince: '2026-07-28T11:30:00.000Z' })]),
      board('sess-2', [item({ id: 'A1', waitingSince: '2026-07-28T09:00:00.000Z' })]),
      board('sess-3', [item({ id: 'A1', waitingSince: '2026-07-28T10:15:00.000Z' })]),
    ],
  });
  expect(view.items.map(i => i.sessionId)).toEqual(['sess-2', 'sess-3', 'sess-1']);
});

test('outcome: clean sweep vs no sweep are distinguished when there are no rows', () => {
  expect(run({ wardenState: { lastSweepAt: '2026-07-28T11:55:00.000Z' } }).outcome).toBe('clean-sweep');
  expect(run({ wardenState: {} }).outcome).toBe('no-sweep');
});

test('empty fleet does not throw and yields an empty, explicit view', () => {
  const view = buildWardenAttentionView({
    now: NOW,
    sessions: [],
    boards: [],
    verdicts: [],
    anomalies: [],
    wardenState: {},
  });
  expect(view.items).toHaveLength(0);
  expect(view.outcome).toBe('no-sweep');
  expect(view.boardsWithParseErrors).toHaveLength(0);
});

test('sweep staleness raises a degraded banner', () => {
  const view = run({
    wardenState: { lastSweepAt: '2026-07-28T11:00:00.000Z' }, // 60m ago, interval 5m → stale
    sweepIntervalMinutes: 5,
  });
  expect(view.wardenDegraded?.reason).toContain('overdue');
  expect(view.outcome).toBe('degraded');
});

test('warden exhaustion cannot render an empty clean sweep', () => {
  const view = run({
    wardenState: {
      lastSweepAt: '2026-07-28T11:55:00.000Z',
      exhaustedSince: '2026-07-28T11:56:00.000Z',
    },
  });
  expect(view.items).toHaveLength(0);
  expect(view.wardenDegraded?.reason).toContain('exhausted');
  expect(view.outcome).toBe('degraded');
});

// ── provider (I/O) ───────────────────────────────────────────────────────────

function attentionFileJson(sessionId: string, items: AttentionItem[]): string {
  const nextId = items.reduce((max, i) => Math.max(max, Number(i.id.slice(1))), 0) + 1;
  return JSON.stringify({
    v: 1,
    sessionId,
    nextId,
    items,
    resolved: [],
    count: items.length,
    updatedAt: '2026-07-28T11:00:00.000Z',
  });
}

async function withTmpPaths<T>(fn: (paths: KTeamPaths, home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), 'warden-attn-'));
  const paths = createPaths(home);
  await mkdir(paths.wardenDir, { recursive: true });
  try {
    return await fn(paths, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function seedBoard(paths: KTeamPaths, sessionId: string, items: AttentionItem[]): Promise<void> {
  const dir = sessionDir(paths, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'attention.json'), attentionFileJson(sessionId, items));
}

test('provider: skips absent boards and only reads present ones', async () => {
  await withTmpPaths(async paths => {
    await seedBoard(paths, 'has-board', [item({ id: 'A1', raisedBySession: 'has-board' })]);
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('has-board'), session('no-board')],
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
    });
    const view = await provider.view();
    expect(view.items.map(i => i.sessionId)).toEqual(['has-board']);
    expect(view.boardsWithParseErrors).toHaveLength(0);
  });
});

test('provider: requests 101, exposes 100, and excludes the truncation sentinel from matching', async () => {
  await withTmpPaths(async paths => {
    await seedBoard(paths, 'sess-1', [item({ id: 'A1', raisedBySession: 'sess-1' })]);
    let requestedLimit = 0;
    const fetched = Array.from({ length: WARDEN_ATTENTION_VERDICT_LIMIT + 1 }, (_, index) =>
      verdict({
        targetSession: index === WARDEN_ATTENTION_VERDICT_LIMIT ? 'sess-1' : `other-${index}`,
        anomalyKind: 'unattended_question',
        verdict: 'needs_human',
        reportPath: `/reports/${index}.md`,
      }),
    );
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('sess-1')],
      verdicts: async limit => {
        requestedLimit = limit;
        return fetched;
      },
      anomalies: async () => [],
      now: () => NOW,
    });
    const view = await provider.view();
    expect(requestedLimit).toBe(101);
    expect(view.verdictCoverage).toEqual({ limit: 100, truncated: true });
    expect(view.items[0]!.judgement).toEqual({
      state: 'none',
      reason: 'No matching judgement was found in the recent 100-verdict window.',
    });
  });
});

test('provider: caches within TTL and re-reads after it lapses', async () => {
  await withTmpPaths(async paths => {
    await seedBoard(paths, 'has-board', [item({ id: 'A1', raisedBySession: 'has-board' })]);
    let listCalls = 0;
    let clock = NOW;
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => {
        listCalls++;
        return [session('has-board')];
      },
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => clock,
      cacheTtlMs: 5_000,
    });
    await provider.view();
    await provider.view(); // within TTL — served from cache
    expect(listCalls).toBe(1);
    clock += 6_000; // past TTL
    await provider.view();
    expect(listCalls).toBe(2);
  });
});

test('provider: reads the live sweep interval after a hot config change', async () => {
  await withTmpPaths(async paths => {
    await writeFile(paths.wardenState, JSON.stringify({ lastSweepAt: '2026-07-28T11:50:00.000Z' }));
    let intervalMinutes = 5;
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [],
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
      cacheTtlMs: 0,
      sweepIntervalMinutes: () => intervalMinutes,
    });
    expect((await provider.view()).outcome).toBe('clean-sweep'); // 10m < 3 × 5m
    intervalMinutes = 2;
    expect((await provider.view()).outcome).toBe('degraded'); // 10m > 3 × 2m
  });
});

test('provider: reads assignments, queue, and failover exhaustion from state.json', async () => {
  await withTmpPaths(async paths => {
    await seedBoard(paths, 'sess-1', [item({ id: 'A1', raisedBySession: 'sess-1' })]);
    await writeFile(
      paths.wardenState,
      JSON.stringify({
        lastSweepAt: '2026-07-28T11:55:00.000Z',
        failover: { exhaustedSince: '2026-07-28T11:40:00.000Z' },
      }),
    );
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('sess-1')],
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
    });
    const view = await provider.view();
    expect(view.items[0]!.judgement.state).toBe('failed');
    expect(view.wardenDegraded?.reason).toContain('exhausted');
    expect(view.lastSweepAt).toBe('2026-07-28T11:55:00.000Z');
  });
});

test('provider: a present but corrupt board surfaces as a parse error', async () => {
  await withTmpPaths(async paths => {
    const dir = sessionDir(paths, 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'attention.json'), '{ not valid json');
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('broken')],
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
    });
    const view = await provider.view();
    expect(view.boardsWithParseErrors).toEqual([{ sessionId: 'broken', parseErrors: 1 }]);
    // A recorded sweep + an unreadable board must not read as a clean all-clear.
    expect(view.outcome).toBe('degraded');
  });
});

// A failure to read the fleet, verdicts, or anomalies must REJECT — never
// resolve to an empty view. An empty view alongside a recorded sweep reads as a
// clean sweep, telling the human "nothing needs you" when the truth is "we
// could not check". Rejecting lets the API/UI render an explicit "unknown".

test('provider: a list failure rejects, never a false clean sweep', async () => {
  await withTmpPaths(async paths => {
    await writeFile(paths.wardenState, JSON.stringify({ lastSweepAt: '2026-07-28T11:55:00.000Z' }));
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => {
        throw new Error('fleet index unavailable');
      },
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
    });
    expect(provider.view()).rejects.toThrow('fleet index unavailable');
  });
});

test('provider: an anomaly failure rejects, never a false clean sweep', async () => {
  await withTmpPaths(async paths => {
    await writeFile(paths.wardenState, JSON.stringify({ lastSweepAt: '2026-07-28T11:55:00.000Z' }));
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('sess-1')],
      verdicts: async () => [],
      anomalies: async () => {
        throw new Error('anomaly file unreadable');
      },
      now: () => NOW,
    });
    expect(provider.view()).rejects.toThrow('anomaly file unreadable');
  });
});

test('provider: a verdict failure rejects rather than dropping every judge', async () => {
  await withTmpPaths(async paths => {
    await seedBoard(paths, 'sess-1', [item({ id: 'A1', raisedBySession: 'sess-1' })]);
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('sess-1')],
      verdicts: async () => {
        throw new Error('verdict read failed');
      },
      anomalies: async () => [],
      now: () => NOW,
    });
    expect(provider.view()).rejects.toThrow('verdict read failed');
  });
});

test('provider: an absent state.json is a legitimate no-sweep, not a failure', async () => {
  await withTmpPaths(async paths => {
    // No state.json written and no boards — the honest answer is "no sweep yet".
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [session('sess-1')],
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
    });
    const view = await provider.view();
    expect(view.outcome).toBe('no-sweep');
    expect(view.lastSweepAt).toBeUndefined();
  });
});

test('provider: a corrupt state.json rejects instead of becoming no-sweep', async () => {
  await withTmpPaths(async paths => {
    await writeFile(paths.wardenState, '{ not json');
    const provider = new WardenAttentionProvider({
      paths,
      list: async () => [],
      verdicts: async () => [],
      anomalies: async () => [],
      now: () => NOW,
    });
    expect(provider.view()).rejects.toThrow();
  });
});
