import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import type { Config } from './types';
import { DEFAULT_CONFIG } from './types';

// ============================================================================
// TTY exit instruction — appended to all TTY agent prompts
// ============================================================================

export function ttyExitInstruction(sessionId: string): string {
  return `\n\n[Session: ${sessionId}]\nWhen you are done, tell the user: "Exit this TTY (type /exit or Ctrl+C) to continue kautopilot."`;
}

/** @deprecated Use ttyExitInstruction(sessionId) instead */
export const TTY_EXIT_INSTRUCTION =
  '\n\nWhen you are done, tell the user: "Exit this TTY (type /exit or Ctrl+C) to continue kautopilot."';

// ============================================================================
// Session agent cache
// ============================================================================

/** Cached session config for the current run */
let _cachedConfig: Config | null = null;

export function setCachedConfig(config: Config | null): void {
  _cachedConfig = config;
}

// ============================================================================
// Agent loading
// ============================================================================

/**
 * Load agent configs from session config.yaml.
 * Call once per phase run before any step handlers execute.
 */
export function loadSessionAgents(sessionId: string): void {
  const path = `${process.env.HOME}/.kautopilot/${sessionId}/config.yaml`;
  if (!existsSync(path)) {
    _cachedConfig = DEFAULT_CONFIG;
    return;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<Config> | undefined;
    if (!parsed) {
      _cachedConfig = DEFAULT_CONFIG;
      return;
    }
    // Merge with defaults — agents are nested by phase
    _cachedConfig = {
      claude_binary: parsed.claude_binary ?? DEFAULT_CONFIG.claude_binary,
      agents: {
        init: { ...DEFAULT_CONFIG.agents.init, ...parsed.agents?.init },
        phase2: { ...DEFAULT_CONFIG.agents.phase2, ...parsed.agents?.phase2 },
        phase3: { ...DEFAULT_CONFIG.agents.phase3, ...parsed.agents?.phase3 },
      },
      types: { ...DEFAULT_CONFIG.types, ...parsed.types },
      kloop: { ...DEFAULT_CONFIG.kloop, ...parsed.kloop },
      settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
      repo: { ...DEFAULT_CONFIG.repo, ...parsed.repo },
    };
  } catch {
    _cachedConfig = DEFAULT_CONFIG;
  }
}

/**
 * Get a resolved agent prompt by phase and name, with variable substitution.
 * Falls back to defaults if cache not initialized.
 */
export function getAgentPrompt(phase: string, name: string, vars?: Record<string, string>): string {
  const config = _cachedConfig ?? DEFAULT_CONFIG;
  const phaseAgents = config.agents[phase as keyof typeof config.agents] as
    | Record<string, { prompt: string; binary?: string }>
    | undefined;
  let content = phaseAgents?.[name]?.prompt ?? `Execute ${name} task.`;

  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
  }

  return content;
}

/**
 * Get the binary for an agent.
 * Priority: env.CLAUDE_BINARY > agent.binary > config.claude_binary > 'claude'
 */
export function getAgentBinary(phase: string, name?: string): string {
  const config = _cachedConfig ?? DEFAULT_CONFIG;
  // CLAUDE_BINARY env var overrides everything
  if (process.env.CLAUDE_BINARY) return process.env.CLAUDE_BINARY;
  if (name) {
    const phaseAgents = config.agents[phase as keyof typeof config.agents] as
      | Record<string, { prompt: string; binary?: string }>
      | undefined;
    return phaseAgents?.[name]?.binary ?? config.claude_binary ?? 'claude';
  }
  return config.claude_binary ?? 'claude';
}

/**
 * Get the default binary (no agent-specific override).
 * Priority: env.CLAUDE_BINARY > config.claude_binary > 'claude'
 */
export function getDefaultBinary(): string {
  const config = _cachedConfig ?? DEFAULT_CONFIG;
  if (process.env.CLAUDE_BINARY) return process.env.CLAUDE_BINARY;
  return config.claude_binary ?? 'claude';
}

/**
 * Get the raw default agents map (for testing/inspection).
 */
export function getDefaultAgents(): Record<string, Record<string, { prompt: string; binary?: string }>> {
  return { ...DEFAULT_CONFIG.agents };
}
