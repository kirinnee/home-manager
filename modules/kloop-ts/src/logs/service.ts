import * as path from 'path';
import type { FsService, Paths, LogFile, RunLogs, LogsService } from '../deps';

// ============================================================================
// LogsService - reads raw JSON logs from ~/.kloop/{runId}/loop-{L}/{agent}/log
// ============================================================================

class LogsServiceImpl implements LogsService {
  constructor(
    private fs: FsService,
    private paths: Paths,
  ) {}

  /**
   * Get current run ID from run.json if exists
   */
  async getCurrentRunId(): Promise<string | null> {
    try {
      const content = await this.fs.readFile(this.paths.runJson);
      const run = JSON.parse(content);
      return run.id || null;
    } catch {
      return null;
    }
  }

  /**
   * List all run IDs that have logs from global kloop storage
   */
  async listRuns(): Promise<string[]> {
    const home = this.paths.kloopHome;
    if (!(await this.fs.exists(home))) {
      return [];
    }

    const entries = await this.fs.readdir(home);
    const runs: string[] = [];

    for (const entry of entries) {
      // Skip non-run directories (index.db, lock files, etc.)
      if (entry.startsWith('.') || entry.endsWith('.lock') || entry === 'index.db') continue;

      const entryPath = path.join(home, entry);
      try {
        const subEntries = await this.fs.readdir(entryPath);
        // A run directory has loop-{N} subdirectories
        if (subEntries.some(f => f.startsWith('loop-'))) {
          runs.push(entry);
        }
      } catch {
        // Not a directory, skip
      }
    }

    return runs.sort().reverse();
  }

  /**
   * List logs, optionally filtered by runId
   */
  async listLogs(runId?: string): Promise<LogFile[]> {
    if (runId) {
      return this.listLogsForRun(runId);
    }

    const runs = await this.listRuns();
    const allLogs: LogFile[] = [];

    for (const run of runs) {
      const logs = await this.listLogsForRun(run);
      allLogs.push(...logs);
    }

    return allLogs;
  }

  /**
   * List logs grouped by run
   */
  async listLogsByRun(): Promise<RunLogs[]> {
    const runs = await this.listRuns();
    const result: RunLogs[] = [];

    for (const runId of runs) {
      const logs = await this.listLogsForRun(runId);
      if (logs.length > 0) {
        result.push({ runId, logs });
      }
    }

    return result;
  }

  /**
   * List logs for a specific run from global kloop storage.
   * Scans ~/.kloop/{runId}/loop-{L}/{implementer,reviewer-{R}}/log
   */
  private async listLogsForRun(runId: string): Promise<LogFile[]> {
    const runDir = this.paths.runPath(runId);

    if (!(await this.fs.exists(runDir))) {
      return [];
    }

    const entries = await this.fs.readdir(runDir);
    const logs: LogFile[] = [];

    for (const entry of entries) {
      const loopMatch = entry.match(/^loop-(\d+)$/);
      if (!loopMatch) continue;

      const loopNum = parseInt(loopMatch[1], 10);
      const loopDir = path.join(runDir, entry);

      // Scan agent directories within this loop
      try {
        const agentDirs = await this.fs.readdir(loopDir);
        for (const agentDir of agentDirs) {
          const logPath = path.join(loopDir, agentDir, 'log');
          if (!(await this.fs.exists(logPath))) continue;

          // Parse agent directory name
          const parsed = this.parseAgentDirName(agentDir, loopNum);
          if (parsed) {
            logs.push({
              runId,
              name: agentDir,
              path: logPath,
              ...parsed,
            });
          }
        }
      } catch {
        // Not a directory, skip
      }
    }

    // Sort by iteration, then role (impl first), then reviewer index
    return logs.sort((a, b) => {
      if (a.iteration !== b.iteration) return a.iteration - b.iteration;
      if (a.role !== b.role) return a.role === 'impl' ? -1 : 1;
      return (a.reviewerIndex ?? 0) - (b.reviewerIndex ?? 0);
    });
  }

  /**
   * Parse agent directory name: "implementer" or "reviewer-{N}"
   */
  private parseAgentDirName(name: string, loopNum: number): Omit<LogFile, 'runId' | 'name' | 'path'> | null {
    if (name === 'implementer') {
      return { iteration: loopNum, role: 'impl' };
    }

    if (name === 'checkpointer') {
      return { iteration: loopNum, role: 'impl' }; // treat as impl for display purposes
    }

    const revMatch = name.match(/^reviewer-(\d+)$/);
    if (revMatch) {
      return {
        iteration: loopNum,
        role: 'rev',
        reviewerIndex: parseInt(revMatch[1], 10),
      };
    }

    return null;
  }

  async readLog(logPath: string): Promise<string> {
    return await this.fs.readFile(logPath);
  }

  parseLogName(name: string): Omit<LogFile, 'runId' | 'name' | 'path'> | null {
    // impl-1.log -> { iteration: 1, role: 'impl' }
    const implMatch = name.match(/^impl-(\d+)\.log$/);
    if (implMatch) {
      return {
        iteration: parseInt(implMatch[1], 10),
        role: 'impl',
      };
    }

    // rev-1-0.log -> { iteration: 1, role: 'rev', reviewerIndex: 0 }
    const revMatch = name.match(/^rev-(\d+)-(\d+)\.log$/);
    if (revMatch) {
      return {
        iteration: parseInt(revMatch[1], 10),
        role: 'rev',
        reviewerIndex: parseInt(revMatch[2], 10),
      };
    }

    return null;
  }
}

export function createLogsService(fs: FsService, paths: Paths): LogsService {
  return new LogsServiceImpl(fs, paths);
}
