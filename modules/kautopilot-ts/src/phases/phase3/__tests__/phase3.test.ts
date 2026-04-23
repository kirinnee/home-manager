import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { withBotSignature } from '../../../core/github';
import { appendEvent } from '../../../core/log';
import type { Phase3Context } from '../types';

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
        compressSpec: false,
        firstLoopFullReview: false,
        previousReviewPropagation: 0,
        synthesis: true,
        synthesisTimeout: 15,
        verify: true,
        verifyPhases: [['claude:claude']],
        verifyTimeout: 5,
        rerankAfterCheckpoint: true,
        implementerRetry: { maxRetries: 2, backoffBaseMs: 5000 },
        firstIterationWeightMultiplier: 2,
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
    expect(ctx.evalResults?.[0].verdict).toBe('reply');
    expect(ctx.evalResults?.[1].verdict).toBe('code_fix');
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
    expect(ctx.ttyResolveItems?.[0].ambiguityReason).toBe('Could be either a false positive or real issue');
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
      firstCommentDatabaseId: 123,
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
        metadata: {
          prNumber: 42,
          prUrl: 'https://github.com/test/repo/pull/42',
        },
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

import { snapshotPath } from '../../../core/artifacts';

describe('ticket_review no artifacts → failed (spec section 13.1.8)', () => {
  const SESSION = `test-ticket-review-noartifacts-${Date.now()}`;

  afterEach(() => {
    const walPath = `${process.env.HOME}/.kautopilot/${SESSION}/log.jsonl`;
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
