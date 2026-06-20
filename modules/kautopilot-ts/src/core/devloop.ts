import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from './artifacts';

export interface DevloopRunResult {
  exitCode: number;
  status: 'completed' | 'max_iterations' | 'conflict' | 'crash';
  runId?: string;
}

export interface DevloopStatus {
  running: boolean;
  pid?: number;
  lastStatus?: string;
  exitReason?: string;
}

/**
 * Initialize a kloop run with a spec file.
 * Uses kloop's global storage and its own native config:
 *   kloop init --workspace <ws> --spec <spec>
 * Returns the kloop runId on success.
 */
export function devloopInit(workspace: string, specPath: string): string {
  const args = ['kloop', 'init', '--workspace', workspace, '--spec', specPath];

  const proc = Bun.spawnSync({
    cmd: args,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(`kloop init failed (exit ${proc.exitCode}): ${stderr}`);
  }

  // Parse runId from kloop init output (looks for "Run ID:     <id>")
  const stdout = proc.stdout.toString();
  const match = stdout.match(/Run ID:\s+(\S+)/);
  if (!match) {
    throw new Error(`Could not parse kloop run ID from output: ${stdout}`);
  }

  return match[1];
}

/**
 * Write a spec file to a temp location inside the kautopilot session dir,
 * suitable for passing to kloop init --spec.
 */
export function writeKloopSpec(kautopilotSessionId: string, content: string, name: string = 'kloop-spec.md'): string {
  const dir = join(sessionDir(kautopilotSessionId), 'tmp');
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, name);
  writeFileSync(specPath, content);
  return specPath;
}

/**
 * Run a kloop run by ID.
 * Captures exit code and determines status.
 * Trusts kloop's internal runTimeout — no external timeout wrapper.
 */
export async function devloopRun(kloopRunId: string): Promise<DevloopRunResult> {
  const proc = Bun.spawn({
    cmd: ['kloop', 'run', kloopRunId],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;

  // Determine status based on exit code and post-run status check
  // Maps to spec-defined outcomes: completed, max_iterations, conflict, crash
  let status: DevloopRunResult['status'];

  if (exitCode === 0) {
    const postStatus = devloopGetStatus(kloopRunId);
    status = postStatus.status;
  } else if (exitCode === 2) {
    status = 'conflict';
  } else {
    // Exit codes 1 (error), 3 (agent_failure), or anything else → crash
    status = 'crash';
  }

  return { exitCode, status, runId: kloopRunId };
}

/**
 * Query kloop status for a run to determine the actual outcome.
 */
interface PostRunResult {
  status: 'completed' | 'max_iterations';
}

function devloopGetStatus(kloopRunId: string): PostRunResult {
  try {
    const proc = Bun.spawnSync({
      cmd: ['kloop', 'status', kloopRunId, '--json'],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.exitCode === 0) {
      const output = proc.stdout.toString().trim();
      const data = JSON.parse(output);

      // kloop reports max_iterations when the loop hit the iteration limit
      if (data.exitReason === 'max_iterations') {
        return { status: 'max_iterations' };
      }
      return { status: 'completed' };
    }
  } catch {
    // Fallback: assume completed if status check fails
  }
  return { status: 'completed' };
}

/**
 * Run `kloop describe` to gather durable loop evidence for rewrite analysis.
 * Returns the describe output as a string.
 */
export function devloopDescribe(kloopRunId: string): string {
  try {
    const proc = Bun.spawnSync({
      cmd: ['kloop', 'describe', kloopRunId],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
    return `(kloop describe failed: exit ${proc.exitCode})`;
  } catch {
    return '(kloop describe unavailable)';
  }
}

/**
 * Check if a kloop run is currently running
 */
export function devloopStatus(kloopRunId: string): DevloopStatus {
  try {
    const proc = Bun.spawnSync({
      cmd: ['kloop', 'status', kloopRunId, '--json'],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.exitCode === 0) {
      const output = proc.stdout.toString().trim();
      const data = JSON.parse(output);
      return {
        running: data.status === 'running',
        lastStatus: data.status,
        exitReason: data.exitReason,
      };
    }
    return { running: false };
  } catch {
    return { running: false };
  }
}

/**
 * Cancel a running kloop run
 */
export function devloopCancel(kloopRunId: string): boolean {
  try {
    const proc = Bun.spawnSync({
      cmd: ['kloop', 'cancel', kloopRunId],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
