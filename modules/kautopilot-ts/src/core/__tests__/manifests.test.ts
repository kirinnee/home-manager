import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('manifests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writeContractManifest creates contract.json with deliveryKind', () => {
    const { writeContractManifest, readContractManifest } = require('../manifests');
    writeContractManifest('sess1', 1, 'pr', 3);
    const manifest = readContractManifest('sess1', 1);
    expect(manifest).not.toBeNull();
    expect(manifest.version).toBe(1);
    expect(manifest.deliveryKind).toBe('pr');
    expect(manifest.planCount).toBe(3);
    expect(manifest.createdAt).toBeDefined();
  });

  it('writeContractManifest supports ticket deliveryKind', () => {
    const { writeContractManifest, readContractManifest } = require('../manifests');
    writeContractManifest('sess1', 2, 'ticket', 1);
    const manifest = readContractManifest('sess1', 2);
    expect(manifest.deliveryKind).toBe('ticket');
  });

  it('supersedEpoch marks old epoch as superseded', () => {
    const { writeContractManifest, supersedEpoch, readContractManifest } = require('../manifests');
    writeContractManifest('sess1', 1, 'pr', 2);
    writeContractManifest('sess1', 2, 'pr', 3);
    supersedEpoch('sess1', 1, 2);
    const oldManifest = readContractManifest('sess1', 1);
    expect(oldManifest.supersededBy).toBe(2);
    expect(oldManifest.supersededAt).toBeDefined();
  });

  it('writePlanManifest creates manifest from plan files', () => {
    const { writePlanManifest } = require('../manifests');
    // Create plan files
    const plansDir = join(tempDir, '.kautopilot/sess1/artifacts/v1/plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1-1.md'), '# Plan 1');
    writeFileSync(join(plansDir, 'plan-2-1.md'), '# Plan 2');
    const manifest = writePlanManifest('sess1', 1);
    expect(manifest.plans).toHaveLength(2);
    expect(manifest.plans[0].ordinal).toBe(1);
    expect(manifest.plans[0].activeRewrite).toBe(1);
    expect(manifest.plans[1].ordinal).toBe(2);
  });

  it('writePlanManifest picks highest rewrite suffix', () => {
    const { writePlanManifest } = require('../manifests');
    const plansDir = join(tempDir, '.kautopilot/sess1/artifacts/v1/plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan-1-1.md'), '# Plan 1 v1');
    writeFileSync(join(plansDir, 'plan-1-2.md'), '# Plan 1 v2');
    writeFileSync(join(plansDir, 'plan-2-1.md'), '# Plan 2');
    const manifest = writePlanManifest('sess1', 1);
    expect(manifest.plans).toHaveLength(2);
    expect(manifest.plans[0].activeRewrite).toBe(2);
    expect(manifest.plans[0].file).toBe('plan-1-2.md');
    expect(manifest.plans[1].activeRewrite).toBe(1);
  });

  it('writeDeliveryManifest creates delivery.json', () => {
    const { writeDeliveryManifest, readDeliveryManifest } = require('../manifests');
    writeDeliveryManifest('sess1', 1, { kind: 'pr', prNumber: 42 });
    const manifest = readDeliveryManifest('sess1', 1);
    expect(manifest.kind).toBe('pr');
    expect(manifest.prNumber).toBe(42);
  });

  it('updateDeliveryManifest merges with existing', () => {
    const { writeDeliveryManifest, updateDeliveryManifest, readDeliveryManifest } = require('../manifests');
    writeDeliveryManifest('sess1', 1, { kind: 'pr', prNumber: 42 });
    updateDeliveryManifest('sess1', 1, { prUrl: 'https://example.com/pr/42' });
    const manifest = readDeliveryManifest('sess1', 1);
    expect(manifest.kind).toBe('pr');
    expect(manifest.prNumber).toBe(42);
    expect(manifest.prUrl).toBe('https://example.com/pr/42');
  });
});
