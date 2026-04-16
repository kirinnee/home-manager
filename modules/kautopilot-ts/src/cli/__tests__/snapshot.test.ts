/**
 * Tests for snapshot epoch auto-detection.
 *
 * Exercises the real resolveEpochVersion function exported from snapshot.ts,
 * plus the actual snapshot CLI command path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { sessionDir, snapshotPath } from '../../core/artifacts';
import { readLog } from '../../core/log';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-snapshot-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function worktreePath(sessionId: string) {
  return join(tempHome, `worktree-${sessionId}`);
}

function setupSession(sessionId: string, version: number) {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.yaml'), YAML.stringify({ version, phase: 'implementation', state: 'resolve' }));
}

async function loadSnapshotModule() {
  return import('../snapshot');
}

async function upsertTestSession(sessionId: string, worktree: string, ticketId = 'local') {
  const { upsertSession } = await import('../../core/db');
  const now = new Date().toISOString();
  upsertSession({
    id: sessionId,
    repo_path: worktree,
    worktree,
    git_root: worktree,
    git_root_host: 'github.com/test-org/test-repo',
    ticket_id: ticketId,
    branch: 'feature/test',
    local: 1,
    state: 'ready',
    created_at: now,
    updated_at: now,
  });
}

async function runSnapshotCommand(args: string[]): Promise<string[]> {
  const { createSnapshotCommand } = await loadSnapshotModule();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    output.push(parts.map(String).join(' '));
  };

  try {
    const command = createSnapshotCommand();
    command.exitOverride();
    await command.parseAsync(args, { from: 'user' });
  } finally {
    console.log = originalLog;
  }

  return output;
}

describe('snapshot CLI — auto-detect through command', () => {
  const SESSION = `test-snapshot-cli-${Date.now()}`;

  afterEach(() => {
    const dir = sessionDir(SESSION);
    const worktree = worktreePath(SESSION);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  });

  it('kautopilot snapshot plans auto-detects epoch from status.yaml', async () => {
    const worktree = worktreePath(SESSION);
    setupSession(SESSION, 2);
    await upsertTestSession(SESSION, worktree);

    const plansDir = join(worktree, 'spec', 'local', 'v2', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1.md'), '# Plan 1\nDo the thing.\n');

    const output = await runSnapshotCommand(['plans', '--session', SESSION]);
    const expectedSnapshotDir = snapshotPath(SESSION, 2, 'plans-1');

    expect(output).toContain('EPOCH_VERSION=2');
    expect(output).toContain('SNAPSHOT_VERSION=1');
    expect(output).toContain(`SNAPSHOT_PATH=${expectedSnapshotDir}`);
    expect(existsSync(join(expectedSnapshotDir, 'plan-1.md'))).toBe(true);

    const events = readLog(SESSION);
    const snapshotEvent = events.at(-1);
    expect(snapshotEvent?.event).toBe('snapshot:created');
    expect(snapshotEvent?.metadata?.type).toBe('plans');
    expect(snapshotEvent?.metadata?.epochVersion).toBe(2);
    expect(snapshotEvent?.metadata?.path).toBe(expectedSnapshotDir);
  });

  it('kautopilot snapshot spec auto-detects epoch from status.yaml and persists feedback.md', async () => {
    const worktree = worktreePath(SESSION);
    setupSession(SESSION, 4);
    await upsertTestSession(SESSION, worktree);

    const specDir = join(worktree, 'spec', 'local', 'v4');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'task-spec.md'), '# Task Spec\n');
    writeFileSync(join(specDir, 'feedback.md'), 'Need to revisit the spec.\n');

    const output = await runSnapshotCommand(['spec', '--session', SESSION]);
    const expectedSpecPath = snapshotPath(SESSION, 4, 'task-spec-1.md');
    const expectedFeedbackPath = snapshotPath(SESSION, 4, 'feedback.md');

    expect(output).toContain('EPOCH_VERSION=4');
    expect(output).toContain('SNAPSHOT_VERSION=1');
    expect(output).toContain(`SNAPSHOT_PATH=${expectedSpecPath}`);
    expect(existsSync(expectedSpecPath)).toBe(true);
    expect(existsSync(expectedFeedbackPath)).toBe(true);
    expect(readFileSync(expectedFeedbackPath, 'utf-8')).toBe('Need to revisit the spec.\n');

    const events = readLog(SESSION);
    const snapshotEvent = events.at(-1);
    expect(snapshotEvent?.event).toBe('snapshot:created');
    expect(snapshotEvent?.metadata?.type).toBe('spec');
    expect(snapshotEvent?.metadata?.epochVersion).toBe(4);
    expect(snapshotEvent?.metadata?.path).toBe(expectedSpecPath);
  });
});

describe('snapshot CLI — backward compat with explicit epoch', () => {
  const SESSION = `test-snapshot-backward-compat-${Date.now()}`;

  afterEach(() => {
    const dir = sessionDir(SESSION);
    const worktree = worktreePath(SESSION);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  });

  it('kautopilot snapshot plans 2 still works with explicit epoch', async () => {
    const worktree = worktreePath(SESSION);
    setupSession(SESSION, 1);
    await upsertTestSession(SESSION, worktree);

    const plansDir = join(worktree, 'spec', 'local', 'v2', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1.md'), '# Plan 1\nExplicit epoch.\n');

    const output = await runSnapshotCommand(['plans', '2', '--session', SESSION]);
    const expectedSnapshotDir = snapshotPath(SESSION, 2, 'plans-1');

    expect(output).not.toContain('EPOCH_VERSION=1');
    expect(output).not.toContain('EPOCH_VERSION=2');
    expect(output).toContain('SNAPSHOT_VERSION=1');
    expect(output).toContain(`SNAPSHOT_PATH=${expectedSnapshotDir}`);
    expect(existsSync(join(expectedSnapshotDir, 'plan-1.md'))).toBe(true);

    const events = readLog(SESSION);
    const snapshotEvent = events.at(-1);
    expect(snapshotEvent?.metadata?.epochVersion).toBe(2);
  });
});
