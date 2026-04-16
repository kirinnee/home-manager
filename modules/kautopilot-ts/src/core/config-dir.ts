import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spinner } from '@clack/prompts';
import { spawn } from 'bun';
import { debugLog } from '../llm/spawn';
import type { Config } from './types';

// In-memory cache: binary path → config dir
const cache = new Map<string, string>();

const GLOBAL_CACHE_FILE = join(process.env.HOME ?? '', '.kautopilot', 'binary-config-dirs.json');

/**
 * Load persisted binary config dirs from the global cache into memory.
 * Returns true if cache was loaded (probing can be skipped).
 */
function loadPersistedConfigDirs(): boolean {
  if (!existsSync(GLOBAL_CACHE_FILE)) return false;

  try {
    const data = JSON.parse(readFileSync(GLOBAL_CACHE_FILE, 'utf-8')) as Record<string, string>;
    for (const [binary, dir] of Object.entries(data)) {
      cache.set(binary, dir);
    }
    debugLog(`[config-dir] Loaded ${Object.keys(data).length} cached dirs from ${GLOBAL_CACHE_FILE}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist cache entries to the global cache file.
 */
function persistConfigDirs(binaries: Iterable<string>): void {
  // Merge with existing file to avoid clobbering entries from other sessions
  let existing: Record<string, string> = {};
  if (existsSync(GLOBAL_CACHE_FILE)) {
    try {
      existing = JSON.parse(readFileSync(GLOBAL_CACHE_FILE, 'utf-8')) as Record<string, string>;
    } catch {
      /* ignore */
    }
  }

  for (const binary of binaries) {
    const dir = cache.get(binary);
    if (dir) existing[binary] = dir;
  }

  mkdirSync(dirname(GLOBAL_CACHE_FILE), { recursive: true });
  writeFileSync(GLOBAL_CACHE_FILE, JSON.stringify(existing, null, 2));
  debugLog(`[config-dir] Persisted ${Object.keys(existing).length} dirs to ${GLOBAL_CACHE_FILE}`);
}

/**
 * Probe a Claude binary to discover its CLAUDE_CONFIG_DIR.
 * Spawns: `{binary} --print --dangerously-skip-permissions 'Run: echo $CLAUDE_CONFIG_DIR. Output ONLY the path.'`
 */
async function probeConfigDir(binary: string): Promise<string> {
  const cached = cache.get(binary);
  if (cached) return cached;

  const prompt = 'Run: echo $CLAUDE_CONFIG_DIR. Output ONLY the path, nothing else.';
  const proc = spawn({
    cmd: [binary, '--print', '--dangerously-skip-permissions', prompt],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutMs = 30_000;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Probing ${binary} for CLAUDE_CONFIG_DIR timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs),
  );

  const [stdout, stderr] = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
    timeout,
  ]);

  if (stderr.trim()) {
    debugLog(`[config-dir] ${binary} stderr: ${stderr.trim()}`);
  }

  // Strip markdown code fences, backticks, whitespace
  const raw = stdout
    .replace(/^```[^\n]*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .replace(/`/g, '')
    .trim();

  // Validate — should be an absolute path
  const configDir = raw.startsWith('/') ? raw : `${process.env.HOME}/.claude`;
  cache.set(binary, configDir);
  debugLog(`[config-dir] ${binary} → ${configDir}`);
  return configDir;
}

/**
 * Discover config dirs for all unique binaries in the config.
 * Loads from persisted cache if available (instant). Otherwise probes in parallel
 * with a spinner and persists the results for next time.
 */
export async function discoverConfigDirs(config: Config): Promise<Record<string, string>> {
  // Collect all unique binary paths
  const binaries = new Set<string>();
  const defaultBin = process.env.CLAUDE_BINARY ?? config.claude_binary ?? 'claude';
  binaries.add(defaultBin);

  // Collect binaries from agent configs
  const agentEntries: Array<{ binary?: string }> = [
    config.agents.phase1.triage,
    config.agents.phase1.spec_writer,
    config.agents.phase1.plan_writer,
    ...Object.values(config.agents.init),
    ...Object.values(config.agents.phase2),
    ...Object.values(config.agents.phase3),
  ];
  for (const agent of agentEntries) {
    if (agent.binary) binaries.add(agent.binary);
  }

  // Check reviewer-level binaries
  if (config.agents.phase1.spec_reviewers) {
    for (const reviewer of Object.values(config.agents.phase1.spec_reviewers)) {
      if (reviewer.binaries) {
        for (const b of reviewer.binaries) binaries.add(b);
      }
    }
  }
  if (config.agents.phase1.plan_reviewers) {
    for (const reviewer of Object.values(config.agents.phase1.plan_reviewers)) {
      if (reviewer.binaries) {
        for (const b of reviewer.binaries) binaries.add(b);
      }
    }
  }

  loadPersistedConfigDirs();

  const missingBinaries = [...binaries].filter(binary => !cache.has(binary));

  if (missingBinaries.length > 0) {
    const s = process.stdout.isTTY ? spinner() : null;
    s?.start('Probing binaries');

    await Promise.all(
      missingBinaries.map(async binary => {
        try {
          await probeConfigDir(binary);
        } catch (err) {
          const fallback = `${process.env.HOME}/.claude`;
          cache.set(binary, fallback);
          debugLog(`[config-dir] Failed to probe ${binary}:`, err);
        }
      }),
    );

    s?.stop('Probing binaries');
  }

  const result: Record<string, string> = {};
  for (const binary of binaries) {
    result[binary] = cache.get(binary) ?? `${process.env.HOME}/.claude`;
  }

  // Persist globally for future sessions
  if (missingBinaries.length > 0) {
    persistConfigDirs(binaries);
  }

  return result;
}

/**
 * Get the cached config dir for a binary. Returns null if not probed yet.
 */
export function getConfigDir(binary: string): string | null {
  return cache.get(binary) ?? null;
}
