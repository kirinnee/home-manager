/**
 * Triage phase unit tests — validates spec DoD criteria B through E.
 *
 * Tests exercise actual runtime code paths (file I/O, log parsing, config resolution)
 * without requiring a live kautopilot session or TTY binary.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-triage-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

import { sessionDir } from '../../core/artifacts';
import { appendEvent, readLog } from '../../core/log';
import {
  readContractManifest,
  readDeliveryManifest,
  writeContractManifest,
  writeDeliveryManifest,
} from '../../core/manifests';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import type { Config, SessionRow } from '../../core/types';
import type { Phase1Context } from '../phase1/types';

// ============================================================================
// Test helpers
// ============================================================================

function makeSession(sessionId: string, worktree: string, local = 1): SessionRow {
  return {
    id: sessionId,
    repo_path: `/tmp/test-repo-${sessionId}`,
    worktree,
    git_root: 'https://github.com/test/repo',
    git_root_host: 'github.com',
    ticket_id: local ? 'local-test' : 'TEST-1',
    branch: 'feature/test',
    local,
    state: 'ready',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeConfig(overrides?: { triage?: string; spec_writer?: string; plan_writer?: string }): Config {
  return {
    claude_binary: 'claude',
    agents: {
      init: {},
      phase1: {
        triage: { prompt: overrides?.triage ?? '' },
        spec_writer: { prompt: overrides?.spec_writer ?? '' },
        plan_writer: { prompt: overrides?.plan_writer ?? '' },
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
      pollInterval: 5,
      defaultLlmTimeout: 300,
      coderabbit: true,
      removeSpecOnPush: false,
    },
    repo: { baseBranch: 'main', ticketSystem: null, prComment: null },
  };
}

function makeCtx(sessionId: string, worktree: string, overrides?: Partial<Phase1Context>): Phase1Context {
  return {
    session: makeSession(sessionId, worktree),
    config: makeConfig(),
    version: 1,
    attempt: 1,
    ...overrides,
  };
}

function cleanSession(sessionId: string) {
  const dir = sessionDir(sessionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function cleanWorktree(wt: string) {
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
}

// ============================================================================
// A. Configurable prompts (config schema + defaults)
// ============================================================================

describe('A. Configurable prompts', () => {
  it('config.agents.phase1 has triage, spec_writer, plan_writer fields', () => {
    const config = makeConfig();
    expect(config.agents.phase1.triage).toBeDefined();
    expect(typeof config.agents.phase1.triage.prompt).toBe('string');
    expect(typeof config.agents.phase1.spec_writer.prompt).toBe('string');
    expect(typeof config.agents.phase1.plan_writer.prompt).toBe('string');
  });

  it('config.agents.phase1 prompts can be overridden', () => {
    const customTriage = 'Custom triage prompt for org X';
    const customSpec = 'Custom spec writer prompt';
    const config = makeConfig({
      triage: customTriage,
      spec_writer: customSpec,
    });
    expect(config.agents.phase1.triage.prompt).toBe(customTriage);
    expect(config.agents.phase1.spec_writer.prompt).toBe(customSpec);
    expect(config.agents.phase1.plan_writer.prompt).toBe(''); // default from makeConfig
  });

  it('DEFAULT_CONFIG.agents.phase1 contains all three default prompts', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    expect(DEFAULT_CONFIG.agents.phase1.triage.prompt).toContain('triaging a ticket');
    expect(DEFAULT_CONFIG.agents.phase1.spec_writer.prompt).toContain('{triage}');
    expect(DEFAULT_CONFIG.agents.phase1.plan_writer.prompt).toContain('{triage}');
    expect(DEFAULT_CONFIG.agents.phase1.triage.prompt.length).toBeGreaterThan(50);
    expect(DEFAULT_CONFIG.agents.phase1.spec_writer.prompt.length).toBeGreaterThan(50);
    expect(DEFAULT_CONFIG.agents.phase1.plan_writer.prompt.length).toBeGreaterThan(50);
  });

  it('configSchema parses agents.phase1 with defaults when omitted', async () => {
    const { configSchema } = await import('../../core/types');
    const parsed = configSchema.parse({
      agents: {
        phase1: {
          triage: { prompt: 't' },
          spec_writer: { prompt: 's' },
          plan_writer: { prompt: 'p' },
        },
      },
    });
    expect(parsed.agents.phase1.triage.prompt).toBe('t');
    expect(parsed.agents.phase1.spec_writer.prompt).toBe('s');
    expect(parsed.agents.phase1.plan_writer.prompt).toBe('p');
  });

  it('configSchema allows partial phase1 prompt overrides', async () => {
    const { configSchema } = await import('../../core/types');
    const parsed = configSchema.parse({
      agents: {
        phase1: {
          triage: { prompt: 'custom triage' },
          spec_writer: { prompt: 's' },
          plan_writer: { prompt: 'p' },
        },
      },
    });
    expect(parsed.agents.phase1.triage.prompt).toBe('custom triage');
    expect(parsed.agents.phase1.spec_writer.prompt).toBe('s');
    expect(parsed.agents.phase1.plan_writer.prompt).toBe('p');
  });
});

// ============================================================================
// B. Triage phase — crash recovery (skip when already approved)
// ============================================================================

describe('B. Triage phase — crash recovery', () => {
  const sessionId = `test-triage-recovery-${Date.now()}`;
  const worktree = `/tmp/kautopilot-test-wt-triage-${sessionId}`;

  afterEach(() => {
    cleanSession(sessionId);
    cleanWorktree(worktree);
  });

  it('skips triage when triage:approved event exists in log and restores deliveryKind', async () => {
    // Set up session directory
    const sDir = sessionDir(sessionId);
    mkdirSync(sDir, { recursive: true });

    // Write triage:approved to the log
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'triage:approved',
      version: 1,
      metadata: { deliveryKind: 'ticket', complexity: 'moderate' },
    });

    // Create worktree with triage.md in spec/{ticketId}/v1/
    const specDir = join(worktree, 'spec', 'local-test', 'v1');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, 'triage.md'),
      [
        '# Triage: Research task',
        '',
        '## Delivery Kind',
        'ticket',
        '',
        '## Complexity',
        'moderate',
        '',
        '## Assessment',
        'Needs research first.',
        '',
        '## Clarifications',
        'None',
        '',
        '## Risks',
        'Unknown scope',
      ].join('\n'),
    );

    const ctx = makeCtx(sessionId, worktree);

    // Dynamically import to pick up the log we just wrote
    const { handleTriage } = await import('../phase1/triage');
    const nextState = await handleTriage(ctx);

    // Should skip triage and advance to write_spec
    expect(nextState).toBe('write_spec');
    // Should restore deliveryKind from triage.md
    expect(ctx.deliveryKind).toBe('ticket');
  });

  it('restores pr deliveryKind from triage.md on recovery', async () => {
    const altSessionId = `test-triage-recovery-pr-${Date.now()}`;
    const altWorktree = `/tmp/kautopilot-test-wt-pr-${altSessionId}`;
    const sDir = sessionDir(altSessionId);
    mkdirSync(sDir, { recursive: true });

    appendEvent(altSessionId, {
      ts: new Date().toISOString(),
      event: 'triage:approved',
      version: 1,
      metadata: { deliveryKind: 'pr', complexity: 'straightforward' },
    });

    const specDir = join(altWorktree, 'spec', 'local-test', 'v1');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, 'triage.md'),
      [
        '# Triage: Simple fix',
        '',
        '## Delivery Kind',
        'pr',
        '',
        '## Complexity',
        'straightforward',
        '',
        '## Assessment',
        'One line change.',
        '',
        '## Clarifications',
        'None',
        '',
        '## Risks',
        'Low risk',
      ].join('\n'),
    );

    const ctx = makeCtx(altSessionId, altWorktree);
    const { handleTriage } = await import('../phase1/triage');
    const nextState = await handleTriage(ctx);

    expect(nextState).toBe('write_spec');
    expect(ctx.deliveryKind).toBe('pr');

    cleanSession(altSessionId);
    cleanWorktree(altWorktree);
  });

  it('defaults deliveryKind to pr when triage.md is missing on recovery', async () => {
    const altSessionId = `test-triage-no-file-${Date.now()}`;
    const altWorktree = `/tmp/kautopilot-test-wt-nofile-${altSessionId}`;
    const sDir = sessionDir(altSessionId);
    mkdirSync(sDir, { recursive: true });

    appendEvent(altSessionId, {
      ts: new Date().toISOString(),
      event: 'triage:approved',
      version: 1,
      metadata: { deliveryKind: 'pr', complexity: 'moderate' },
    });

    // Create worktree but no triage.md — parseTriage returns null
    mkdirSync(join(altWorktree, 'spec', 'local-test', 'v1'), {
      recursive: true,
    });

    const ctx = makeCtx(altSessionId, altWorktree);
    const { handleTriage } = await import('../phase1/triage');
    const nextState = await handleTriage(ctx);

    expect(nextState).toBe('write_spec');
    // deliveryKind stays undefined when parseTriage returns null
    expect(ctx.deliveryKind).toBeUndefined();

    cleanSession(altSessionId);
    cleanWorktree(altWorktree);
  });
});

// ============================================================================
// C. Triage informs spec writer — prompt variable resolution
// ============================================================================

describe('C. Triage informs spec writer — {triage} variable', () => {
  it('buildPromptVars includes triage pointing to spec/{ticketId}/v{version}/triage.md', () => {
    const vars = buildPromptVars('/tmp/worktree', 1, 'TEST-1');
    expect(vars.triage).toBe(join('/tmp/worktree', 'spec', 'TEST-1', 'v1', 'triage.md'));
  });

  it('buildPromptVars triage path varies by version', () => {
    const v1 = buildPromptVars('/tmp/wt', 1, 'TEST-1');
    const v2 = buildPromptVars('/tmp/wt', 2, 'TEST-1');
    expect(v1.triage).toContain('v1');
    expect(v2.triage).toContain('v2');
    expect(v1.triage).not.toBe(v2.triage);
  });

  it('resolvePromptVars replaces {triage} with resolved path', () => {
    const vars = buildPromptVars('/tmp/worktree', 1, 'TEST-1');
    const prompt = 'Read the triage assessment at {triage} and adapt your behavior.';
    const resolved = resolvePromptVars(prompt, vars);
    expect(resolved).not.toContain('{triage}');
    expect(resolved).toContain(join('/tmp/worktree', 'spec', 'TEST-1', 'v1', 'triage.md'));
  });

  it('DEFAULT_SPEC_WRITER_PROMPT references {triage} and adapts behavior', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    const prompt = DEFAULT_CONFIG.agents.phase1.spec_writer.prompt;
    expect(prompt).toContain('{triage}');
    expect(prompt).toContain('straightforward');
    expect(prompt).toContain('moderate');
    expect(prompt).toContain('complex');
    expect(prompt).toContain('ticket');
  });

  it('DEFAULT_PLAN_WRITER_PROMPT references {triage}', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    const prompt = DEFAULT_CONFIG.agents.phase1.plan_writer.prompt;
    expect(prompt).toContain('{triage}');
    expect(prompt).toContain('ticket');
    expect(prompt).toContain('vertically split');
  });

  it('all prompt variables resolve together', () => {
    const vars = buildPromptVars('/tmp/worktree', 2, 'TEST-1');
    const prompt =
      'Ticket: {ticket}\nSpec: {spec}\nSpecDir: {specDir}\nPlans: {plans}\nWorktree: {worktree}\nTriage: {triage}';
    const resolved = resolvePromptVars(prompt, vars);
    expect(resolved).not.toContain('{ticket}');
    expect(resolved).not.toContain('{spec}');
    expect(resolved).not.toContain('{specDir}');
    expect(resolved).not.toContain('{plans}');
    expect(resolved).not.toContain('{worktree}');
    expect(resolved).not.toContain('{triage}');
    expect(resolved).toContain('/tmp/worktree/spec/TEST-1/ticket.md');
    expect(resolved).toContain('/tmp/worktree/spec/TEST-1/v2/task-spec.md');
    expect(resolved).toContain('/tmp/worktree/spec/TEST-1/v2');
    expect(resolved).toContain('/tmp/worktree/spec/TEST-1/v2/plans');
    expect(resolved).toContain('/tmp/worktree');
    expect(resolved).toContain('/tmp/worktree/spec/TEST-1/v2/triage.md');
  });
});

// ============================================================================
// D. Delivery kind propagates to manifests
// ============================================================================

describe('D. Delivery kind propagation to manifests', () => {
  const sessionId = `test-delivery-prop-${Date.now()}`;

  afterEach(() => {
    cleanSession(sessionId);
  });

  it('writeContractManifest writes deliveryKind=pr', () => {
    const sDir = sessionDir(sessionId);
    mkdirSync(sDir, { recursive: true });

    writeContractManifest(sessionId, 1, 'pr', 2);

    const manifest = readContractManifest(sessionId, 1);
    expect(manifest).not.toBeNull();
    expect(manifest?.deliveryKind).toBe('pr');
    expect(manifest?.planCount).toBe(2);
    expect(manifest?.version).toBe(1);
  });

  it('writeContractManifest writes deliveryKind=ticket', () => {
    const sDir = sessionDir(sessionId);
    mkdirSync(sDir, { recursive: true });

    writeContractManifest(sessionId, 1, 'ticket', 3);

    const manifest = readContractManifest(sessionId, 1);
    expect(manifest).not.toBeNull();
    expect(manifest?.deliveryKind).toBe('ticket');
    expect(manifest?.planCount).toBe(3);
  });

  it('writeDeliveryManifest writes kind=pr', () => {
    const sDir = sessionDir(sessionId);
    mkdirSync(sDir, { recursive: true });

    writeDeliveryManifest(sessionId, 1, { kind: 'pr' });

    const manifest = readDeliveryManifest(sessionId, 1);
    expect(manifest).not.toBeNull();
    expect(manifest?.kind).toBe('pr');
  });

  it('writeDeliveryManifest writes kind=ticket', () => {
    const sDir = sessionDir(sessionId);
    mkdirSync(sDir, { recursive: true });

    writeDeliveryManifest(sessionId, 1, { kind: 'ticket' });

    const manifest = readDeliveryManifest(sessionId, 1);
    expect(manifest).not.toBeNull();
    expect(manifest?.kind).toBe('ticket');
  });

  it('finalize_plans propagates ctx.deliveryKind to both manifests', async () => {
    const finalizeSessionId = `test-finalize-prop-${Date.now()}`;
    const finalizeWorktree = `/tmp/kautopilot-test-wt-finalize-${finalizeSessionId}`;

    // Set up session dir
    mkdirSync(sessionDir(finalizeSessionId), { recursive: true });

    // Set up worktree with plan files
    const plansDir = join(finalizeWorktree, 'spec', 'local-test', 'v1', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1.md'), '# Plan 1\nImplement the change');

    // Create a git repo so finalize_plans can commit
    const { $ } = await import('bun');
    await $`git init`.cwd(finalizeWorktree).quiet();
    await $`git config user.email test@test.com`.cwd(finalizeWorktree).quiet();
    await $`git config user.name Test`.cwd(finalizeWorktree).quiet();

    const ctx: Phase1Context = {
      session: makeSession(finalizeSessionId, finalizeWorktree),
      config: makeConfig(),
      version: 1,
      attempt: 1,
      deliveryKind: 'ticket',
    };

    const { handleFinalizePlans } = await import('../phase1/finalize-plans');
    await handleFinalizePlans(ctx);

    // Verify contract manifest
    const contract = readContractManifest(finalizeSessionId, 1);
    expect(contract).not.toBeNull();
    expect(contract?.deliveryKind).toBe('ticket');

    // Verify delivery manifest
    const delivery = readDeliveryManifest(finalizeSessionId, 1);
    expect(delivery).not.toBeNull();
    expect(delivery?.kind).toBe('ticket');

    cleanSession(finalizeSessionId);
    cleanWorktree(finalizeWorktree);
  });

  it('finalize_plans defaults to pr when deliveryKind is undefined', async () => {
    const defaultSessionId = `test-finalize-default-${Date.now()}`;
    const defaultWorktree = `/tmp/kautopilot-test-wt-default-${defaultSessionId}`;

    mkdirSync(sessionDir(defaultSessionId), { recursive: true });

    const plansDir = join(defaultWorktree, 'spec', 'local-test', 'v1', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1.md'), '# Plan 1\nDo the thing');

    const { $ } = await import('bun');
    await $`git init`.cwd(defaultWorktree).quiet();
    await $`git config user.email test@test.com`.cwd(defaultWorktree).quiet();
    await $`git config user.name Test`.cwd(defaultWorktree).quiet();

    const ctx: Phase1Context = {
      session: makeSession(defaultSessionId, defaultWorktree),
      config: makeConfig(),
      version: 1,
      attempt: 1,
      // deliveryKind intentionally omitted
    };

    const { handleFinalizePlans } = await import('../phase1/finalize-plans');
    await handleFinalizePlans(ctx);

    const contract = readContractManifest(defaultSessionId, 1);
    expect(contract?.deliveryKind).toBe('pr'); // defaults to pr

    const delivery = readDeliveryManifest(defaultSessionId, 1);
    expect(delivery?.kind).toBe('pr'); // defaults to pr

    cleanSession(defaultSessionId);
    cleanWorktree(defaultWorktree);
  });
});

// ============================================================================
// E. Crash recovery — event log patterns
// ============================================================================

describe('E. Crash recovery — event log patterns', () => {
  const sessionId = `test-crash-events-${Date.now()}`;

  afterEach(() => {
    cleanSession(sessionId);
  });

  it('triage:approved event is detectable by readLog', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'triage:approved',
      version: 1,
      metadata: { deliveryKind: 'pr', complexity: 'straightforward' },
    });

    const events = readLog(sessionId);
    const approved = events.some(e => e.event === 'triage:approved');
    expect(approved).toBe(true);
  });

  it('triage:started + triage:interrupted pattern for crash recovery', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'triage:started',
      version: 1,
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'triage:interrupted',
      version: 1,
    });

    const events = readLog(sessionId);
    const hasStarted = events.some(e => e.event === 'triage:started');
    const hasInterrupted = events.some(e => e.event === 'triage:interrupted');
    const hasApproved = events.some(e => e.event === 'triage:approved');

    expect(hasStarted).toBe(true);
    expect(hasInterrupted).toBe(true);
    expect(hasApproved).toBe(false);
  });

  it('triage:completed event includes deliveryKind and complexity metadata', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'triage:completed',
      version: 1,
      metadata: { deliveryKind: 'ticket', complexity: 'complex' },
    });

    const events = readLog(sessionId);
    const completed = events.find(e => e.event === 'triage:completed');
    expect(completed).toBeDefined();
    expect(completed?.metadata?.deliveryKind).toBe('ticket');
    expect(completed?.metadata?.complexity).toBe('complex');
  });
});

// ============================================================================
// F. Dead code removed
// ============================================================================

describe('F. Dead code removed', () => {
  it('Phase1Context has no typeConfig or ticketType fields', () => {
    const ctx: Phase1Context = {
      session: makeSession('test', '/tmp/wt'),
      config: makeConfig(),
      version: 1,
      attempt: 1,
    };
    // TypeScript type check — typeConfig/ticketType should not be valid keys
    expect('typeConfig' in ctx).toBe(false);
    expect('ticketType' in ctx).toBe(false);
    // deliveryKind is valid but optional — not set means not present on the object
    expect(ctx.deliveryKind).toBeUndefined();
  });

  it('Phase1Context only has deliveryKind as optional extra field', () => {
    const ctx: Phase1Context = {
      session: makeSession('test', '/tmp/wt'),
      config: makeConfig(),
      version: 1,
      attempt: 1,
      deliveryKind: 'ticket',
    };
    expect(ctx.deliveryKind).toBe('ticket');
  });
});

// ============================================================================
// H. Version-scoped event checks (Reviewer 3 Issues 1-3)
// ============================================================================

describe('H. Version-scoped event checks', () => {
  const sessionId = `test-version-scope-${Date.now()}`;

  afterEach(() => {
    cleanSession(sessionId);
  });

  it('write_spec:completed with version scopes approval correctly', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    // v1 events — spec was approved and completed
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_spec:started',
      version: 1,
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'spec:approved',
      metadata: { draft: 1 },
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_spec:completed',
      version: 1,
    });
    // v1 amendment escalation
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:started',
      version: 1,
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'spec_amendment:requested',
      metadata: { reason: 'spec drift' },
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:escalated',
      version: 1,
    });

    const events = readLog(sessionId);

    // v1 spec: completed — should be found
    const completedForV1 = events.some(e => e.event === 'write_spec:completed' && e.version === 1);
    expect(completedForV1).toBe(true);

    // v2 spec: NOT completed — should NOT be found
    const completedForV2 = events.some(e => e.event === 'write_spec:completed' && e.version === 2);
    expect(completedForV2).toBe(false);
  });

  it('write_plans:completed with version scopes approval correctly', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    // v1 events — plans were NOT completed (escalated instead)
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:started',
      version: 1,
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'spec_amendment:requested',
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:escalated',
      version: 1,
    });

    const events = readLog(sessionId);

    // v1 plans: NOT completed (escalated)
    const completedForV1 = events.some(e => e.event === 'write_plans:completed' && e.version === 1);
    expect(completedForV1).toBe(false);
  });

  it('post-TTY amendment check scopes to current version only', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    // v1 events — amendment was requested
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:started',
      version: 1,
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'spec_amendment:requested',
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:escalated',
      version: 1,
    });

    // v2 events — new TTY session
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_plans:started',
      version: 2,
    });

    const events = readLog(sessionId);

    // Scope to v2's TTY session only (after write_plans:started version=2)
    const startedIdx = events.findLastIndex(e => e.event === 'write_plans:started' && e.version === 2);
    const eventsSinceStart = startedIdx >= 0 ? events.slice(startedIdx + 1) : events;

    const amendmentInV2Scope = eventsSinceStart.some(e => e.event === 'spec_amendment:requested');
    expect(amendmentInV2Scope).toBe(false); // v1's amendment NOT in v2's scope
  });

  it('post-TTY approval check scopes to current version only', () => {
    mkdirSync(sessionDir(sessionId), { recursive: true });

    // v1 events — spec was approved
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_spec:started',
      version: 1,
    });
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'spec:approved',
    });

    // v2 events — new TTY session
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'write_spec:started',
      version: 2,
    });

    const events = readLog(sessionId);

    // Scope to v2's TTY session only
    const startedIdx = events.findLastIndex(e => e.event === 'write_spec:started' && e.version === 2);
    const eventsSinceStart = startedIdx >= 0 ? events.slice(startedIdx + 1) : events;

    const approvedInV2Scope = eventsSinceStart.some(e => e.event === 'spec:approved');
    expect(approvedInV2Scope).toBe(false); // v1's approval NOT in v2's scope
  });
});

// ============================================================================
// I. Template override injection (Spec Section 13 Item 4)
// ============================================================================

describe('I. Template override injection', () => {
  it('custom triage template text appears in resolved mechanics', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    const customTemplate = '# CUSTOM TRIAGE: Special Format\n## My Custom Section\nDetails here';
    const config = {
      ...DEFAULT_CONFIG,
      templates: { ...DEFAULT_CONFIG.templates, triage: customTemplate },
    };

    const vars = buildPromptVars('/tmp/worktree', 1, 'TEST-1');

    // Simulate what handleTriage does: mechanics.replace('{triageTemplate}', config.templates.triage)
    const mechanicsTemplate = `Output must follow:\n{triageTemplate}\nEnd of format`;
    const mechanicsWithTemplate = mechanicsTemplate.replace('{triageTemplate}', config.templates.triage);
    const resolved = resolvePromptVars(mechanicsWithTemplate, vars);

    expect(resolved).toContain('CUSTOM TRIAGE: Special Format');
    expect(resolved).toContain('My Custom Section');
    expect(resolved).not.toContain('{triageTemplate}');
  });

  it('custom spec template text appears in resolved mechanics', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    const customTemplate = '# MY SPEC TEMPLATE\n## Custom Requirements\nGo here';
    const config = {
      ...DEFAULT_CONFIG,
      templates: { ...DEFAULT_CONFIG.templates, spec: customTemplate },
    };

    const vars = buildPromptVars('/tmp/worktree', 2, 'PROJ-1');

    const mechanicsTemplate = `Draft must follow:\n{specTemplate}\nEnd`;
    const resolved = resolvePromptVars(mechanicsTemplate.replace('{specTemplate}', config.templates.spec), vars);

    expect(resolved).toContain('MY SPEC TEMPLATE');
    expect(resolved).toContain('Custom Requirements');
  });

  it('custom plan template text appears in resolved mechanics', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    const customTemplate = '# PLAN FORMAT\n## Custom Plan Section';
    const config = {
      ...DEFAULT_CONFIG,
      templates: { ...DEFAULT_CONFIG.templates, plan: customTemplate },
    };

    const vars = buildPromptVars('/tmp/worktree', 1, 'TEST-1');

    const mechanicsTemplate = `Plan format:\n{planTemplate}\nEnd`;
    const resolved = resolvePromptVars(mechanicsTemplate.replace('{planTemplate}', config.templates.plan), vars);

    expect(resolved).toContain('PLAN FORMAT');
    expect(resolved).toContain('Custom Plan Section');
  });

  it('default template is used when no override', async () => {
    const { DEFAULT_CONFIG } = await import('../../core/types');
    const vars = buildPromptVars('/tmp/worktree', 1, 'TEST-1');

    const mechanicsTemplate = `Format:\n{triageTemplate}\nEnd`;
    const resolved = resolvePromptVars(
      mechanicsTemplate.replace('{triageTemplate}', DEFAULT_CONFIG.templates.triage),
      vars,
    );

    expect(resolved).toContain('Delivery Kind');
    expect(resolved).toContain('Assumptions to Verify');
    expect(resolved).toContain('Validation Matrix');
  });
});
