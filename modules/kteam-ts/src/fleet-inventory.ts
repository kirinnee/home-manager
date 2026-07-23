// Fleet inventory — pure-ish reads for the "New session" UI flow:
//   - listWrappers(): the kfleet account wrappers in ~/.kfleet/bin, marked
//     claude/codex + auto/interactive. kteam only LAUNCHES auto wrappers
//     (see SessionManager.start), so each carries a `launchable` flag.
//   - scanProjects(): git repos under the configured project roots, with a
//     cheap last-activity timestamp, for the project picker + list grouping.
//
// Kept dependency-light and side-effect-free (just fs reads) so it is trivially
// unit-testable against a tmpdir.

import { existsSync, readdirSync } from 'fs';
import { stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { inferHarness, modelHint } from './core';
import type { Harness } from './types';

export interface WrapperInfo {
  /** Wrapper filename, e.g. `claude-auto-loge` — the value POSTed as `agent`. */
  name: string;
  harness: Harness;
  /** `auto` when the wrapper runs the harness in auto mode (`*-auto-*`). */
  mode: 'auto' | 'interactive';
  /** kteam can only start auto-mode wrappers; interactive ones are shown but
   *  not selectable. */
  launchable: boolean;
  /** Friendly model/account hint derived from the wrapper name. */
  modelHint: string;
}

export interface ProjectInfo {
  /** Directory basename — the display name. */
  name: string;
  /** Absolute path — the value used as the session cwd. */
  path: string;
  /** ISO timestamp of the most recent activity signal we can read cheaply. */
  lastActivity?: string;
}

/** Expand a leading `~` (and `$HOME`) to the user's home directory. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p.startsWith('$HOME/')) return path.join(home, p.slice(6));
  return p;
}

/** List claude/codex wrappers from the kfleet bin. crc-* and anything that is
 *  not a recognised harness prefix are skipped. Sorted launchable-first, then
 *  by name. */
export function listWrappers(binDir: string): WrapperInfo[] {
  if (!existsSync(binDir)) return [];
  const out: WrapperInfo[] = [];
  for (const name of readdirSync(binDir)) {
    if (!/^(claude|codex)-/.test(name)) continue; // skip crc-* etc.
    let harness: Harness;
    try {
      harness = inferHarness(name);
    } catch {
      continue;
    }
    const mode = /^(claude|codex)-auto-/.test(name) ? 'auto' : 'interactive';
    out.push({ name, harness, mode, launchable: mode === 'auto', modelHint: modelHint(name) });
  }
  return out.sort((a, b) => {
    if (a.launchable !== b.launchable) return a.launchable ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Cheap last-activity signal for a repo: newest mtime among the working dir
 *  and `.git/HEAD` (commits/checkouts bump HEAD; edits bump the dir). */
async function lastActivity(dir: string): Promise<string | undefined> {
  const stamps: number[] = [];
  const dirStat = await stat(dir).catch(() => undefined);
  if (dirStat) stamps.push(dirStat.mtimeMs);
  const head = await stat(path.join(dir, '.git', 'HEAD')).catch(() => undefined);
  if (head) stamps.push(head.mtimeMs);
  if (!stamps.length) return undefined;
  return new Date(Math.max(...stamps)).toISOString();
}

function isGitRepo(dir: string): boolean {
  try {
    return existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/** Scan the given roots for git repositories, one level deep (plus the root
 *  itself if it is a repo). Returns unique repos sorted most-recently-active
 *  first. Missing roots are skipped. */
export async function scanProjects(roots: string[], home = os.homedir()): Promise<ProjectInfo[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  const consider = (dir: string) => {
    const abs = path.resolve(dir);
    if (seen.has(abs) || !isGitRepo(abs)) return;
    seen.add(abs);
    found.push(abs);
  };
  for (const rawRoot of roots) {
    const root = expandHome(rawRoot, home);
    if (!existsSync(root)) continue;
    consider(root);
    let entries: string[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.config') continue; // skip dotdirs
      consider(path.join(root, entry));
    }
  }
  const projects = await Promise.all(
    found.map(async abs => ({ name: path.basename(abs), path: abs, lastActivity: await lastActivity(abs) })),
  );
  return projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
}
