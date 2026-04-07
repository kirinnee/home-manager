/**
 * End-to-end evidence test: detect state reads research.json artifacts correctly.
 *
 * Validates that the detect state handler:
 * 1. Reads detectedTools from research.json without crashing (regression for Object.keys(undefined))
 * 2. Handles missing detectedTools gracefully (defensive null coalescing)
 * 3. Produces valid detection.json artifact
 * 4. Emits detect:started and detect:completed WAL events
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('E2E: detect state reads research.json correctly', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-detect-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detect state handles research.json with detectedTools present', async () => {
    const { detect } = require('../init/states') as typeof import('../init/states');
    const { readInitLog } = require('../../core/log') as typeof import('../../core/log');

    const initId = 'detect-test-with-tools';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    // Write research.json WITH detectedTools (the fix)
    const researchData = {
      systemName: 'GitHub Issues',
      accessPaths: [{ method: 'cli', tool: 'gh', available: true }],
      hierarchy: 'org > repo > issue',
      transitionModel: 'open/closed',
      constraints: [],
      detectionPlan: [
        {
          check: 'nonexistent-binary',
          type: 'binary',
          command: 'nonexistent-binary-xyz --version',
        },
      ],
      detectedTools: { 'GitHub CLI (gh)': 'gh version 2.x' },
      followUpQuestions: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'research.json'), JSON.stringify(researchData, null, 2));

    const ctx = {
      initId,
      config: {
        repo: {
          org: 'test',
          baseBranch: 'main',
          ticketSystem: null,
          prComment: null,
        },
      },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    // Should NOT throw — previously would crash with Object.keys(undefined)
    const nextState = await detect(ctx as any);

    expect(nextState).toBe('gather_context');

    // Verify detection.json artifact was written
    const detectionPath = join(initPath, 'detection.json');
    expect(existsSync(detectionPath)).toBe(true);

    const detection = JSON.parse(readFileSync(detectionPath, 'utf-8'));
    expect(detection.tools).toEqual({ 'GitHub CLI (gh)': 'gh version 2.x' });
    expect(Array.isArray(detection.available)).toBe(true);
    expect(Array.isArray(detection.missing)).toBe(true);
    // gh was in detectedTools, so it should appear in available
    expect(detection.available).toContain('GitHub CLI (gh)');

    // Verify WAL events
    const log = readInitLog(initId);
    const events = log.map((e: any) => e.event);
    expect(events).toContain('detect:started');
    expect(events).toContain('detect:completed');
  });

  it('detect state handles research.json WITHOUT detectedTools (defensive)', async () => {
    const { detect } = require('../init/states') as typeof import('../init/states');
    const { readInitLog } = require('../../core/log') as typeof import('../../core/log');

    const initId = 'detect-test-no-tools';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    // Write research.json WITHOUT detectedTools — the pre-fix scenario
    const researchData = {
      systemName: 'Jira',
      accessPaths: [],
      hierarchy: 'unknown',
      transitionModel: 'unknown',
      constraints: [],
      detectionPlan: [],
      // NOTE: no detectedTools field — simulates pre-fix research.json
      followUpQuestions: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'research.json'), JSON.stringify(researchData, null, 2));

    const ctx = {
      initId,
      config: {
        repo: {
          org: 'test',
          baseBranch: 'main',
          ticketSystem: null,
          prComment: null,
        },
      },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    // Should NOT throw — the defensive ?? {} handles missing detectedTools
    const nextState = await detect(ctx as any);

    expect(nextState).toBe('gather_context');

    // Verify detection.json artifact was written with empty tools
    const detectionPath = join(initPath, 'detection.json');
    expect(existsSync(detectionPath)).toBe(true);

    const detection = JSON.parse(readFileSync(detectionPath, 'utf-8'));
    expect(detection.tools).toEqual({});
    expect(detection.available).toEqual([]);

    // Verify WAL events
    const log = readInitLog(initId);
    const events = log.map((e: any) => e.event);
    expect(events).toContain('detect:started');
    expect(events).toContain('detect:completed');
  });
});
