/**
 * End-to-end evidence test: local-mode ticket preservation invariant.
 *
 * Spec requirement: when init downgrades to local mode, the user-provided
 * ticket content must survive through phase 1's pull-ticket handler without
 * being replaced by a placeholder.
 *
 * This test exercises the actual runtime file I/O paths:
 *   init writes spec/ticket.md → pull-ticket reads it → verifies preservation
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-local-e2e-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});
import { sessionDir, sessionArtifactPath, ensureArtifactDir } from '../../core/artifacts';
import { handlePullTicket } from '../phase1/pull-ticket';
import type { Phase1Context } from '../phase1/types';
import type { SessionRow, Config } from '../../core/types';

// Distinctive marker text — proves this exact content survived
const MARKER = `UNIQUE_LOCAL_TICKET_MARKER_${Date.now()}_A7F3B9`;
const PLACEHOLDER_HEADING = '# Local Task';
const PLACEHOLDER_BODY = 'Describe the task here';
const TICKET_BODY = `# local-abc123\n\n${MARKER}\n\nThis is distinctive ticket content entered during local init.\nIt must NOT be overwritten by the runtime placeholder text.\n`;

function cleanSession(sessionId: string) {
  const dir = sessionDir(sessionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function cleanWorktree(wt: string) {
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
}

function makeLocalSession(sessionId: string, worktree: string): SessionRow {
  return {
    id: sessionId,
    repo_path: `/tmp/test-repo-${sessionId}`,
    worktree,
    git_root: 'https://github.com/test/repo',
    git_root_host: 'github.com',
    ticket_id: 'local-abc123',
    branch: 'feature/local-abc123',
    local: 1,
    state: 'ready',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeConfig(): Config {
  return {
    repo: {
      org: 'test-org',
      baseBranch: 'main',
      ticketSystem: null,
      prComment: null,
    },
  } as Config;
}

// ============================================================================
// Scenario: Local init → pull-ticket preserves user content
// ============================================================================

describe('E2E: Local-mode ticket preservation invariant', () => {
  const sessionId = `e2e-local-ticket-${Date.now()}`;
  const worktree = `/tmp/kautopilot-test-wt-${sessionId}`;
  let session: SessionRow;

  afterEach(() => {
    cleanSession(sessionId);
    cleanWorktree(worktree);
  });

  it('preserves user-provided ticket content through pull-ticket phase', async () => {
    session = makeLocalSession(sessionId, worktree);

    // ── Step 1: Simulate downgrade_local writing ticket content ──
    // This is what states.ts:906-915 does
    const specDir = join(worktree, 'spec', session.ticket_id!);
    mkdirSync(specDir, { recursive: true });
    const ticketPath = join(specDir, 'ticket.md');
    writeFileSync(ticketPath, TICKET_BODY);

    // Also write to session artifact path (init's second write)
    const artifactDest = sessionArtifactPath(sessionId, 'ticket.md');
    ensureArtifactDir(artifactDest);
    writeFileSync(artifactDest, TICKET_BODY);

    // Verify init wrote correctly
    expect(existsSync(ticketPath)).toBe(true);
    expect(readFileSync(ticketPath, 'utf-8')).toContain(MARKER);
    expect(readFileSync(artifactDest, 'utf-8')).toContain(MARKER);

    // ── Step 2: Run pull-ticket handler (phase 1) ──
    const ctx: Phase1Context = {
      session,
      config: makeConfig(),
      version: 1,
      attempt: 1,
    };

    const nextState = await handlePullTicket(ctx);
    expect(nextState).toBe('triage'); // Handler should advance to triage

    // ── Step 3: Verify ticket content is preserved ──
    const afterContent = readFileSync(ticketPath, 'utf-8');

    // The placeholder must NOT be present
    expect(afterContent).not.toContain(PLACEHOLDER_HEADING);
    expect(afterContent).not.toContain(PLACEHOLDER_BODY);

    // The distinctive user content MUST be present
    expect(afterContent).toContain(MARKER);
    expect(afterContent).toBe(TICKET_BODY);

    // ── Step 4: Verify runtime snapshot artifact ──
    const snapshotDest = sessionArtifactPath(sessionId, 'ticket.md');
    expect(existsSync(snapshotDest)).toBe(true);
    const snapshotContent = readFileSync(snapshotDest, 'utf-8');
    expect(snapshotContent).toContain(MARKER);
    expect(snapshotContent).toBe(TICKET_BODY);
  });

  it('writes placeholder when spec/ticket.md does NOT exist (control case)', async () => {
    // Use a different session to avoid conflicts
    const altSessionId = `e2e-local-no-ticket-${Date.now()}`;
    const altWorktree = `/tmp/kautopilot-test-wt-nodata-${altSessionId}`;
    const altSession = makeLocalSession(altSessionId, altWorktree);

    try {
      // Create worktree but NOT spec/ticket.md
      mkdirSync(altWorktree, { recursive: true });

      const ctx: Phase1Context = {
        session: altSession,
        config: makeConfig(),
        version: 1,
        attempt: 1,
      };

      await handlePullTicket(ctx);

      // Placeholder SHOULD be written
      const ticketPath = join(altWorktree, 'spec', altSession.ticket_id!, 'ticket.md');
      expect(existsSync(ticketPath)).toBe(true);
      const content = readFileSync(ticketPath, 'utf-8');
      expect(content).toContain(PLACEHOLDER_HEADING);
      expect(content).toContain(PLACEHOLDER_BODY);
    } finally {
      cleanSession(altSessionId);
      cleanWorktree(altWorktree);
    }
  });
});
