import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RunScope = { kind: 'session' | 'init'; id: string };

export function artifactPath(id: string, version: number, phase: string, ...segments: string[]): string {
  return `${process.env.HOME}/.kautopilot/${id}/artifacts/v${version}/${phase}/${segments.join('/')}`;
}

/**
 * Flat snapshot path — used for the frozen artifact snapshot before implementation.
 * e.g. snapshotPath('abc', 1, 'ticket.md') → ~/.kautopilot/abc/artifacts/v1/ticket.md
 * e.g. snapshotPath('abc', 1, 'plans', 'plan-1.md') → ~/.kautopilot/abc/artifacts/v1/plans/plan-1.md
 */
export function snapshotPath(id: string, version: number, ...segments: string[]): string {
  return `${process.env.HOME}/.kautopilot/${id}/artifacts/v${version}/${segments.join('/')}`;
}

/**
 * Version-agnostic artifact path — for files that don't change between versions (e.g. ticket.md).
 * e.g. sessionArtifactPath('abc', 'ticket.md') → ~/.kautopilot/abc/artifacts/ticket.md
 */
export function sessionArtifactPath(id: string, ...segments: string[]): string {
  return `${process.env.HOME}/.kautopilot/${id}/artifacts/${segments.join('/')}`;
}

export function ensureArtifactDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function sessionDir(id: string): string {
  return `${process.env.HOME}/.kautopilot/${id}`;
}

/**
 * Init attempt directory — separate from runtime sessions.
 * e.g. initDir('abc12345') → ~/.kautopilot/init/abc12345
 */
export function initDir(id: string): string {
  return `${process.env.HOME}/.kautopilot/init/${id}`;
}

export function scopeDir(scope: RunScope): string {
  return scope.kind === 'init' ? initDir(scope.id) : sessionDir(scope.id);
}

export function runsDir(scope: RunScope): string {
  return join(scopeDir(scope), 'runs');
}

export function nextRunNumber(scope: RunScope): number {
  const dir = runsDir(scope);
  mkdirSync(dir, { recursive: true });
  const numbers = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => Number(entry.name));
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

export function runDir(scope: RunScope, runNumber: number): string {
  return join(runsDir(scope), String(runNumber));
}

export function runFilePath(
  scope: RunScope,
  runNumber: number,
  fileName: 'context' | 'logs' | 'command' | 'prompt.md' | 'output.json',
): string {
  return join(runDir(scope, runNumber), fileName);
}
