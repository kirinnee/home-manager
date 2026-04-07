import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-configdir-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

import { discoverConfigDirs } from '../config-dir';
import type { Config } from '../types';

const GLOBAL_CACHE_FILE = join(process.env.HOME!, '.kautopilot', 'binary-config-dirs.json');
const BACKUP_PATH = `${GLOBAL_CACHE_FILE}.test-backup`;

const TEST_CONFIG: Config = {
  claude_binary: 'claude',
  agents: {
    init: {
      a: { prompt: 'x', binary: 'custom-init' },
    },
    phase1: {
      triage: { prompt: '' },
      spec_writer: { prompt: '' },
      plan_writer: { prompt: '' },
      spec_reviewers: {},
      plan_reviewers: {},
    },
    phase2: {},
    phase3: {},
    generic: {},
  },
  templates: {
    triage: '',
    spec: '',
    plan: '',
  },
  kloop: {
    implementers: { claude: 1 },
    reviewPhases: [['claude']],
    maxIterations: 10,
    implementerTimeout: 30,
    reviewerTimeout: 15,
    conflictCheckThreshold: 2,
    firstLoopFullReview: false,
    previousReviewPropagation: 0,
  },
  settings: {
    maxPushCycles: 10,
    pollInterval: 5,
    defaultLlmTimeout: 300,
    coderabbit: true,
    removeSpecOnPush: false,
  },
  repo: {
    baseBranch: 'main',
    ticketSystem: null,
    prComment: null,
  },
};

describe('discoverConfigDirs', () => {
  beforeEach(() => {
    // Back up existing global cache
    if (existsSync(GLOBAL_CACHE_FILE)) {
      const content = readFileSync(GLOBAL_CACHE_FILE, 'utf-8');
      writeFileSync(BACKUP_PATH, content);
    }
    mkdirSync(join(process.env.HOME!, '.kautopilot'), { recursive: true });
  });

  afterEach(() => {
    // Restore original global cache
    if (existsSync(BACKUP_PATH)) {
      const content = readFileSync(BACKUP_PATH, 'utf-8');
      writeFileSync(GLOBAL_CACHE_FILE, content);
      rmSync(BACKUP_PATH, { force: true });
    } else if (existsSync(GLOBAL_CACHE_FILE)) {
      rmSync(GLOBAL_CACHE_FILE, { force: true });
    }
  });

  it('loads persisted cache entries and persists to global cache', async () => {
    writeFileSync(GLOBAL_CACHE_FILE, JSON.stringify({ claude: '/tmp/claude-config' }, null, 2));

    const result = await discoverConfigDirs(TEST_CONFIG);

    expect(result.claude).toBe('/tmp/claude-config');
    expect(result['custom-init']).toBeDefined();

    const persisted = JSON.parse(readFileSync(GLOBAL_CACHE_FILE, 'utf-8')) as Record<string, string>;
    expect(persisted.claude).toBe('/tmp/claude-config');
    expect(persisted['custom-init']).toBeDefined();
    expect(Object.keys(persisted).sort()).toEqual(['claude', 'custom-init']);
  }, 60_000);
});
