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
import type { Harness, RuntimeModelOption } from './types';

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
  /** Account-safe values accepted by Claude Code's native `/model` command.
   *  Codex deliberately omits this: its native picker discovers the live
   *  account catalog and supported effort levels itself. */
  runtimeModels?: RuntimeModelOption[];
}

const ANTHROPIC_RUNTIME_MODELS: RuntimeModelOption[] = [
  { value: 'fable', label: 'Fable 5 · 1M' },
  { value: 'opus', label: 'Opus 5 · 1M' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

const LOGE_RUNTIME_MODELS: RuntimeModelOption[] = [
  { value: 'claude-fable-5[1m]', label: 'Fable 5 · 1M' },
  { value: 'claude-opus-5[1m]', label: 'Opus 5 · 1M' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

const GLM_RUNTIME_MODELS: RuntimeModelOption[] = [
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'glm-5-turbo', label: 'GLM-5 Turbo' },
  { value: 'glm-4.7', label: 'GLM-4.7' },
];

const DEEPSEEK_RUNTIME_MODELS: RuntimeModelOption[] = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

/** Account-aware Claude `/model` allowlist. Keep this aligned with the
 * generated-wrapper mappings in kfleet/config.yaml. Returning no choices is an
 * explicit unsupported verdict: callers must not guess an Anthropic id. */
export function runtimeModelsForWrapper(binary: string): RuntimeModelOption[] {
  const name = path.basename(binary);
  let models: RuntimeModelOption[] | undefined;
  if (/^claude-auto-(kirin|liftoff|atomi)$/.test(name)) models = ANTHROPIC_RUNTIME_MODELS;
  else if (name === 'claude-auto-loge') models = LOGE_RUNTIME_MODELS;
  else if (/^claude-auto-glm52[ab]$/.test(name)) models = GLM_RUNTIME_MODELS;
  else if (name === 'claude-auto-mm3') models = [{ value: 'MiniMax-M3', label: 'MiniMax M3' }];
  else if (/^claude-auto-dsv4[fp]$/.test(name)) models = DEEPSEEK_RUNTIME_MODELS;
  return models?.map(model => ({ ...model })) ?? [];
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
    const runtimeModels = harness === 'claude' ? runtimeModelsForWrapper(name) : [];
    out.push({
      name,
      harness,
      mode,
      launchable: mode === 'auto',
      modelHint: modelHint(name),
      // Present (even when empty) on every Claude wrapper in the current API.
      // The browser uses ABSENCE to recognize an older daemon whose wrappers
      // payload predates runtime controls and asks for a restart instead of
      // misreporting "this account has no choices".
      ...(harness === 'claude' ? { runtimeModels } : {}),
    });
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
