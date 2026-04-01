import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotPath, ensureArtifactDir } from './artifacts';
import { parsePlanFilename } from '../phases/shared';
import type { ContractManifest, PlanManifest, DeliveryManifest, DeliveryKind } from './types';

// ============================================================================
// Contract manifest
// ============================================================================

export function writeContractManifest(
  sessionId: string,
  version: number,
  deliveryKind: DeliveryKind,
  planCount: number,
): void {
  const manifest: ContractManifest = {
    version,
    deliveryKind,
    specFile: 'task-spec.md',
    planCount,
    createdAt: new Date().toISOString(),
  };
  const path = snapshotPath(sessionId, version, 'contract.json');
  ensureArtifactDir(path);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

export function readContractManifest(sessionId: string, version: number): ContractManifest | null {
  const path = snapshotPath(sessionId, version, 'contract.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function supersedEpoch(sessionId: string, oldVersion: number, newVersion: number): void {
  const manifest = readContractManifest(sessionId, oldVersion);
  if (manifest) {
    manifest.supersededBy = newVersion;
    manifest.supersededAt = new Date().toISOString();
    const path = snapshotPath(sessionId, oldVersion, 'contract.json');
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }
}

// ============================================================================
// Plan manifest
// ============================================================================

export function writePlanManifest(sessionId: string, version: number): PlanManifest {
  const plansDir = snapshotPath(sessionId, version, 'plans');
  const plans: PlanManifest['plans'] = [];

  if (existsSync(plansDir)) {
    const files = readdirSync(plansDir);
    const byOrdinal = new Map<number, { rewrite: number; filename: string }>();

    for (const f of files) {
      const parsed = parsePlanFilename(f);
      if (!parsed) continue;
      const existing = byOrdinal.get(parsed.ordinal);
      if (!existing || parsed.rewrite > existing.rewrite) {
        byOrdinal.set(parsed.ordinal, { rewrite: parsed.rewrite, filename: f });
      }
    }

    for (const [ordinal, { rewrite, filename }] of Array.from(byOrdinal.entries()).sort(([a], [b]) => a - b)) {
      plans.push({
        ordinal,
        activeRewrite: rewrite,
        file: filename,
        completed: false,
      });
    }
  }

  const manifest: PlanManifest = { plans };
  const path = snapshotPath(sessionId, version, 'plans', 'manifest.json');
  ensureArtifactDir(path);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function readPlanManifest(sessionId: string, version: number): PlanManifest | null {
  const path = snapshotPath(sessionId, version, 'plans', 'manifest.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Update a plan entry in the manifest with completion state and optional commit SHA.
 * Spec section 5.2 / 8: plan manifest records completion and produced commit SHA.
 */
export function updatePlanManifestEntry(
  sessionId: string,
  version: number,
  planOrdinal: number,
  completed: boolean,
  commitSha?: string,
): void {
  const manifest = readPlanManifest(sessionId, version);
  if (!manifest) return;

  const entry = manifest.plans.find(p => p.ordinal === planOrdinal);
  if (entry) {
    entry.completed = completed;
    if (commitSha) entry.commitSha = commitSha;
  }

  const path = snapshotPath(sessionId, version, 'plans', 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

// ============================================================================
// Delivery manifest
// ============================================================================

export function writeDeliveryManifest(sessionId: string, version: number, delivery: DeliveryManifest): void {
  const path = snapshotPath(sessionId, version, 'delivery.json');
  ensureArtifactDir(path);
  writeFileSync(path, JSON.stringify(delivery, null, 2));
}

export function readDeliveryManifest(sessionId: string, version: number): DeliveryManifest | null {
  const path = snapshotPath(sessionId, version, 'delivery.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function updateDeliveryManifest(sessionId: string, version: number, updates: Partial<DeliveryManifest>): void {
  const existing = readDeliveryManifest(sessionId, version) ?? { kind: 'pr' as const };
  Object.assign(existing, updates);
  writeDeliveryManifest(sessionId, version, existing);
}
