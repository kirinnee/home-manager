import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { applyConfigEdit, globalConfigPath, readConfigResponse } from './config';

// Config-pane backing store: GET reads/resolves ~/.kloop/config.yaml (defaults when
// absent), PUT validates (schema + wrapper existence is checked by validateAgentsOrThrow;
// with no ~/.kfleet/bin present in the test env, wrapper enforcement is skipped) and
// persists, recording a durable change note.

let home: string;

describe('server config pane', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kloop-cfg-'));
    process.env.KLOOP_HOME = home;
  });
  afterEach(() => {
    delete process.env.KLOOP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('GET returns resolved defaults when no file exists', async () => {
    const resp = await readConfigResponse();
    expect(resp.exists).toBe(false);
    expect(resp.path).toBe(globalConfigPath());
    expect(resp.config).not.toBeNull();
    expect(resp.config?.maxIterations).toBeGreaterThan(0);
    expect(Array.isArray(resp.wrappers)).toBe(true);
  });

  it('PUT with a flat patch persists + re-nests + records a change note', async () => {
    const result = await applyConfigEdit({ patch: { maxIterations: 9, reviewerTimeout: 20 } });
    expect(result.ok).toBe(true);
    expect(result.change?.fields).toContain('maxIterations');
    // Persisted to disk, nested v2 layout, reloadable.
    const onDisk = YAML.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(onDisk.maxIterations).toBe(9);
    const after = await readConfigResponse();
    expect(after.config?.maxIterations).toBe(9);
    expect(after.config?.reviewerTimeout).toBe(20);
    expect(after.lastChange?.fields).toContain('reviewerTimeout');
  });

  it('PUT with raw YAML persists verbatim and validates', async () => {
    const yaml = [
      'configVersion: 2',
      'maxIterations: 5',
      'implementer:',
      '  pools:',
      '    claude-auto-liftoff: 1',
      'reviewer:',
      '  phases:',
      '    - - codex-auto-loio',
      '  lenses: [general]',
    ].join('\n');
    const result = await applyConfigEdit({ yaml, note: 'switch reviewer' });
    expect(result.ok).toBe(true);
    // Raw YAML is written verbatim — the human note lives in the change log, not the file.
    expect(readFileSync(globalConfigPath(), 'utf-8')).not.toContain('switch reviewer');
    const after = await readConfigResponse();
    expect(after.config?.maxIterations).toBe(5);
    expect(after.lastChange?.summary).toBe('switch reviewer');
  });

  it('PUT rejects invalid schema without writing', async () => {
    const result = await applyConfigEdit({ patch: { maxIterations: -3 } });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Nothing was written.
    const after = await readConfigResponse();
    expect(after.exists).toBe(false);
  });

  it('PUT rejects a body with neither yaml nor patch', async () => {
    const result = await applyConfigEdit({});
    expect(result.ok).toBe(false);
  });
});
