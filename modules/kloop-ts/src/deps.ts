import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import type { Config, Run, Session, HistoryEntry, CheckpointResult } from './types';

// ============================================================================
// Dependency Interfaces
// ============================================================================

export interface Paths {
  // Legacy local paths (for backward compatibility during transition)
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
  readonly metricsDir: string;
  readonly failureMd: string;
  readonly historyEntry: (runId: string) => string;
  readonly verdictFile: (iteration: number, reviewerIndex: number) => string;
  readonly sessionFile: (sessionId: string) => string;
  readonly runLogsDir: (runId: string) => string;
  readonly runReviewsDir: (runId: string) => string;
  readonly metricsFile: (runId: string) => string;

  // New global kloop paths (set dynamically via KLOOP_HOME)
  readonly kloopHome: string;
  readonly indexDb: string;
  readonly lockFile: (runId: string) => string;
  readonly runPath: (runId: string) => string;
  readonly loopPath: (runId: string, loopIndex: number) => string;
  readonly agentPath: (runId: string, loopIndex: number, agentName: string) => string;
  readonly runConfig: (runId: string) => string;
  readonly runSpec: (runId: string) => string;
  readonly runSpecVersioned: (runId: string, version: number) => string;
  readonly runEvents: (runId: string) => string;
  readonly runStatus: (runId: string) => string;
  readonly runLearnings: (runId: string) => string;
  readonly runLog: (runId: string) => string;
  readonly loopSummaryMd: (runId: string, loopIndex: number) => string;
  readonly loopSummaryJson: (runId: string, loopIndex: number) => string;
  readonly loopLearningMd: (runId: string, loopIndex: number) => string;
  readonly loopCheckpoint: (runId: string, loopIndex: number) => string;
  readonly loopMetrics: (runId: string, loopIndex: number) => string;
  readonly loopImplementerPath: (runId: string, loopIndex: number) => string;
  readonly loopReviewerPath: (runId: string, loopIndex: number, reviewerIndex: number) => string;
  readonly loopEvidencePath: (runId: string, loopIndex: number) => string;
  readonly loopReviewsPath: (runId: string, loopIndex: number) => string;
  readonly loopVerdictsPath: (runId: string, loopIndex: number) => string;
  readonly loopCheckpointerPath: (runId: string, loopIndex: number) => string;
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
  fs: FsService;
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
  listMetricRuns(): Promise<string[]>;
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
const METRICS_DIR = `${BASE_DIR}/metrics`;

/** Get the KLOOP_HOME directory, respecting the env var override. */
export function getKloopHome(): string {
  return process.env.KLOOP_HOME ?? path.join(os.homedir(), '.kloop');
}

export const paths: Paths = {
  // Legacy local paths (for backward compatibility during transition)
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
  metricsDir: METRICS_DIR,
  failureMd: `${BASE_DIR}/failure.md`,
  historyEntry: (runId: string) => `${HISTORY_DIR}/${runId}.json`,
  verdictFile: (iteration: number, reviewerIndex: number) => `${VERDICTS_DIR}/${iteration}-${reviewerIndex}.json`,
  sessionFile: (sessionId: string) => `${SESSIONS_DIR}/${sessionId}.json`,
  runLogsDir: (runId: string) => `${LOGS_DIR}/${runId}`,
  runReviewsDir: (runId: string) => `${REVIEWS_DIR}/${runId}`,
  metricsFile: (runId: string) => `${METRICS_DIR}/${runId}.jsonl`,

  // Global kloop paths (dynamic via KLOOP_HOME)
  kloopHome: getKloopHome(),
  indexDb: path.join(getKloopHome(), 'index.db'),
  lockFile: (runId: string) => path.join(getKloopHome(), `${runId}.lock`),
  runPath: (runId: string) => path.join(getKloopHome(), runId),
  loopPath: (runId: string, loopIndex: number) => path.join(getKloopHome(), runId, `loop-${loopIndex}`),
  agentPath: (runId: string, loopIndex: number, agentName: string) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, agentName),
  runConfig: (runId: string) => path.join(getKloopHome(), runId, 'config.yaml'),
  runSpec: (runId: string) => path.join(getKloopHome(), runId, 'spec.md'),
  runSpecVersioned: (runId: string, version: number) => path.join(getKloopHome(), runId, `spec-${version}.md`),
  runEvents: (runId: string) => path.join(getKloopHome(), runId, 'events.jsonl'),
  runStatus: (runId: string) => path.join(getKloopHome(), runId, 'status.yaml'),
  runLearnings: (runId: string) => path.join(getKloopHome(), runId, 'learnings.md'),
  runLog: (runId: string) => path.join(getKloopHome(), runId, 'run.log'),
  loopSummaryMd: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'summary.md'),
  loopSummaryJson: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'summary.json'),
  loopLearningMd: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'learning.md'),
  loopCheckpoint: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'checkpoint.json'),
  loopMetrics: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'metrics.jsonl'),
  loopImplementerPath: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'implementer'),
  loopReviewerPath: (runId: string, loopIndex: number, reviewerIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, `reviewer-${reviewerIndex}`),
  loopEvidencePath: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'evidence'),
  loopReviewsPath: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'reviews'),
  loopVerdictsPath: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'verdicts'),
  loopCheckpointerPath: (runId: string, loopIndex: number) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'checkpointer'),
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

// Generate 8-char base36 nanoid for kloop (customAlphabet cached at module level)
const { customAlphabet } = require('nanoid');
const _kloopNanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

export function generateKloopRunId(): string {
  return _kloopNanoid();
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

/**
 * Count existing spec-N.md files in a run directory to determine the next version number.
 * Returns the next version (1 if no spec-N.md files exist).
 */
export async function nextSpecVersion(runId: string): Promise<number> {
  const runDir = paths.runPath(runId);
  try {
    const files = await fs.readdir(runDir);
    let maxVersion = 0;
    for (const f of files) {
      const match = f.match(/^spec-(\d+)\.md$/);
      if (match) {
        const v = parseInt(match[1], 10);
        if (v > maxVersion) maxVersion = v;
      }
    }
    return maxVersion + 1;
  } catch {
    return 1;
  }
}
