import * as path from 'path';
import * as fs from 'fs/promises';
import type { Config, Run, Session, VerdictFile, HistoryEntry, CheckpointResult } from './types';
import { DEFAULT_CONFIG } from './types';

// ============================================================================
// Dependency Interfaces
// ============================================================================

export interface Paths {
  readonly baseDir: string;
  readonly spec: string;
  readonly config: string;
  readonly currentDir: string;
  readonly runJson: string;
  readonly sessionsDir: string;
  readonly verdictsDir: string;
  readonly evidenceDir: string;
  readonly evidenceMd: string;
  readonly learnings: string;
  readonly historyDir: string;
  readonly logsDir: string;
  readonly reviewsDir: string;
  readonly historyEntry: (runId: string) => string;
  readonly verdictFile: (iteration: number, reviewerIndex: number) => string;
  readonly sessionFile: (sessionId: string) => string;
  readonly runLogsDir: (runId: string) => string;
  readonly runReviewsDir: (runId: string) => string;
}

export interface FsService {
  mkdir(dir: string): Promise<void>;
  readFile(path: string): Promise<string>;
  readJson<T>(path: string): Promise<T | null>;
  writeFile(path: string, content: string): Promise<void>;
  writeJson(path: string, data: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface TmuxService {
  isAvailable(): Promise<boolean>;
  isSessionAlive(sessionName: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  killSession(sessionName: string): Promise<boolean>;
  killAllSessions(): Promise<number>;
  runInSession(params: {
    sessionName: string;
    command: string;
    cwd: string;
    timeoutMins: number;
  }): Promise<{ exitCode: number; durationMs: number; timedOut: boolean }>;
  generateSessionName(params: {
    dirHash: string;
    runId: string;
    iteration: number;
    role: 'impl' | 'rev';
    reviewerIndex?: number;
  }): string;
  parseSessionName(sessionName: string): {
    dirHash: string;
    runId: string;
    iteration: number;
    role: 'impl' | 'rev';
    reviewerIndex?: number;
  } | null;
}

export interface StateService {
  initProject(config?: Partial<Config>): Promise<void>;
  hasConfig(): Promise<boolean>;
  loadConfig(): Promise<Config>;
  saveConfig(config: Config): Promise<void>;
  hasCurrentRun(): Promise<boolean>;
  createRun(specPath: string): Promise<Run>;
  loadRun(): Promise<Run | null>;
  saveRun(run: Run): Promise<void>;
  updatePhase(phase: Run['phase']): Promise<void>;
  incrementIteration(): Promise<number>;
  incrementConsecutiveFailures(): Promise<number>;
  resetConsecutiveFailures(): Promise<void>;
  addLearning(learning: string): Promise<void>;
  completeRun(statusOrCheckpointRan?: Run['status'] | boolean, checkpointRanFlag?: boolean): Promise<HistoryEntry>;
  cancelRun(): Promise<void>;
  saveSession(session: Session): Promise<void>;
  loadSessions(): Promise<Session[]>;
  loadVerdicts(iteration: number): Promise<Map<number, VerdictFile>>;
  clearEvidence(): Promise<void>;
  clearVerdicts(iteration: number): Promise<void>;
  clearReviews(): Promise<void>;
  readLearnings(): Promise<string | null>;
  archiveRun(checkpointRan?: boolean): Promise<HistoryEntry>;
  listHistory(): Promise<HistoryEntry[]>;
  clearCurrentRun(): Promise<void>;
  destroy(): Promise<void>;
  destroyAll(): Promise<void>;
  // Checkpoint methods
  saveCheckpointResult(result: CheckpointResult, iteration?: number): Promise<void>;
  loadCheckpointResult(): Promise<CheckpointResult | null>;
  loadCheckpointResultForIteration(iteration: number): Promise<CheckpointResult | null>;
  clearCheckpointResult(): Promise<void>;
  backupSpec(runId: string): Promise<string>;
  loadSpec(): Promise<string>;
  saveSpec(content: string): Promise<void>;
}

export interface HistoryService {
  list(): Promise<HistoryEntry[]>;
  load(runId: string): Promise<HistoryEntry | null>;
  format(entry: HistoryEntry): string;
  formatList(entries: HistoryEntry[]): string;
  clear(): Promise<void>;
}

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

// ============================================================================
// Default Paths Implementation
// ============================================================================

const BASE_DIR = '.kagent';
const CURRENT_DIR = `${BASE_DIR}/current`;
const SESSIONS_DIR = `${CURRENT_DIR}/sessions`;
const VERDICTS_DIR = `${CURRENT_DIR}/verdicts`;
const EVIDENCE_DIR = `${CURRENT_DIR}/evidence`;
const HISTORY_DIR = `${BASE_DIR}/history`;
const LOGS_DIR = `${BASE_DIR}/logs`;
const REVIEWS_DIR = `${BASE_DIR}/reviews`;

export const paths: Paths = {
  baseDir: BASE_DIR,
  spec: `${BASE_DIR}/spec.md`,
  config: `${BASE_DIR}/config.json`,
  currentDir: CURRENT_DIR,
  runJson: `${CURRENT_DIR}/run.json`,
  sessionsDir: SESSIONS_DIR,
  verdictsDir: VERDICTS_DIR,
  evidenceDir: EVIDENCE_DIR,
  evidenceMd: `${EVIDENCE_DIR}/evidence.md`,
  learnings: `${CURRENT_DIR}/learnings.md`,
  historyDir: HISTORY_DIR,
  logsDir: LOGS_DIR,
  reviewsDir: REVIEWS_DIR,
  historyEntry: (runId: string) => `${HISTORY_DIR}/${runId}.json`,
  verdictFile: (iteration: number, reviewerIndex: number) => `${VERDICTS_DIR}/${iteration}-${reviewerIndex}.json`,
  sessionFile: (sessionId: string) => `${SESSIONS_DIR}/${sessionId}.json`,
  runLogsDir: (runId: string) => `${LOGS_DIR}/${runId}`,
  runReviewsDir: (runId: string) => `${REVIEWS_DIR}/${runId}`,
};

// ============================================================================
// Default FsService Implementation
// ============================================================================

class DefaultFsService implements FsService {
  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async readFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf-8');
  }

  async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readdir(dirPath: string): Promise<string[]> {
    return await fs.readdir(dirPath);
  }

  async rm(dirPath: string, options = { recursive: false }): Promise<void> {
    await fs.rm(dirPath, options);
  }
}

export const defaultFsService: FsService = new DefaultFsService();

// ============================================================================
// Utilities
// ============================================================================

export function generateId(): string {
  return crypto.randomUUID();
}

export function generateRunId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function getDirHash(dirPath: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(dirPath);
  return hasher.digest('hex').slice(0, 8);
}

export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

// ============================================================================
// Spec Template
// ============================================================================

export const SPEC_TEMPLATE = `# Specification: [Title]

## Objective
[Clear, concise description of what to build]

## Acceptance Criteria
- [ ] Criterion 1 (specific, measurable)
- [ ] Criterion 2
- [ ] Criterion 3

## Definition of Done
- [ ] All acceptance criteria met
- [ ] Tests pass (if applicable)
- [ ] No lint/type errors (if applicable)

## Out of Scope
- [What this task does NOT include]

## Technical Constraints
- [Any specific requirements or limitations]
`;

// ============================================================================
// Dependency Factory
// ============================================================================

export interface Dependencies {
  paths: Paths;
  fs: FsService;
}

export function createDeps(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    paths: overrides.paths ?? paths,
    fs: overrides.fs ?? defaultFsService,
  };
}

export type Deps = ReturnType<typeof createDeps>;
