import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
