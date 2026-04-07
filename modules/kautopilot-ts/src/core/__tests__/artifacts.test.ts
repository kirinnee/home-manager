import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('artifacts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('artifactPath generates deterministic path', () => {
    const { artifactPath } = require('../artifacts') as typeof import('../artifacts');
    const path = artifactPath('abc123', 1, 'plan', 'spec.md');
    expect(path).toBe(join(tempDir, '.kautopilot/abc123/artifacts/v1/plan/spec.md'));
  });

  it('artifactPath handles multiple segments', () => {
    const { artifactPath } = require('../artifacts') as typeof import('../artifacts');
    const path = artifactPath('abc123', 2, 'implementation', 'src', 'index.ts');
    expect(path).toBe(join(tempDir, '.kautopilot/abc123/artifacts/v2/implementation/src/index.ts'));
  });

  it('snapshotPath generates flat versioned artifact path', () => {
    const { snapshotPath } = require('../artifacts') as typeof import('../artifacts');
    const path = snapshotPath('abc123', 1, 'plans', 'plan-1.md');
    expect(path).toBe(join(tempDir, '.kautopilot/abc123/artifacts/v1/plans/plan-1.md'));
  });

  it('sessionArtifactPath generates version-agnostic artifact path', () => {
    const { sessionArtifactPath } = require('../artifacts') as typeof import('../artifacts');
    const path = sessionArtifactPath('abc123', 'ticket.md');
    expect(path).toBe(join(tempDir, '.kautopilot/abc123/artifacts/ticket.md'));
  });

  it('sessionDir returns session directory', () => {
    const { sessionDir } = require('../artifacts') as typeof import('../artifacts');
    const dir = sessionDir('xyz789');
    expect(dir).toBe(join(tempDir, '.kautopilot/xyz789'));
  });

  it('initDir returns init attempt directory', () => {
    const { initDir } = require('../artifacts') as typeof import('../artifacts');
    const dir = initDir('init123');
    expect(dir).toBe(join(tempDir, '.kautopilot/init/init123'));
  });

  it('runsDir resolves session and init roots correctly', () => {
    const { runsDir } = require('../artifacts') as typeof import('../artifacts');
    expect(runsDir({ kind: 'session', id: 'abc123' })).toBe(join(tempDir, '.kautopilot/abc123/runs'));
    expect(runsDir({ kind: 'init', id: 'init123' })).toBe(join(tempDir, '.kautopilot/init/init123/runs'));
  });

  it('nextRunNumber increments numeric run directories only', () => {
    const { runsDir, nextRunNumber } = require('../artifacts') as typeof import('../artifacts');
    const dir = runsDir({ kind: 'session', id: 'abc123' });
    mkdirSync(join(dir, '1'), { recursive: true });
    mkdirSync(join(dir, '2'), { recursive: true });
    mkdirSync(join(dir, 'notes'), { recursive: true });
    expect(nextRunNumber({ kind: 'session', id: 'abc123' })).toBe(3);
  });

  it('runFilePath builds standard run artifact file paths', () => {
    const { runFilePath } = require('../artifacts') as typeof import('../artifacts');
    expect(runFilePath({ kind: 'init', id: 'init123' }, 4, 'prompt.md')).toBe(
      join(tempDir, '.kautopilot/init/init123/runs/4/prompt.md'),
    );
    expect(runFilePath({ kind: 'session', id: 'abc123' }, 2, 'logs')).toBe(
      join(tempDir, '.kautopilot/abc123/runs/2/logs'),
    );
  });
});
