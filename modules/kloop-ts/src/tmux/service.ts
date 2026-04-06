import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { TmuxService } from '../deps';
import * as commands from './commands';
import { getDirHash } from '../deps';

// ============================================================================
// TmuxService class (IO edge)
// ============================================================================

class TmuxServiceImpl implements TmuxService {
  private statusDir = path.join(os.tmpdir(), 'kloop', 'status');

  constructor(private spawn: typeof Bun.spawn = Bun.spawn.bind(Bun)) {}

  async isAvailable(): Promise<boolean> {
    try {
      const proc = this.spawn(['tmux', '-V'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async isSessionAlive(sessionName: string): Promise<boolean> {
    const cmd = commands.buildHasSessionCommand(sessionName);
    const proc = this.spawn(cmd, {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }

  async listSessions(): Promise<string[]> {
    const cmd = commands.buildListSessionsCommand();
    const proc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return []; // No server running
    }

    const output = await new Response(proc.stdout).text();
    return output
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.startsWith('kloop-') || s.startsWith('devloop-'));
  }

  async killSession(sessionName: string): Promise<boolean> {
    const cmd = commands.buildKillSessionCommand(sessionName);
    const proc = this.spawn(cmd, {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }

  async killAllSessions(): Promise<number> {
    const sessions = await this.listSessions();
    let killed = 0;

    for (const session of sessions) {
      if (await this.killSession(session)) {
        killed++;
      }
    }

    return killed;
  }

  async runInSession(params: {
    sessionName: string;
    command: string;
    cwd: string;
    timeoutMins: number;
  }): Promise<{ exitCode: number; durationMs: number; timedOut: boolean }> {
    await this.ensureStatusDir();

    const startTime = Date.now();
    const statusFile = this.getStatusFilePath(params.sessionName);

    // Clean up any stale status file
    try {
      await fs.unlink(statusFile);
    } catch {}

    // Write initial "running" marker
    await fs.writeFile(statusFile, 'RUNNING', { mode: 0o600 });

    // Wrap command with timeout
    const wrappedCommand = `${commands.buildTimeoutCommand(params.command, params.timeoutMins)}; echo $? > "${statusFile}"`;

    // Create tmux session
    const cmd = commands.buildNewSessionCommand({
      sessionName: params.sessionName,
      cwd: params.cwd,
      command: wrappedCommand,
    });

    // Create environment without CLAUDECODE to prevent nested sessions from inheriting it
    const { CLAUDECODE: _, ...envWithoutClaudeCode } = process.env;

    const createProc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: envWithoutClaudeCode,
    });

    const createExitCode = await createProc.exited;
    if (createExitCode !== 0) {
      const stderr = await new Response(createProc.stderr).text();
      throw new Error(`Failed to create tmux session: ${stderr.trim() || `exit code ${createExitCode}`}`);
    }

    // Poll for session completion
    const maxPollTime = (params.timeoutMins + 2) * 60 * 1000;
    const pollStart = Date.now();

    while (true) {
      const alive = await this.isSessionAlive(params.sessionName);
      if (!alive) break;

      if (Date.now() - pollStart > maxPollTime) {
        await this.killSession(params.sessionName);
        break;
      }

      await Bun.sleep(2000);
    }

    const durationMs = Date.now() - startTime;

    // Read exit code from status file
    let exitCode = 1;
    let timedOut = false;

    try {
      const statusContent = await fs.readFile(statusFile, 'utf-8');
      const trimmed = statusContent.trim();

      if (trimmed === 'RUNNING') {
        exitCode = 1;
      } else {
        const parsed = parseInt(trimmed, 10);
        if (Number.isFinite(parsed)) {
          exitCode = parsed;
          timedOut = exitCode === 124; // timeout command's exit code
        }
      }
    } catch {}

    // Clean up status file
    try {
      await fs.unlink(statusFile);
    } catch {}

    return { exitCode, durationMs, timedOut };
  }

  generateSessionName(params: {
    dirHash: string;
    runId: string;
    iteration: number;
    role: 'impl' | 'rev';
    reviewerIndex?: number;
  }): string {
    return commands.generateSessionName(params);
  }

  parseSessionName(sessionName: string): {
    dirHash: string;
    runId: string;
    iteration: number;
    role: 'impl' | 'rev';
    reviewerIndex?: number;
  } | null {
    return commands.parseSessionName(sessionName);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async ensureStatusDir(): Promise<void> {
    await fs.mkdir(this.statusDir, { recursive: true, mode: 0o700 });
  }

  private getStatusFilePath(sessionName: string): string {
    const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.statusDir, `${safeName}.status`);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createTmuxService(spawn?: typeof Bun.spawn): TmuxService {
  return new TmuxServiceImpl(spawn);
}
