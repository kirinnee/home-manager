import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { logWarn } from '../util/format';
import { initDir } from './artifacts';
import { checkInitLock } from './init-lock';
import type { InitState, InitStatus } from './init-types';
import { appendInitEvent, readInitLog } from './log';
import type { LogEntry } from './types';

// ============================================================================
// Initial status
// ============================================================================

function initialInitStatus(): InitStatus {
  return {
    walCursor: 0,
    walTimestamp: '',
    state: 'identify',
    stateStatus: 'pending',
    pid: null,
    running: false,
    startedAt: null,
    context: {},
    completedStates: [],
    outcome: null,
  };
}

// ============================================================================
// Init lifecycle events — excluded from state tracking
// ============================================================================

const INIT_LIFECYCLE_EVENTS = new Set([
  'init:started',
  'init:completed',
  'init:failed',
  'init:cancelled',
  'init:crash_recovered',
  'context:updated',
]);

// ============================================================================
// applyEvent reducer for init
// ============================================================================

function applyInitEvent(status: InitStatus, entry: LogEntry, index: number): void {
  status.walCursor = index + 1;
  status.walTimestamp = entry.ts;

  const { event } = entry;

  // Init process start
  if (event === 'init:started') {
    status.running = true;
    status.pid = (entry.metadata?.pid as number) ?? null;
    status.startedAt = entry.ts;
  }

  // Init process end
  if (
    event === 'init:completed' ||
    event === 'init:failed' ||
    event === 'init:cancelled' ||
    event === 'init:abandoned'
  ) {
    status.running = false;
    status.pid = null;
    if (event === 'init:failed') {
      status.outcome = 'failed';
    } else if (event === 'init:cancelled') {
      status.outcome = 'cancelled';
    } else if (event === 'init:abandoned') {
      status.outcome = 'abandoned';
    }
  }

  // State started (skip lifecycle events)
  if (event.endsWith(':started') && !INIT_LIFECYCLE_EVENTS.has(event)) {
    const name = event.replace(':started', '') as InitState;
    status.state = name;
    status.stateStatus = 'running';
  }

  // State completed (skip lifecycle events)
  if (event.endsWith(':completed') && !INIT_LIFECYCLE_EVENTS.has(event)) {
    const name = event.replace(':completed', '') as InitState;
    if (name === status.state) {
      status.stateStatus = 'completed';
    }
    if (!status.completedStates.includes(name)) {
      status.completedStates.push(name);
    }
  }

  // State failed
  if (event.endsWith(':failed') && !INIT_LIFECYCLE_EVENTS.has(event)) {
    const name = event.replace(':failed', '') as InitState;
    if (name === status.state) {
      status.stateStatus = 'failed';
    }
  }

  // Crash recovery — reset running state without setting terminal outcome
  if (event === 'init:crash_recovered') {
    status.running = false;
    status.pid = null;
    // Reset current state to pending so it can be re-entered on resume
    if (status.stateStatus === 'running') {
      status.stateStatus = 'pending';
    }
  }

  // Context updates — filter out non-context keys (consistent with session status.ts)
  if (event === 'context:updated' && entry.metadata) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { reason, pid, state, criticalOk, downgrade, regenerate, retry, ...contextFields } = entry.metadata;
    Object.assign(status.context, contextFields);
  }

  // Outcome events
  if (event === 'promote:completed') {
    status.outcome = (entry.metadata?.outcome as InitStatus['outcome']) ?? 'promoted';
  }
  if (event === 'downgrade_local:completed') {
    status.outcome = 'downgraded_local';
  }
}

// ============================================================================
// YAML I/O
// ============================================================================

function initStatusPath(id: string): string {
  return join(initDir(id), 'status.yaml');
}

function readInitStatusYaml(id: string): InitStatus | null {
  const path = initStatusPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return YAML.parse(raw) as InitStatus;
  } catch {
    return null;
  }
}

function writeInitStatusYaml(id: string, status: InitStatus): void {
  const path = initStatusPath(id);
  mkdirSync(dirname(path), { recursive: true });
  const content = YAML.stringify(status, { lineWidth: 120 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ============================================================================
// ensureInitStatus — lazy incremental replay
// ============================================================================

export function ensureInitStatus(id: string): InitStatus {
  const log = readInitLog(id);
  const existing = readInitStatusYaml(id);

  if (existing && existing.walCursor >= log.length) {
    return existing;
  }

  const status = existing ?? initialInitStatus();
  const startIdx = existing ? existing.walCursor : 0;

  for (let i = startIdx; i < log.length; i++) {
    applyInitEvent(status, log[i], i);
  }

  writeInitStatusYaml(id, status);
  return status;
}

// ============================================================================
// Crash recovery for init
// ============================================================================

export function detectAndRecoverInitCrash(initId: string): boolean {
  const status = ensureInitStatus(initId);

  if (!status.running) return false;
  const lock = checkInitLock(initId);
  if (lock.locked) return false;

  // Dead process detected — emit recovery event (non-terminal, allows resume)
  const crashedState = status.state;
  const crashedPid = status.pid;

  appendInitEvent(initId, {
    ts: new Date().toISOString(),
    event: 'init:crash_recovered',
    metadata: {
      reason: 'crash',
      pid: crashedPid,
      state: crashedState,
    },
  });

  ensureInitStatus(initId);

  logWarn(`Init crash detected (PID ${crashedPid} in ${crashedState}) — recovered for resume`);
  return true;
}
