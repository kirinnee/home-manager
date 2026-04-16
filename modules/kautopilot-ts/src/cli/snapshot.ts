import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import * as YAML from 'yaml';
import { findNextPlansVersion, findNextSpecVersion } from '../core/artifact-versioning';
import { ensureArtifactDir, sessionDir, snapshotPath } from '../core/artifacts';
import { getSessionById, getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { appendEvent } from '../core/log';

/**
 * Resolve session ID from: --session flag > KAUTOPILOT_SESSION env > walk-up status.yaml > getSessionByWorktree
 */
function resolveSessionId(explicitSession?: string): string {
  // 1. Explicit flag
  if (explicitSession) return explicitSession;

  // 2. Environment variable
  const envSession = process.env.KAUTOPILOT_SESSION;
  if (envSession) return envSession;

  // 3. Walk up from cwd to find status.yaml in ~/.kautopilot/<sessionId>/
  // This handles the case where cwd is inside ~/.kautopilot/<sessionId>/
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    const statusPath = join(dir, 'status.yaml');
    if (existsSync(statusPath)) {
      // Found status.yaml in a session directory
      // Session dir is ~/.kautopilot/<sessionId>/
      const kautopilotIdx = dir.indexOf('.kautopilot');
      if (kautopilotIdx !== -1) {
        const sessionId = dir.slice(kautopilotIdx + '.kautopilot/'.length).split('/')[0];
        if (sessionId) return sessionId;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4. Fall back to getSessionByWorktree - look up session from DB by worktree
  try {
    const repoPath = getGitRoot();
    const worktree = getWorktree();
    const session = getSessionByWorktree(repoPath, worktree);
    if (session) return session.id;
  } catch {
    // Not in a git repo or no session found
  }

  throw new Error(
    'Could not resolve session. Use --session <id>, set KAUTOPILOT_SESSION, or run from within a worktree with an active session.',
  );
}

/**
 * Find the repo working copy path for the spec.
 * Pattern: spec/<ticket-id>/v<N>/task-spec.md
 */
function findRepoSpecPath(sessionId: string, epochVersion: number): string | null {
  const session = getSessionById(sessionId);
  const worktree = session?.worktree;
  if (!worktree) return null;

  // Get ticket ID from DB (primary source), then fall back to status.yaml
  let ticketId = session?.ticket_id || null;
  if (!ticketId) {
    const statusPath = join(sessionDir(sessionId), 'status.yaml');
    if (existsSync(statusPath)) {
      const content = readFileSync(statusPath, 'utf-8');
      const parsed = YAML.parse(content);
      ticketId = parsed?.context?.ticketId || parsed?.ticketId || null;
    }
  }
  ticketId = ticketId || 'local';

  // Check common path
  const specPath = join(worktree, 'spec', ticketId, `v${epochVersion}`, 'task-spec.md');
  if (existsSync(specPath)) return specPath;

  // Try "local" as fallback
  if (ticketId !== 'local') {
    const localSpecPath = join(worktree, 'spec', 'local', `v${epochVersion}`, 'task-spec.md');
    if (existsSync(localSpecPath)) return localSpecPath;
  }

  return null;
}

/**
 * Find the repo working copy path for plans.
 * Pattern: spec/<ticket-id>/v<N>/plans/
 */
function findRepoPlansPath(sessionId: string, epochVersion: number): string | null {
  const session = getSessionById(sessionId);
  const worktree = session?.worktree;
  if (!worktree) return null;

  // Get ticket ID from DB (primary source), then fall back to status.yaml
  let ticketId = session?.ticket_id || null;
  if (!ticketId) {
    const statusPath = join(sessionDir(sessionId), 'status.yaml');
    if (existsSync(statusPath)) {
      const content = readFileSync(statusPath, 'utf-8');
      const parsed = YAML.parse(content);
      ticketId = parsed?.context?.ticketId || parsed?.ticketId || null;
    }
  }
  ticketId = ticketId || 'local';

  const plansPath = join(worktree, 'spec', ticketId, `v${epochVersion}`, 'plans');
  if (existsSync(plansPath)) return plansPath;

  if (ticketId !== 'local') {
    const localPlansPath = join(worktree, 'spec', 'local', `v${epochVersion}`, 'plans');
    if (existsSync(localPlansPath)) return localPlansPath;
  }

  return null;
}

/**
 * Copy a directory recursively.
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Resolve epoch version: explicit argument > session status.yaml > error.
 */
function resolveEpochVersion(sessionId: string, explicitVersion?: number): number {
  if (explicitVersion !== undefined) return explicitVersion;

  const statusPath = join(sessionDir(sessionId), 'status.yaml');
  if (existsSync(statusPath)) {
    const raw = readFileSync(statusPath, 'utf-8');
    const parsed = YAML.parse(raw);
    if (parsed?.version && typeof parsed.version === 'number') {
      console.log(`EPOCH_VERSION=${parsed.version}`);
      return parsed.version;
    }
  }

  throw new Error('Could not auto-detect epoch version. Specify it explicitly: kautopilot snapshot <type> <version>');
}

function handleSnapshot(type: 'spec' | 'plans', epochVersion: number | undefined, sessionId?: string): void {
  const id = resolveSessionId(sessionId);
  const resolvedVersion = resolveEpochVersion(id, epochVersion);

  // Ensure artifact directory exists
  const artifactDir = snapshotPath(id, resolvedVersion);
  mkdirSync(artifactDir, { recursive: true });

  if (type === 'spec') {
    // Find repo working copy
    const repoSpecPath = findRepoSpecPath(id, resolvedVersion);
    if (!repoSpecPath || !existsSync(repoSpecPath)) {
      throw new Error(
        `No working copy spec found. Expected at spec/<ticket>/v${resolvedVersion}/task-spec.md in worktree.`,
      );
    }

    // Find next version
    const snapshotVersion = findNextSpecVersion(id, resolvedVersion);
    const destPath = snapshotPath(id, resolvedVersion, `task-spec-${snapshotVersion}.md`);
    ensureArtifactDir(destPath);
    copyFileSync(repoSpecPath, destPath);

    // If feedback.md exists alongside task-spec.md, persist it as the current epoch feedback artifact.
    const repoFeedbackPath = join(dirname(repoSpecPath), 'feedback.md');
    if (existsSync(repoFeedbackPath)) {
      const feedbackDestPath = snapshotPath(id, resolvedVersion, 'feedback.md');
      ensureArtifactDir(feedbackDestPath);
      copyFileSync(repoFeedbackPath, feedbackDestPath);
    }

    // Log event
    appendEvent(id, {
      ts: new Date().toISOString(),
      event: 'snapshot:created',
      metadata: {
        type: 'spec',
        epochVersion: resolvedVersion,
        snapshotVersion,
        path: destPath,
      },
    });

    // Output for LLM consumption
    console.log(`SNAPSHOT_VERSION=${snapshotVersion}`);
    console.log(`SNAPSHOT_PATH=${destPath}`);
  } else {
    // Plans snapshot
    const repoPlansPath = findRepoPlansPath(id, resolvedVersion);
    if (!repoPlansPath || !existsSync(repoPlansPath)) {
      throw new Error(`No working copy plans found. Expected at spec/<ticket>/v${resolvedVersion}/plans/ in worktree.`);
    }

    // Find next version
    const snapshotVersion = findNextPlansVersion(id, resolvedVersion);
    const destDir = snapshotPath(id, resolvedVersion, `plans-${snapshotVersion}`);
    copyDirRecursive(repoPlansPath, destDir);

    // Log event
    appendEvent(id, {
      ts: new Date().toISOString(),
      event: 'snapshot:created',
      metadata: {
        type: 'plans',
        epochVersion: resolvedVersion,
        snapshotVersion,
        path: destDir,
      },
    });

    // Output for LLM consumption
    console.log(`SNAPSHOT_VERSION=${snapshotVersion}`);
    console.log(`SNAPSHOT_PATH=${destDir}`);
  }
}

export function createSnapshotCommand(): Command {
  return new Command('snapshot')
    .description('Create a versioned snapshot of working copies')
    .argument('<type>', 'Artifact type: spec or plans')
    .argument('[epoch-version]', 'Epoch version number (auto-detected if omitted)', v => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) {
        throw new Error('Epoch version must be a positive integer');
      }
      return n;
    })
    .option('--session <id>', 'Session ID (or set KAUTOPILOT_SESSION)')
    .action((type: string, epochVersion: number | undefined, opts: { session?: string }) => {
      if (type !== 'spec' && type !== 'plans') {
        console.error(`Invalid type: ${type}. Must be 'spec' or 'plans'.`);
        process.exit(1);
      }
      handleSnapshot(type, epochVersion, opts.session);
    });
}
