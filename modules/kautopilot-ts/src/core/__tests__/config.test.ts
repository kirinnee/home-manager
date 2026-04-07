import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Override HOME to temp dir for config tests
const origHome = process.env.HOME;

describe('config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writeConfig creates config file with defaults', () => {
    const { writeConfig, readConfig } = require('../config') as typeof import('../config');
    const { DEFAULT_CONFIG } = require('../types') as typeof import('../types');
    writeConfig('testid', { ...DEFAULT_CONFIG });

    const config = readConfig('testid');
    expect(config).not.toBeNull();
    expect(config?.claude_binary).toBe('claude');
    // commit agent uses shared COMMIT_AGENT_PROMPT (not in config.agents)
    expect(config?.agents.phase2.resolve).toBeDefined();
    expect(config?.agents.phase2.resolve.prompt).toContain('revisit_spec');
    expect(config?.kloop.maxIterations).toBe(10);
    expect(config?.repo.baseBranch).toBe('main');
    expect(config?.repo.ticketSystem).toBeNull();

    expect(existsSync(join(tempDir, '.kautopilot/testid/config.yaml'))).toBe(true);
  });

  it('readConfig returns null for missing config', () => {
    const { readConfig } = require('../config') as typeof import('../config');
    const result = readConfig('nonexistent');
    expect(result).toBeNull();
  });

  it('readConfig reads config back after writeConfig', () => {
    const { writeConfig, readConfig } = require('../config') as typeof import('../config');
    const { DEFAULT_CONFIG } = require('../types') as typeof import('../types');
    writeConfig('testid', { ...DEFAULT_CONFIG });
    const config = readConfig('testid');
    expect(config).not.toBeNull();
    expect(config?.claude_binary).toBe('claude');
    expect(config?.kloop.maxIterations).toBe(10);
  });

  it('writeConfig persists changes', () => {
    const { writeConfig, readConfig } = require('../config') as typeof import('../config');
    const { DEFAULT_CONFIG } = require('../types') as typeof import('../types');
    writeConfig('testid', { ...DEFAULT_CONFIG });

    const config = readConfig('testid')!;
    config.repo.baseBranch = 'develop';
    config.kloop.maxIterations = 20;
    writeConfig('testid', config);

    const reloaded = readConfig('testid')!;
    expect(reloaded.repo.baseBranch).toBe('develop');
    expect(reloaded.kloop.maxIterations).toBe(20);
  });

  it('ensureGlobalConfig creates ~/.kautopilot/config.yaml', () => {
    const { ensureGlobalConfig } = require('../config') as typeof import('../config');
    ensureGlobalConfig();
    expect(existsSync(join(tempDir, '.kautopilot/config.yaml'))).toBe(true);
  });

  it('ensureGlobalConfig does not overwrite existing config', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { ensureGlobalConfig } = require('../config') as typeof import('../config');

    // Create a config with custom content
    const globalDir = join(tempDir, '.kautopilot');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'config.yaml'), 'claude_binary: my-custom-binary\n');

    ensureGlobalConfig();

    // Should still have custom content
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const content = readFileSync(join(globalDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('my-custom-binary');
  });

  it('resolveConfig merges with built-in defaults', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { resolveConfig } = require('../config') as typeof import('../config');

    // Create a minimal config
    const globalDir = join(tempDir, '.kautopilot');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'config.yaml'), 'claude_binary: custom-claude\n');

    const config = resolveConfig();
    expect(config.claude_binary).toBe('custom-claude');
    // Defaults should still be present
    expect(config.agents.phase2.resolve).toBeDefined();
    expect(config.kloop.maxIterations).toBe(10);
  });

  it('pickConfig returns org config when org is set', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { pickConfig } = require('../config') as typeof import('../config');

    // Create org config
    const orgDir = join(tempDir, '.kautopilot/orgs/myorg');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'config.yaml'), 'claude_binary: org-claude\n');

    const result = pickConfig('myorg');
    expect(result).toContain('myorg');
  });

  it('pickConfig returns configPathOverride when provided', () => {
    const { pickConfig } = require('../config') as typeof import('../config');
    const result = pickConfig('myorg', '/some/custom/path.yaml');
    expect(result).toBe('/some/custom/path.yaml');
  });

  it('migrates legacy kloop fields from settings when kloop is absent', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { readConfig } = require('../config') as typeof import('../config');
    const sessionDir = join(tempDir, '.kautopilot/testid');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'config.yaml'),
      ['settings:', '  maxIterations: 21', '  implementerTimeout: 44', '  reviewerTimeout: 11'].join('\n'),
    );

    const config = readConfig('testid')!;
    expect(config.kloop.maxIterations).toBe(21);
    expect(config.kloop.implementerTimeout).toBe(44);
    expect(config.kloop.reviewerTimeout).toBe(11);
  });

  it('backfills missing kloop fields from legacy settings', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { readConfig } = require('../config') as typeof import('../config');
    const sessionDir = join(tempDir, '.kautopilot/testid');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'config.yaml'),
      [
        'kloop:',
        '  maxIterations: 25',
        'settings:',
        '  maxIterations: 21',
        '  implementerTimeout: 44',
        '  reviewerTimeout: 11',
      ].join('\n'),
    );

    const config = readConfig('testid')!;
    expect(config.kloop.maxIterations).toBe(25);
    expect(config.kloop.implementerTimeout).toBe(44);
    expect(config.kloop.reviewerTimeout).toBe(11);
  });

  it('prefers explicit kloop values over legacy settings', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { readConfig } = require('../config') as typeof import('../config');
    const sessionDir = join(tempDir, '.kautopilot/testid');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'config.yaml'),
      [
        'kloop:',
        '  maxIterations: 25',
        '  implementerTimeout: 33',
        '  reviewerTimeout: 9',
        'settings:',
        '  maxIterations: 21',
        '  implementerTimeout: 44',
        '  reviewerTimeout: 11',
      ].join('\n'),
    );

    const config = readConfig('testid')!;
    expect(config.kloop.maxIterations).toBe(25);
    expect(config.kloop.implementerTimeout).toBe(33);
    expect(config.kloop.reviewerTimeout).toBe(9);
  });

  it('config has no roles or steps', () => {
    const { writeConfig, readConfig } = require('../config') as typeof import('../config');
    const { DEFAULT_CONFIG } = require('../types') as typeof import('../types');
    writeConfig('testid', { ...DEFAULT_CONFIG });
    const config = readConfig('testid')!;
    expect((config as Record<string, unknown>).roles).toBeUndefined();
    expect((config as Record<string, unknown>).steps).toBeUndefined();
  });
});
