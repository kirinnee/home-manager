import { resolveDisplayModel } from './core';
import type { WardenFailoverPolicy } from './daemon-config';
import type { Harness, SessionConfig, SessionState } from './types';

export type WardenSelectionReason = 'preferred' | 'failover' | 'rotation';
export type WardenModelSource = ReturnType<typeof resolveDisplayModel>['source'];

/** Selection facts captured before a warden launch. The per-wrapper reasons
 *  are the exact strings produced by selectWardenAccount(). */
export interface WardenSelectionProvenance {
  policy: WardenFailoverPolicy;
  selection: WardenSelectionReason;
  configuredFirst: string;
  skipped: Record<string, string>;
}

/** Daemon-owned facts for one successfully-created warden session. */
export interface WardenSpawnProvenance extends WardenSelectionProvenance {
  v: 1;
  /** Exact session creation time returned by start(). */
  at: string;
  wardenSessionId: string;
  /** Assigned-warden target. Fleet sweeps have no single target. */
  target?: string;
  /** Resolved CLI/account returned by start(), not the requested wrapper. */
  wrapper: string;
  /** Display model resolved from returned configured + observed state. */
  model: string;
  modelSource: WardenModelSource;
  harness: Harness;
  failedOver: boolean;
}

type ProvenanceSessionView = {
  config: Pick<SessionConfig, 'binary' | 'createdAt' | 'harness' | 'id' | 'model'>;
  state: Pick<SessionState, 'observedModel'>;
};

/** Build provenance only from the SessionView that start() actually returned,
 *  plus the daemon's already-computed selection evidence. */
export function buildWardenSpawnProvenance(
  view: ProvenanceSessionView,
  selection: WardenSelectionProvenance,
  target?: string,
): WardenSpawnProvenance {
  const resolved = resolveDisplayModel(view.config.binary, view.config.model, view.state.observedModel);
  const failedOver =
    selection.policy === 'fallback' &&
    selection.selection === 'failover' &&
    view.config.binary !== selection.configuredFirst;
  return {
    v: 1,
    at: view.config.createdAt,
    wardenSessionId: view.config.id,
    ...(target ? { target } : {}),
    wrapper: view.config.binary,
    model: resolved.model,
    modelSource: resolved.source,
    harness: view.config.harness,
    policy: selection.policy,
    selection: selection.selection,
    configuredFirst: selection.configuredFirst,
    skipped: { ...selection.skipped },
    failedOver,
  };
}

export function provenancePath(reportPath: string): string {
  return `${reportPath}.meta.json`;
}

const modelSourceLabel: Record<WardenModelSource, string> = {
  harness: 'Harness observation',
  wrapper: 'Wrapper mapping',
  configured: 'Configured model',
  unknown: 'Unknown',
};

const singleLine = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
const codeValue = (value: string): string => `\`${singleLine(value).replaceAll('`', "'")}\``;
const textValue = (value: string): string => singleLine(value).replaceAll('*', '\\*');

/** Short, scan-friendly markdown injected only when a valid sidecar exists. */
export function renderProvenanceMarkdown(meta: WardenSpawnProvenance): string {
  const model = meta.modelSource === 'unknown' ? 'Unknown' : codeValue(meta.model);
  const lines = [
    '## Who ran this check',
    `- CLI: **${codeValue(meta.wrapper)}**`,
    `- Model: **${model}**`,
    `- Model source: **${modelSourceLabel[meta.modelSource]}**`,
    `- Harness: **${codeValue(meta.harness)}**`,
    `- Warden: **${codeValue(meta.wardenSessionId)}**`,
    `- Failover: **${meta.failedOver ? 'Yes' : 'No'}**`,
  ];
  if (meta.failedOver) {
    lines.push(`- From: **${codeValue(meta.configuredFirst)}**`);
    lines.push(`- Why: **${textValue(meta.skipped[meta.configuredFirst] ?? 'daemon reason unavailable')}**`);
  }
  return lines.join('\n');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sidecars are daemon-owned, but validate disk input so a partial/corrupt
 *  write never changes a report or its verdict response. */
export function isWardenSpawnProvenance(value: unknown): value is WardenSpawnProvenance {
  if (!isRecord(value) || value.v !== 1) return false;
  if (
    typeof value.at !== 'string' ||
    typeof value.wardenSessionId !== 'string' ||
    (value.target !== undefined && typeof value.target !== 'string') ||
    typeof value.wrapper !== 'string' ||
    typeof value.model !== 'string' ||
    !['harness', 'wrapper', 'configured', 'unknown'].includes(String(value.modelSource)) ||
    !['claude', 'codex'].includes(String(value.harness)) ||
    !['fallback', 'round_robin'].includes(String(value.policy)) ||
    !['preferred', 'failover', 'rotation'].includes(String(value.selection)) ||
    typeof value.configuredFirst !== 'string' ||
    typeof value.failedOver !== 'boolean' ||
    !isRecord(value.skipped)
  )
    return false;
  if (!Object.values(value.skipped).every(reason => typeof reason === 'string')) return false;
  const expectedFailover =
    value.policy === 'fallback' && value.selection === 'failover' && value.wrapper !== value.configuredFirst;
  return value.failedOver === expectedFailover;
}
