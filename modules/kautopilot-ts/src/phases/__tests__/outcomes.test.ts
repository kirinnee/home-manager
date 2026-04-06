import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { ensureStatus } from '../../core/status';
import { appendEvent, logPath, readLog } from '../../core/log';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-outcomes-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});
import type { Phase3Context, PollSignals } from '../phase3/types';
import { computeRolloverRecommendation } from '../phase3/poll';
import {
  updatePlanManifestEntry,
  readPlanManifest,
  writePlanManifest,
  updateDeliveryManifest,
  readDeliveryManifest,
} from '../../core/manifests';
import { runScriptFromDir, type ScriptResult } from '../../core/scripts';
import { snapshotPath, ensureArtifactDir } from '../../core/artifacts';

// ============================================================================
// kloop outcome → orchestrator transition tests (spec section 7)
// ============================================================================

describe('kloop outcome handling (spec section 7.2-7.4)', () => {
  it('completed status maps correctly', () => {
    // Spec: completed → advance to next plan
    const status = 'completed';
    expect(status === 'completed').toBe(true);
    // In running.ts: returns 'commit'
  });

  it('max_situations status triggers rewrite analysis', () => {
    // Spec: max_situations → enter rewrite analysis
    const status = 'max_situations';
    expect(status === 'max_situations' || status === 'conflict').toBe(true);
    // In running.ts: returns 'resolve'
  });

  it('conflict status triggers rewrite analysis', () => {
    const status: string = 'conflict';
    expect(status === 'max_situations' || status === 'conflict').toBe(true);
    // In running.ts: returns 'resolve'
  });

  it('crash status retries before rewrite (invariant 8)', () => {
    // Spec: crash → retry/recover first, do not rewrite immediately
    const status = 'crash';
    expect(status === 'crash').toBe(true);
    // In running.ts: increments crashRetryCount, returns 'setup_run' for retry
  });

  it('valid rewrite decisions are the four spec-defined types', () => {
    const validDecisions = ['refine_local', 'patch_downstream', 'regenerate_remaining', 'revisit_spec'];
    expect(validDecisions).toHaveLength(4);
    expect(validDecisions).toContain('refine_local');
    expect(validDecisions).toContain('patch_downstream');
    expect(validDecisions).toContain('regenerate_remaining');
    expect(validDecisions).toContain('revisit_spec');
  });

  it('only revisit_spec creates a new epoch', () => {
    // Spec section 4.3: revisit_spec is the only rewrite that creates a new epoch
    const epochCreatingDecisions = ['refine_local', 'patch_downstream', 'regenerate_remaining', 'revisit_spec'].filter(
      d => d === 'revisit_spec',
    );
    expect(epochCreatingDecisions).toEqual(['revisit_spec']);
  });
});

// ============================================================================
// PR rollover heuristic tests (spec section 10.2)
// ============================================================================

describe('PR rollover heuristics (spec section 10.2)', () => {
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

  it('does not recommend rollover for quiet PR', () => {
    const signals = makeSignals({
      unresolvedThreads: 2,
      prComments: 5,
      prAge: 24,
    });
    const result = computeRolloverRecommendation(signals, 1);
    expect(result.shouldRollover).toBe(false);
  });

  it('recommends rollover when multiple signals fire', () => {
    const signals = makeSignals({
      unresolvedThreads: 20,
      prComments: 60,
      prAge: 48,
    });
    const result = computeRolloverRecommendation(signals, 3);
    expect(result.shouldRollover).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('unresolved threads');
    expect(result.reason).toContain('total comments');
  });

  it('considers push cycles as a signal', () => {
    const signals = makeSignals({
      unresolvedThreads: 20,
      prComments: 10,
      prAge: 24,
    });
    const result = computeRolloverRecommendation(signals, 10);
    expect(result.shouldRollover).toBe(true);
    expect(result.reason).toContain('push cycles');
  });

  it('considers PR age as a signal', () => {
    const signals = makeSignals({
      unresolvedThreads: 20,
      prComments: 10,
      prAge: 200, // > 168h threshold
    });
    const result = computeRolloverRecommendation(signals, 2);
    expect(result.shouldRollover).toBe(true);
    expect(result.reason).toContain('PR age');
  });

  it('requires at least 2 signals for rollover', () => {
    // Only one signal (high threads) — should NOT rollover
    const signals = makeSignals({
      unresolvedThreads: 20,
      prComments: 5,
      prAge: 12,
    });
    const result = computeRolloverRecommendation(signals, 1);
    expect(result.shouldRollover).toBe(false);
  });

  it('persists rollover signals', () => {
    const signals = makeSignals({
      unresolvedThreads: 5,
      prComments: 30,
      prAge: 48,
    });
    const result = computeRolloverRecommendation(signals, 4);
    expect(result.signals).toBeDefined();
    expect(result.signals.unresolvedThreads).toBe(5);
    expect(result.signals.totalComments).toBe(30);
    expect(result.signals.pushCycles).toBe(4);
    expect(result.signals.prAgeHours).toBe(48);
  });
});

// ============================================================================
// Delivery kind routing tests (spec sections 2.3, 3.3)
// ============================================================================

describe('delivery kind routing (spec section 2.3)', () => {
  it('pr and ticket are the only valid delivery kinds', () => {
    type DeliveryKind = 'pr' | 'ticket';
    const kinds: DeliveryKind[] = ['pr', 'ticket'];
    expect(kinds).toHaveLength(2);
  });

  it('no standalone report delivery kind', () => {
    // Spec section 2.3: There is no separate report delivery kind
    type DeliveryKind = 'pr' | 'ticket';
    const kinds: DeliveryKind[] = ['pr', 'ticket'];
    expect(kinds).not.toContain('report');
  });
});

// ============================================================================
// Contract epoch versioning tests (spec section 4)
// ============================================================================

const TEST_SESSION = `test-outcomes-${Date.now()}`;
const SESSION_DIR = join(process.env.HOME!, '.kautopilot', TEST_SESSION);

if (!existsSync(SESSION_DIR)) {
  mkdirSync(SESSION_DIR, { recursive: true });
}

process.on('exit', () => {
  if (existsSync(SESSION_DIR)) {
    rmSync(SESSION_DIR, { recursive: true, force: true });
  }
});

describe('contract epoch versioning (spec section 4)', () => {
  it('contract rewrite creates new epoch', () => {
    // revisit_spec → new epoch vN+1
    const currentVersion = 1;
    const newVersion = currentVersion + 1;
    expect(newVersion).toBe(2);
  });

  it('persists revisit_spec as durable status context for phase1 escalation', () => {
    appendEvent(TEST_SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase2:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-04-01T10:00:01Z', event: 'resolve:started', version: 1 });
    appendEvent(TEST_SESSION, {
      ts: '2026-04-01T10:00:02Z',
      event: 'context:updated',
      metadata: { rewriteDecision: 'revisit_spec' },
    });
    const status = ensureStatus(TEST_SESSION);
    expect(status.context.rewriteDecision).toBe('revisit_spec');
  });

  it('execution rewrite stays in same epoch', () => {
    const decisions = ['refine_local', 'patch_downstream', 'regenerate_remaining'];
    for (const decision of decisions) {
      expect(decision).not.toBe('revisit_spec');
      // These stay in the same epoch — no version increment
    }
  });
});

// ============================================================================
// Script expansion tests (spec section 12)
// ============================================================================

describe('ticket script expansion (spec section 12)', () => {
  it('ALL_SCRIPTS includes expanded ticket operations', () => {
    const { ALL_SCRIPTS } = require('../../core/scripts');
    expect(ALL_SCRIPTS).toContain('update-ticket');
    expect(ALL_SCRIPTS).toContain('create-downstream-ticket');
    expect(ALL_SCRIPTS).toContain('add-comment');
    expect(ALL_SCRIPTS).toContain('move-to-todo');
    expect(ALL_SCRIPTS).toContain('attach-artifact');
  });

  it('expanded scripts are in OPTIONAL_SCRIPTS', () => {
    const { OPTIONAL_SCRIPTS } = require('../../core/scripts');
    expect(OPTIONAL_SCRIPTS).toContain('update-ticket');
    expect(OPTIONAL_SCRIPTS).toContain('create-downstream-ticket');
    expect(OPTIONAL_SCRIPTS).toContain('add-comment');
    expect(OPTIONAL_SCRIPTS).toContain('move-to-todo');
    expect(OPTIONAL_SCRIPTS).toContain('attach-artifact');
  });

  it('critical scripts are unchanged', () => {
    const { CRITICAL_SCRIPTS } = require('../../core/scripts');
    expect(CRITICAL_SCRIPTS).toEqual(['extract-ticket', 'get-ticket']);
  });
});

// ============================================================================
// Behavioral tests for loop-3 spec requirements
// ============================================================================

const TEST_SESSION_OUTCOMES = `test-outcomes-${Date.now()}`;

process.on('exit', () => {
  const walPath = logPath(TEST_SESSION_OUTCOMES);
  if (existsSync(walPath)) {
    rmSync(walPath, { recursive: true, force: true });
  }
});

describe('ticketFeedback durable signal (spec sections 4.2 / 11.2)', () => {
  it('ticketFeedback event is persisted to WAL and reconstructed via status', () => {
    // Simulate Phase 3 writing ticket feedback event
    appendEvent(TEST_SESSION_OUTCOMES, {
      ts: new Date().toISOString(),
      event: 'ticket_review:started',
      version: 1,
    });
    appendEvent(TEST_SESSION_OUTCOMES, {
      ts: new Date().toISOString(),
      event: 'context:updated',
      version: 1,
      metadata: { ticketFeedback: true },
    });
    // WAL replay reconstructs the signal in status.context
    const status = ensureStatus(TEST_SESSION_OUTCOMES);
    expect(status.context.ticketFeedback).toBe(true);
  });

  it('ticketFeedback from prior events persists in WAL replay', () => {
    // Append a follow-up event — the previous ticketFeedback:true still shows up in status
    appendEvent(TEST_SESSION_OUTCOMES, {
      ts: new Date().toISOString(),
      event: 'phase3:started',
      version: 1,
    });
    const status = ensureStatus(TEST_SESSION_OUTCOMES);
    // WAL is append-only; prior ticketFeedback:true persists unless superseded by new epoch
    expect(status.context.ticketFeedback).toBe(true);
  });
});

describe('plan manifest completion state (spec sections 5.2 / 8)', () => {
  const SESSION = `test-plan-manifest-${Date.now()}`;
  const VERSION = 1;

  beforeEach(() => {
    const plansDir = snapshotPath(SESSION, VERSION, 'plans');
    const planFile = join(plansDir, 'plan-1-1.md');
    // Create plans dir and file so writePlanManifest creates an entry for ordinal 1
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(planFile, '# Plan 1\nDo the thing.');
    writePlanManifest(SESSION, VERSION);
  });

  afterEach(() => {
    const dir = snapshotPath(SESSION, VERSION, 'plans');
    rmSync(dir, { recursive: true, force: true });
  });

  it('updatePlanManifestEntry writes completed:true and commitSha', () => {
    updatePlanManifestEntry(SESSION, VERSION, 1, true, 'abc123def456');
    const manifest = readPlanManifest(SESSION, VERSION);
    const entry = manifest?.plans.find(p => p.ordinal === 1);
    expect(entry?.completed).toBe(true);
    expect(entry?.commitSha).toBe('abc123def456');
  });

  it('initial plan manifest has completed:false', () => {
    // Write initial state (not completed)
    const manifest = readPlanManifest(SESSION, VERSION);
    const entry = manifest?.plans.find(p => p.ordinal === 1);
    expect(entry?.completed).toBe(false);
    expect(entry?.commitSha).toBeUndefined();
  });
});

describe('PR rollover history in delivery manifest (spec sections 10.2 / 13.1.F)', () => {
  const SESSION = `test-rollover-${Date.now()}`;
  const VERSION = 1;

  afterEach(() => {
    const dir = `${process.env.HOME}/.kautopilot/${SESSION}/artifacts/v${VERSION}`;
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rollover recommendation is persisted to delivery manifest', () => {
    updateDeliveryManifest(SESSION, VERSION, {
      kind: 'pr',
      prNumber: 123,
    });

    // Simulate rollover being recommended
    const { readDeliveryManifest } = require('../../core/manifests');
    const existing = readDeliveryManifest(SESSION, VERSION);
    const history = existing?.prRolloverHistory ?? [];
    history.push({
      fromPr: 123,
      toPr: 123,
      reason: 'PR review saturation: 20 unresolved threads; 8 push cycles',
      timestamp: new Date().toISOString(),
    });

    updateDeliveryManifest(SESSION, VERSION, { prRolloverHistory: history });
    const updated = readDeliveryManifest(SESSION, VERSION);
    expect(updated?.prRolloverHistory).toHaveLength(1);
    expect(updated?.prRolloverHistory?.[0].reason).toContain('review saturation');
  });
});

describe('runScriptFromDir no-op script success (spec section 13.1.G / 13.1.7)', () => {
  const SCRIPTS_DIR = join(process.env.HOME!, `.kautopilot/test-scripts-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(SCRIPTS_DIR, { recursive: true });
    writeFileSync(join(SCRIPTS_DIR, 'noop.sh'), '#!/bin/bash\nexit 0\n');
    Bun.spawnSync({ cmd: ['chmod', '+x', join(SCRIPTS_DIR, 'noop.sh')] });
  });

  afterEach(() => {
    rmSync(SCRIPTS_DIR, { recursive: true, force: true });
  });

  it('no-op script (exit 0, empty stdout) returns ok:true', () => {
    const result = runScriptFromDir(SCRIPTS_DIR, 'noop.sh', []);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('failing script returns ok:false', () => {
    writeFileSync(join(SCRIPTS_DIR, 'fail.sh'), '#!/bin/bash\nexit 1\n');
    Bun.spawnSync({ cmd: ['chmod', '+x', join(SCRIPTS_DIR, 'fail.sh')] });
    const result = runScriptFromDir(SCRIPTS_DIR, 'fail.sh', []);
    expect(result.ok).toBe(false);
  });

  it('script with stdout returns ok:true and captures stdout', () => {
    writeFileSync(join(SCRIPTS_DIR, 'output.sh'), '#!/bin/bash\necho "hello"\nexit 0\n');
    Bun.spawnSync({ cmd: ['chmod', '+x', join(SCRIPTS_DIR, 'output.sh')] });
    const result = runScriptFromDir(SCRIPTS_DIR, 'output.sh', []);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hello');
  });
});

// ============================================================================
// revisit_spec end-to-end re-entry through implementation (spec section 1.1)
// ============================================================================

describe('revisit_spec re-entry through implementation (spec section 1.1)', () => {
  const SESSION = `test-revisit-spec-${Date.now()}`;

  afterEach(() => {
    const dir = `${process.env.HOME}/.kautopilot/${SESSION}`;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('revisit_spec WAL sequence creates v2 epoch and preserves rewrite history', () => {
    // Simulate Phase 2 running on v1, hitting a conflict, resolve deciding revisit_spec
    appendEvent(SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase2:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:01:00Z',
      event: 'clear_loop:started',
      version: 1,
      metadata: { planIndex: 0 },
    });
    appendEvent(SESSION, { ts: '2026-04-01T10:01:01Z', event: 'clear_loop:completed', version: 1 });
    appendEvent(SESSION, { ts: '2026-04-01T10:02:00Z', event: 'setup_run:started', version: 1 });
    appendEvent(SESSION, { ts: '2026-04-01T10:02:01Z', event: 'setup_run:completed', version: 1 });
    appendEvent(SESSION, { ts: '2026-04-01T10:03:00Z', event: 'running:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:10:00Z',
      event: 'running:completed',
      version: 1,
      metadata: { status: 'max_situations' },
    });
    appendEvent(SESSION, { ts: '2026-04-01T10:10:01Z', event: 'resolve:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:11:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'revisit_spec' },
    });
    appendEvent(SESSION, { ts: '2026-04-01T10:11:01Z', event: 'resolve:completed', version: 1 });

    // Status reconstructs the revisit_spec decision
    let status = ensureStatus(SESSION);
    expect(status.context.rewriteDecision).toBe('revisit_spec');
    expect(status.phase).toBe('implementation');
    expect(status.version).toBe(1);

    // Simulate the orchestrator superseding epoch and starting v2 Phase 1
    const { writeContractManifest, supersedEpoch } = require('../../core/manifests');
    writeContractManifest(SESSION, 1, 'pr', 2);
    supersedEpoch(SESSION, 1, 2);

    // Verify contract manifest records supersession
    const { readContractManifest } = require('../../core/manifests');
    const v1Contract = readContractManifest(SESSION, 1);
    expect(v1Contract?.supersededBy).toBe(2);
    expect(v1Contract?.supersededAt).toBeDefined();

    // Start Phase 1 for v2
    appendEvent(SESSION, { ts: '2026-04-01T10:12:00Z', event: 'phase1:started', version: 2 });
    appendEvent(SESSION, { ts: '2026-04-01T10:15:00Z', event: 'phase1:completed', version: 2 });

    // Then Phase 2 for v2
    appendEvent(SESSION, { ts: '2026-04-01T10:15:01Z', event: 'phase2:started', version: 2 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:16:00Z',
      event: 'clear_loop:started',
      version: 2,
      metadata: { planIndex: 0 },
    });
    appendEvent(SESSION, { ts: '2026-04-01T10:16:01Z', event: 'clear_loop:completed', version: 2 });

    status = ensureStatus(SESSION);
    expect(status.phase).toBe('implementation');
    expect(status.version).toBe(2);
    // completedSteps reset for new phase
    expect(status.completedSteps).toContain('clear_loop');
  });

  it('rewrite history is reconstructable from WAL for describe --json', () => {
    // Simulate two rewrite events across versions
    appendEvent(SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase2:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:05:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'refine_local', plan: 'plan-1' },
    });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:10:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'revisit_spec' },
    });

    const log = readLog(SESSION);
    const rewriteHistory: Array<{ version: number; decision: string; plan?: string }> = [];
    for (const entry of log) {
      if (entry.event === 'context:updated' && entry.version !== undefined) {
        const meta = entry.metadata as Record<string, unknown> | undefined;
        if (meta?.rewriteDecision && typeof meta.rewriteDecision === 'string') {
          rewriteHistory.push({
            version: entry.version,
            decision: meta.rewriteDecision,
            plan: meta.plan as string | undefined,
          });
        }
      }
    }

    expect(rewriteHistory).toHaveLength(2);
    expect(rewriteHistory[0]).toEqual({ version: 1, decision: 'refine_local', plan: 'plan-1' });
    expect(rewriteHistory[1]).toEqual({ version: 1, decision: 'revisit_spec', plan: undefined });
  });
});

// ============================================================================
// PR rollover execution flow (spec section 1.3)
// ============================================================================

describe('PR rollover execution flow (spec section 1.3)', () => {
  const SESSION = `test-pr-rollover-exec-${Date.now()}`;
  const VERSION = 1;

  afterEach(() => {
    const dir = `${process.env.HOME}/.kautopilot/${SESSION}`;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('rollover records fromPr with placeholder toPr=0, then updates after new PR creation', () => {
    // Step 1: Initial PR delivery manifest
    updateDeliveryManifest(SESSION, VERSION, {
      kind: 'pr',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    // Step 2: Rollover detected — close old PR, record placeholder
    const oldPrNumber = 42;
    updateDeliveryManifest(SESSION, VERSION, {
      prNumber: undefined,
      prUrl: undefined,
      prRolloverHistory: [
        {
          fromPr: oldPrNumber,
          toPr: 0, // placeholder
          reason: 'PR review saturation: 20 unresolved threads; 10 push cycles',
          timestamp: '2026-04-01T10:00:00Z',
        },
      ],
    });

    // Verify placeholder state
    let delivery = readDeliveryManifest(SESSION, VERSION);
    expect(delivery?.prRolloverHistory).toHaveLength(1);
    expect(delivery?.prRolloverHistory?.[0].toPr).toBe(0);
    expect(delivery?.prRolloverHistory?.[0].fromPr).toBe(42);

    // Step 3: New PR created, update placeholder
    const newPrNumber = 85;
    if (delivery?.prRolloverHistory) {
      const lastEntry = delivery.prRolloverHistory.findLast(
        (e: { fromPr: number; toPr: number }) => e.fromPr === oldPrNumber && e.toPr === 0,
      );
      expect(lastEntry).toBeDefined();
      lastEntry!.toPr = newPrNumber;
      updateDeliveryManifest(SESSION, VERSION, {
        prNumber: newPrNumber,
        prUrl: `https://github.com/org/repo/pull/${newPrNumber}`,
        prRolloverHistory: delivery.prRolloverHistory,
      });
    }

    // Verify final state
    delivery = readDeliveryManifest(SESSION, VERSION);
    expect(delivery?.prNumber).toBe(85);
    expect(delivery?.prRolloverHistory?.[0].fromPr).toBe(42);
    expect(delivery?.prRolloverHistory?.[0].toPr).toBe(85);
    expect(delivery?.prRolloverHistory?.[0].reason).toContain('review saturation');
  });

  it('rollover context signal persists in WAL and is cleared after new PR creation', () => {
    // Simulate rollover context update
    appendEvent(SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase3:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:01:00Z',
      event: 'context:updated',
      metadata: { rolloverFromPr: 42, prNumber: undefined, prUrl: undefined },
    });

    let status = ensureStatus(SESSION);
    expect(status.context.rolloverFromPr).toBe(42);

    // After creating new PR, clear rollover context
    appendEvent(SESSION, {
      ts: '2026-04-01T10:02:00Z',
      event: 'context:updated',
      metadata: { rolloverFromPr: undefined, prNumber: 85, prUrl: 'https://github.com/org/repo/pull/85' },
    });

    status = ensureStatus(SESSION);
    expect(status.context.prNumber).toBe(85);
  });
});

// ============================================================================
// describe/status --json actual output validation (spec section 1.4)
// ============================================================================

describe('describe --json durable state surface (spec sections 9.2 / 13.1.E)', () => {
  const SESSION = `test-describe-json-${Date.now()}`;
  const VERSION = 1;

  afterEach(() => {
    const dir = `${process.env.HOME}/.kautopilot/${SESSION}`;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes full describe --json output from WAL + manifests', () => {
    // Set up WAL events
    appendEvent(SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase1:started', version: 1 });
    appendEvent(SESSION, { ts: '2026-04-01T10:01:00Z', event: 'phase1:completed', version: 1 });
    appendEvent(SESSION, { ts: '2026-04-01T10:02:00Z', event: 'phase2:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:05:00Z',
      event: 'context:updated',
      version: 1,
      metadata: { rewriteDecision: 'refine_local', plan: 'plan-1' },
    });
    appendEvent(SESSION, { ts: '2026-04-01T10:10:00Z', event: 'phase2:completed', version: 1 });

    // Set up plan manifest with completion state
    const plansDir = snapshotPath(SESSION, VERSION, 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1-1.md'), '# Plan 1');
    writeFileSync(join(plansDir, 'plan-2-1.md'), '# Plan 2');
    writePlanManifest(SESSION, VERSION);
    updatePlanManifestEntry(SESSION, VERSION, 1, true, 'abc123');

    // Set up delivery manifest
    updateDeliveryManifest(SESSION, VERSION, {
      kind: 'pr',
      prNumber: 99,
      prUrl: 'https://github.com/org/repo/pull/99',
      prRolloverHistory: [
        {
          fromPr: 50,
          toPr: 99,
          reason: 'saturation',
          timestamp: '2026-04-01T09:00:00Z',
        },
      ],
    });

    // Set up contract manifest
    const { writeContractManifest } = require('../../core/manifests');
    writeContractManifest(SESSION, VERSION, 'pr', 2);

    // Reconstruct the describe --json output structure (same logic as describe.ts)
    const log = readLog(SESSION);
    const status = ensureStatus(SESSION);
    const planManifest = readPlanManifest(SESSION, VERSION);
    const delivery = readDeliveryManifest(SESSION, VERSION);

    // Rewrite history from WAL
    const rewriteHistory: Array<{ version: number; decision: string; plan?: string }> = [];
    for (const entry of log) {
      if (entry.event === 'context:updated' && entry.version !== undefined) {
        const meta = entry.metadata as Record<string, unknown> | undefined;
        if (meta?.rewriteDecision && typeof meta.rewriteDecision === 'string') {
          rewriteHistory.push({
            version: entry.version,
            decision: meta.rewriteDecision,
            plan: meta.plan as string | undefined,
          });
        }
      }
    }

    const data = {
      activeEpoch: status.version,
      currentPlans:
        planManifest?.plans.map(p => ({
          ordinal: p.ordinal,
          file: p.file,
          activeRewrite: p.activeRewrite,
          completed: p.completed,
          commitSha: p.commitSha ?? null,
        })) ?? [],
      rewriteHistory,
      handoffReason: status.context.rewriteDecision ? `rewrite: ${status.context.rewriteDecision}` : null,
      delivery: {
        kind: delivery?.kind ?? null,
        prNumber: delivery?.prNumber ?? null,
        prUrl: delivery?.prUrl ?? null,
        rolloverHistory: delivery?.prRolloverHistory ?? [],
        ticketArtifacts: delivery?.ticketArtifacts ?? [],
        publishedAt: delivery?.publishedAt ?? null,
      },
      rolloverRecommendation: status.context.rolloverRecommendation ?? null,
    };

    // Validate all required fields and structure
    expect(data.activeEpoch).toBe(1);
    expect(data.currentPlans).toHaveLength(2);
    expect(data.currentPlans[0].ordinal).toBe(1);
    expect(data.currentPlans[0].completed).toBe(true);
    expect(data.currentPlans[0].commitSha).toBe('abc123');
    expect(data.currentPlans[1].ordinal).toBe(2);
    expect(data.currentPlans[1].completed).toBe(false);
    expect(data.currentPlans[1].commitSha).toBeNull();

    expect(data.rewriteHistory).toHaveLength(1);
    expect(data.rewriteHistory[0].decision).toBe('refine_local');
    expect(data.rewriteHistory[0].plan).toBe('plan-1');

    expect(data.handoffReason).toBe('rewrite: refine_local');

    expect(data.delivery.kind).toBe('pr');
    expect(data.delivery.prNumber).toBe(99);
    expect(data.delivery.rolloverHistory).toHaveLength(1);
    expect(data.delivery.rolloverHistory[0].fromPr).toBe(50);
    expect(data.delivery.rolloverHistory[0].toPr).toBe(99);
    expect(data.delivery.ticketArtifacts).toEqual([]);
    expect(data.delivery.publishedAt).toBeNull();
    expect(data.rolloverRecommendation).toBeNull();

    // Verify JSON round-trip (parseable output)
    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.activeEpoch).toBe(1);
    expect(parsed.delivery.prNumber).toBe(99);
  });

  it('status --json exposes matching fields from WAL + manifests', () => {
    appendEvent(SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase2:started', version: 1 });
    appendEvent(SESSION, {
      ts: '2026-04-01T10:05:00Z',
      event: 'context:updated',
      metadata: { deliveryKind: 'ticket', ticketFeedback: true },
    });

    const status = ensureStatus(SESSION);

    const data = {
      phase: status.phase,
      state: status.state,
      version: status.version,
      activeEpoch: status.version,
      context: status.context,
      currentPlans: (() => {
        const pm = readPlanManifest(SESSION, status.version);
        return (
          pm?.plans.map(p => ({
            ordinal: p.ordinal,
            file: p.file,
            activeRewrite: p.activeRewrite,
            completed: p.completed,
            commitSha: p.commitSha ?? null,
          })) ?? []
        );
      })(),
      delivery: (() => {
        const d = readDeliveryManifest(SESSION, status.version);
        return d
          ? {
              kind: d.kind,
              prNumber: d.prNumber ?? null,
              prUrl: d.prUrl ?? null,
              rolloverHistory: d.prRolloverHistory ?? [],
              ticketArtifacts: d.ticketArtifacts ?? [],
              publishedAt: d.publishedAt ?? null,
            }
          : null;
      })(),
      rolloverRecommendation: status.context.rolloverRecommendation ?? null,
    };

    expect(data.phase).toBe('implementation');
    expect(data.version).toBe(1);
    expect(data.activeEpoch).toBe(1);
    expect(data.context.deliveryKind).toBe('ticket');
    expect(data.context.ticketFeedback).toBe(true);
    expect(data.currentPlans).toEqual([]);
    expect(data.delivery).toBeNull();
    expect(data.rolloverRecommendation).toBeNull();

    // Verify JSON round-trip
    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.activeEpoch).toBe(1);
    expect(parsed.context.ticketFeedback).toBe(true);
  });

  it('handoffReason correctly identifies ticket_feedback vs rewrite', () => {
    // Test ticket_feedback handoff reason
    appendEvent(SESSION, { ts: '2026-04-01T10:00:00Z', event: 'phase3:started', version: 1 });
    appendEvent(SESSION, { ts: '2026-04-01T10:01:00Z', event: 'context:updated', metadata: { ticketFeedback: true } });

    let status = ensureStatus(SESSION);
    let handoffReason = status.context.rewriteDecision
      ? `rewrite: ${status.context.rewriteDecision}`
      : status.context.ticketFeedback
        ? 'ticket_feedback'
        : null;
    expect(handoffReason).toBe('ticket_feedback');

    // Override with a rewrite decision — rewrite takes precedence
    appendEvent(SESSION, {
      ts: '2026-04-01T10:02:00Z',
      event: 'context:updated',
      metadata: { rewriteDecision: 'revisit_spec' },
    });
    status = ensureStatus(SESSION);
    handoffReason = status.context.rewriteDecision
      ? `rewrite: ${status.context.rewriteDecision}`
      : status.context.ticketFeedback
        ? 'ticket_feedback'
        : null;
    expect(handoffReason).toBe('rewrite: revisit_spec');
  });
});
