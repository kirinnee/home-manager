import * as path from 'path';
import pc from 'picocolors';
import { paths, generateKloopRunId } from '../deps';
import { LoopRunner } from '../loop/runner';
import { AgentRunner } from '../agents/runner';
import { IndexDb, EventLog, PidLock, killRunTmuxSessions } from '../index-db';
import type { CliDeps } from './index';
import { EVENT_TYPES, type KloopEvent } from '../types';

// ============================================================================
// run.log capture — captures stdout/stderr to ~/.kloop/{runId}/run.log
// ============================================================================

let runLogStream: import('fs/promises').FileHandle | null = null;

async function startRunLogCapture(runId: string): Promise<void> {
  const logPath = paths.runLog(runId);
  const { mkdir, open } = await import('fs/promises');
  await mkdir(paths.runPath(runId), { recursive: true });
  runLogStream = await open(logPath, 'a');
}

async function writeRunLog(msg: string): Promise<void> {
  if (runLogStream) {
    await runLogStream.write(msg + '\n');
  }
}

async function stopRunLogCapture(): Promise<void> {
  if (runLogStream) {
    await runLogStream.close();
    runLogStream = null;
  }
}

// Intercept console.log and console.error to also write to run.log
const _origConsoleLog = console.log;
const _origConsoleError = console.error;

function patchConsole(runId: string): void {
  console.log = (...args: unknown[]) => {
    _origConsoleLog(...args);
    writeRunLog(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    _origConsoleError(...args);
    writeRunLog(args.map(String).join(' '));
  };
}

function unpatchConsole(): void {
  console.log = _origConsoleLog;
  console.error = _origConsoleError;
}

export async function handler(runId: string | undefined, opts: { detach?: boolean }, deps: CliDeps): Promise<void> {
  const { state, tmux, indexDb, eventLog, pidLock } = deps;
  const workspace = process.cwd();

  // Resolve run ID if not provided
  if (!runId) {
    const row = await indexDb.getRunByWorkspace(workspace);
    if (!row) {
      console.error('No run found for this workspace. Run kloop init first.');
      process.exit(1);
    }
    runId = row.id;
  }

  // Check if the run is currently active — only truly active if PID lock + alive PID
  const lock = await pidLock.read(runId);
  const prevStatus = await eventLog.deriveStatus(runId, lock?.pid);
  if (lock && (await pidLock.isPidAlive(lock.pid))) {
    console.error(pc.red(`Run ${runId} is still ${prevStatus?.status ?? 'running'}.`));
    console.error(pc.dim('Cancel it first: kloop cancel'));
    process.exit(1);
  }

  // If previous run is terminal (completed/cancelled/crashed/error), clone into a new run
  if (prevStatus && eventLog.isTerminal(prevStatus.status)) {
    const oldId = runId;
    const newId = generateKloopRunId();
    const { mkdir, copyFile, writeFile } = await import('fs/promises');

    // Create new run directory
    const newRunDir = paths.runPath(newId);
    await mkdir(newRunDir, { recursive: true });

    // Copy spec + config from old run
    const oldConfigPath = paths.runConfig(oldId);
    const oldSpecPath = paths.runSpec(oldId);
    if (await deps.state.fs.exists(oldConfigPath)) {
      await copyFile(oldConfigPath, paths.runConfig(newId));
    }
    if (await deps.state.fs.exists(oldSpecPath)) {
      await copyFile(oldSpecPath, paths.runSpec(newId));
    }

    // Create empty events + learnings
    await writeFile(paths.runEvents(newId), '', 'utf-8');
    await writeFile(paths.runLearnings(newId), '', 'utf-8');

    // Insert into index.db (updates workspace mapping)
    await indexDb.insertRun({
      id: newId,
      workspace,
      started_at: new Date().toISOString(),
    });

    console.log(pc.yellow(`Previous run ${oldId} ended: ${prevStatus.status}`));
    if (prevStatus.exitReason) {
      console.log(pc.dim(`  ${prevStatus.exitReason}`));
    }
    console.log(pc.dim(`Cloning into new run ${newId}...`));
    console.log('');
    runId = newId;
  }

  // Daemon mode: use tmux session as the persistent background process
  if (opts.detach) {
    const daemonSession = `kloop-${runId}-daemon`;

    // Check if a daemon session already exists
    if (await tmux.isSessionAlive(daemonSession)) {
      console.error(pc.red(`Daemon session ${daemonSession} already exists.`));
      console.error(pc.dim('Cancel or attach first: kloop cancel / kloop attach'));
      process.exit(1);
    }

    const entryPoint = path.resolve(import.meta.dir, '..', 'index.ts');
    const command = `bun run "${entryPoint}" run ${runId}`;

    // Create a detached tmux session running the kloop command.
    // Use child_process.spawn with detached:true so the tmux process
    // survives when the parent bun process exits.
    const { spawn } = await import('child_process');
    const child = spawn('tmux', ['new-session', '-d', '-s', daemonSession, '-c', workspace, command], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    console.log(pc.green(`Detached: ${runId}`));
    console.log(pc.dim(`  kloop status   — check progress`));
    console.log(pc.dim(`  kloop logs     — view run log`));
    console.log(pc.dim(`  kloop attach   — jump into tmux`));
    process.exitCode = 0;
    return;
  }

  // Start run.log capture
  await startRunLogCapture(runId);
  patchConsole(runId);

  try {
    // Remove local .kloop/ symlinks if present (created by kloop link)
    await unlinkLocalKloop();

    // Check if tmux is available
    const available = await tmux.isAvailable();
    if (!available) {
      console.error('Error: tmux is not installed');
      console.error('Install with: brew install tmux (macOS) or apt install tmux (Linux)');
      process.exit(1);
    }

    // Validate run directory exists
    const runDir = paths.runPath(runId);
    if (!(await deps.state.fs.exists(runDir))) {
      console.error(`Error: Run directory not found: ${runDir}`);
      console.error(`Run: kloop init`);
      process.exit(1);
    }

    // Validate spec.md and config.yaml exist
    const configPath = paths.runConfig(runId);
    const specPath = paths.runSpec(runId);
    if (!(await deps.state.fs.exists(configPath))) {
      console.error(`Error: config.yaml not found: ${configPath}`);
      process.exit(1);
    }
    if (!(await deps.state.fs.exists(specPath))) {
      console.error(`Error: spec.md not found: ${specPath}`);
      process.exit(1);
    }

    // Load config from global storage (YAML)
    let config: any;
    try {
      const YAML = await import('yaml');
      const configContent = await deps.state.fs.readFile(configPath);
      config = YAML.parse(configContent);
    } catch (err) {
      console.error(`Error: Failed to parse config.yaml: ${(err as Error).message}`);
      process.exit(1);
    }

    // Acquire PID lock
    await pidLock.acquire(runId, workspace);

    // Register signal handlers for graceful Ctrl+C / SIGTERM
    let cleanedUp = false;
    const cleanup = async (signal: string) => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        // Kill tmux sessions linked to this run
        await killRunTmuxSessions(tmux, runId);
        await eventLog.append(runId, {
          type: EVENT_TYPES.CANCEL,
          timestamp: new Date().toISOString(),
          reason: `received ${signal}`,
        } as KloopEvent);
        await pidLock.release(runId);
      } catch {
        // Ignore — event log might not be accessible
      }
      unpatchConsole();
      await stopRunLogCapture();
      process.exit(130); // 128 + SIGINT(2) = 130
    };
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));

    // Write run_start event
    await eventLog.append(runId, {
      type: EVENT_TYPES.RUN_START,
      timestamp: new Date().toISOString(),
      config,
    } as KloopEvent);

    console.log(`KLOOP [${runId}]: Starting run in ${workspace}`);

    // Create agent runner with configured binaries
    const agentRunner = new AgentRunner(tmux, state, config);

    // Create loop runner
    const loopRunner = new LoopRunner(state, tmux, agentRunner, paths);

    // Run the loop with explicit run ID
    const result = await loopRunner.runWithId(runId);

    console.log('');
    console.log(`Loop finished: ${result.status}`);

    // Note: runWithId() in runner.ts already writes the terminal event
    // (completed/error/conflict/agent_failure) — do NOT write duplicates here.

    // Release lock
    await pidLock.release(runId);

    // Stop log capture before exit
    unpatchConsole();
    await stopRunLogCapture();

    // Remove signal handlers (cleanup already done)
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    // Exit with code
    if (result.status === 'conflict') {
      process.exit(2);
    }
    if (result.status === 'agent_failure') {
      process.exit(3);
    }
    if (result.status === 'failed') {
      process.exit(1);
    }
  } catch (err) {
    const error = err as Error & { name: string };

    // Write error event if possible
    try {
      await eventLog.append(runId, {
        type: EVENT_TYPES.ERROR,
        timestamp: new Date().toISOString(),
        exitCode: 1,
        message: error.message,
      } as KloopEvent);
    } catch {
      // Ignore — event log might not be accessible
    }

    // Release lock on error
    try {
      await pidLock.release(runId);
    } catch {
      // Ignore
    }

    // Stop log capture before exit
    unpatchConsole();
    await stopRunLogCapture();

    // Remove signal handlers
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    if (error.name === 'AgentFailureError') {
      console.log('');
      console.log('========================================');
      console.log('AGENT FAILURE');
      console.log('========================================');
      console.log(error.message);
      console.log('');
      console.log('A failure.md file has been generated.');
      console.log('Please resolve and restart the loop.');
      console.log('========================================');
      process.exit(3);
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function unlinkLocalKloop(): Promise<void> {
  const { stat, rm } = await import('fs/promises');
  const localKloop = path.join(process.cwd(), '.kloop');
  try {
    const s = await stat(localKloop);
    if (s.isSymbolicLink()) {
      await rm(localKloop);
    } else if (s.isDirectory()) {
      // Directory with symlinks inside (created by kloop link)
      await rm(localKloop, { recursive: true });
    }
  } catch {
    // Doesn't exist — nothing to do
  }
}
