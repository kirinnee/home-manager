import { existsSync, readdirSync } from 'node:fs';
import { snapshotPath } from './artifacts';

/**
 * Find the next available snapshot version number for a spec within an epoch.
 * Returns 1 if no snapshots exist yet.
 */
export function findNextSpecVersion(sessionId: string, epochVersion: number): number {
  const artifactDir = snapshotPath(sessionId, epochVersion);
  if (!existsSync(artifactDir)) return 1;
  const files = readdirSync(artifactDir);
  const versions = files
    .filter(f => /^task-spec-(\d+)\.md$/.test(f))
    .map(f => {
      const match = f.match(/^task-spec-(\d+)\.md$/);
      return match ? parseInt(match[1], 10) : 0;
    });
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

/**
 * Find the path to the latest spec snapshot within an epoch.
 * Returns null if no snapshots exist.
 */
export function findLatestSpecPath(sessionId: string, epochVersion: number): string | null {
  const next = findNextSpecVersion(sessionId, epochVersion);
  const current = next - 1;
  if (current === 0) return null;
  return snapshotPath(sessionId, epochVersion, `task-spec-${current}.md`);
}

/**
 * Find the next available snapshot version number for plans within an epoch.
 * Returns 1 if no snapshots exist yet.
 */
export function findNextPlansVersion(sessionId: string, epochVersion: number): number {
  const artifactDir = snapshotPath(sessionId, epochVersion);
  if (!existsSync(artifactDir)) return 1;
  const entries = readdirSync(artifactDir, { withFileTypes: true });
  const versions = entries
    .filter(e => e.isDirectory() && /^plans-(\d+)$/.test(e.name))
    .map(e => {
      const match = e.name.match(/^plans-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

/**
 * Find the path to the latest plans snapshot directory within an epoch.
 * Returns null if no snapshots exist.
 */
export function findLatestPlansPath(sessionId: string, epochVersion: number): string | null {
  const next = findNextPlansVersion(sessionId, epochVersion);
  const current = next - 1;
  if (current === 0) return null;
  return snapshotPath(sessionId, epochVersion, `plans-${current}`);
}
