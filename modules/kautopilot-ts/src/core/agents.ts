import type { Config } from './types';
import { DEFAULT_CONFIG } from './types';

// ============================================================================
// TTY exit instruction — appended to all TTY agent prompts
// ============================================================================

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
 * Get a resolved agent prompt by phase and name, with variable substitution.
 */
export function getAgentPrompt(phase: string, name: string, vars?: Record<string, string>): string {
  const config = _cachedConfig ?? DEFAULT_CONFIG;
  const phaseAgents = config.agents[phase as keyof typeof config.agents] as
    | Record<string, { prompt: string; binary?: string }>
    | undefined;
  // A known phase with a missing prompt is a configuration/wiring bug — fail loudly
  // instead of silently shipping a useless "Execute <name> task." prompt to an agent.
  if (phaseAgents && !phaseAgents[name]?.prompt) {
    throw new Error(`No agent prompt configured for ${phase}.${name} (known phase, missing prompt).`);
  }
  let content = phaseAgents?.[name]?.prompt ?? `Execute ${name} task.`;

  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
  }

  return content;
}
