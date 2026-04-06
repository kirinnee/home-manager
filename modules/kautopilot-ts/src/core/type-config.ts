import { join } from 'node:path';
import type { Config } from './types';

/**
 * Prompt variable context — all resolved to absolute paths.
 */
export interface PromptVars {
  ticket: string;
  spec: string;
  specDir: string;
  plans: string;
  worktree: string;
  triage: string;
}

/**
 * Build the prompt variable context for a given session.
 */
export function buildPromptVars(worktree: string, version: number, ticketId: string): PromptVars {
  const vDir = join(worktree, 'spec', ticketId, `v${version}`);
  return {
    ticket: join(worktree, 'spec', ticketId, 'ticket.md'),
    spec: join(vDir, 'task-spec.md'),
    specDir: vDir,
    plans: join(vDir, 'plans'),
    worktree,
    triage: join(vDir, 'triage.md'),
  };
}

/**
 * Replace {variable} placeholders in a prompt string with resolved values.
 */
export function resolvePromptVars(prompt: string, vars: PromptVars): string {
  let result = prompt;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Resolve the timeout for an LLM call.
 * Priority: per-prompt override > config.settings.defaultLlmTimeout
 */
export function resolveTimeout(specific: number | undefined, config: Config): number {
  return specific ?? config.settings.defaultLlmTimeout;
}

/**
 * Resolve the binary for a reviewer or context source.
 * Priority: CLAUDE_BINARY env > first entry in binaries array > config.claude_binary > 'claude'
 */
export function resolveBinary(binaries: string[] | undefined, config: Config): string {
  if (process.env.CLAUDE_BINARY) return process.env.CLAUDE_BINARY;
  if (binaries && binaries.length > 0) return binaries[0];
  return config.claude_binary ?? 'claude';
}
