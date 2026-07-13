// Cross-account session sharing. Each kind gets ONE pool (~/.kfleet/shared/<kind>)
// holding the session-state entries listed in its KindSpec.sharedState; every
// account's copy of those entries is migrated into the pool and replaced with a
// symlink, so any account can `--resume` any session. Identity (.claude.json,
// auth.json, settings, sqlite state) is never touched — it stays per-account.
//
// Migration is rename-based (same volume), so live sessions keep their inodes and
// keep appending through the new symlink. Idempotent: an entry already linked at
// the pool is left alone. On path collisions between two accounts the newer file
// wins; the loser is preserved under <pool>/.migration-conflicts/<account>/.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { sharedDir } from '../deps';
import { KIND_SPECS, type SharedEntry } from './kinds';
import type { Kind } from './types';

export interface SharedResult {
  /** entries/files moved into the pool this run (0 when already migrated) */
  migrated: number;
  /** path collisions resolved (loser kept under .migration-conflicts/) */
  conflicts: number;
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** Make sure the pool-side target exists so symlinks never dangle. */
function ensurePoolEntry(entry: SharedEntry, poolPath: string): void {
  if (entry.type === 'dir') {
    mkdirSync(poolPath, { recursive: true });
  } else {
    mkdirSync(path.dirname(poolPath), { recursive: true });
    if (!existsSync(poolPath)) writeFileSync(poolPath, '');
  }
}

/** Recursively move `src` into `dst`. Existing pool paths win or lose by mtime;
 *  the loser lands at <conflictDir>/<rel>. `src` is consumed (removed). */
function mergeDirInto(src: string, dst: string, conflictDir: string, rel: string, out: SharedResult): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const existing = lstatOrNull(d);
    if (!existing) {
      renameSync(s, d);
      out.migrated++;
      continue;
    }
    if (entry.isDirectory() && existing.isDirectory()) {
      mergeDirInto(s, d, conflictDir, path.join(rel, entry.name), out);
      continue;
    }
    // Same path in both trees (file/symlink/type mismatch): newer mtime wins,
    // loser is preserved under .migration-conflicts/ rather than deleted.
    const loser = path.join(conflictDir, rel, entry.name);
    mkdirSync(path.dirname(loser), { recursive: true });
    rmSync(loser, { recursive: true, force: true }); // re-runs: keep latest loser only
    if (lstatSync(s).mtimeMs > existing.mtimeMs) {
      renameSync(d, loser);
      renameSync(s, d);
    } else {
      renameSync(s, loser);
    }
    out.conflicts++;
  }
  rmSync(src, { recursive: true, force: true }); // empty now (all children renamed out)
}

/** Merge two JSONL files: union of lines, deduped, ordered by their
 *  `timestamp`/`ts` field when present (claude/codex prompt history). */
function mergeJsonlInto(poolFile: string, srcFile: string): void {
  const lines = new Set<string>();
  for (const f of [poolFile, srcFile]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').split('\n')) if (l.trim()) lines.add(l);
  }
  const keyed = [...lines].map(l => {
    let t = Number.POSITIVE_INFINITY; // unparseable lines sink to the end, order preserved
    try {
      const o = JSON.parse(l) as { timestamp?: unknown; ts?: unknown };
      const k = o.timestamp ?? o.ts;
      if (typeof k === 'number') t = k;
    } catch {}
    return { l, t };
  });
  keyed.sort((a, b) => a.t - b.t); // stable: equal/missing keys keep insertion order
  const tmp = `${poolFile}.kfleet-merge`;
  writeFileSync(tmp, `${keyed.map(e => e.l).join('\n')}\n`);
  renameSync(tmp, poolFile);
}

/** Migrate one account's shared-state entries into the kind pool and symlink
 *  them back. Safe to run repeatedly and while sessions are live. */
export function materializeSharedHistory(kind: Kind, configDir: string, poolRoot = sharedDir): SharedResult {
  const pool = path.join(poolRoot, kind);
  const account = path.basename(configDir);
  const out: SharedResult = { migrated: 0, conflicts: 0 };

  for (const entry of KIND_SPECS[kind].sharedState) {
    const poolPath = path.join(pool, entry.name);
    const dest = path.join(configDir, entry.name);
    const st = lstatOrNull(dest);

    if (st?.isSymbolicLink()) {
      if (readlinkSync(dest) === poolPath) {
        ensurePoolEntry(entry, poolPath); // already migrated — just heal a missing target
        continue;
      }
      rmSync(dest); // stale/foreign link — replace with the pool link
    } else if (st) {
      if (!lstatOrNull(poolPath)) {
        // First account to bring this entry: adopt it wholesale (atomic rename).
        mkdirSync(path.dirname(poolPath), { recursive: true });
        renameSync(dest, poolPath);
        out.migrated++;
      } else if (entry.type === 'dir') {
        mergeDirInto(dest, poolPath, path.join(pool, '.migration-conflicts', account), entry.name, out);
      } else {
        mergeJsonlInto(poolPath, dest);
        rmSync(dest);
        out.migrated++;
      }
    }

    ensurePoolEntry(entry, poolPath);
    mkdirSync(configDir, { recursive: true });
    symlinkSync(poolPath, dest);
  }
  return out;
}
