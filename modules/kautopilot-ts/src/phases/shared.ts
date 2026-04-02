import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotPath, type RunScope } from '../core/artifacts';
import { getAgentPrompt } from '../core/agents';
import { spawnTTY, type SpawnTTYOptions } from '../llm/spawn';
import { appendEvent } from '../core/log';
import { getConfigDir } from '../core/config-dir';
import { startTurnWatcher } from '../core/turn-watcher';

/**
 * Load prompt template — delegates to the agent resolution system.
 * Used by phase 2/3 handlers that reference agents by phase and name.
 */
export function loadPromptTemplate(phase: string, name: string, vars?: Record<string, string>): string {
  const key = name.replace(/-/g, '_');
  return getAgentPrompt(phase, key, vars);
}

/**
 * Parse plan filename into { ordinal, rewrite } or null if not a valid plan file.
 * Supports both conventions:
 *   plan-1-1.md → ordinal=1, rewrite=1  (spec convention)
 *   plan-1.md   → ordinal=1, rewrite=1  (legacy flat convention)
 */
export function parsePlanFilename(filename: string): { ordinal: number; rewrite: number } | null {
  // Spec convention: plan-{ordinal}-{rewrite}.md
  const suffixed = filename.match(/^plan-(\d+)-(\d+)\.md$/);
  if (suffixed) {
    return { ordinal: parseInt(suffixed[1], 10), rewrite: parseInt(suffixed[2], 10) };
  }
  // Legacy: plan-{ordinal}.md (treated as rewrite 1)
  const flat = filename.match(/^plan-(\d+)\.md$/);
  if (flat) {
    return { ordinal: parseInt(flat[1], 10), rewrite: 1 };
  }
  return null;
}

/**
 * Resolve active plans from a directory using the spec convention:
 * plan-{ordinal}-{rewrite}.md — the active plan for each ordinal is the highest rewrite suffix.
 * Returns one path per ordinal, sorted by ordinal.
 */
export function resolveActivePlans(plansDir: string): string[] {
  if (!existsSync(plansDir)) return [];
  const files = readdirSync(plansDir);
  const byOrdinal = new Map<number, { rewrite: number; filename: string }>();

  for (const f of files) {
    const parsed = parsePlanFilename(f);
    if (!parsed) continue;
    const existing = byOrdinal.get(parsed.ordinal);
    if (!existing || parsed.rewrite > existing.rewrite) {
      byOrdinal.set(parsed.ordinal, { rewrite: parsed.rewrite, filename: f });
    }
  }

  return Array.from(byOrdinal.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => join(plansDir, v.filename));
}

/**
 * Discover plan files dynamically from a directory.
 * Uses resolveActivePlans for spec-convention files (plan-N-M.md),
 * falls back to legacy flat files (plan-N.md).
 */
export function discoverPlans(plansDir: string): string[] {
  return resolveActivePlans(plansDir);
}

/**
 * Read a file from session artifact snapshot.
 * Defaults to task-spec.md (the finalized spec).
 */
export function resolveSpec(sessionId: string, version: number, filename: string = 'task-spec.md'): string {
  const sessionPath = snapshotPath(sessionId, version, filename);
  if (existsSync(sessionPath)) return readFileSync(sessionPath, 'utf-8');
  return '';
}

/**
 * Discover plan file paths from session snapshot.
 * Uses resolveActivePlans to pick the highest rewrite suffix per ordinal.
 */
export function resolvePlans(sessionId: string, version: number): string[] {
  const sessionPlansDir = snapshotPath(sessionId, version, 'plans');
  return resolveActivePlans(sessionPlansDir);
}

/**
 * Validate that plan files have actual content (not empty).
 * Returns array of empty file paths.
 */
export function validatePlanContent(planFiles: string[]): string[] {
  return planFiles.filter(p => {
    const content = readFileSync(p, 'utf-8').trim();
    return content.length === 0;
  });
}

/**
 * Find the latest plan-draft-N/ directory in the plans dir.
 * Returns { ordinal, dir, files } or null if no drafts exist.
 */
export function findLatestPlanDraftDir(plansDir: string): { ordinal: number; dir: string; files: string[] } | null {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const drafts = entries
    .filter(e => e.isDirectory() && /^plan-draft-\d+$/.test(e.name))
    .map(e => ({ name: e.name, ordinal: parseInt(e.name.match(/plan-draft-(\d+)/)![1]) }))
    .sort((a, b) => b.ordinal - a.ordinal);

  if (drafts.length === 0) return null;

  const latest = drafts[0];
  const draftDir = join(plansDir, latest.name);
  const files = readdirSync(draftDir)
    .filter(f => /^plan-\d+\.md$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/plan-(\d+)/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/plan-(\d+)/)?.[1] || '0', 10);
      return numA - numB;
    })
    .map(f => join(draftDir, f));

  return { ordinal: latest.ordinal, dir: draftDir, files };
}

/**
 * Read all plan files from a plan-draft-N directory, returning
 * an array of { filename, content } in plan order.
 */
export function readPlanDraftFiles(draftDir: string): Array<{ filename: string; content: string }> {
  const files = readdirSync(draftDir)
    .filter(f => /^plan-\d+\.md$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/plan-(\d+)/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/plan-(\d+)/)?.[1] || '0', 10);
      return numA - numB;
    });

  return files.map(f => ({
    filename: f,
    content: readFileSync(join(draftDir, f), 'utf-8'),
  }));
}

/**
 * Derive a project key from a worktree path (for Claude JSONL path resolution).
 * Matches Claude's internal key derivation: replace / and . with -.
 * e.g. /Users/erng/.config/foo → -Users-erng--config-foo
 */
function deriveProjectKey(worktree: string): string {
  return worktree.replace(/[/.]/g, '-');
}

/**
 * Spawn a TTY with turn tracking.
 * Wraps spawnTTY with:
 * 1. Generate claude session ID
 * 2. Emit context:updated with JSONL path info
 * 3. Start turn watcher (updates userTurn in status.yaml)
 * 4. Run spawnTTY (blocks)
 * 5. Close watcher
 */
export async function spawnTTYWithTurnTracking(
  sessionId: string,
  binary: string,
  prompt: string,
  options: SpawnTTYOptions & { worktree: string },
): Promise<number> {
  const claudeSessionId = crypto.randomUUID();
  const configDir = getConfigDir(binary) ?? `${process.env.HOME}/.claude`;
  const projectKey = deriveProjectKey(options.worktree);
  const jsonlPath = join(configDir, 'projects', projectKey, `${claudeSessionId}.jsonl`);

  // Emit context so external tools know which JSONL to watch
  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { claudeSessionId, claudeJsonlPath: jsonlPath },
  });

  // Start watching the JSONL for turn changes
  const watcher = startTurnWatcher(sessionId, jsonlPath);

  try {
    const runScope: RunScope = { kind: 'session', id: sessionId };
    const exitCode = await spawnTTY(binary, prompt, {
      ...options,
      claudeSessionId,
      runScope,
      label: options.label ?? 'tty-handoff',
      context: `TTY handoff for session ${sessionId}`,
    });
    return exitCode;
  } finally {
    watcher.close();
  }
}
