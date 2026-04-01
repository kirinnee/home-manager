import { spawn } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinner } from '@clack/prompts';
import type { Config } from './types';
import { debugLog } from '../llm/spawn';
import { sessionDir } from './artifacts';

// In-memory cache: binary path → config dir
const cache = new Map<string, string>();

const CACHE_FILE = 'binary-config-dirs.json';

/**
 * Load persisted binary config dirs from disk into the in-memory cache.
 * Returns true if cache was loaded (probing can be skipped).
 */
export function loadPersistedConfigDirs(id: string): boolean {
  const path = join(sessionDir(id), CACHE_FILE);
  if (!existsSync(path)) return false;

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
    for (const [binary, dir] of Object.entries(data)) {
      cache.set(binary, dir);
    }
    debugLog(`[config-dir] Loaded ${Object.keys(data).length} cached dirs from ${path}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the selected cache entries to disk.
 */
function persistConfigDirs(id: string, binaries: Iterable<string>): void {
  const path = join(sessionDir(id), CACHE_FILE);
  const data: Record<string, string> = {};
  let count = 0;
  for (const binary of binaries) {
    const dir = cache.get(binary);
    if (!dir) continue;
    data[binary] = dir;
    count++;
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
  debugLog(`[config-dir] Persisted ${count} dirs to ${path}`);
}

/**
 * Probe a Claude binary to discover its CLAUDE_CONFIG_DIR.
 * Spawns: `{binary} --print --dangerously-skip-permissions 'Run: echo $CLAUDE_CONFIG_DIR. Output ONLY the path.'`
 */
export async function probeConfigDir(binary: string): Promise<string> {
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
export async function discoverConfigDirs(config: Config, sessionId?: string): Promise<Record<string, string>> {
  // Collect all unique binary paths
  const binaries = new Set<string>();
  const defaultBin = process.env.CLAUDE_BINARY ?? config.claude_binary ?? 'claude';
  binaries.add(defaultBin);

  for (const phase of Object.values(config.agents)) {
    for (const agent of Object.values(phase)) {
      if (agent.binary) binaries.add(agent.binary);
    }
  }

  // Also check type-level binaries (reviewers)
  for (const typeConfig of Object.values(config.types)) {
    for (const reviewer of Object.values(typeConfig.spec_reviewers)) {
      if (reviewer.binaries) {
        for (const b of reviewer.binaries) binaries.add(b);
      }
    }
    for (const reviewer of Object.values(typeConfig.plan_reviewers)) {
      if (reviewer.binaries) {
        for (const b of reviewer.binaries) binaries.add(b);
      }
    }
  }

  if (sessionId) {
    loadPersistedConfigDirs(sessionId);
  }

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

  // Persist for next time
  if (sessionId) {
    persistConfigDirs(sessionId, binaries);
  }

  return result;
}

/**
 * Get the cached config dir for a binary. Returns null if not probed yet.
 */
export function getConfigDir(binary: string): string | null {
  return cache.get(binary) ?? null;
}
