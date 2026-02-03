import * as path from 'path';
import type { FsService, Paths } from '../deps';

// ============================================================================
// LogsService - reads raw JSON logs from .kagent/logs/{runId}/
// ============================================================================

export interface LogFile {
  runId: string;
  name: string;
  path: string;
  iteration: number;
  role: 'impl' | 'rev';
  reviewerIndex?: number;
}

export interface RunLogs {
  runId: string;
  logs: LogFile[];
}

export interface LogsService {
  listRuns(): Promise<string[]>;
  listLogs(runId?: string): Promise<LogFile[]>;
  listLogsByRun(): Promise<RunLogs[]>;
  readLog(logPath: string): Promise<string>;
  parseLogName(name: string): Omit<LogFile, 'runId' | 'name' | 'path'> | null;
  getCurrentRunId(): Promise<string | null>;
}

export class LogsServiceImpl implements LogsService {
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
   * List all run IDs that have logs
   */
  async listRuns(): Promise<string[]> {
    if (!(await this.fs.exists(this.paths.logsDir))) {
      return [];
    }

    const entries = await this.fs.readdir(this.paths.logsDir);
    const runs: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(this.paths.logsDir, entry);
      // Check if it's a directory by trying to read it
      try {
        const files = await this.fs.readdir(entryPath);
        if (files.some(f => f.endsWith('.log'))) {
          runs.push(entry);
        }
      } catch {
        // Not a directory, skip
      }
    }

    return runs.sort().reverse(); // Most recent first (assuming IDs are sortable)
  }

  /**
   * List logs, optionally filtered by runId
   */
  async listLogs(runId?: string): Promise<LogFile[]> {
    if (runId) {
      return this.listLogsForRun(runId);
    }

    // List all logs from all runs
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
   * List logs for a specific run
   */
  private async listLogsForRun(runId: string): Promise<LogFile[]> {
    const runLogsDir = this.paths.runLogsDir(runId);

    if (!(await this.fs.exists(runLogsDir))) {
      return [];
    }

    const files = await this.fs.readdir(runLogsDir);
    const logs: LogFile[] = [];

    for (const file of files.filter(f => f.endsWith('.log'))) {
      const parsed = this.parseLogName(file);
      if (parsed) {
        logs.push({
          runId,
          name: file,
          path: path.join(runLogsDir, file),
          ...parsed,
        });
      }
    }

    // Sort by iteration, then role (impl first), then reviewer index
    return logs.sort((a, b) => {
      if (a.iteration !== b.iteration) return a.iteration - b.iteration;
      if (a.role !== b.role) return a.role === 'impl' ? -1 : 1;
      return (a.reviewerIndex ?? 0) - (b.reviewerIndex ?? 0);
    });
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
