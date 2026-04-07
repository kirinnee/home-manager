import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('plan file resolution (spec section 5.3)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-plans-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parsePlanFilename parses spec convention (plan-N-M.md)', () => {
    const { parsePlanFilename } = require('../shared');
    expect(parsePlanFilename('plan-1-1.md')).toEqual({
      ordinal: 1,
      rewrite: 1,
    });
    expect(parsePlanFilename('plan-2-3.md')).toEqual({
      ordinal: 2,
      rewrite: 3,
    });
    expect(parsePlanFilename('plan-10-5.md')).toEqual({
      ordinal: 10,
      rewrite: 5,
    });
  });

  it('parsePlanFilename parses legacy flat convention (plan-N.md)', () => {
    const { parsePlanFilename } = require('../shared');
    expect(parsePlanFilename('plan-1.md')).toEqual({ ordinal: 1, rewrite: 1 });
    expect(parsePlanFilename('plan-5.md')).toEqual({ ordinal: 5, rewrite: 1 });
  });

  it('parsePlanFilename rejects non-plan files', () => {
    const { parsePlanFilename } = require('../shared');
    expect(parsePlanFilename('manifest.json')).toBeNull();
    expect(parsePlanFilename('plan-draft-1.md')).toBeNull();
    expect(parsePlanFilename('readme.md')).toBeNull();
  });

  it('resolveActivePlans returns highest rewrite per ordinal', () => {
    const { resolveActivePlans } = require('../shared');
    // Create plan files with multiple rewrites
    writeFileSync(join(tempDir, 'plan-1-1.md'), '# Plan 1 v1');
    writeFileSync(join(tempDir, 'plan-1-2.md'), '# Plan 1 v2');
    writeFileSync(join(tempDir, 'plan-1-3.md'), '# Plan 1 v3');
    writeFileSync(join(tempDir, 'plan-2-1.md'), '# Plan 2 v1');
    writeFileSync(join(tempDir, 'plan-3-1.md'), '# Plan 3 v1');
    writeFileSync(join(tempDir, 'plan-3-2.md'), '# Plan 3 v2');

    const plans = resolveActivePlans(tempDir);
    expect(plans).toHaveLength(3);
    expect(plans[0]).toEndWith('plan-1-3.md');
    expect(plans[1]).toEndWith('plan-2-1.md');
    expect(plans[2]).toEndWith('plan-3-2.md');
  });

  it('resolveActivePlans sorts by ordinal', () => {
    const { resolveActivePlans } = require('../shared');
    writeFileSync(join(tempDir, 'plan-3-1.md'), '# Plan 3');
    writeFileSync(join(tempDir, 'plan-1-1.md'), '# Plan 1');
    writeFileSync(join(tempDir, 'plan-2-1.md'), '# Plan 2');

    const plans = resolveActivePlans(tempDir);
    expect(plans).toHaveLength(3);
    expect(plans[0]).toEndWith('plan-1-1.md');
    expect(plans[1]).toEndWith('plan-2-1.md');
    expect(plans[2]).toEndWith('plan-3-1.md');
  });

  it('resolveActivePlans handles empty directory', () => {
    const { resolveActivePlans } = require('../shared');
    const plans = resolveActivePlans(tempDir);
    expect(plans).toHaveLength(0);
  });

  it('resolveActivePlans handles nonexistent directory', () => {
    const { resolveActivePlans } = require('../shared');
    const plans = resolveActivePlans(join(tempDir, 'nonexistent'));
    expect(plans).toHaveLength(0);
  });

  it('rewrite does not overwrite prior plan files', () => {
    const { resolveActivePlans } = require('../shared');
    writeFileSync(join(tempDir, 'plan-1-1.md'), '# Original');

    // Simulate a rewrite (new file, no overwrite)
    writeFileSync(join(tempDir, 'plan-1-2.md'), '# Rewritten');

    // Both files must still exist
    expect(existsSync(join(tempDir, 'plan-1-1.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'plan-1-2.md'))).toBe(true);

    // Active plan should be the rewrite
    const plans = resolveActivePlans(tempDir);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEndWith('plan-1-2.md');
  });

  it('legacy flat files are handled as rewrite 1', () => {
    const { resolveActivePlans } = require('../shared');
    writeFileSync(join(tempDir, 'plan-1.md'), '# Legacy plan 1');
    writeFileSync(join(tempDir, 'plan-2.md'), '# Legacy plan 2');

    const plans = resolveActivePlans(tempDir);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEndWith('plan-1.md');
    expect(plans[1]).toEndWith('plan-2.md');
  });

  it('mixed legacy and spec convention resolves correctly', () => {
    const { resolveActivePlans } = require('../shared');
    writeFileSync(join(tempDir, 'plan-1.md'), '# Legacy');
    writeFileSync(join(tempDir, 'plan-1-2.md'), '# Spec rewrite');

    const plans = resolveActivePlans(tempDir);
    expect(plans).toHaveLength(1);
    // plan-1-2.md has rewrite=2 which is higher than plan-1.md (rewrite=1)
    expect(plans[0]).toEndWith('plan-1-2.md');
  });
});
