import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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

  it('sessionDir returns session directory', () => {
    const { sessionDir } = require('../artifacts') as typeof import('../artifacts');
    const dir = sessionDir('xyz789');
    expect(dir).toBe(join(tempDir, '.kautopilot/xyz789'));
  });
});
