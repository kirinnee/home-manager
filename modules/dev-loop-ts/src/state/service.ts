import type { Config, Run, Session, VerdictFile, HistoryEntry, Phase } from '../types';
import { parseConfig, parseRun, parseSession, parseVerdictFile, parseHistoryEntry, DEFAULT_CONFIG } from '../types';
import type { FsService, Paths } from '../deps';
import { generateRunId, getCurrentTimestamp, SPEC_TEMPLATE } from '../deps';
import * as config from './config';

export class StateService {
  constructor(
    private fs: FsService,
    private paths: Paths,
  ) {}

  // Configuration
  async initProject(overrides: Partial<Config> = {}): Promise<void> {
    await this.fs.mkdir(this.paths.baseDir);
    await this.fs.mkdir(this.paths.historyDir);

    if (!(await this.fs.exists(this.paths.spec))) {
      await this.fs.writeFile(this.paths.spec, SPEC_TEMPLATE);
    }

    if (await this.fs.exists(this.paths.config)) {
      const existing = await this.loadConfig();
      await this.saveConfig({ ...existing, ...overrides });
    } else {
      await this.saveConfig(config.mergeConfig(overrides));
    }
  }

  async hasConfig(): Promise<boolean> {
    return this.fs.exists(this.paths.config);
  }

  async loadConfig(): Promise<Config> {
    const content = await this.fs.readFile(this.paths.config);
    return parseConfig(JSON.parse(content));
  }

  async saveConfig(cfg: Config): Promise<void> {
    await this.fs.writeJson(this.paths.config, cfg);
  }

  // Run Management
  async hasCurrentRun(): Promise<boolean> {
    return this.fs.exists(this.paths.runJson);
  }

  async createRun(specPath: string): Promise<Run> {
    await this.fs.mkdir(this.paths.currentDir);
    await this.fs.mkdir(this.paths.sessionsDir);
    await this.fs.mkdir(this.paths.verdictsDir);
    await this.fs.mkdir(this.paths.evidenceDir);

    const run: Run = {
      id: generateRunId(),
      spec: specPath,
      status: 'running',
      iteration: 0,
      phase: 'implementing',
      startedAt: getCurrentTimestamp(),
      learnings: [],
    };

    await this.saveRun(run);
    return run;
  }

  async loadRun(): Promise<Run | null> {
    if (!(await this.fs.exists(this.paths.runJson))) return null;
    const content = await this.fs.readFile(this.paths.runJson);
    return parseRun(JSON.parse(content));
  }

  async saveRun(run: Run): Promise<void> {
    await this.fs.writeJson(this.paths.runJson, run);
  }

  async updatePhase(phase: Phase): Promise<void> {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.phase = phase;
    await this.saveRun(run);
  }

  async incrementIteration(): Promise<number> {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.iteration += 1;
    await this.saveRun(run);
    return run.iteration;
  }

  async addLearning(learning: string): Promise<void> {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.learnings.push(learning);
    await this.saveRun(run);
  }

  async completeRun(status: Run['status']): Promise<HistoryEntry> {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.status = status;
    run.phase = 'done';
    await this.saveRun(run);
    return await this.archiveRun();
  }

  async cancelRun(): Promise<void> {
    const run = await this.loadRun();
    if (!run) return;
    run.status = 'cancelled';
    run.phase = 'done';
    await this.saveRun(run);
  }

  // Session Management
  async saveSession(session: Session): Promise<void> {
    await this.fs.writeJson(this.paths.sessionFile(session.id), session);
  }

  async loadSessions(): Promise<Session[]> {
    if (!(await this.fs.exists(this.paths.sessionsDir))) return [];

    const files = await this.fs.readdir(this.paths.sessionsDir);
    const sessions: Session[] = [];

    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await this.fs.readFile(`${this.paths.sessionsDir}/${file}`);
        sessions.push(parseSession(JSON.parse(content)));
      } catch (err) {
        if (process.env.DEBUG) console.error(`Failed to parse session ${file}:`, err);
      }
    }
    return sessions;
  }

  // Verdict Management
  async saveVerdict(iteration: number, reviewerIndex: number, verdict: VerdictFile): Promise<void> {
    await this.fs.writeJson(this.paths.verdictFile(iteration, reviewerIndex), verdict);
  }

  async loadVerdicts(iteration: number): Promise<Map<number, VerdictFile>> {
    if (!(await this.fs.exists(this.paths.verdictsDir))) return new Map();

    const files = await this.fs.readdir(this.paths.verdictsDir);
    const pattern = new RegExp(`^${iteration}-(\\d+)\\.json$`);
    const verdicts = new Map<number, VerdictFile>();

    for (const file of files) {
      const match = file.match(pattern);
      if (match) {
        const content = await this.fs.readFile(`${this.paths.verdictsDir}/${file}`);
        verdicts.set(parseInt(match[1], 10), parseVerdictFile(JSON.parse(content)));
      }
    }
    return verdicts;
  }

  async clearVerdicts(iteration: number): Promise<void> {
    if (!(await this.fs.exists(this.paths.verdictsDir))) return;

    const files = await this.fs.readdir(this.paths.verdictsDir);
    const pattern = new RegExp(`^${iteration}-\\d+\\.json$`);

    for (const file of files) {
      if (pattern.test(file)) {
        await this.fs.unlink(`${this.paths.verdictsDir}/${file}`);
      }
    }
  }

  // Evidence
  async clearEvidence(): Promise<void> {
    if (await this.fs.exists(this.paths.evidenceDir)) {
      const files = await this.fs.readdir(this.paths.evidenceDir);
      for (const file of files) {
        await this.fs.unlink(`${this.paths.evidenceDir}/${file}`);
      }
    }
    await this.fs.mkdir(this.paths.evidenceDir);
  }

  // Reviews (in current/)
  async clearReviews(): Promise<void> {
    const reviewsDir = `${this.paths.currentDir}/reviews`;
    if (await this.fs.exists(reviewsDir)) {
      const files = await this.fs.readdir(reviewsDir);
      for (const file of files) {
        await this.fs.unlink(`${reviewsDir}/${file}`);
      }
    }
    await this.fs.mkdir(reviewsDir);
  }

  // Learnings
  async readLearnings(): Promise<string | null> {
    if (!(await this.fs.exists(this.paths.learnings))) return null;
    return this.fs.readFile(this.paths.learnings);
  }

  // History
  async archiveRun(): Promise<HistoryEntry> {
    const run = await this.loadRun();
    if (!run) throw new Error('No run to archive');

    const sessions = await this.loadSessions();
    const cfg = await this.loadConfig();

    const entry: HistoryEntry = {
      id: run.id,
      spec: run.spec,
      config: cfg,
      status: run.status as 'completed' | 'cancelled' | 'failed',
      iterations: run.iteration,
      startedAt: run.startedAt,
      completedAt: getCurrentTimestamp(),
      summary: this.buildSummary(sessions, run.learnings),
    };

    await this.fs.writeJson(this.paths.historyEntry(run.id), entry);
    await this.fs.rm(this.paths.currentDir, { recursive: true });
    return entry;
  }

  private buildSummary(sessions: Session[], learnings: string[]) {
    const byIteration = new Map<number, Session[]>();
    for (const s of sessions) {
      const list = byIteration.get(s.iteration) || [];
      list.push(s);
      byIteration.set(s.iteration, list);
    }

    return Array.from(byIteration.entries()).map(([iteration, iterSessions]) => {
      const impl = iterSessions.find(s => s.role === 'implementer');
      const reviewers = iterSessions.filter(s => s.role === 'reviewer');

      return {
        iteration,
        implementerDuration:
          impl?.completedAt && impl?.startedAt
            ? new Date(impl.completedAt).getTime() - new Date(impl.startedAt).getTime()
            : 0,
        reviewerVerdicts: reviewers.map(r => ({
          index: r.reviewerIndex ?? 0,
          verdict: r.verdict ?? 'rejected',
          binary: r.binary,
        })),
        learnings: learnings.filter((_, i) => i < iteration),
        sessions: iterSessions.map(s => ({
          role: s.role,
          reviewerIndex: s.reviewerIndex,
        })),
      };
    });
  }

  async listHistory(): Promise<HistoryEntry[]> {
    if (!(await this.fs.exists(this.paths.historyDir))) return [];

    const files = await this.fs.readdir(this.paths.historyDir);
    const entries: HistoryEntry[] = [];

    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await this.fs.readFile(`${this.paths.historyDir}/${file}`);
        entries.push(parseHistoryEntry(JSON.parse(content)));
      } catch (err) {
        if (process.env.DEBUG) console.error(`Failed to parse history ${file}:`, err);
      }
    }

    return entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  async loadHistoryEntry(runId: string): Promise<HistoryEntry | null> {
    const entryPath = this.paths.historyEntry(runId);
    if (!(await this.fs.exists(entryPath))) return null;
    const content = await this.fs.readFile(entryPath);
    return parseHistoryEntry(JSON.parse(content));
  }

  // Clear current run (preserves config, spec, history)
  async clearCurrentRun(): Promise<void> {
    if (await this.fs.exists(this.paths.currentDir)) {
      await this.fs.rm(this.paths.currentDir, { recursive: true });
    }
  }

  // Destroy all state EXCEPT history
  async destroy(): Promise<void> {
    // Remove current run
    await this.clearCurrentRun();

    // Remove config and spec, but preserve history
    if (await this.fs.exists(this.paths.config)) {
      await this.fs.unlink(this.paths.config);
    }
    if (await this.fs.exists(this.paths.spec)) {
      await this.fs.unlink(this.paths.spec);
    }

    // Clean up empty base dir if history is also empty
    if (await this.fs.exists(this.paths.historyDir)) {
      const historyFiles = await this.fs.readdir(this.paths.historyDir);
      if (historyFiles.length === 0) {
        await this.fs.rm(this.paths.historyDir, { recursive: true });
      }
    }

    // Remove base dir only if empty
    if (await this.fs.exists(this.paths.baseDir)) {
      try {
        const remaining = await this.fs.readdir(this.paths.baseDir);
        if (remaining.length === 0) {
          await this.fs.rm(this.paths.baseDir, { recursive: true });
        }
      } catch {
        // Ignore errors
      }
    }
  }

  // Destroy everything including history
  async destroyAll(): Promise<void> {
    if (await this.fs.exists(this.paths.baseDir)) {
      await this.fs.rm(this.paths.baseDir, { recursive: true });
    }
  }
}
