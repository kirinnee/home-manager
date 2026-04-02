/**
 * End-to-end evidence test: normalize state preserves research hierarchy and defaults.
 *
 * Validates that the normalize state handler:
 * 1. Reads the structured hierarchy field from research.json (not researchOutput)
 * 2. Preserves the researched hierarchy in setup-brief.json
 * 3. Uses 'unknown' only when hierarchy is genuinely unavailable
 * 4. Produces valid setup-brief.json artifact
 * 5. Derives defaults from research constraints, detection, and user context
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('E2E: normalize preserves research hierarchy', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-normalize-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalize preserves hierarchy from research.json when structured hierarchy is present', async () => {
    const { normalize } = require('../init/states') as typeof import('../init/states');
    const { readInitLog } = require('../../core/log') as typeof import('../../core/log');

    const initId = 'normalize-test-hierarchy';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    // Write identify.json
    const identifyData = { systemName: 'GitHub Issues', timestamp: new Date().toISOString() };
    writeFileSync(join(initPath, 'identify.json'), JSON.stringify(identifyData));

    // Write research.json WITH structured hierarchy
    const researchData = {
      systemName: 'GitHub Issues',
      accessPaths: [{ method: 'cli', tool: 'gh', available: true }],
      hierarchy: 'org > repo > issue',
      transitionModel: 'open/closed',
      constraints: [],
      detectionPlan: [],
      detectedTools: { 'GitHub CLI (gh)': 'gh version 2.x' },
      followUpQuestions: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'research.json'), JSON.stringify(researchData));

    // Write detection.json
    const detectionData = {
      tools: { 'GitHub CLI (gh)': 'gh version 2.x' },
      configFiles: {},
      authStatus: { 'GitHub CLI (gh)': 'authenticated' },
      available: ['GitHub CLI (gh)'],
      missing: [],
      uncertain: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'detection.json'), JSON.stringify(detectionData));

    // Write user-context.json
    const userContext = {
      userAnswer: 'gh issue maps to org > repo > issue',
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'user-context.json'), JSON.stringify(userContext));

    const ctx = {
      initId,
      config: { repo: { org: 'test', baseBranch: 'main', ticketSystem: null } },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    const nextState = await normalize(ctx as any);

    expect(nextState).toBe('generate');

    // Verify setup-brief.json was written
    const briefPath = join(initPath, 'setup-brief.json');
    expect(existsSync(briefPath)).toBe(true);

    const setupBrief = JSON.parse(readFileSync(briefPath, 'utf-8'));

    // KEY ASSERTION: hierarchy from research.json must be preserved
    expect(setupBrief.hierarchy).toBe('org > repo > issue');

    // Other fields should be correctly populated
    expect(setupBrief.systemName).toBe('GitHub Issues');
    expect(setupBrief.chosenAccessPath).toBe('gh-cli');
    expect(setupBrief.readiness).toBe('ready');
    expect(setupBrief.confidence).toBe('high');

    // Defaults should be derived from research + detection + user context
    expect(setupBrief.defaults).toBeDefined();
    expect(typeof setupBrief.defaults).toBe('object');
    expect(setupBrief.defaults.detectedTools).toBe('GitHub CLI (gh)');
    expect(setupBrief.defaults.transitionModel).toBe('open/closed');
    expect(setupBrief.defaults.userContext).toBe('gh issue maps to org > repo > issue');

    // Verify WAL events
    const log = readInitLog(initId);
    const events = log.map((e: any) => e.event);
    expect(events).toContain('normalize:started');
    expect(events).toContain('normalize:completed');
  });

  it('normalize uses unknown when research.json has no hierarchy', async () => {
    const { normalize } = require('../init/states') as typeof import('../init/states');
    const { readInitLog } = require('../../core/log') as typeof import('../../core/log');

    const initId = 'normalize-test-unknown-hierarchy';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    // Write identify.json
    const identifyData = { systemName: 'Generic Ticket System', timestamp: new Date().toISOString() };
    writeFileSync(join(initPath, 'identify.json'), JSON.stringify(identifyData));

    // Write research.json with hierarchy set to 'unknown'
    const researchData = {
      systemName: 'Generic Ticket System',
      accessPaths: [],
      hierarchy: 'unknown',
      transitionModel: 'unknown',
      constraints: [],
      detectionPlan: [],
      detectedTools: {},
      followUpQuestions: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'research.json'), JSON.stringify(researchData));

    // Write detection.json
    const detectionData = {
      tools: {},
      configFiles: {},
      authStatus: {},
      available: [],
      missing: [],
      uncertain: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'detection.json'), JSON.stringify(detectionData));

    // Write user-context.json
    const userContext = {
      userAnswer: 'ticket system',
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'user-context.json'), JSON.stringify(userContext));

    const ctx = {
      initId,
      config: { repo: { org: 'test', baseBranch: 'main', ticketSystem: null } },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    const nextState = await normalize(ctx as any);

    expect(nextState).toBe('generate');

    const briefPath = join(initPath, 'setup-brief.json');
    const setupBrief = JSON.parse(readFileSync(briefPath, 'utf-8'));

    // When hierarchy is 'unknown' in research, it should be preserved as 'unknown'
    expect(setupBrief.hierarchy).toBe('unknown');
  });

  it('normalize derives defaults from research constraints, detection, and user context', async () => {
    const { normalize } = require('../init/states') as typeof import('../init/states');

    const initId = 'normalize-test-defaults';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    writeFileSync(
      join(initPath, 'identify.json'),
      JSON.stringify({
        systemName: 'Jira',
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'research.json'),
      JSON.stringify({
        systemName: 'Jira',
        accessPaths: [{ method: 'cli', tool: 'jira', available: true }],
        hierarchy: 'project > epic > story > subtask',
        transitionModel: 'To Do → In Progress → In Review → Done',
        constraints: ['Only admins can move to Done', 'Subtasks must close before parent'],
        detectionPlan: [],
        detectedTools: { 'Jira CLI': 'jira version 1.x' },
        followUpQuestions: [],
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'detection.json'),
      JSON.stringify({
        tools: { 'Jira CLI': 'jira version 1.x' },
        configFiles: {},
        authStatus: { 'Jira CLI': 'authenticated' },
        available: ['Jira CLI'],
        missing: [],
        uncertain: [],
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'user-context.json'),
      JSON.stringify({
        userAnswer: 'always use project BACKEND, sprint folder current',
        timestamp: new Date().toISOString(),
      }),
    );

    const ctx = {
      initId,
      config: { repo: { org: 'test', baseBranch: 'main', ticketSystem: null } },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    await normalize(ctx as any);

    const setupBrief = JSON.parse(readFileSync(join(initPath, 'setup-brief.json'), 'utf-8'));

    // Research constraints should be joined into defaults
    expect(setupBrief.defaults.constraints).toBe('Only admins can move to Done; Subtasks must close before parent');
    // Research transition model should be preserved
    expect(setupBrief.defaults.transitionModel).toBe('To Do → In Progress → In Review → Done');
    // Detected tools should be included
    expect(setupBrief.defaults.detectedTools).toBe('Jira CLI');
    // User context should be preserved
    expect(setupBrief.defaults.userContext).toBe('always use project BACKEND, sprint folder current');
  });

  it('normalize does not misclassify acli-based access as needing setup help', async () => {
    const { normalize } = require('../init/states') as typeof import('../init/states');

    const initId = 'normalize-test-acli-ready';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    writeFileSync(
      join(initPath, 'identify.json'),
      JSON.stringify({
        systemName: 'jira',
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'research.json'),
      JSON.stringify({
        systemName: 'jira',
        accessPaths: [{ method: 'Atlassian CLI (acli)', tool: 'acli', available: true }],
        hierarchy: 'project > issue',
        transitionModel: 'workflow',
        constraints: [],
        detectionPlan: [],
        detectedTools: { 'Atlassian CLI (acli)': 'acli version 1.3.14-stable' },
        followUpQuestions: [],
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'detection.json'),
      JSON.stringify({
        tools: { 'Atlassian CLI (acli)': 'acli version 1.3.14-stable' },
        configFiles: {},
        authStatus: { jira: 'unknown' },
        available: ['Atlassian CLI (acli)', 'acli'],
        missing: [],
        uncertain: ['jira'],
        timestamp: new Date().toISOString(),
      }),
    );

    const userAnswer =
      'acli. todo, in-progress, review. there are alot of weird workflow movement and constraint, which you need to study.';
    writeFileSync(
      join(initPath, 'user-context.json'),
      JSON.stringify({
        userAnswer,
        accessAssessment: `Access appears ready: ${userAnswer}`,
        needsSetupHelp: false,
        timestamp: new Date().toISOString(),
      }),
    );

    const ctx = {
      initId,
      config: { repo: { org: 'test', baseBranch: 'main', ticketSystem: null } },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    await normalize(ctx as any);

    const userContext = JSON.parse(readFileSync(join(initPath, 'user-context.json'), 'utf-8'));
    const setupBrief = JSON.parse(readFileSync(join(initPath, 'setup-brief.json'), 'utf-8'));

    expect(userContext.needsSetupHelp).toBe(false);
    expect(userContext.accessAssessment).toContain('Access appears ready');
    expect(setupBrief.chosenAccessPath).toBe('jira-cli');
    expect(setupBrief.readiness).toBe('partial');
  });

  it('normalize produces empty defaults when no data sources have defaults', async () => {
    const { normalize } = require('../init/states') as typeof import('../init/states');

    const initId = 'normalize-test-empty-defaults';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    writeFileSync(
      join(initPath, 'identify.json'),
      JSON.stringify({
        systemName: 'Unknown System',
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'research.json'),
      JSON.stringify({
        systemName: 'Unknown System',
        accessPaths: [],
        hierarchy: 'unknown',
        transitionModel: 'unknown',
        constraints: [],
        detectionPlan: [],
        detectedTools: {},
        followUpQuestions: [],
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'detection.json'),
      JSON.stringify({
        tools: {},
        configFiles: {},
        authStatus: {},
        available: [],
        missing: [],
        uncertain: [],
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(
      join(initPath, 'user-context.json'),
      JSON.stringify({
        userAnswer: '',
        timestamp: new Date().toISOString(),
      }),
    );

    const ctx = {
      initId,
      config: { repo: { org: 'test', baseBranch: 'main', ticketSystem: null } },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    await normalize(ctx as any);

    const setupBrief = JSON.parse(readFileSync(join(initPath, 'setup-brief.json'), 'utf-8'));

    // When no data sources have defaults, defaults should be empty
    expect(setupBrief.defaults).toEqual({});
    expect(Object.keys(setupBrief.defaults).length).toBe(0);
  });

  it('normalize uses unknown when research.json is missing hierarchy field (legacy artifact)', async () => {
    const { normalize } = require('../init/states') as typeof import('../init/states');

    const initId = 'normalize-test-missing-hierarchy';
    const initPath = join(tempDir, '.kautopilot', 'init', initId);
    mkdirSync(initPath, { recursive: true });

    // Write identify.json
    const identifyData = { systemName: 'Jira', timestamp: new Date().toISOString() };
    writeFileSync(join(initPath, 'identify.json'), JSON.stringify(identifyData));

    // Write research.json WITHOUT hierarchy field (simulates pre-fix legacy artifact)
    const researchData = {
      systemName: 'Jira',
      accessPaths: [],
      // NOTE: no hierarchy field — simulates legacy pre-fix research.json
      transitionModel: 'unknown',
      constraints: [],
      detectionPlan: [],
      detectedTools: {},
      followUpQuestions: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'research.json'), JSON.stringify(researchData));

    // Write detection.json
    const detectionData = {
      tools: {},
      configFiles: {},
      authStatus: {},
      available: [],
      missing: [],
      uncertain: [],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'detection.json'), JSON.stringify(detectionData));

    // Write user-context.json
    const userContext = {
      userAnswer: 'jira',
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(initPath, 'user-context.json'), JSON.stringify(userContext));

    const ctx = {
      initId,
      config: { repo: { org: 'test', baseBranch: 'main', ticketSystem: null } },
      workDir: tempDir,
      gitRootPath: tempDir,
      worktree: tempDir,
      remoteUrl: 'https://github.com/test/repo',
      gitRootHost: 'github.com',
      org: 'test',
      forceLocal: false,
      ticketIdArg: undefined,
    };

    const nextState = await normalize(ctx as any);

    expect(nextState).toBe('generate');

    const briefPath = join(initPath, 'setup-brief.json');
    const setupBrief = JSON.parse(readFileSync(briefPath, 'utf-8'));

    // When hierarchy field is missing entirely, fallback to 'unknown'
    expect(setupBrief.hierarchy).toBe('unknown');
  });
});
