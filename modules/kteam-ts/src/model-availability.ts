import path from 'path';
import type { AgentUsage } from './core';
import { atomicJson, readJson } from './io';
import type { KTeamPaths } from './paths';

/** Per-account model availability learned from the interactive TUI itself.
 *
 *  `claude -p` (the harness probe, kfleet usage) serves Fable fine on an account
 *  whose INTERACTIVE TUI demands usage-credit consent first — so neither feed can
 *  see it. kteam records it the moment the consent selector is detected and
 *  routing/start read it back, like the auth-rejection verdicts in the usage
 *  feed. A record expires so buying credits (or a plan change) heals by itself. */
export const MODEL_UNAVAILABLE_TTL_MS = 12 * 60 * 60 * 1000;

export interface ModelUnavailableRecord {
  /** Wrapper basename, e.g. `claude-auto-loge3`. */
  binary: string;
  /** Model family key (`fable`). */
  family: string;
  /** The model as the harness named it ("Fable 5.1"). */
  model: string;
  reason: string;
  at: string;
}

export function modelAvailabilityFile(paths: KTeamPaths): string {
  return path.join(paths.daemon, 'model-availability.json');
}

/** Family key for a requested model / alias / display name; undefined for
 *  models that have never needed interactive consent. */
export function consentModelFamily(model: string | undefined): string | undefined {
  return model && /fable/i.test(model) ? 'fable' : undefined;
}

export async function readModelUnavailable(paths: KTeamPaths, nowMs = Date.now()): Promise<ModelUnavailableRecord[]> {
  const records = await readJson<ModelUnavailableRecord[]>(modelAvailabilityFile(paths)).catch(() => []);
  if (!Array.isArray(records)) return [];
  return records.filter(record => {
    const at = Date.parse(record?.at);
    return typeof record?.binary === 'string' && Number.isFinite(at) && nowMs - at < MODEL_UNAVAILABLE_TTL_MS;
  });
}

export async function markModelUnavailable(
  paths: KTeamPaths,
  record: ModelUnavailableRecord,
  nowMs = Date.now(),
): Promise<void> {
  const kept = (await readModelUnavailable(paths, nowMs)).filter(
    item => !(item.binary === record.binary && item.family === record.family),
  );
  await atomicJson(modelAvailabilityFile(paths), [...kept, record]);
}

export function findModelUnavailable(
  records: readonly ModelUnavailableRecord[],
  binary: string,
  model: string | undefined,
): ModelUnavailableRecord | undefined {
  const family = consentModelFamily(model);
  if (!family) return undefined;
  const base = path.basename(binary);
  return records.find(record => record.binary === base && record.family === family);
}

/** Overlay the records onto the usage feed so routing sees them: a Fable record
 *  sets `fableUnavailable` (adding a bare entry for wrappers the feed lacks). */
export function applyModelAvailability(
  usage: readonly AgentUsage[],
  records: readonly ModelUnavailableRecord[],
): AgentUsage[] {
  const fable = new Map(records.filter(record => record.family === 'fable').map(record => [record.binary, record]));
  const merged = usage.map(item => {
    const record = fable.get(item.binary);
    return record ? { ...item, fableUnavailable: record.reason } : item;
  });
  for (const [binary, record] of fable)
    if (!merged.some(item => item.binary === binary)) merged.push({ binary, fableUnavailable: record.reason });
  return merged;
}
