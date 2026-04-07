import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('spawn run artifacts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-spawn-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawnPrintRaw creates run artifacts for init-scoped runs', async () => {
    const { spawnPrintRaw } = require('../spawn') as typeof import('../spawn');

    const output = await spawnPrintRaw('sh', 'echo ok', {
      runScope: { kind: 'init', id: 'init123' },
      cwd: tempDir,
      label: 'test-print',
      context: 'unit test print run',
    });

    expect(output).toBe('');
    expect(readFileSync(join(tempDir, '.kautopilot/init/init123/runs/1/prompt.md'), 'utf-8')).toBe('echo ok');
    expect(readFileSync(join(tempDir, '.kautopilot/init/init123/runs/1/command'), 'utf-8')).toContain('sh --print');
    expect(readFileSync(join(tempDir, '.kautopilot/init/init123/runs/1/logs'), 'utf-8')).toContain(
      '--print: invalid option',
    );
    expect(readFileSync(join(tempDir, '.kautopilot/init/init123/runs/1/context'), 'utf-8')).toContain(
      'scopeKind: init',
    );
  });

  it('spawnPrintRaw increments run numbers within a session root', async () => {
    const { spawnPrintRaw } = require('../spawn') as typeof import('../spawn');

    await spawnPrintRaw('sh', 'echo first', {
      runScope: { kind: 'session', id: 'sess123' },
      cwd: tempDir,
      label: 'first',
    });

    await spawnPrintRaw('sh', 'echo second', {
      runScope: { kind: 'session', id: 'sess123' },
      cwd: tempDir,
      label: 'second',
    });

    expect(readFileSync(join(tempDir, '.kautopilot/sess123/runs/2/prompt.md'), 'utf-8')).toBe('echo second');
  });
});
