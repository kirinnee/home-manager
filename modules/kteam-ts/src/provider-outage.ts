// Deterministic provider-outage evidence and persistence.
//
// This module is intentionally pure: the daemon sweep supplies persisted pane
// snapshots, wall-clock time, and the previous reducer state. No LLM, tmux, I/O,
// or implicit clock participates in deciding whether a provider is unavailable.

import type { SessionConfig, SessionState, SessionStatus } from './types';
import { WARDEN_LABEL, type WardenAnomaly } from './warden-detect';

export type ProviderFailureClass = 'cooling_down' | 'monthly_spend_limit';

export interface ProviderFailureObservation {
  sessionId: string;
  teammate?: string;
  label?: string;
  status: SessionStatus;
  binary: string;
  provider: string;
  failureClass: ProviderFailureClass;
  model?: string;
  /** Short, control-stripped evidence only. Never the whole pane. */
  evidence: string;
}

export interface ProviderSnapshotView {
  config: Pick<SessionConfig, 'id' | 'binary' | 'harness' | 'label' | 'mode' | 'parent' | 'teammate'>;
  state: Pick<SessionState, 'status'>;
  snapshot: string;
}

export interface ProviderOutageStreak {
  signature: string;
  provider: string;
  failureClass: ProviderFailureClass;
  /** Monthly spend limits are account/wrapper scoped, unlike pool cooling. */
  binary?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** The last observation that advanced consecutiveSweeps. Quick manual sweeps
   *  cannot satisfy persistence merely by running twice in a row. */
  lastCountedAt: string;
  consecutiveSweeps: number;
  confirmed: boolean;
  affectedSessionIds: string[];
  models: string[];
}

/** Durable reducer state. Streaks are keyed by matching evidence signature,
 *  while generations are provider-wide so a different failure class after a
 *  clean recovery still creates a fresh Attention item. */
export interface ProviderOutageState {
  signatures?: Record<string, ProviderOutageStreak>;
  generations?: Record<string, number>;
  activeProviders?: string[];
}

export interface ProviderOutageOptions {
  /** Matching evidence must be visible in this many independent sessions. */
  minDistinctSessions?: number;
  /** Sightings on this many distinct sweep observations are required. */
  persistenceSweeps?: number;
  /** Minimum wall time between counted sightings. */
  minPersistenceMs?: number;
  /** Only this many final non-empty visual rows are eligible evidence. */
  tailLines?: number;
}

export interface ProviderOutageResult {
  state: ProviderOutageState;
  anomalies: WardenAnomaly[];
}

/** A first sighting is deliberately pending. With the default five-minute
 *  sweep cadence, the second consecutive sweep confirms the outage in about
 *  five minutes; forced back-to-back sweeps still need sixty real seconds. */
export const PROVIDER_OUTAGE_PERSISTENCE_SWEEPS = 2;
export const PROVIDER_OUTAGE_MIN_DISTINCT_SESSIONS = 2;
export const PROVIDER_OUTAGE_MIN_PERSISTENCE_MS = 60_000;
export const PROVIDER_OUTAGE_TAIL_LINES = 24;

const ACTIVE = new Set<SessionStatus>(['running', 'thinking', 'tool_running', 'rate_limited', 'retrying']);
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/gu;

const parseMs = (value: string | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const canonicalProvider = (value: string): string => value.trim().toLowerCase();

function cleanPane(value: string): string {
  return value.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(CONTROLS, '').replace(/\r/g, '');
}

function visualTail(snapshot: string, tailLines: number): string {
  const lines = cleanPane(snapshot)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  return lines.slice(-Math.max(8, Math.min(80, Math.floor(tailLines)))).join('\n');
}

const shortEvidence = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 240);

/** Only actively working auto sessions may corroborate an outage. Interactive,
 *  waiting, terminal, and warden sessions may retain historical error rows and
 *  are excluded so stale panes and the escalation mechanism cannot self-confirm. */
export function providerSnapshotEligible(view: Pick<ProviderSnapshotView, 'config' | 'state'>): boolean {
  return view.config.mode !== 'interactive' && view.config.label !== WARDEN_LABEL && ACTIVE.has(view.state.status);
}

/** Apply the detector's authoritative no-recursion rule to a fleet snapshot.
 *  Descendants are excluded by ancestry even if an old/malformed config lost
 *  the force-inherited warden label. */
export function providerEligibleSessionIds(
  views: readonly Pick<ProviderSnapshotView, 'config' | 'state'>[],
): Set<string> {
  const byId = new Map(views.map(view => [view.config.id, view]));
  const inWardenLineage = (view: Pick<ProviderSnapshotView, 'config' | 'state'>): boolean => {
    const seen = new Set<string>();
    let current: Pick<ProviderSnapshotView, 'config' | 'state'> | undefined = view;
    while (current && !seen.has(current.config.id)) {
      seen.add(current.config.id);
      if (current.config.label === WARDEN_LABEL) return true;
      current = current.config.parent ? byId.get(current.config.parent) : undefined;
    }
    return false;
  };
  return new Set(
    views.filter(view => providerSnapshotEligible(view) && !inWardenLineage(view)).map(view => view.config.id),
  );
}

/** Extract at most one current provider failure from the visible tail. Exact
 *  CLIProxy cooling text is self-identifying (429 + model + provider). Monthly
 *  spend-limit UI is accepted only on a harness-rendered glyph row, then mapped
 *  from the known harness rather than guessed from a wrapper suffix. */
export function providerFailureFromSnapshot(
  view: ProviderSnapshotView,
  options: Pick<ProviderOutageOptions, 'tailLines'> = {},
): ProviderFailureObservation | undefined {
  if (!providerSnapshotEligible(view) || !view.snapshot.trim()) return undefined;
  const tail = visualTail(view.snapshot, options.tailLines ?? PROVIDER_OUTAGE_TAIL_LINES);
  if (!tail) return undefined;

  const cooling = [
    ...tail.matchAll(
      /(?:Request rejected\s*\(\s*429\s*\)|\b429\b)[\s\S]{0,220}?All credentials for model\s+([^\s·]+)\s+are cooling down via provider\s+([A-Za-z0-9._-]+)/giu,
    ),
  ].at(-1);
  const spend = [
    ...tail.matchAll(
      /^\s*(?:●\s+API Error:|⎿)\s*[^\n]*(?:monthly\s+(?:spend|usage)\s+limit|monthly\s+spending\s+limit)[^\n]*$/gimu,
    ),
  ].at(-1);

  // Prefer whichever recognized frame appears later in the current tail. A
  // spend-limit row after generic pool cooling preserves the actionable cause.
  const coolingIndex = cooling?.index ?? -1;
  const spendIndex = spend?.index ?? -1;
  if (spend && spendIndex >= coolingIndex) {
    const provider = view.config.harness === 'claude' ? 'claude' : view.config.harness === 'codex' ? 'openai' : '';
    if (!provider) return undefined;
    return {
      sessionId: view.config.id,
      teammate: view.config.teammate,
      label: view.config.label,
      status: view.state.status,
      binary: view.config.binary,
      provider,
      failureClass: 'monthly_spend_limit',
      evidence: shortEvidence(spend[0]),
    };
  }
  if (!cooling) return undefined;
  const provider = canonicalProvider(cooling[2] ?? '');
  if (!provider) return undefined;
  return {
    sessionId: view.config.id,
    teammate: view.config.teammate,
    label: view.config.label,
    status: view.state.status,
    binary: view.config.binary,
    provider,
    failureClass: 'cooling_down',
    model: cooling[1],
    evidence: shortEvidence(cooling[0]),
  };
}

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort() as T[];
}

const canonicalBinary = (value: string): string =>
  (value.replace(/\\/g, '/').split('/').at(-1) ?? value).trim().toLowerCase();

/** Only matching failures advance one another. Cooling is provider-wide;
 *  monthly spend limits are scoped to the wrapper/account that owns the cap. */
export function providerFailureSignature(observation: ProviderFailureObservation): string {
  const provider = canonicalProvider(observation.provider);
  return observation.failureClass === 'monthly_spend_limit'
    ? `provider:${provider}|monthly_spend_limit|wrapper:${canonicalBinary(observation.binary)}`
    : `provider:${provider}|cooling_down`;
}

function reasonLabel(value: ProviderFailureClass): string {
  return value === 'monthly_spend_limit' ? 'monthly spend limit' : 'HTTP 429 / credentials cooling down';
}

function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes}m`;
}

/** Persist, damp, and aggregate observations. Provider identity—not session
 *  identity—is the outage key, so ten failing panes become one anomaly. */
export function reduceProviderOutages(
  previous: ProviderOutageState,
  observations: readonly ProviderFailureObservation[],
  nowMs: number,
  options: ProviderOutageOptions = {},
): ProviderOutageResult {
  const minDistinctSessions = Math.max(
    2,
    Math.floor(options.minDistinctSessions ?? PROVIDER_OUTAGE_MIN_DISTINCT_SESSIONS),
  );
  const persistenceSweeps = Math.max(2, Math.floor(options.persistenceSweeps ?? PROVIDER_OUTAGE_PERSISTENCE_SWEEPS));
  const minPersistenceMs = Math.max(60_000, options.minPersistenceMs ?? PROVIDER_OUTAGE_MIN_PERSISTENCE_MS);
  const nowIso = new Date(nowMs).toISOString();
  const grouped = new Map<string, ProviderFailureObservation[]>();
  for (const observation of observations) {
    const provider = canonicalProvider(observation.provider);
    if (!provider) continue;
    const normalized = { ...observation, provider };
    const signature = providerFailureSignature(normalized);
    const list = grouped.get(signature);
    if (list) list.push(normalized);
    else grouped.set(signature, [normalized]);
  }

  const signatures: Record<string, ProviderOutageStreak> = {};
  for (const [signature, rawCurrent] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const current = [...new Map(rawCurrent.map(item => [item.sessionId, item])).values()];
    // One pane can repeat forever without proving a provider-wide outage. A
    // sub-threshold sweep resets the matching streak rather than preserving it.
    if (current.length < minDistinctSessions) continue;
    const prior = previous.signatures?.[signature];
    const priorCountedAt = parseMs(prior?.lastCountedAt);
    const advances = prior !== undefined && nowMs - priorCountedAt >= minPersistenceMs;
    const consecutiveSweeps = prior === undefined ? 1 : prior.consecutiveSweeps + (advances ? 1 : 0);
    const firstSeenAt = prior?.firstSeenAt && parseMs(prior.firstSeenAt) > 0 ? prior.firstSeenAt : nowIso;
    const lastCountedAt = prior === undefined || advances ? nowIso : prior.lastCountedAt;
    const affectedSessionIds = sortedUnique(current.map(item => item.sessionId));
    const models = sortedUnique(current.map(item => item.model).filter((value): value is string => Boolean(value)));
    const sample = current[0]!;
    signatures[signature] = {
      signature,
      provider: sample.provider,
      failureClass: sample.failureClass,
      ...(sample.failureClass === 'monthly_spend_limit' ? { binary: canonicalBinary(sample.binary) } : {}),
      firstSeenAt,
      lastSeenAt: nowIso,
      lastCountedAt,
      consecutiveSweeps,
      confirmed:
        prior?.confirmed === true ||
        (consecutiveSweeps >= persistenceSweeps && nowMs - parseMs(firstSeenAt) >= minPersistenceMs),
      affectedSessionIds,
      models,
    };
  }

  const activeProviders = sortedUnique(
    Object.values(signatures)
      .filter(streak => streak.confirmed)
      .map(streak => streak.provider),
  );
  const generations = { ...(previous.generations ?? {}) };
  const previouslyActive = new Set(previous.activeProviders ?? []);
  for (const provider of activeProviders) {
    if (!previouslyActive.has(provider)) generations[provider] = (generations[provider] ?? 0) + 1;
  }
  const state: ProviderOutageState = { signatures, generations, activeProviders };
  const anomalies: WardenAnomaly[] = [];
  for (const provider of activeProviders) {
    const confirmed = Object.values(signatures).filter(streak => streak.confirmed && streak.provider === provider);
    const confirmedKeys = new Set(confirmed.map(streak => streak.signature));
    const current = [...grouped.entries()]
      .filter(([signature]) => confirmedKeys.has(signature))
      .flatMap(([, items]) => items);
    const uniqueCurrent = [...new Map(current.map(item => [item.sessionId, item])).values()];
    if (uniqueCurrent.length === 0) continue;
    const affectedSessionIds = sortedUnique(uniqueCurrent.map(item => item.sessionId));
    const failureClasses = sortedUnique(confirmed.map(streak => streak.failureClass));
    const models = sortedUnique(confirmed.flatMap(streak => streak.models));
    // Prefer a normal target over a warden as the per-session Attention anchor,
    // then make the choice deterministic so churn does not randomize reports.
    const representative = [...uniqueCurrent].sort((a, b) => {
      const aw = a.label === 'kteam-warden' ? 1 : 0;
      const bw = b.label === 'kteam-warden' ? 1 : 0;
      return aw - bw || a.sessionId.localeCompare(b.sessionId);
    })[0]!;
    const reasons = failureClasses.map(reasonLabel).join(' + ');
    const modelDetail = models.length ? `; model${models.length === 1 ? '' : 's'} ${models.join(', ')}` : '';
    const firstSeenAt = confirmed.map(streak => streak.firstSeenAt).sort((a, b) => parseMs(a) - parseMs(b))[0]!;
    const consecutiveSweeps = Math.min(...confirmed.map(streak => streak.consecutiveSweeps));
    anomalies.push({
      kind: 'provider_unavailable',
      fleetKey: `provider:${provider}`,
      generation: generations[provider] ?? 1,
      provider,
      affectedSessionIds,
      failureClasses,
      models,
      sessionId: representative.sessionId,
      teammate: representative.teammate,
      label: representative.label,
      status: representative.status,
      detail:
        `provider ${provider} is unavailable in ${affectedSessionIds.length} active auto session` +
        `${affectedSessionIds.length === 1 ? '' : 's'} (${reasons}${modelDetail}); ` +
        `persisted across ${consecutiveSweeps} deterministic sweeps for ${durationLabel(nowMs - parseMs(firstSeenAt))}`,
      since: firstSeenAt,
    });
  }
  return { state, anomalies };
}

/** Convenience for the sweep: classify eligible snapshots, then reduce them. */
export function detectProviderOutages(
  previous: ProviderOutageState,
  views: readonly ProviderSnapshotView[],
  nowMs: number,
  options: ProviderOutageOptions = {},
): ProviderOutageResult {
  const eligible = providerEligibleSessionIds(views);
  const observations = views
    .filter(view => eligible.has(view.config.id))
    .map(view => providerFailureFromSnapshot(view, options))
    .filter((value): value is ProviderFailureObservation => value !== undefined);
  return reduceProviderOutages(previous, observations, nowMs, options);
}
