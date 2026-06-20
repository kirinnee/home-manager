import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { plansRepoDir } from '../core/revisions';
import type { SessionMeta } from '../core/session-meta';

/**
 * The repo bucket plan files are AUTHORED into (`epoch/<E>/plans/<repo>/`). Plans
 * are tagged by repo via front-matter and partitioned per repo in finalize_plans,
 * but they physically share one on-disk folder — the primary repo, or "default"
 * before triage registers any.
 */
export function authoringRepoName(meta: SessionMeta): string {
  return meta.repos[0]?.repo ?? 'default';
}

/**
 * Each plan is a folder of versions under `epoch/<E>/plans/<repo>/<plan>/vN.md`.
 * Return `{ plan, file }` for the latest version of each plan folder, where
 * `plan` is the folder name (e.g. `plan-1`) and `file` is the absolute vN.md path.
 */
export function latestPlanFiles(sessionId: string, epoch: number, repo: string): { plan: string; file: string }[] {
  const dir = plansRepoDir(sessionId, epoch, repo);
  if (!existsSync(dir)) return [];
  const out: { plan: string; file: string }[] = [];
  for (const plan of readdirSync(dir).sort()) {
    const planDir = join(dir, plan);
    let entries: string[];
    try {
      entries = readdirSync(planDir);
    } catch {
      continue; // not a directory
    }
    let max = 0;
    for (const name of entries) {
      const m = /^v(\d+)\.md$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (max > 0) out.push({ plan, file: join(planDir, `v${max}.md`) });
  }
  return out;
}

/**
 * Parse plan filename into { ordinal, rewrite } or null if not a valid plan file.
 * Supports both conventions:
 *   plan-1-1.md → ordinal=1, rewrite=1  (spec convention)
 *   plan-1.md   → ordinal=1, rewrite=1  (legacy flat convention)
 */
function parsePlanFilename(filename: string): { ordinal: number; rewrite: number } | null {
  // Spec convention: plan-{ordinal}-{rewrite}.md
  const suffixed = filename.match(/^plan-(\d+)-(\d+)\.md$/);
  if (suffixed) {
    return {
      ordinal: parseInt(suffixed[1], 10),
      rewrite: parseInt(suffixed[2], 10),
    };
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
