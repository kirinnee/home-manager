import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStatus } from '../status';
import { appendEvent } from '../log';
import type { LogEntry } from '../types';

const TEST_SESSION = 'test-status-' + Date.now();
const SESSION_DIR = join(process.env.HOME!, '.kautopilot', TEST_SESSION);

beforeEach(() => {
  mkdirSync(SESSION_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(SESSION_DIR)) {
    rmSync(SESSION_DIR, { recursive: true });
  }
});

describe('ensureStatus', () => {
  it('returns initial status for empty log', () => {
    const status = ensureStatus(TEST_SESSION);
    expect(status.phase).toBe('none');
    expect(status.state).toBe('none');
    expect(status.running).toBe(false);
    expect(status.walCursor).toBe(0);
    expect(status.completedSteps).toEqual([]);
    expect(status.lastCheckpoint).toBeNull();
  });

  it('tracks phase and state from events', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'start:started', metadata: { phase: 'plan' } });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:02Z', event: 'pull_ticket:started', version: 1 });

    const status = ensureStatus(TEST_SESSION);
    expect(status.phase).toBe('plan');
    expect(status.version).toBe(1);
    expect(status.state).toBe('pull_ticket');
    expect(status.stateStatus).toBe('running');
    expect(status.running).toBe(true);
  });

  it('marks completed steps and checkpoints', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'start:started', metadata: { phase: 'plan' } });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:02Z', event: 'pull_ticket:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:03Z', event: 'pull_ticket:completed', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:04Z', event: 'route_type:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:05Z', event: 'route_type:completed', version: 1 });

    const status = ensureStatus(TEST_SESSION);
    expect(status.completedSteps).toEqual(['pull_ticket', 'route_type']);
    expect(status.lastCheckpoint).toBe('route_type');
    expect(status.stateStatus).toBe('completed');
  });

  it('tracks parallel subtasks', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'gather_context:started', version: 1 });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:02Z',
      event: 'subtask:started',
      metadata: { task: 'codebase', parent: 'gather_context' },
    });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:03Z',
      event: 'subtask:started',
      metadata: { task: 'docs', parent: 'gather_context' },
    });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:10Z',
      event: 'subtask:completed',
      metadata: { task: 'codebase', parent: 'gather_context' },
    });

    const status = ensureStatus(TEST_SESSION);
    expect(status.tasks.codebase.status).toBe('completed');
    expect(status.tasks.docs.status).toBe('running');
  });

  it('clears tasks when parent state completes', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'gather_context:started', version: 1 });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:02Z',
      event: 'subtask:started',
      metadata: { task: 'codebase', parent: 'gather_context' },
    });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:10Z',
      event: 'subtask:completed',
      metadata: { task: 'codebase', parent: 'gather_context' },
    });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:11Z', event: 'gather_context:completed', version: 1 });

    const status = ensureStatus(TEST_SESSION);
    expect(Object.keys(status.tasks)).toEqual([]);
    expect(status.completedSteps).toContain('gather_context');
  });

  it('handles context:updated events', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:01Z',
      event: 'context:updated',
      metadata: { ticketType: 'product' },
    });

    const status = ensureStatus(TEST_SESSION);
    expect(status.context.ticketType).toBe('product');
  });

  it('handles reset:completed — rolls back to checkpoint', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'start:started', metadata: { phase: 'plan' } });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:02Z', event: 'pull_ticket:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:03Z', event: 'pull_ticket:completed', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:04Z', event: 'route_type:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:05Z', event: 'route_type:completed', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:06Z', event: 'gather_context:started', version: 1 });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:07Z',
      event: 'subtask:started',
      metadata: { task: 'codebase', parent: 'gather_context' },
    });
    // Crash here, then reset
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:01:00Z',
      event: 'crash:detected',
      metadata: { state: 'gather_context', checkpoint: 'route_type' },
    });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:01:01Z',
      event: 'reset:completed',
      metadata: { checkpoint: 'route_type' },
    });

    const status = ensureStatus(TEST_SESSION);
    expect(status.state).toBe('route_type');
    expect(status.stateStatus).toBe('completed');
    expect(status.completedSteps).toEqual(['pull_ticket', 'route_type']);
    expect(Object.keys(status.tasks)).toEqual([]);
    expect(status.running).toBe(false);
  });

  it('incremental replay — only processes new events', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase1:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'pull_ticket:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:02Z', event: 'pull_ticket:completed', version: 1 });

    const status1 = ensureStatus(TEST_SESSION);
    expect(status1.walCursor).toBe(3);
    expect(status1.completedSteps).toEqual(['pull_ticket']);

    // Add more events
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:03Z', event: 'route_type:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:04Z', event: 'route_type:completed', version: 1 });

    const status2 = ensureStatus(TEST_SESSION);
    expect(status2.walCursor).toBe(5);
    expect(status2.completedSteps).toEqual(['pull_ticket', 'route_type']);
  });

  it('persists status to YAML file', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase1:started', version: 1 });
    ensureStatus(TEST_SESSION);

    const yamlPath = join(SESSION_DIR, 'status.yaml');
    expect(existsSync(yamlPath)).toBe(true);

    const content = readFileSync(yamlPath, 'utf-8');
    expect(content).toContain('phase: plan');
    expect(content).toContain('walCursor: 1');
  });

  it('tracks per-plan cycle with completedPlans', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase2:started', version: 1 });
    // Plan 0
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:01Z', event: 'clear_loop:started', metadata: { planIndex: 0 } });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:02Z', event: 'clear_loop:completed', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:03Z', event: 'setup_run:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:04Z', event: 'setup_run:completed', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:05Z', event: 'running:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:06Z', event: 'running:completed', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:07Z', event: 'commit:started', version: 1 });
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:08Z', event: 'commit:completed', version: 1 });
    // Plan 1
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:09Z', event: 'clear_loop:started', metadata: { planIndex: 1 } });

    const status = ensureStatus(TEST_SESSION);
    expect(status.completedPlans).toEqual([0]);
    expect(status.context.planIndex).toBe(1);
    expect(status.completedSteps).toEqual([]); // reset for plan 1
  });

  it('extracts stats from metadata', () => {
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:00Z',
      event: 'poll:completed',
      metadata: { replies: 5, resolved: 3, pushCycle: 2 },
    });

    const status = ensureStatus(TEST_SESSION);
    expect(status.stats.totalReplies).toBe(5);
    expect(status.stats.totalResolved).toBe(3);
    expect(status.stats.pushCycles).toBe(2);
  });

  it('persists reported failed run ids from context updates', () => {
    appendEvent(TEST_SESSION, { ts: '2026-03-24T10:00:00Z', event: 'phase3:started', version: 1 });
    appendEvent(TEST_SESSION, {
      ts: '2026-03-24T10:00:01Z',
      event: 'context:updated',
      metadata: { reportedFailedRunIds: [12, 34] },
    });

    const status = ensureStatus(TEST_SESSION);
    expect(status.context.reportedFailedRunIds).toEqual([12, 34]);
  });
});
