// ============================================================================
// Pure: build tmux command strings and session name parsing
// ============================================================================

export interface TmuxSessionParams {
  dirHash: string;
  runId: string;
  iteration: number;
  role: 'impl' | 'rev';
  reviewerIndex?: number;
}

/**
 * Generate tmux session name per spec format:
 * kloop-{runId}-{iteration}-{role}[-{index}]
 *
 * The new naming scheme uses only runId (not dirHash) to simplify session management.
 * For backward compatibility, we still support parsing old devloop-{dirHash}-{runId}-... names.
 */
export function generateSessionName(params: TmuxSessionParams): string {
  const { runId, iteration, role, reviewerIndex } = params;

  if (role === 'rev' && reviewerIndex !== undefined) {
    return `kloop-${runId}-${iteration}-rev-${reviewerIndex}`;
  }

  return `kloop-${runId}-${iteration}-${role}`;
}

/**
 * Parse a tmux session name back into components.
 * Supports both new kloop-{runId}-... and legacy devloop-{dirHash}-{runId}-... formats.
 */
export function parseSessionName(sessionName: string): TmuxSessionParams | null {
  // Try new format: kloop-{runId}-{iteration}-{role}[-{index}]
  if (sessionName.startsWith('kloop-')) {
    return parseKloopSessionName(sessionName);
  }

  // Try legacy format: devloop-{dirHash}-{runId}-{iteration}-{role}[-{index}]
  if (sessionName.startsWith('devloop-')) {
    return parseLegacySessionName(sessionName);
  }

  return null;
}

function parseKloopSessionName(sessionName: string): TmuxSessionParams | null {
  const withoutPrefix = sessionName.slice('kloop-'.length);

  // Handle daemon sessions: kloop-{runId}-daemon
  if (withoutPrefix.endsWith('-daemon')) {
    const runId = withoutPrefix.slice(0, -'-daemon'.length);
    return { dirHash: '', runId, iteration: 0, role: 'impl' };
  }

  const parts = withoutPrefix.split('-');

  // Format: runId-iteration-role or runId-iteration-role-index
  if (parts.length < 3) {
    return null;
  }

  const runId = parts[0];
  const iteration = parseInt(parts[1], 10);

  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }

  const role = parts[2] as 'impl' | 'rev';
  if (role !== 'impl' && role !== 'rev') {
    return null;
  }

  const reviewerIndex = parts[3] !== undefined ? parseInt(parts[3], 10) : undefined;

  return {
    dirHash: '', // Not used in new format
    runId,
    iteration,
    role,
    reviewerIndex,
  };
}

function parseLegacySessionName(sessionName: string): TmuxSessionParams | null {
  const withoutPrefix = sessionName.slice('devloop-'.length);
  const parts = withoutPrefix.split('-');

  // Format: dirHash-runId-iteration-role or dirHash-runId-iteration-role-index
  if (parts.length < 4) {
    return null;
  }

  const dirHash = parts[0];
  const runId = parts[1];
  const iteration = parseInt(parts[2], 10);

  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }

  const role = parts[3] as 'impl' | 'rev';
  if (role !== 'impl' && role !== 'rev') {
    return null;
  }

  const reviewerIndex = parts[4] !== undefined ? parseInt(parts[4], 10) : undefined;

  return {
    dirHash,
    runId,
    iteration,
    role,
    reviewerIndex,
  };
}

/**
 * Build tmux command to create a new session
 */
export function buildNewSessionCommand(params: { sessionName: string; cwd: string; command: string }): string[] {
  // Triple-layer protection to prevent nested Claude Code sessions from inheriting CLAUDECODE:
  // 1. tmux -e CLAUDECODE= - set to empty in tmux session environment
  // 2. env -u CLAUDECODE - unset before running the shell
  // 3. unset CLAUDECODE - unset in the shell itself (belt and suspenders)
  const commandWithUnset = `unset CLAUDECODE && ${params.command}`;
  return [
    'tmux',
    'new-session',
    '-d',
    '-s',
    params.sessionName,
    '-c',
    params.cwd,
    '-e',
    'CLAUDECODE=',
    'env',
    '-u',
    'CLAUDECODE',
    'sh',
    '-c',
    commandWithUnset,
  ];
}

/**
 * Build tmux command to check if session exists
 */
export function buildHasSessionCommand(sessionName: string): string[] {
  return ['tmux', 'has-session', '-t', sessionName];
}

/**
 * Build tmux command to list all sessions
 */
export function buildListSessionsCommand(): string[] {
  return ['tmux', 'ls', '-F', '#{session_name}'];
}

/**
 * Build tmux command to kill a session
 */
export function buildKillSessionCommand(sessionName: string): string[] {
  return ['tmux', 'kill-session', '-t', sessionName];
}

/**
 * Build tmux command to attach to a session
 */
export function buildAttachCommand(sessionName: string): string[] {
  return ['tmux', 'attach', '-t', sessionName];
}

/**
 * Build a command with timeout wrapper
 */
export function buildTimeoutCommand(command: string, timeoutMins: number): string {
  return `timeout ${timeoutMins}m ${command}`;
}
