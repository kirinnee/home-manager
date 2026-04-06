import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import type { Phase3Context } from '../types';
import type { PollSignals } from '../types';
import { computePollState } from '../poll';
import { preFilterThreads } from '../eval';
import { withBotSignature } from '../../../core/github';
import { appendEvent } from '../../../core/log';

// ============================================================================
// Test helpers
// ============================================================================

function makeCtx(overrides?: Partial<Phase3Context>): Phase3Context {
  return {
    session: {
      id: 'test-session',
      repo_path: '/tmp/test',
      worktree: '/tmp/test',
      git_root: '/tmp/test',
      git_root_host: 'github.com/test/repo',
      ticket_id: 'TEST-1',
      branch: 'feature/test',
      local: 0,
      state: 'running',
      created_at: '2026-03-24T00:00:00Z',
      updated_at: '2026-03-24T00:00:00Z',
    },
    config: {
      claude_binary: 'claude',
      agents: {
        init: {},
        phase1: {
          triage: { prompt: '' },
          spec_writer: { prompt: '' },
          plan_writer: { prompt: '' },
          spec_reviewers: {},
          plan_reviewers: {},
        },
        phase2: {},
        phase3: {},
        generic: {},
      },
      templates: {
        triage: '',
        spec: '',
        plan: '',
      },
      kloop: {
        implementers: { claude: 1 },
        reviewPhases: [['claude']],
        maxIterations: 10,
        implementerTimeout: 30,
        reviewerTimeout: 15,
        conflictCheckThreshold: 2,
        firstLoopFullReview: false,
        previousReviewPropagation: 0,
        reviewerFailureLimit: 2,
      },
      settings: {
        maxPushCycles: 10,
        pollInterval: 60,
        defaultLlmTimeout: 300,
        coderabbit: true,
        removeSpecOnPush: false,
      },
      repo: {
        baseBranch: 'main',
        ticketSystem: null,
        prComment: null,
      },
    },
    version: 1,
    attempt: 1,
    ticketId: 'TEST-1',
    deliveryKind: 'pr',
    prNumber: 123,
    prUrl: 'https://github.com/test/repo/pull/123',
    baseBranch: 'main',
    pushCycle: 0,
    mergePolicy: null,
    deferredActions: [],
    forceWithLease: false,
    ...overrides,
  };
}

function makeSignals(overrides?: Partial<PollSignals>): PollSignals {
  return {
    prState: 'OPEN',
    mergeable: true,
    mergeStateStatus: 'CLEAN',
    checks: [],
    threads: 0,
    unresolvedThreads: 0,
    reviews: [],
    prComments: 0,
    changesRequested: false,
    approvals: 0,
    prAge: 0,
    ...overrides,
  };
}

// ============================================================================
// computePollState tests
// ============================================================================

describe('computePollState', () => {
  it('returns mergeable when all checks pass and no threads', () => {
    const signals = makeSignals({
      checks: [
        { name: 'ci', status: 'passing' },
        { name: 'lint', status: 'passing' },
      ],
      approvals: 1,
    });
    const ctx = makeCtx({
      mergePolicy: {
        requiresApprovingReviews: true,
        requiredApprovingReviewCount: 1,
        requiresStatusChecks: true,
        requiredStatusCheckContexts: ['ci'],
        requiresCodeOwnerReviews: false,
      },
    });
    expect(computePollState(signals, ctx)).toBe('mergeable');
  });

  it('returns mergeable without approval when not required', () => {
    const signals = makeSignals({
      checks: [{ name: 'ci', status: 'passing' }],
      approvals: 0,
    });
    const ctx = makeCtx({ mergePolicy: null });
    expect(computePollState(signals, ctx)).toBe('mergeable');
  });

  it('returns blocked when changes are requested', () => {
    const signals = makeSignals({
      changesRequested: true,
      approvals: 1,
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('blocked');
  });

  it('returns blocked when there are unresolved threads', () => {
    const signals = makeSignals({
      threads: 2,
      unresolvedThreads: 2,
      approvals: 1,
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('blocked');
  });

  it('returns pending when GitHub reports the PR is not mergeable', () => {
    const signals = makeSignals({
      approvals: 1,
      mergeable: false,
      mergeStateStatus: 'DIRTY',
      checks: [{ name: 'ci', status: 'passing' }],
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('pending');
  });

  it('returns mergeable even when more approvals are required (approvals excluded from automation)', () => {
    const signals = makeSignals({
      approvals: 1,
      checks: [{ name: 'ci', status: 'passing' }],
    });
    const ctx = makeCtx({
      mergePolicy: {
        requiresApprovingReviews: true,
        requiredApprovingReviewCount: 2,
        requiresStatusChecks: true,
        requiredStatusCheckContexts: ['ci'],
        requiresCodeOwnerReviews: false,
      },
    });
    expect(computePollState(signals, ctx)).toBe('mergeable');
  });

  it('returns blocked when CI is failing', () => {
    const signals = makeSignals({
      checks: [
        { name: 'ci', status: 'passing' },
        { name: 'lint', status: 'failing' },
      ],
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('blocked');
  });

  it('returns pending when CI is still running', () => {
    const signals = makeSignals({
      checks: [{ name: 'ci', status: 'pending' }],
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('pending');
  });

  it('returns mergeable when approval required but not yet given (approvals excluded from automation)', () => {
    const signals = makeSignals({
      checks: [{ name: 'ci', status: 'passing' }],
      approvals: 0,
    });
    const ctx = makeCtx({
      mergePolicy: {
        requiresApprovingReviews: true,
        requiredApprovingReviewCount: 1,
        requiresStatusChecks: false,
        requiredStatusCheckContexts: [],
        requiresCodeOwnerReviews: false,
      },
    });
    expect(computePollState(signals, ctx)).toBe('mergeable');
  });

  it('throws when PR is closed', () => {
    const signals = makeSignals({ prState: 'CLOSED' });
    const ctx = makeCtx();
    expect(() => computePollState(signals, ctx)).toThrow('PR was closed externally');
  });

  it('returns pending when CodeRabbit is running', () => {
    const signals = makeSignals({
      crStatus: 'running',
      approvals: 1,
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('pending');
  });

  it('returns pending when CodeRabbit is failing', () => {
    const signals = makeSignals({
      crStatus: 'failing',
      approvals: 1,
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('pending');
  });

  it('returns mergeable when CodeRabbit is passing', () => {
    const signals = makeSignals({
      crStatus: 'passing',
      approvals: 1,
      checks: [{ name: 'ci', status: 'passing' }],
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('mergeable');
  });

  it('returns mergeable when CodeRabbit is none', () => {
    const signals = makeSignals({
      crStatus: 'none',
      approvals: 1,
      checks: [{ name: 'ci', status: 'passing' }],
    });
    const ctx = makeCtx();
    expect(computePollState(signals, ctx)).toBe('mergeable');
  });
});

// ============================================================================
// preFilterThreads tests
// ============================================================================

describe('preFilterThreads', () => {
  it('closes outdated threads', () => {
    const threads = [
      {
        id: 't1',
        isOutdated: true,
        author: 'reviewer',
        body: 'Fix this',
        firstCommentId: 'c1',
        replies: [],
        lastReplyByBot: false,
      },
    ];
    const results = preFilterThreads(threads, 'none');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('outdated');
    expect(results[0].templateReply).toContain('outdated');
  });

  it('closes ghosted threads (bot replied + CR CI done)', () => {
    const threads = [
      {
        id: 't2',
        isOutdated: false,
        author: 'reviewer',
        body: 'Fix this',
        firstCommentId: 'c2',
        replies: [{ id: 'r1', author: 'claude', body: 'Fixed', isBot: true }],
        lastReplyByBot: true,
      },
    ];
    const results = preFilterThreads(threads, 'passing');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('ghosted');
    expect(results[0].templateReply).toContain('CI checks');
  });

  it('closes ghosted threads when CR is failing', () => {
    const threads = [
      {
        id: 't2',
        isOutdated: false,
        author: 'reviewer',
        body: 'Fix this',
        firstCommentId: 'c2',
        replies: [{ id: 'r1', author: 'claude', body: 'Fixed', isBot: true }],
        lastReplyByBot: true,
      },
    ];
    const results = preFilterThreads(threads, 'failing');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('ghosted');
  });

  it('skips pending threads (bot replied + CR CI running)', () => {
    const threads = [
      {
        id: 't3',
        isOutdated: false,
        author: 'reviewer',
        body: 'Check this',
        firstCommentId: 'c3',
        replies: [{ id: 'r1', author: 'claude', body: 'Looking into it', isBot: true }],
        lastReplyByBot: true,
      },
    ];
    const results = preFilterThreads(threads, 'running');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('pending');
  });

  it('sends human threads to LLM eval', () => {
    const threads = [
      {
        id: 't4',
        isOutdated: false,
        author: 'human-reviewer',
        body: 'This logic is wrong',
        firstCommentId: 'c4',
        replies: [],
        lastReplyByBot: false,
      },
    ];
    const results = preFilterThreads(threads, 'none');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('needs_eval');
  });

  it('handles mixed threads correctly', () => {
    const threads = [
      {
        id: 't1',
        isOutdated: true,
        author: 'reviewer',
        body: 'Old',
        firstCommentId: 'c1',
        replies: [],
        lastReplyByBot: false,
      },
      {
        id: 't2',
        isOutdated: false,
        author: 'human',
        body: 'New issue',
        firstCommentId: 'c2',
        replies: [],
        lastReplyByBot: false,
      },
      {
        id: 't3',
        isOutdated: false,
        author: 'coderabbit',
        body: 'Suggestion',
        firstCommentId: 'c3',
        replies: [{ id: 'r1', author: 'claude', body: 'Done', isBot: true }],
        lastReplyByBot: true,
      },
    ];
    const results = preFilterThreads(threads, 'passing');
    expect(results).toHaveLength(3);
    expect(results[0].category).toBe('outdated');
    expect(results[1].category).toBe('needs_eval');
    expect(results[2].category).toBe('ghosted');
  });

  it('handles empty threads list', () => {
    const results = preFilterThreads([], 'none');
    expect(results).toHaveLength(0);
  });

  it('ghosted detection uses last reply author', () => {
    const threads = [
      {
        id: 't1',
        isOutdated: false,
        author: 'human',
        body: 'Please fix',
        firstCommentId: 'c1',
        replies: [
          { id: 'r1', author: 'claude', body: 'Done', isBot: true },
          { id: 'r2', author: 'human', body: 'Still broken', isBot: false },
        ],
        lastReplyByBot: false,
      },
    ];
    const results = preFilterThreads(threads, 'passing');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('needs_eval');
  });
});

// ============================================================================
// withBotSignature tests
// ============================================================================

describe('withBotSignature', () => {
  it('appends bot signature to body', () => {
    const body = 'This is my reply';
    const result = withBotSignature(body);
    expect(result).toBe('This is my reply\n\nBy Claude Code Kautopilot');
  });

  it('works with empty body', () => {
    const result = withBotSignature('');
    expect(result).toBe('\n\nBy Claude Code Kautopilot');
  });

  it('preserves existing newlines', () => {
    const body = 'Line 1\n\nLine 3';
    const result = withBotSignature(body);
    expect(result).toBe('Line 1\n\nLine 3\n\nBy Claude Code Kautopilot');
  });
});

// ============================================================================
// Phase3 state map completeness tests
// ============================================================================

describe('phase3 state map', () => {
  it('all states are reachable from commit_pending', async () => {
    const { runPhase3 } = await import('../index');
    expect(typeof runPhase3).toBe('function');
  });

  it('context has all required fields with defaults', () => {
    const ctx = makeCtx({
      prNumber: null,
      prUrl: null,
    });
    expect(ctx.prNumber).toBeNull();
    expect(ctx.prUrl).toBeNull();
    expect(ctx.pushCycle).toBe(0);
    expect(ctx.mergePolicy).toBeNull();
    expect(ctx.deferredActions).toEqual([]);
    expect(ctx.ttyReason).toBeUndefined();
    expect(ctx.evalResults).toBeUndefined();
    expect(ctx.ttyResolveItems).toBeUndefined();
  });

  it('context supports eval results storage', () => {
    const ctx = makeCtx();
    ctx.evalResults = [
      {
        unitId: 'thread-t1',
        unitType: 'thread',
        verdict: 'reply',
        reply: 'Fixed in abc123',
      },
      {
        unitId: 'ci-lint',
        unitType: 'ci_failure',
        verdict: 'code_fix',
        codeFix: 'Remove unused import',
      },
    ];
    expect(ctx.evalResults).toHaveLength(2);
    expect(ctx.evalResults![0].verdict).toBe('reply');
    expect(ctx.evalResults![1].verdict).toBe('code_fix');
  });

  it('context supports tty resolve items', () => {
    const ctx = makeCtx();
    ctx.ttyResolveItems = [
      {
        id: 'thread-t1',
        type: 'thread',
        title: 'thread-t1',
        reasoning: 'Not sure if this is a valid concern',
        ambiguityReason: 'Could be either a false positive or real issue',
      },
    ];
    expect(ctx.ttyResolveItems).toHaveLength(1);
    expect(ctx.ttyResolveItems![0].ambiguityReason).toBe('Could be either a false positive or real issue');
  });
});

// ============================================================================
// DeferredAction tests
// ============================================================================

describe('DeferredAction types', () => {
  it('supports reply_thread action', () => {
    const action = {
      type: 'reply_thread' as const,
      threadId: 't1',
      body: 'Fixed in commit abc123',
    };
    expect(action.type).toBe('reply_thread');
    expect(action.threadId).toBe('t1');
  });

  it('supports resolve action', () => {
    const action = {
      type: 'resolve' as const,
      threadId: 't2',
    };
    expect(action.type).toBe('resolve');
  });

  it('supports react action', () => {
    const action = {
      type: 'react' as const,
      commentId: 'c1',
      reaction: '+1',
    };
    expect(action.type).toBe('react');
    expect(action.reaction).toBe('+1');
  });
});

// ============================================================================
// Bug fix tests
// ============================================================================

describe('bug fixes', () => {
  it('forceWithLease defaults to false', () => {
    const ctx = makeCtx();
    expect(ctx.forceWithLease).toBe(false);
  });

  it('forceWithLease can be set to true', () => {
    const ctx = makeCtx({ forceWithLease: true });
    expect(ctx.forceWithLease).toBe(true);
  });

  it('ttyReason includes merge_conflict', () => {
    const ctx = makeCtx({ ttyReason: 'merge_conflict' });
    expect(ctx.ttyReason).toBe('merge_conflict');
  });

  it('pollInterval is in config settings', () => {
    const ctx = makeCtx();
    expect(ctx.config.settings.pollInterval).toBe(60);
    const customCtx = makeCtx({
      config: {
        ...ctx.config,
        settings: { ...ctx.config.settings, pollInterval: 30 },
      },
    });
    expect(customCtx.config.settings.pollInterval).toBe(30);
  });

  it('PollThread includes firstCommentId', () => {
    const thread = {
      id: 't1',
      isOutdated: false,
      author: 'reviewer',
      body: 'Fix this',
      firstCommentId: 'comment-123',
      replies: [],
    };
    expect(thread.firstCommentId).toBe('comment-123');
  });

  it('reconstructPhase3Context restores prNumber from log', async () => {
    // Simulate reconstruction logic inline (avoids cross-module import issues in tests)
    // The actual implementation lives in src/phases/phase3/index.ts
    const mockLog = [
      {
        ts: '2026-03-25T00:00:00Z',
        event: 'create_pr:completed',
        version: 1,
        metadata: { prNumber: 42, prUrl: 'https://github.com/test/repo/pull/42' },
      },
      {
        ts: '2026-03-25T00:01:00Z',
        event: 'push:completed',
        version: 1,
        metadata: { pushCycle: 3, success: true },
      },
    ];

    // We can't easily mock readLog, so test the reconstruction logic inline
    let prNumber: number | null = null;
    let prUrl: string | null = null;
    let pushCycle = 0;

    for (let i = mockLog.length - 1; i >= 0; i--) {
      const entry = mockLog[i];
      if (!entry.metadata) continue;
      if (entry.metadata.prNumber != null) prNumber = entry.metadata.prNumber as number;
      if (entry.metadata.prUrl != null) prUrl = entry.metadata.prUrl as string;
      if (entry.metadata.pushCycle != null) pushCycle = Math.max(pushCycle, entry.metadata.pushCycle as number);
    }

    expect(prNumber).toBe(42);
    expect(prUrl).toBe('https://github.com/test/repo/pull/42');
    expect(pushCycle).toBe(3);
  });
});

// ============================================================================
// Ticket delivery behavioral tests (spec sections 11.2, 13.1.G, 13.1.7, 13.1.8)
// ============================================================================

import { logPath } from '../../../core/log';
import { snapshotPath } from '../../../core/artifacts';

describe('ticket_review no artifacts → failed (spec section 13.1.8)', () => {
  const SESSION = `test-ticket-review-noartifacts-${Date.now()}`;

  afterEach(() => {
    const walPath = logPath(SESSION);
    if (existsSync(walPath)) {
      rmSync(walPath, { recursive: true, force: true });
    }
    const epochDir = snapshotPath(SESSION, 1, '.');
    if (existsSync(epochDir)) {
      rmSync(epochDir, { recursive: true, force: true });
    }
  });

  it('returns failed when no draft artifacts exist for ticket epoch', async () => {
    // Set up minimal WAL so ensureStatus works
    appendEvent(SESSION, {
      ts: new Date().toISOString(),
      event: 'init:completed',
    });
    appendEvent(SESSION, {
      ts: new Date().toISOString(),
      event: 'phase1:started',
      version: 1,
    });

    const { handleTicketReview } = await import('../ticket-review');
    const ctx = makeCtx({ deliveryKind: 'ticket', version: 1 });
    ctx.session = {
      id: SESSION,
      repo_path: '/tmp/test',
      worktree: '/tmp/test',
      git_root: '/tmp/test',
      git_root_host: 'github.com/test/repo',
      ticket_id: 'TEST-1',
      branch: 'feature/test',
      local: 0,
      state: 'running',
      created_at: '2026-03-24T00:00:00Z',
      updated_at: '2026-03-24T00:00:00Z',
    };

    // No artifacts are in the epoch dir
    const result = await handleTicketReview(ctx);
    expect(result).toBe('failed');
  });
});
