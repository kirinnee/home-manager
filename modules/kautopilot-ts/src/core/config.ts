import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as YAML from 'yaml';
import type { Config } from './types';
import { DEFAULT_CONFIG } from './types';

function configPath(id: string): string {
  return `${process.env.HOME}/.kautopilot/${id}/config.yaml`;
}

export function readConfig(id: string): Config | null {
  const path = configPath(id);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = YAML.parse(raw) as Partial<Config> | undefined;
  if (!parsed) return DEFAULT_CONFIG;
  // Legacy migration: hoist old settings fields into kloop
  const legacySettings = parsed.settings as Record<string, unknown> | undefined;
  const migratedKloop = { ...(parsed.kloop ?? {}) } as Record<string, unknown>;
  if (legacySettings) {
    if (migratedKloop.maxIterations == null && legacySettings.maxIterations != null)
      migratedKloop.maxIterations = legacySettings.maxIterations;
    if (migratedKloop.implementerTimeout == null && legacySettings.implementerTimeout != null)
      migratedKloop.implementerTimeout = legacySettings.implementerTimeout;
    if (migratedKloop.reviewerTimeout == null && legacySettings.reviewerTimeout != null)
      migratedKloop.reviewerTimeout = legacySettings.reviewerTimeout;
  }

  return {
    claude_binary: parsed.claude_binary ?? DEFAULT_CONFIG.claude_binary,
    agents: {
      init: { ...DEFAULT_CONFIG.agents.init, ...parsed.agents?.init },
      phase2: { ...DEFAULT_CONFIG.agents.phase2, ...parsed.agents?.phase2 },
      phase3: { ...DEFAULT_CONFIG.agents.phase3, ...parsed.agents?.phase3 },
    },
    types: { ...DEFAULT_CONFIG.types, ...parsed.types },
    kloop: { ...DEFAULT_CONFIG.kloop, ...migratedKloop },
    settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
    repo: { ...DEFAULT_CONFIG.repo, ...parsed.repo },
  };
}

export function writeConfig(id: string, config: Config): void {
  const path = configPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(config));
}

// ============================================================================
// Config resolution (init-time)
// ============================================================================

function globalConfigPath(): string {
  return `${process.env.HOME}/.kautopilot/config.yaml`;
}

function orgConfigPath(org: string): string {
  return `${process.env.HOME}/.kautopilot/orgs/${org}/config.yaml`;
}

/**
 * Ensure ~/.kautopilot/config.yaml exists with built-in defaults.
 * Called on first init or org init.
 */
export function ensureGlobalConfig(): void {
  const path = globalConfigPath();
  if (existsSync(path)) return;

  mkdirSync(dirname(path), { recursive: true });
  const header = '# kautopilot global config\n# Edit these to customize agent behavior and binary.\n\n';
  writeFileSync(path, header + YAML.stringify(DEFAULT_CONFIG));
}

/**
 * Pick which config file to use (only one wins, not merged).
 * Priority: --config flag > org config > global config
 */
export function pickConfig(org?: string, configPathOverride?: string): string | null {
  if (configPathOverride) return configPathOverride;
  if (org) {
    const orgPath = orgConfigPath(org);
    if (existsSync(orgPath)) return orgPath;
  }
  return globalConfigPath();
}

/**
 * Resolve final config: merge built-in defaults with the picked config file.
 * One config file wins — no multi-layer merging at init time.
 */
export function resolveConfig(org?: string, configPathOverride?: string): Config {
  const picked = pickConfig(org, configPathOverride);
  if (!picked || !existsSync(picked)) return { ...DEFAULT_CONFIG };

  const raw = readFileSync(picked, 'utf-8');
  const parsed = YAML.parse(raw) as Partial<Config> | undefined;
  if (!parsed) return { ...DEFAULT_CONFIG };

  // Legacy migration: hoist old settings fields into kloop
  const legacySettings = parsed.settings as Record<string, unknown> | undefined;
  const migratedKloop = { ...(parsed.kloop ?? {}) } as Record<string, unknown>;
  if (legacySettings) {
    if (migratedKloop.maxIterations == null && legacySettings.maxIterations != null)
      migratedKloop.maxIterations = legacySettings.maxIterations;
    if (migratedKloop.implementerTimeout == null && legacySettings.implementerTimeout != null)
      migratedKloop.implementerTimeout = legacySettings.implementerTimeout;
    if (migratedKloop.reviewerTimeout == null && legacySettings.reviewerTimeout != null)
      migratedKloop.reviewerTimeout = legacySettings.reviewerTimeout;
  }

  return {
    claude_binary: parsed.claude_binary ?? DEFAULT_CONFIG.claude_binary,
    agents: {
      init: { ...DEFAULT_CONFIG.agents.init, ...parsed.agents?.init },
      phase2: { ...DEFAULT_CONFIG.agents.phase2, ...parsed.agents?.phase2 },
      phase3: { ...DEFAULT_CONFIG.agents.phase3, ...parsed.agents?.phase3 },
    },
    types: { ...DEFAULT_CONFIG.types, ...parsed.types },
    kloop: { ...DEFAULT_CONFIG.kloop, ...migratedKloop },
    settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
    repo: { ...DEFAULT_CONFIG.repo, ...parsed.repo },
  };
}
