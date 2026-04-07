/**
 * End-to-end scenario evidence tests (spec section 1.2).
 *
 * Each test exercises the complete durable state machinery:
 * WAL events → status reconstruction → manifest I/O → describe/status output.
 *
 * These are integration tests that validate real runtime paths,
 * not mocks or type-level assertions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readLog } from '../../core/log';
import { detectAndRecoverCrash, ensureStatus } from '../../core/status';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-e2e-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

import { snapshotPath } from '../../core/artifacts';
import {
  readContractManifest,
  readDeliveryManifest,
  readPlanManifest,
  supersedEpoch,
  updateDeliveryManifest,
  updatePlanManifestEntry,
  writeContractManifest,
  writeDeliveryManifest,
  writePlanManifest,
} from '../../core/manifests';
import { computeRolloverRecommendation } from '../phase3/poll';

function cleanSession(sessionId: string) {
  const dir = `${process.env.HOME}/.kautopilot/${sessionId}`;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function setupPlans(sessionId: string, version: number, count: number) {
  const plansDir = snapshotPath(sessionId, version, 'plans');
  mkdirSync(plansDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(plansDir, `plan-${i}-1.md`), `# Plan ${i}\nImplement step ${i}.`);
  }
  return writePlanManifest(sessionId, version);
}

// ============================================================================
// Scenario 1: Normal PR-only flow
// ============================================================================

describe('E2E Scenario 1: Normal PR-only flow', () => {
  const S = `e2e-normal-pr-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('completes Phase 1 → Phase 2 → Phase 3 with PR delivery', () => {
    // Phase 1: Plan
    writeContractManifest(S, 1, 'pr', 2);
    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase1:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:00Z',
      event: 'phase1:completed',
      version: 1,
    });
    setupPlans(S, 1, 2);

    // Phase 2: Implementation
    appendEvent(S, {
      ts: '2026-04-01T10:06:00Z',
      event: 'phase2:started',
      version: 1,
    });
    // Plan 1
    appendEvent(S, {
      ts: '2026-04-01T10:06:01Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 0 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:06:02Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:07:00Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:20:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'completed' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:20:01Z',
      event: 'commit:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:20:02Z',
      event: 'commit:completed',
      version: 1,
    });
    updatePlanManifestEntry(S, 1, 1, true, 'sha-plan1');
    // Plan 2
    appendEvent(S, {
      ts: '2026-04-01T10:21:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 1 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:21:01Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:22:00Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:35:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'completed' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:35:01Z',
      event: 'commit:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:35:02Z',
      event: 'commit:completed',
      version: 1,
    });
    updatePlanManifestEntry(S, 1, 2, true, 'sha-plan2');
    appendEvent(S, {
      ts: '2026-04-01T10:35:03Z',
      event: 'phase2:completed',
      version: 1,
    });

    // Phase 3: Polish (PR delivery)
    appendEvent(S, {
      ts: '2026-04-01T10:36:00Z',
      event: 'phase3:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:36:01Z',
      event: 'push:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:36:02Z',
      event: 'push:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:37:00Z',
      event: 'create_pr:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:37:01Z',
      event: 'context:updated',
      metadata: { prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:37:02Z',
      event: 'create_pr:completed',
      version: 1,
    });
    writeDeliveryManifest(S, 1, {
      kind: 'pr',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    appendEvent(S, {
      ts: '2026-04-01T11:00:00Z',
      event: 'phase3:completed',
      version: 1,
    });

    // Validate final state
    const status = ensureStatus(S);
    expect(status.phase).toBe('polish');
    expect(status.version).toBe(1);
    expect(status.context.prNumber).toBe(42);

    const manifest = readPlanManifest(S, 1);
    expect(manifest?.plans.every(p => p.completed)).toBe(true);
    expect(manifest?.plans[0].commitSha).toBe('sha-plan1');
    expect(manifest?.plans[1].commitSha).toBe('sha-plan2');

    const delivery = readDeliveryManifest(S, 1);
    expect(delivery?.kind).toBe('pr');
    expect(delivery?.prNumber).toBe(42);
  });
});

// ============================================================================
// Scenario 2: PR flow with contract rewrite and same-PR reuse
// ============================================================================

describe('E2E Scenario 2: PR flow with contract rewrite and same-PR reuse', () => {
  const S = `e2e-rewrite-same-pr-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('refine_local rewrite stays in v1 and reuses same PR', () => {
    writeContractManifest(S, 1, 'pr', 2);
    setupPlans(S, 1, 2);

    // Phase 1 + Phase 2 start
    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase1:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'phase1:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:02:00Z',
      event: 'phase2:started',
      version: 1,
    });

    // Plan 1 hits max_situations → resolve → refine_local
    appendEvent(S, {
      ts: '2026-04-01T10:03:00Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'max_situations' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:01Z',
      event: 'resolve:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:11:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'refine_local' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:11:01Z',
      event: 'resolve:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:11:02Z',
      event: 'rewrite_spec:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:12:00Z',
      event: 'rewrite_spec:completed',
      version: 1,
    });

    // Retry plan 1 successfully
    appendEvent(S, {
      ts: '2026-04-01T10:12:01Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:20:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'completed' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:20:01Z',
      event: 'commit:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:20:02Z',
      event: 'commit:completed',
      version: 1,
    });
    updatePlanManifestEntry(S, 1, 1, true, 'sha-plan1-v2');
    appendEvent(S, {
      ts: '2026-04-01T10:25:00Z',
      event: 'phase2:completed',
      version: 1,
    });

    // Phase 3 — creates PR
    appendEvent(S, {
      ts: '2026-04-01T10:26:00Z',
      event: 'phase3:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:27:00Z',
      event: 'context:updated',
      metadata: { prNumber: 77, prUrl: 'https://github.com/org/repo/pull/77' },
    });
    writeDeliveryManifest(S, 1, { kind: 'pr', prNumber: 77 });
    appendEvent(S, {
      ts: '2026-04-01T10:30:00Z',
      event: 'phase3:completed',
      version: 1,
    });

    // Validate: same version, same PR
    const status = ensureStatus(S);
    expect(status.version).toBe(1);
    expect(status.context.rewriteDecision).toBe('refine_local');
    expect(status.context.prNumber).toBe(77);

    const contract = readContractManifest(S, 1);
    expect(contract?.supersededBy).toBeUndefined();

    const delivery = readDeliveryManifest(S, 1);
    expect(delivery?.prNumber).toBe(77);
    expect(delivery?.prRolloverHistory).toBeUndefined();
  });
});

// ============================================================================
// Scenario 3: PR flow with heuristic rollover to a fresh PR
// ============================================================================

describe('E2E Scenario 3: PR flow with heuristic rollover to fresh PR', () => {
  const S = `e2e-rollover-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('old PR closed, new PR created, manifest records from→to', () => {
    writeContractManifest(S, 1, 'pr', 1);
    setupPlans(S, 1, 1);

    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase3:started',
      version: 1,
    });
    // Initial PR
    writeDeliveryManifest(S, 1, {
      kind: 'pr',
      prNumber: 10,
      prUrl: 'https://github.com/org/repo/pull/10',
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'context:updated',
      metadata: { prNumber: 10 },
    });

    // Poll detects rollover signals
    const signals = {
      prState: 'OPEN',
      mergeable: true,
      mergeStateStatus: 'CLEAN',
      checks: [],
      threads: 25,
      unresolvedThreads: 20,
      reviews: [],
      prComments: 60,
      changesRequested: false,
      approvals: 0,
      prAge: 200,
    };
    const rollover = computeRolloverRecommendation(signals, 10);
    expect(rollover.shouldRollover).toBe(true);

    // Rollover: close old PR #10, record placeholder
    updateDeliveryManifest(S, 1, {
      prNumber: undefined,
      prUrl: undefined,
      prRolloverHistory: [
        {
          fromPr: 10,
          toPr: 0,
          reason: rollover.reason!,
          timestamp: '2026-04-01T10:05:00Z',
        },
      ],
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:01Z',
      event: 'context:updated',
      metadata: { rolloverFromPr: 10, prNumber: undefined },
    });

    // Create new PR #25
    const newPr = 25;
    const delivery = readDeliveryManifest(S, 1)!;
    const prRolloverHistory = delivery.prRolloverHistory
      ? [{ ...delivery.prRolloverHistory[0], toPr: newPr }]
      : undefined;
    updateDeliveryManifest(S, 1, {
      prNumber: newPr,
      prUrl: `https://github.com/org/repo/pull/${newPr}`,
      prRolloverHistory,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:06:00Z',
      event: 'context:updated',
      metadata: { rolloverFromPr: undefined, prNumber: newPr },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:00Z',
      event: 'phase3:completed',
      version: 1,
    });

    // Validate
    const finalDelivery = readDeliveryManifest(S, 1)!;
    expect(finalDelivery.prNumber).toBe(25);
    expect(finalDelivery.prRolloverHistory).toHaveLength(1);
    expect(finalDelivery.prRolloverHistory?.[0].fromPr).toBe(10);
    expect(finalDelivery.prRolloverHistory?.[0].toPr).toBe(25);

    const status = ensureStatus(S);
    expect(status.context.prNumber).toBe(25);
  });
});

// ============================================================================
// Scenario 4: Ticket flow with draft artifacts, feedback, and new epoch
// ============================================================================

describe('E2E Scenario 4: Ticket flow with feedback → new epoch', () => {
  const S = `e2e-ticket-feedback-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('ticket feedback triggers vN+1 epoch with new plans', () => {
    // v1: Plan + Implementation + Phase 3 (ticket delivery)
    writeContractManifest(S, 1, 'ticket', 1);
    setupPlans(S, 1, 1);

    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase1:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'phase1:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:02:00Z',
      event: 'phase2:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:00Z',
      event: 'commit:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:01Z',
      event: 'commit:completed',
      version: 1,
    });
    updatePlanManifestEntry(S, 1, 1, true, 'sha-v1');
    appendEvent(S, {
      ts: '2026-04-01T10:10:02Z',
      event: 'phase2:completed',
      version: 1,
    });

    // Phase 3: ticket_draft produces artifacts
    appendEvent(S, {
      ts: '2026-04-01T10:11:00Z',
      event: 'phase3:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:12:00Z',
      event: 'ticket_draft:started',
      version: 1,
    });
    const artifactDir = snapshotPath(S, 1, 'ticket-artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'report-1.md'), '# Report\nFindings here.');
    appendEvent(S, {
      ts: '2026-04-01T10:13:00Z',
      event: 'ticket_draft:completed',
      version: 1,
    });

    // ticket_review: user gives feedback → ticketFeedback signal
    appendEvent(S, {
      ts: '2026-04-01T10:14:00Z',
      event: 'ticket_review:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:15:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { ticketFeedback: true },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:15:01Z',
      event: 'ticket_review:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:15:02Z',
      event: 'phase3:completed',
      version: 1,
    });

    // Status shows ticketFeedback
    let status = ensureStatus(S);
    expect(status.context.ticketFeedback).toBe(true);

    // Orchestrator detects feedback, supersedes v1, starts v2
    supersedEpoch(S, 1, 2);
    writeContractManifest(S, 2, 'ticket', 1);
    setupPlans(S, 2, 1);

    appendEvent(S, {
      ts: '2026-04-01T10:16:00Z',
      event: 'phase1:started',
      version: 2,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:17:00Z',
      event: 'phase1:completed',
      version: 2,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:18:00Z',
      event: 'phase2:started',
      version: 2,
    });

    status = ensureStatus(S);
    expect(status.version).toBe(2);
    expect(status.phase).toBe('implementation');

    const v1Contract = readContractManifest(S, 1);
    expect(v1Contract?.supersededBy).toBe(2);
  });
});

// ============================================================================
// Scenario 5: Ticket flow with approval and publish
// ============================================================================

describe('E2E Scenario 5: Ticket flow with approval and publish', () => {
  const S = `e2e-ticket-publish-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('ticket approval → publish records ticketArtifacts and publishedAt', () => {
    writeContractManifest(S, 1, 'ticket', 1);
    setupPlans(S, 1, 1);

    // Phases 1-2
    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase1:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'phase1:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:02:00Z',
      event: 'phase2:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:00Z',
      event: 'phase2:completed',
      version: 1,
    });

    // Phase 3: ticket_draft → ticket_review (approval) → ticket_publish
    appendEvent(S, {
      ts: '2026-04-01T10:06:00Z',
      event: 'phase3:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:07:00Z',
      event: 'ticket_draft:started',
      version: 1,
    });
    const artifactDir = snapshotPath(S, 1, 'ticket-artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'report-1.md'), '# Report');
    appendEvent(S, {
      ts: '2026-04-01T10:08:00Z',
      event: 'ticket_draft:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:09:00Z',
      event: 'ticket_review:started',
      version: 1,
    });
    // User approves (no ticketFeedback event)
    appendEvent(S, {
      ts: '2026-04-01T10:10:00Z',
      event: 'ticket_review:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:11:00Z',
      event: 'ticket_publish:started',
      version: 1,
    });

    // Publish succeeds, delivery manifest updated
    const publishedAt = '2026-04-01T10:12:00Z';
    writeDeliveryManifest(S, 1, {
      kind: 'ticket',
      ticketArtifacts: ['report-1.md', 'report-1.pdf'],
      publishedAt,
    });
    appendEvent(S, {
      ts: publishedAt,
      event: 'ticket_publish:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:12:01Z',
      event: 'phase3:completed',
      version: 1,
    });

    const delivery = readDeliveryManifest(S, 1)!;
    expect(delivery.kind).toBe('ticket');
    expect(delivery.ticketArtifacts).toContain('report-1.md');
    expect(delivery.ticketArtifacts).toContain('report-1.pdf');
    expect(delivery.publishedAt).toBe(publishedAt);

    const status = ensureStatus(S);
    expect(status.context.ticketFeedback).toBeUndefined();
  });
});

// ============================================================================
// Scenario 6: Conflict-triggered rewrite flow
// ============================================================================

describe('E2E Scenario 6: Conflict-triggered rewrite flow', () => {
  const S = `e2e-conflict-rewrite-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('conflict → resolve → patch_downstream rewrites remaining plans in same epoch', () => {
    writeContractManifest(S, 1, 'pr', 3);
    setupPlans(S, 1, 3);

    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase2:started',
      version: 1,
    });

    // Plan 1 completes
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 0 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:01Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:00Z',
      event: 'commit:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:01Z',
      event: 'commit:completed',
      version: 1,
    });
    updatePlanManifestEntry(S, 1, 1, true, 'sha-p1');

    // Plan 2 hits conflict
    appendEvent(S, {
      ts: '2026-04-01T10:06:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 1 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:06:01Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:07:00Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:15:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'conflict' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:15:01Z',
      event: 'resolve:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:16:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'patch_downstream' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:16:01Z',
      event: 'resolve:completed',
      version: 1,
    });

    // patch_downstream rewrites plans 2 and 3 — stays in same epoch
    appendEvent(S, {
      ts: '2026-04-01T10:16:02Z',
      event: 'rewrite_spec:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:17:00Z',
      event: 'rewrite_spec:completed',
      version: 1,
    });

    const status = ensureStatus(S);
    expect(status.version).toBe(1);
    expect(status.context.rewriteDecision).toBe('patch_downstream');

    const contract = readContractManifest(S, 1);
    expect(contract?.supersededBy).toBeUndefined();

    const manifest = readPlanManifest(S, 1);
    expect(manifest?.plans[0].completed).toBe(true);
    expect(manifest?.plans[1].completed).toBe(false);
    expect(manifest?.plans[2].completed).toBe(false);
  });
});

// ============================================================================
// Scenario 7: Max-situations-triggered rewrite flow
// ============================================================================

describe('E2E Scenario 7: Max-situations-triggered rewrite → revisit_spec', () => {
  const S = `e2e-max-sit-rewrite-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('max_situations → revisit_spec creates v2 epoch', () => {
    writeContractManifest(S, 1, 'pr', 1);
    setupPlans(S, 1, 1);

    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'phase2:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 0 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:01Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:02:00Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'max_situations' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:10:01Z',
      event: 'resolve:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:11:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'revisit_spec' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:11:01Z',
      event: 'resolve:completed',
      version: 1,
    });

    let status = ensureStatus(S);
    expect(status.context.rewriteDecision).toBe('revisit_spec');

    // Supersede v1 → v2
    supersedEpoch(S, 1, 2);
    writeContractManifest(S, 2, 'pr', 2);
    setupPlans(S, 2, 2);

    // v2 Phase 1 → Phase 2
    appendEvent(S, {
      ts: '2026-04-01T10:12:00Z',
      event: 'phase1:started',
      version: 2,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:13:00Z',
      event: 'phase1:completed',
      version: 2,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:14:00Z',
      event: 'phase2:started',
      version: 2,
    });

    status = ensureStatus(S);
    expect(status.version).toBe(2);
    expect(status.phase).toBe('implementation');

    const v1 = readContractManifest(S, 1);
    expect(v1?.supersededBy).toBe(2);

    const v2Manifest = readPlanManifest(S, 2);
    expect(v2Manifest?.plans).toHaveLength(2);
    expect(v2Manifest?.plans.every(p => !p.completed)).toBe(true);
  });
});

// ============================================================================
// Scenario 8: Crash and resume flow
// ============================================================================

describe('E2E Scenario 8: Crash and resume flow', () => {
  const S = `e2e-crash-resume-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('crash during running state → recovery resets to last checkpoint → resume', () => {
    writeContractManifest(S, 1, 'pr', 2);
    setupPlans(S, 1, 2);

    // Phase 2 starts, plan 1 commits (checkpoint)
    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'start:started',
      metadata: { pid: 99999998, phase: 'implementation' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:00:01Z',
      event: 'phase2:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 0 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:01Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:00Z',
      event: 'commit:started',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:05:01Z',
      event: 'commit:completed',
      version: 1,
    });
    updatePlanManifestEntry(S, 1, 1, true, 'sha-p1');

    // Plan 2 starts running then "crashes" (no completed event)
    appendEvent(S, {
      ts: '2026-04-01T10:06:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 1 },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:06:01Z',
      event: 'clear_loop:completed',
      version: 1,
    });
    appendEvent(S, {
      ts: '2026-04-01T10:07:00Z',
      event: 'running:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    // No running:completed — simulates a crash

    let status = ensureStatus(S);
    expect(status.running).toBe(true);
    expect(status.state).toBe('running');
    expect(status.stateStatus).toBe('running');
    // After plan 2's clear_loop:started, completedSteps was reset (per-plan cycle)
    // so last checkpoint is clear_loop (from plan 2's cycle)
    expect(status.lastCheckpoint).toBe('clear_loop');

    // Simulate crash detection (PID 99999998 is not alive)
    const recovered = detectAndRecoverCrash(S, '/tmp/fake-worktree');
    expect(recovered).toBe(true);

    status = ensureStatus(S);
    expect(status.running).toBe(false);
    expect(status.state).toBe('clear_loop'); // reset to last checkpoint in current cycle
    expect(status.stateStatus).toBe('completed');

    // Verify plan 1 is still complete but plan 2 is not
    const manifest = readPlanManifest(S, 1);
    expect(manifest?.plans[0].completed).toBe(true);
    expect(manifest?.plans[1].completed).toBe(false);

    // Verify WAL has crash:detected and reset:completed events
    const log = readLog(S);
    const crashEvent = log.find(e => e.event === 'crash:detected');
    expect(crashEvent).toBeDefined();
    expect(crashEvent?.metadata?.state).toBe('running');
    expect(crashEvent?.metadata?.checkpoint).toBe('clear_loop');

    const resetEvent = log.find(e => e.event === 'reset:completed');
    expect(resetEvent).toBeDefined();
    expect(resetEvent?.metadata?.checkpoint).toBe('clear_loop');
  });
});

describe('E2E Scenario 9: Crash during re-executed checkpoint state', () => {
  const S = `e2e-crash-checkpoint-reexec-${Date.now()}`;
  afterEach(() => cleanSession(S));

  it('crash in create_pr → reset to push checkpoint → resumes at create_pr (skips push)', () => {
    // Scenario: push completes (checkpoint), create_pr crashes.
    // Reset to checkpoint push means push succeeded — resume from create_pr.
    appendEvent(S, {
      ts: '2026-04-01T10:00:00Z',
      event: 'start:started',
      metadata: { pid: 99999998, phase: 'polish' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:00:01Z',
      event: 'phase3:started',
      version: 1,
    });

    // commit_pending completes (checkpoint)
    appendEvent(S, {
      ts: '2026-04-01T10:01:00Z',
      event: 'commit_pending:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:01Z',
      event: 'commit_pending:completed',
      version: 1,
    });

    // prereview completes (not a checkpoint)
    appendEvent(S, {
      ts: '2026-04-01T10:01:30Z',
      event: 'prereview:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:01:31Z',
      event: 'prereview:completed',
      version: 1,
    });

    // push completes (checkpoint = push)
    appendEvent(S, {
      ts: '2026-04-01T10:02:00Z',
      event: 'push:started',
      version: 1,
      metadata: { stepType: 'code' },
    });
    appendEvent(S, {
      ts: '2026-04-01T10:02:01Z',
      event: 'push:completed',
      version: 1,
    });

    // create_pr starts then crashes (no :completed)
    appendEvent(S, {
      ts: '2026-04-01T10:03:00Z',
      event: 'create_pr:started',
      version: 1,
      metadata: { stepType: 'code' },
    });

    let status = ensureStatus(S);
    expect(status.state).toBe('create_pr');
    expect(status.lastCheckpoint).toBe('push');

    // Crash recovery
    const recovered = detectAndRecoverCrash(S, '/tmp/fake-worktree');
    expect(recovered).toBe(true);

    status = ensureStatus(S);
    expect(status.running).toBe(false);
    // Reset to push checkpoint — push is completed, resume from next state (create_pr)
    expect(status.state).toBe('push');
    expect(status.stateStatus).toBe('completed');
    expect(status.completedSteps).toEqual(['commit_pending', 'prereview', 'push']);
    expect(status.lastCheckpoint).toBe('push');

    // Verify WAL
    const log = readLog(S);
    const resetEvent = log.findLast(e => e.event === 'reset:completed');
    expect(resetEvent?.metadata?.checkpoint).toBe('push');
  });
});
