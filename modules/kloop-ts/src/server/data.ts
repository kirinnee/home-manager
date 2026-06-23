import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as YAML from 'yaml';
import type { CliDeps } from '../cli';
import { getKloopHome, paths } from '../deps';
import { flattenNestedConfig } from '../types';

// ============================================================================
// Read-only views of ~/.kloop for the `kloop serve` web UI. kloop is the source
// of truth, so this reads its own event log / index directly (no CLI shelling)
// and assembles the SAME JSON shapes `kloop ps --json` / `kloop describe --json`
// emit — the viewer client was written against those shapes.
// ============================================================================

export interface KloopData {
  listRuns(): Promise<unknown[]>;
  runDetail(id: string): Promise<unknown | null>;
  readFile(rel: string): string | null;
  listDir(rel: string): string[];
  resolvePath(rel: string): string | null;
}

/** Resolve a path under ~/.kloop, refusing traversal AND symlink escape (G4). */
function safeKloopPath(rel: string): string | null {
  const root = getKloopHome();
  const p = resolve(root, rel);
  if (p !== root && !p.startsWith(`${root}/`)) return null;
  // Refuse symlinks that resolve outside the root (a planted link in a run dir).
  try {
    if (existsSync(p)) {
      const real = realpathSync(p);
      const realRoot = realpathSync(root);
      if (real !== realRoot && !real.startsWith(`${realRoot}/`)) return null;
    }
  } catch {
    return null;
  }
  return p;
}

/** Parsed config.yaml for a run, minus the large `prompts` blob; null if absent. */
function readRunConfig(id: string): Record<string, unknown> | null {
  const p = safeKloopPath(join(id, 'config.yaml'));
  if (!p || !existsSync(p)) return null;
  try {
    const v = YAML.parse(readFileSync(p, 'utf-8'));
    if (!v || typeof v !== 'object') return null;
    // Config files may be the nested v2 role-block layout — flatten to the flat key
    // shape the dashboard reads (implementers/reviewPhases/poolProfiles/etc.). Old flat
    // files pass through unchanged.
    const flat = flattenNestedConfig(v) as Record<string, unknown>;
    const { prompts: _drop, ...rest } = flat;
    return rest;
  } catch {
    return null;
  }
}

export function makeKloopData(deps: CliDeps): KloopData {
  const { indexDb, eventLog, pidLock } = deps;

  return {
    // `kloop ps -a --json` shape (newest first), read-only (no crash reaping —
    // deriveStatus already flags a dead pid as `crashed` for display).
    async listRuns() {
      const rows = await indexDb.listRuns();
      const runs: Record<string, unknown>[] = [];
      for (const row of rows) {
        const lock = await pidLock.read(row.id);
        const state = await eventLog.deriveStatus(row.id, lock?.pid);
        if (!state) continue;
        const startedMs = new Date(row.started_at).getTime();
        const terminal = state.status !== 'running' && state.status !== 'pending';
        const endMs = terminal && state.lastEventAt ? new Date(state.lastEventAt).getTime() : Date.now();
        runs.push({
          id: row.id,
          workspace: row.workspace,
          status: state.status,
          loop: state.currentLoop,
          maxIterations: state.config?.maxIterations,
          phase: state.currentPhase,
          exitReason: state.exitReason,
          startedAt: row.started_at,
          elapsedMs: Math.max(0, endMs - startedMs),
          endedAt: terminal ? state.lastEventAt : undefined,
        });
      }
      runs.sort((a, b) => new Date(b.startedAt as string).getTime() - new Date(a.startedAt as string).getTime());
      return runs;
    },

    // `kloop describe --json` shape + the full parsed config attached as `config`
    // (for the Overview's implementer-weight / review-phase / checkpointer cards).
    async runDetail(id: string) {
      const row = await indexDb.getRun(id);
      if (!row) return null;
      const lock = await pidLock.read(id);
      const mat = await eventLog.materializeStatus(id, lock?.pid);
      const status = await eventLog.enrichStatus(mat, id);
      const cfg = readRunConfig(id);
      const loops = status.loops ?? [];
      // Cap elapsed at the last event for terminal runs (don't keep ticking).
      const startMs = new Date(status.startedAt).getTime();
      const terminal = status.status !== 'running' && status.status !== 'pending';
      const endMs = terminal && status.lastEventAt ? new Date(status.lastEventAt).getTime() : Date.now();
      return {
        id,
        workspace: row.workspace,
        status: status.status,
        loop: loops.length > 0 ? loops[loops.length - 1].loop : 0,
        maxIterations: cfg?.maxIterations,
        compressSpec: cfg?.compressSpec,
        synthesis: cfg?.synthesis,
        verify: cfg?.verify,
        verifyPhases: cfg?.verifyPhases,
        verifyTimeout: cfg?.verifyTimeout,
        rerankAfterCheckpoint: cfg?.rerankAfterCheckpoint,
        implementerRetry: cfg?.implementerRetry,
        firstIterationWeightMultiplier: cfg?.firstIterationWeightMultiplier,
        startedAt: status.startedAt,
        elapsedMs: Math.max(0, endMs - startMs),
        exitCode: status.exitCode,
        exitReason: status.exitReason,
        failures: status.consecutiveFailures,
        failureThreshold: status.failureThreshold,
        loops,
        lastEventIndex: status.lastEventIndex,
        config: cfg,
      };
    },

    readFile(rel: string): string | null {
      const p = safeKloopPath(rel);
      if (!p || !existsSync(p)) return null;
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },

    listDir(rel: string): string[] {
      const p = safeKloopPath(rel);
      if (!p || !existsSync(p)) return [];
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },

    // Exposed for the SSE tail endpoint; also enforces existence + is-a-file.
    resolvePath(rel: string): string | null {
      const p = safeKloopPath(rel);
      if (!p || !existsSync(p)) return null;
      try {
        if (!statSync(p).isFile()) return null;
      } catch {
        return null;
      }
      return p;
    },
  };
}

export { getKloopHome, paths };
