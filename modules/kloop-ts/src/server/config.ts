import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { buildDefaultConfigYaml, CONFIG_VERSION } from '../agents/default-config';
import { validateAgentsOrThrow } from '../agents/runner';
import { getKloopHome } from '../deps';
import { installedWrappers } from '../kteam';
import { flattenNestedConfig, nestFlatConfig, parseRawConfig } from '../types';
import type { Config } from '../types';

// ============================================================================
// Config pane backing store for `kloop serve`.
//
// The editable config is the GLOBAL kloop defaults file `~/.kloop/config.yaml`
// (YAML, nested v2). Per-run config.yaml files are snapshots and are NOT touched
// here. GET returns the raw text + a resolved view + the valid wrapper list; PUT
// validates (schema + wrappers must exist in ~/.kfleet/bin) then persists, and
// appends a durable change note so the UI can surface "last changed …".
// ============================================================================

/** Path of the global kloop config file the pane reads and writes. */
export function globalConfigPath(): string {
  return join(getKloopHome(), 'config.yaml');
}

/** Durable, append-only change log for config edits (newest surfaced in the UI). */
function changeLogPath(): string {
  return join(getKloopHome(), '.config-history.jsonl');
}

export interface ConfigChangeNote {
  at: string;
  summary: string;
  fields: string[];
}

export interface ConfigResponse {
  path: string;
  exists: boolean;
  /** Raw YAML text (defaults text when the file is absent). */
  yaml: string;
  /** Fully-resolved config (defaults applied) for the form, or null if unparseable. */
  config: Config | null;
  /** Flattened key/value view (what the form edits), or null if unparseable. */
  flat: Record<string, unknown> | null;
  /** Installed kfleet auto-wrappers a role may be assigned to. */
  wrappers: string[];
  /** File mtime (ms) or null when the file is absent. */
  mtimeMs: number | null;
  /** Newest persisted change note, if any. */
  lastChange: ConfigChangeNote | null;
}

async function readLastChange(): Promise<ConfigChangeNote | null> {
  try {
    const text = await readFile(changeLogPath(), 'utf-8');
    const lines = text.split('\n').filter(l => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return null;
    return JSON.parse(last) as ConfigChangeNote;
  } catch {
    return null;
  }
}

async function appendChange(note: ConfigChangeNote): Promise<void> {
  try {
    await appendFile(changeLogPath(), `${JSON.stringify(note)}\n`, 'utf-8');
  } catch {
    /* change history is best-effort — never fail a write because the log couldn't append */
  }
}

/** Read the global config for the GET endpoint. Falls back to generated defaults. */
export async function readConfigResponse(): Promise<ConfigResponse> {
  const path = globalConfigPath();
  let yaml: string;
  let exists = false;
  let mtimeMs: number | null = null;
  try {
    yaml = await readFile(path, 'utf-8');
    exists = true;
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    yaml = buildDefaultConfigYaml();
  }

  let config: Config | null = null;
  let flat: Record<string, unknown> | null = null;
  try {
    const raw = YAML.parse(yaml) ?? {};
    flat = flattenNestedConfig(raw) as Record<string, unknown>;
    config = parseRawConfig(raw);
  } catch {
    /* leave config/flat null — the raw YAML editor still works */
  }

  return {
    path,
    exists,
    yaml,
    config,
    flat,
    wrappers: installedWrappers(),
    mtimeMs,
    lastChange: await readLastChange(),
  };
}

/** Body accepted by the PUT endpoint: raw YAML text OR a flat-key patch. */
export interface ConfigEdit {
  /** Full replacement YAML (advanced editor). Comments preserved verbatim. */
  yaml?: string;
  /** Flat-key overrides merged into the current config (form edits). */
  patch?: Record<string, unknown>;
  /** Optional human note describing the edit. */
  note?: string;
}

export interface ConfigEditResult {
  ok: boolean;
  error?: string;
  change?: ConfigChangeNote;
  config?: Config | null;
}

/** Human-readable summary of which flat keys a patch touched. */
function summarizePatch(patch: Record<string, unknown>): { summary: string; fields: string[] } {
  const fields = Object.keys(patch);
  const summary = fields.length ? `Edited ${fields.join(', ')}` : 'Edited config';
  return { summary, fields };
}

/**
 * Validate + persist a config edit. Validation: YAML parses, schema accepts it, and
 * every referenced agent is an installed kfleet wrapper (rejects unknown). On success
 * writes the file and appends a change note. Never throws — returns {ok:false,error}.
 */
export async function applyConfigEdit(edit: ConfigEdit): Promise<ConfigEditResult> {
  const path = globalConfigPath();
  try {
    let outputYaml: string;
    let change: ConfigChangeNote;

    if (typeof edit.yaml === 'string') {
      const raw = YAML.parse(edit.yaml) ?? {};
      const config = parseRawConfig(raw); // throws on schema failure
      validateAgentsOrThrow(config, installedWrappers()); // throws on unknown wrapper
      outputYaml = edit.yaml; // preserve the user's exact text + comments
      change = {
        at: new Date().toISOString(),
        summary: edit.note?.trim() || 'Replaced config (raw YAML)',
        fields: [],
      };
    } else if (edit.patch && typeof edit.patch === 'object') {
      // Merge flat-key patch into the current (flattened) config, then re-nest.
      let currentFlat: Record<string, unknown>;
      try {
        currentFlat = flattenNestedConfig(YAML.parse(await readFile(path, 'utf-8')) ?? {}) as Record<string, unknown>;
      } catch {
        currentFlat = flattenNestedConfig(YAML.parse(buildDefaultConfigYaml())) as Record<string, unknown>;
      }
      const mergedFlat = { ...currentFlat, ...edit.patch, configVersion: CONFIG_VERSION };
      const config = parseRawConfig(mergedFlat); // throws on schema failure
      validateAgentsOrThrow(config, installedWrappers()); // throws on unknown wrapper
      const nested = nestFlatConfig(mergedFlat);
      outputYaml = YAML.stringify(nested, { lineWidth: 0 });
      const { summary, fields } = summarizePatch(edit.patch);
      change = { at: new Date().toISOString(), summary: edit.note?.trim() || summary, fields };
    } else {
      return { ok: false, error: 'edit must include either `yaml` or `patch`' };
    }

    await writeFile(path, outputYaml, 'utf-8');
    await appendChange(change);
    const after = await readConfigResponse();
    return { ok: true, change, config: after.config };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
