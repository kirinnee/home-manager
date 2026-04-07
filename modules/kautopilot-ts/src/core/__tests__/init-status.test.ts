import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('init status and logs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-init-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('materializes init status from init WAL events', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    appendInitEvent('init-123', {
      ts: '2026-04-01T10:00:00Z',
      event: 'init:started',
      metadata: { pid: 42 },
    });
    appendInitEvent('init-123', {
      ts: '2026-04-01T10:00:01Z',
      event: 'identify:started',
    });
    appendInitEvent('init-123', {
      ts: '2026-04-01T10:00:02Z',
      event: 'context:updated',
      metadata: { systemName: 'GitHub Issues' },
    });
    appendInitEvent('init-123', {
      ts: '2026-04-01T10:00:03Z',
      event: 'identify:completed',
    });
    appendInitEvent('init-123', {
      ts: '2026-04-01T10:00:04Z',
      event: 'research:started',
    });

    const status = ensureInitStatus('init-123');
    expect(status.running).toBe(true);
    expect(status.state).toBe('research');
    expect(status.stateStatus).toBe('running');
    expect(status.completedStates).toEqual(['identify']);
    expect(status.context.systemName).toBe('GitHub Issues');
    expect(status.walCursor).toBe(5);
  });

  it('tracks promotion and downgrade outcomes from WAL', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    appendInitEvent('init-promoted', {
      ts: '2026-04-01T11:00:00Z',
      event: 'init:started',
      metadata: { pid: 7 },
    });
    appendInitEvent('init-promoted', {
      ts: '2026-04-01T11:00:01Z',
      event: 'promote:completed',
      metadata: { outcome: 'promoted_degraded', sessionId: 'sess-1' },
    });
    appendInitEvent('init-promoted', {
      ts: '2026-04-01T11:00:02Z',
      event: 'init:completed',
    });

    const promoted = ensureInitStatus('init-promoted');
    expect(promoted.outcome).toBe('promoted_degraded');
    expect(promoted.running).toBe(false);

    appendInitEvent('init-local', {
      ts: '2026-04-01T12:00:00Z',
      event: 'init:started',
      metadata: { pid: 8 },
    });
    appendInitEvent('init-local', {
      ts: '2026-04-01T12:00:01Z',
      event: 'downgrade_local:completed',
    });
    appendInitEvent('init-local', {
      ts: '2026-04-01T12:00:02Z',
      event: 'init:completed',
    });

    const local = ensureInitStatus('init-local');
    expect(local.outcome).toBe('downgraded_local');
    expect(local.running).toBe(false);
  });

  it('reads init logs from the init root instead of runtime session root', () => {
    const { appendInitEvent, readInitLog, readLog } = require('../log') as typeof import('../log');

    appendInitEvent('init-root-check', {
      ts: '2026-04-01T13:00:00Z',
      event: 'identify:started',
    });

    expect(readInitLog('init-root-check')).toHaveLength(1);
    expect(readLog('init-root-check')).toHaveLength(0);
    expect(existsSync(join(tempDir, '.kautopilot', 'init', 'init-root-check', 'log.jsonl'))).toBe(true);
  });

  it('handles init crash recovery — resets running state without terminal outcome', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    // Simulate a crash: process started, ran into research phase, then died
    appendInitEvent('init-crash', {
      ts: '2026-04-01T14:00:00Z',
      event: 'init:started',
      metadata: { pid: 99991 },
    });
    appendInitEvent('init-crash', {
      ts: '2026-04-01T14:00:01Z',
      event: 'identify:started',
    });
    appendInitEvent('init-crash', {
      ts: '2026-04-01T14:00:02Z',
      event: 'identify:completed',
    });
    appendInitEvent('init-crash', {
      ts: '2026-04-01T14:00:03Z',
      event: 'research:started',
    });
    // Process crashes here — no research:completed or init:completed

    const beforeRecovery = ensureInitStatus('init-crash');
    expect(beforeRecovery.running).toBe(true);
    expect(beforeRecovery.state).toBe('research');
    expect(beforeRecovery.stateStatus).toBe('running');
    expect(beforeRecovery.outcome).toBeNull(); // No terminal outcome

    // Now simulate crash recovery event
    appendInitEvent('init-crash', {
      ts: '2026-04-01T15:00:00Z',
      event: 'init:crash_recovered',
      metadata: { reason: 'crash', pid: 99991, state: 'research' },
    });

    const afterRecovery = ensureInitStatus('init-crash');
    expect(afterRecovery.running).toBe(false);
    expect(afterRecovery.pid).toBeNull();
    expect(afterRecovery.stateStatus).toBe('pending'); // Reset so it can be re-entered
    expect(afterRecovery.state).toBe('research'); // Still on research
    expect(afterRecovery.completedStates).toEqual(['identify']);
    expect(afterRecovery.outcome).toBeNull(); // Still no terminal outcome
  });

  it('tracks all init states through complete lifecycle', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:00Z',
      event: 'init:started',
      metadata: { pid: 100 },
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:01Z',
      event: 'identify:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:02Z',
      event: 'identify:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:03Z',
      event: 'research:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:04Z',
      event: 'research:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:05Z',
      event: 'detect:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:06Z',
      event: 'detect:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:07Z',
      event: 'gather_context:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:08Z',
      event: 'gather_context:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:09Z',
      event: 'normalize:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:10Z',
      event: 'normalize:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:11Z',
      event: 'generate:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:12Z',
      event: 'generate:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:13Z',
      event: 'verify:started',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:14Z',
      event: 'verify:completed',
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:15Z',
      event: 'promote:completed',
      metadata: { outcome: 'promoted', sessionId: 'sess-full' },
    });
    appendInitEvent('init-full', {
      ts: '2026-04-01T16:00:16Z',
      event: 'init:completed',
    });

    const status = ensureInitStatus('init-full');
    expect(status.outcome).toBe('promoted');
    expect(status.running).toBe(false);
    expect(status.completedStates).toEqual([
      'identify',
      'research',
      'detect',
      'gather_context',
      'normalize',
      'generate',
      'verify',
      'promote',
    ]);
  });

  it('tracks failed init outcome', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    appendInitEvent('init-fail', {
      ts: '2026-04-01T17:00:00Z',
      event: 'init:started',
      metadata: { pid: 200 },
    });
    appendInitEvent('init-fail', {
      ts: '2026-04-01T17:00:01Z',
      event: 'identify:started',
    });
    appendInitEvent('init-fail', {
      ts: '2026-04-01T17:00:02Z',
      event: 'identify:completed',
    });
    appendInitEvent('init-fail', {
      ts: '2026-04-01T17:00:03Z',
      event: 'init:failed',
      metadata: { reason: 'terminal_state' },
    });

    const status = ensureInitStatus('init-fail');
    expect(status.outcome).toBe('failed');
    expect(status.running).toBe(false);
  });

  it('persists repair-loop metadata through context updates', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    appendInitEvent('init-repair', {
      ts: '2026-04-01T18:00:00Z',
      event: 'init:started',
      metadata: { pid: 300 },
    });
    appendInitEvent('init-repair', {
      ts: '2026-04-01T18:00:01Z',
      event: 'context:updated',
      metadata: { repairAttempts: 2, maxRepairAttempts: 3 },
    });

    const status = ensureInitStatus('init-repair');
    expect(status.context.repairAttempts).toBe(2);
    expect(status.context.maxRepairAttempts).toBe(3);
  });

  it('persists init status to YAML and supports incremental replay', () => {
    const { appendInitEvent } = require('../log') as typeof import('../log');
    const { ensureInitStatus } = require('../init-status') as typeof import('../init-status');

    appendInitEvent('init-yaml', {
      ts: '2026-04-01T19:00:00Z',
      event: 'init:started',
      metadata: { pid: 400 },
    });
    appendInitEvent('init-yaml', {
      ts: '2026-04-01T19:00:01Z',
      event: 'identify:started',
    });

    const status1 = ensureInitStatus('init-yaml');
    expect(status1.walCursor).toBe(2);

    // Verify YAML was written
    const yamlPath = join(tempDir, '.kautopilot', 'init', 'init-yaml', 'status.yaml');
    expect(existsSync(yamlPath)).toBe(true);
    const yamlContent = readFileSync(yamlPath, 'utf-8');
    expect(yamlContent).toContain('state: identify');

    // Add more events and verify incremental replay
    appendInitEvent('init-yaml', {
      ts: '2026-04-01T19:00:02Z',
      event: 'identify:completed',
    });
    const status2 = ensureInitStatus('init-yaml');
    expect(status2.walCursor).toBe(3);
    expect(status2.completedStates).toEqual(['identify']);
  });
});
