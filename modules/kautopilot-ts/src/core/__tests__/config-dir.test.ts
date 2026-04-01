import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverConfigDirs } from '../config-dir';
import type { Config } from '../types';

const SESSION_ID = `test-config-dir-${Date.now()}`;
const SESSION_DIR = join(process.env.HOME!, '.kautopilot', SESSION_ID);
const CACHE_FILE = join(SESSION_DIR, 'binary-config-dirs.json');

const TEST_CONFIG: Config = {
  claude_binary: 'claude',
  agents: {
    init: {
      a: { prompt: 'x', binary: 'custom-init' },
    },
    phase2: {},
    phase3: {},
  },
  types: {},
  kloop: {
    implementers: { claude: 1 },
    reviewPhases: [['claude']],
    maxIterations: 10,
    implementerTimeout: 30,
    reviewerTimeout: 15,
    conflictCheckThreshold: 2,
    firstLoopFullReview: false,
    previousReviewPropagation: 0,
    reviewerFailureLimit: 2,
  },
  settings: {
    maxPushCycles: 10,
    pollInterval: 60,
    defaultLlmTimeout: 300,
  },
  repo: {
    baseBranch: 'main',
    ticketSystem: null,
  },
};

describe('discoverConfigDirs', () => {
  beforeEach(() => {
    mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(SESSION_DIR)) {
      rmSync(SESSION_DIR, { recursive: true, force: true });
    }
  });

  it('loads persisted cache entries and persists session-relevant binaries', async () => {
    writeFileSync(CACHE_FILE, JSON.stringify({ claude: '/tmp/claude-config' }, null, 2));

    const result = await discoverConfigDirs(TEST_CONFIG, SESSION_ID);

    expect(result.claude).toBe('/tmp/claude-config');
    expect(result['custom-init']).toBeDefined();

    const persisted = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Record<string, string>;
    expect(persisted.claude).toBe('/tmp/claude-config');
    expect(persisted['custom-init']).toBeDefined();
    expect(Object.keys(persisted).sort()).toEqual(['claude', 'custom-init']);
  }, 60_000);
});
