// Fleet-wide Warden Attention projection.
//
// A READ-ONLY view over the existing per-session Attention boards, joined with
// the warden's recent verdicts, current anomalies, and the daemon's warden
// assignment/queue/failover state. It answers exactly two human questions:
//
//   - which agent needs the human
//   - why
//
// It is a VIEW, not a second Attention store. It never writes attention data and
// never invents a new resolution workflow — acting on an item happens on the
// per-session surface reachable via the row's session id.
//
// Two halves live here:
//   - `buildWardenAttentionView` — a PURE aggregator (no I/O, no clock).
//   - `WardenAttentionProvider`  — the I/O shell that reads the boards/state
//     with bounded concurrency and a short cache suitable for a 30 s poll.

import { readFile, stat } from 'fs/promises';
import { attentionFile, parseAttentionFile } from './attention-store';
import type { AttentionBy, AttentionItem, AttentionSource } from './attention-types';
import { readJson } from './io';
import type { KTeamPaths } from './paths';
import type { WardenAnomaly, WardenAnomalyKind } from './warden-detect';
import {
  parseWardenAnomalyKind,
  parseWardenVerdictSourceRef,
  type WardenVerdict,
  type WardenVerdictKind,
  type WardenVerdictSourceIdentity,
} from './warden-verdicts';

/** Whether the warden reached a trustworthy judgement for a waiting agent, and
 *  if not, WHY not — so silence can never render a flagged agent as fine. */
export type WardenJudgementState = 'judged' | 'pending' | 'queued' | 'failed' | 'none';

/** Who ran the check and with what, when the report carried provenance. Every
 *  field is optional: old reports predate the sidecar and carry none. */
export interface WardenJudgeProvenance {
  wardenSessionId?: string;
  /** The wrapper/account that actually ran (the CLI). */
  wrapper?: string;
  /** Explicit `--model`, else the wrapper default when only a hint is known. */
  model?: string;
  harness?: string;
}

export interface WardenJudgement {
  state: WardenJudgementState;
  /** The classified verdict, when a report exists. `unknown` maps to `failed`. */
  verdict?: WardenVerdictKind;
  /** The verdict reason, or an explicit sentence for a non-judged state. Never
   *  blank: a state with no human-readable why is worse than useless. */
  reason: string;
  judgedBy?: WardenJudgeProvenance;
  /** When the judgement (or the failure it stands in for) is anchored, ISO. */
  at?: string;
  /** Only present when a report file actually exists. */
  reportPath?: string;
  /** The verdict predates this waiting item — it judged an earlier situation. */
  stale?: boolean;
}

/** `warden-anomaly` marks a synthetic row for a current anomaly with no board
 *  record — surfaced so a pending/queued/failed/unjudged agent is never silent. */
export type FleetAttentionSource = AttentionSource | 'warden-anomaly';

export interface FleetAttentionItem {
  sessionId: string;
  teammate?: string;
  label?: string;
  sessionStatus?: string;
  /** Attention id (e.g. `A3`), or `anomaly:<kind>:<sessionId>` for a synthetic. */
  id: string;
  source: FleetAttentionSource;
  subject: string;
  why: string;
  /** ISO — oldest waiting first across the whole fleet. */
  waitingSince: string;
  howToResolve: string;
  raisedBy?: AttentionBy;
  raisedByName?: string;
  judgement: WardenJudgement;
  /** True for a synthesized anomaly row (no Attention board record). */
  fromAnomaly?: boolean;
  /** Set for a provider-wide anomaly, expanded to each affected session. */
  provider?: string;
}

/** Distinguishes the four no-different-rows situations that must never collapse
 *  into one another:
 *   - `items`       — rows exist; someone needs the human.
 *   - `clean-sweep` — a sweep ran, every board read cleanly, nothing is waiting.
 *   - `degraded`    — a sweep ran but a board could not be read, so a waiting
 *                     agent may be HIDDEN. Never a clean all-clear.
 *   - `no-sweep`    — no sweep/judgement yet; we simply do not know. */
export type WardenAttentionOutcome = 'items' | 'clean-sweep' | 'degraded' | 'no-sweep';

export interface WardenAttentionView {
  generatedAt: string;
  lastSweepAt?: string;
  outcome: WardenAttentionOutcome;
  /** Fleet-level degraded banner: exhaustion or an overdue sweep. */
  wardenDegraded?: { since?: string; reason: string };
  /** Oldest waiting first. */
  items: FleetAttentionItem[];
  /** Boards that could not be fully read — surfaced instead of vanishing. */
  boardsWithParseErrors: { sessionId: string; parseErrors: number }[];
  /** Finite recent-verdict coverage used for every judgement on this view. */
  verdictCoverage: WardenVerdictCoverage;
}

export interface WardenVerdictCoverage {
  /** Verdicts visible to this Attention projection. */
  limit: number;
  /** True when at least one older verdict exists outside the visible window. */
  truncated: boolean;
}

/** Minimal shape the builder needs from a session view — structurally satisfied
 *  by `SessionView` so the daemon can pass `manager.list()` straight through. */
export interface FleetSessionLike {
  config: { id: string; teammate?: string; name?: string; label?: string };
  state: { status?: string };
}

/** One session's parsed board, as the I/O shell hands it to the builder. */
export interface AttentionBoardInput {
  sessionId: string;
  parseErrors: number;
  items: AttentionItem[];
}

/** The slice of the durable warden `state.json` the projection consumes. The
 *  provider flattens `failover.exhaustedSince` up so the builder stays flat. */
export interface WardenAttentionState {
  lastSweepAt?: string;
  /** Live assigned wardens, keyed by TARGET session id. Only the recorded
   *  anomaly kinds (or exact report path) are pending for Attention. */
  assignments?: Record<
    string,
    {
      wardenId?: string;
      kinds?: WardenAnomalyKind[];
      reportPath?: string;
    }
  >;
  /** Sus targets deferred to a queue this sweep. */
  assignedQueue?: { sessionId?: string; kind?: WardenAnomalyKind }[];
  /** Set while EVERY warden account is ineligible — no judgement can be reached. */
  exhaustedSince?: string;
}

export interface WardenAttentionInput {
  /** Wall-clock ms — injected so the builder stays pure/deterministic. */
  now: number;
  sessions: FleetSessionLike[];
  boards: AttentionBoardInput[];
  verdicts: WardenVerdict[];
  verdictCoverage?: WardenVerdictCoverage;
  anomalies: WardenAnomaly[];
  wardenState: WardenAttentionState;
  /** Sweep cadence; a sweep older than 3× this is flagged degraded. */
  sweepIntervalMinutes?: number;
}

const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
export const WARDEN_ATTENTION_VERDICT_LIMIT = 100;

type WardenVerdictMatch = WardenVerdictSourceIdentity;

const anomalyKey = (sessionId: string, kind: WardenAnomalyKind): string => `${sessionId}\u0000${kind}`;
const reportKey = (sessionId: string, reportPath: string): string => `${sessionId}\u0000${reportPath}`;
const reportBlockKey = (sessionId: string, reportPath: string, kind: WardenAnomalyKind): string =>
  `${sessionId}\u0000${reportPath}\u0000${kind}`;

function verdictMatchForItem(item: AttentionItem): WardenVerdictMatch | undefined {
  if (item.source === 'question') return { anomalyKind: 'unattended_question' };
  // Only daemon-created agent-raised rows carry warden/provider identities.
  // Task, permission, and free-form rows have no verdict selector even when a
  // coincidental sourceRef happens to resemble one.
  if (item.source !== 'agent-raised') return undefined;
  const sourceRef = item.sourceRef;
  if (sourceRef?.startsWith('provider-unavailable:')) return { anomalyKind: 'provider_unavailable' };
  if (sourceRef?.startsWith('warden:')) return parseWardenVerdictSourceRef(sourceRef);
  return undefined;
}

const isMissingPath = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/** Outcome-first, short subject per anomaly kind (ADHD-friendly). */
const ANOMALY_SUBJECT: Record<WardenAnomalyKind, string> = {
  dead_monitor: 'Session lost its monitor',
  unattended_question: 'A question is waiting',
  abandoned_wreckage: 'A finished session looks abandoned',
  quota_reset_passed: 'Quota reset — session can resume',
  declared_wait_overdue: 'A declared wait is overdue',
  peer_wait_unanswerable: 'A peer wait cannot be answered',
  sus_thinking: 'Session may be stuck thinking',
  sus_subprocess: 'Session stuck in a subprocess',
  bootstrap_degraded: 'Session bootstrap is degraded',
  provider_unavailable: 'Provider is unavailable',
};

const parseMs = (value: string | undefined): number => {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
};

/** Who ran the check, from the report's daemon-written sidecar. Old reports
 *  predate the sidecar and carry no `spawn` — the projection still judges them,
 *  it simply cannot name the account/model. */
function provenanceOf(verdict: WardenVerdict): WardenJudgeProvenance | undefined {
  const spawn = verdict.spawn;
  if (!spawn) return undefined;
  const out: WardenJudgeProvenance = {};
  if (spawn.wardenSessionId) out.wardenSessionId = spawn.wardenSessionId;
  if (spawn.wrapper) out.wrapper = spawn.wrapper;
  if (spawn.model) out.model = spawn.model;
  if (spawn.harness) out.harness = spawn.harness;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Fleet-wide Warden Attention projection. Pure: everything comes in through
 *  the argument; nothing is read, written, or clocked here. */
export function buildWardenAttentionView(input: WardenAttentionInput): WardenAttentionView {
  const { now, sessions, boards, verdicts, anomalies, wardenState } = input;
  const verdictCoverage = input.verdictCoverage ?? {
    limit: WARDEN_ATTENTION_VERDICT_LIMIT,
    truncated: false,
  };

  const sessionsById = new Map(sessions.map(s => [s.config.id, s]));
  const assignedAnomalies = new Set<string>();
  const assignedReports = new Set<string>();
  for (const [sessionId, assignment] of Object.entries(wardenState.assignments ?? {})) {
    for (const rawKind of assignment?.kinds ?? []) {
      const kind = parseWardenAnomalyKind(rawKind);
      if (kind) assignedAnomalies.add(anomalyKey(sessionId, kind));
    }
    if (assignment?.reportPath) assignedReports.add(reportKey(sessionId, assignment.reportPath));
  }
  const queuedAnomalies = new Set<string>();
  for (const queued of wardenState.assignedQueue ?? []) {
    const kind = parseWardenAnomalyKind(queued?.kind);
    if (queued?.sessionId && kind) queuedAnomalies.add(anomalyKey(queued.sessionId, kind));
  }
  const exhaustedSince = wardenState.exhaustedSince;

  // Verdict identity is exact: target + anomaly kind, or target + report path.
  // A session-wide index would let one incident judge unrelated task/question
  // rows and would hide simultaneous anomaly classes.
  const newestByAnomaly = new Map<string, WardenVerdict>();
  const newestByReport = new Map<string, WardenVerdict>();
  const newestByReportBlock = new Map<string, WardenVerdict>();
  const keepNewest = (index: Map<string, WardenVerdict>, key: string, verdict: WardenVerdict): void => {
    const previous = index.get(key);
    if (!previous || parseMs(verdict.at) > parseMs(previous.at)) index.set(key, verdict);
  };
  for (const verdict of verdicts) {
    const id = verdict.targetSession;
    if (!id) continue;
    const exactReportKey = reportKey(id, verdict.reportPath);
    const previousReport = newestByReport.get(exactReportKey);
    // fleet.needs_human emits only for a NEEDS_HUMAN block. When one fleet
    // report contains multiple blocks for the same session, sourceRef cannot
    // identify the block; prefer the first needs-human entry, matching
    // reconcileNeedsHuman(), rather than attaching a cleared sibling.
    if (
      !previousReport ||
      parseMs(verdict.at) > parseMs(previousReport.at) ||
      (parseMs(verdict.at) === parseMs(previousReport.at) &&
        previousReport.verdict !== 'needs_human' &&
        verdict.verdict === 'needs_human')
    )
      newestByReport.set(exactReportKey, verdict);
    if (verdict.anomalyKind) {
      keepNewest(newestByAnomaly, anomalyKey(id, verdict.anomalyKind), verdict);
      keepNewest(newestByReportBlock, reportBlockKey(id, verdict.reportPath, verdict.anomalyKind), verdict);
    }
  }

  const matchingVerdict = (sessionId: string, match: WardenVerdictMatch | undefined): WardenVerdict | undefined => {
    if (!match) return undefined;
    if (match.reportPath && match.anomalyKind)
      return newestByReportBlock.get(reportBlockKey(sessionId, match.reportPath, match.anomalyKind));
    if (match.anomalyKind) return newestByAnomaly.get(anomalyKey(sessionId, match.anomalyKind));
    if (match.reportPath) return newestByReport.get(reportKey(sessionId, match.reportPath));
    return undefined;
  };

  const computeJudgement = (
    sessionId: string,
    match: WardenVerdictMatch | undefined,
    waitingSince?: string,
  ): WardenJudgement => {
    const verdict = matchingVerdict(sessionId, match);
    if (verdict) {
      const judgedBy = provenanceOf(verdict);
      if (verdict.verdict === 'unknown') {
        return {
          state: 'failed',
          verdict: 'unknown',
          reason: verdict.reason ?? 'The warden report could not be classified.',
          ...(judgedBy ? { judgedBy } : {}),
          at: verdict.at,
          ...(verdict.reportPath ? { reportPath: verdict.reportPath } : {}),
        };
      }
      // A warden:<reportPath> row was created by that exact report. Its board
      // timestamp may trail the report by milliseconds; identity beats that
      // generic stale heuristic. Kind matches still use time to detect a new
      // recurrence of the same anomaly class.
      const stale =
        match?.anomalyKind !== undefined &&
        match.reportPath === undefined &&
        waitingSince !== undefined &&
        parseMs(verdict.at) < parseMs(waitingSince);
      return {
        state: 'judged',
        verdict: verdict.verdict,
        reason: verdict.reason ?? 'A warden reached a verdict on this session.',
        ...(judgedBy ? { judgedBy } : {}),
        at: verdict.at,
        ...(verdict.reportPath ? { reportPath: verdict.reportPath } : {}),
        ...(stale ? { stale: true } : {}),
      };
    }
    // An ordinary task/permission/free-form row has no warden identity. It must
    // not inherit session-wide pending, queued, exhaustion, or truncation state.
    if (!match) return { state: 'none', reason: 'No matching warden judgement applies to this attention item.' };
    const assigned =
      match.reportPath && match.anomalyKind
        ? assignedReports.has(reportKey(sessionId, match.reportPath)) &&
          assignedAnomalies.has(anomalyKey(sessionId, match.anomalyKind))
        : match.anomalyKind
          ? assignedAnomalies.has(anomalyKey(sessionId, match.anomalyKind))
          : match.reportPath
            ? assignedReports.has(reportKey(sessionId, match.reportPath))
            : false;
    if (assigned) return { state: 'pending', reason: 'A warden is investigating this anomaly now.' };
    if (match.anomalyKind && queuedAnomalies.has(anomalyKey(sessionId, match.anomalyKind)))
      return { state: 'queued', reason: 'This anomaly is queued for a warden.' };
    if (exhaustedSince) {
      return {
        state: 'failed',
        reason: 'No warden could run — every warden account is exhausted.',
        at: exhaustedSince,
      };
    }
    if (verdictCoverage.truncated) {
      return {
        state: 'none',
        reason: `No matching judgement was found in the recent ${verdictCoverage.limit}-verdict window.`,
      };
    }
    return { state: 'none', reason: 'No matching warden judgement yet.' };
  };

  const items: FleetAttentionItem[] = [];
  const coveredAnomalies = new Set<string>();

  // 1) Every open Attention board item — the fleet-wide "who needs the human".
  for (const board of boards) {
    for (const item of board.items) {
      const match = verdictMatchForItem(item);
      const exactVerdict = matchingVerdict(board.sessionId, match);
      if (match?.anomalyKind) coveredAnomalies.add(anomalyKey(board.sessionId, match.anomalyKind));
      if (match?.reportPath && !match.anomalyKind && exactVerdict?.anomalyKind)
        coveredAnomalies.add(anomalyKey(board.sessionId, exactVerdict.anomalyKind));
      const s = sessionsById.get(board.sessionId);
      const row: FleetAttentionItem = {
        sessionId: board.sessionId,
        ...((s?.config.teammate ?? s?.config.name) ? { teammate: s?.config.teammate ?? s?.config.name } : {}),
        ...(s?.config.label ? { label: s.config.label } : {}),
        ...(s?.state.status ? { sessionStatus: s.state.status } : {}),
        id: item.id,
        source: item.source,
        subject: item.subject,
        why: item.why,
        waitingSince: item.waitingSince,
        howToResolve: item.howToResolve,
        raisedBy: item.raisedBy,
        ...(item.raisedByName ? { raisedByName: item.raisedByName } : {}),
        judgement: computeJudgement(board.sessionId, match, item.waitingSince),
      };
      if (item.sourceRef?.startsWith('provider-unavailable:')) row.provider = item.sourceRef.split(':')[1];
      items.push(row);
    }
  }

  // 2) Current anomalies with no board record, expanded to affected sessions —
  //    but only when the warden did NOT reach a confident judgement, so a
  //    cleared anomaly stays quiet while a pending/queued/failed/unjudged one
  //    can never silently read as fine.
  const seenAnomalyRows = new Set<string>();
  for (const anomaly of anomalies) {
    const targets =
      anomaly.kind === 'provider_unavailable'
        ? [anomaly.sessionId, ...(anomaly.affectedSessionIds ?? [])].filter(
            (v, i, all): v is string => !!v && all.indexOf(v) === i,
          )
        : [anomaly.sessionId];
    for (const target of targets) {
      if (!target || coveredAnomalies.has(anomalyKey(target, anomaly.kind))) continue;
      const rowId = `anomaly:${anomaly.kind}:${target}`;
      if (seenAnomalyRows.has(rowId)) continue;
      const judgement = computeJudgement(target, { anomalyKind: anomaly.kind }, anomaly.since);
      // A CURRENT judgement covers the anomaly and stays quiet. A stale verdict
      // (it judged an earlier situation) does NOT — surface the anomaly with the
      // stale verdict attached so a re-flagged agent never reads as fine.
      // A current non-human-action verdict covers the anomaly. `needs_human`
      // is the opposite: surface it until the existing Attention source has
      // persisted its board row, otherwise a delayed/failed source write can
      // briefly turn the warden's explicit request into a false all-clear.
      if (judgement.state === 'judged' && judgement.verdict !== 'needs_human' && !judgement.stale) continue;
      seenAnomalyRows.add(rowId);
      const s = sessionsById.get(target);
      items.push({
        sessionId: target,
        ...((s?.config.teammate ?? s?.config.name ?? anomaly.teammate)
          ? { teammate: s?.config.teammate ?? s?.config.name ?? anomaly.teammate }
          : {}),
        ...((s?.config.label ?? anomaly.label) ? { label: s?.config.label ?? anomaly.label } : {}),
        ...((s?.state.status ?? anomaly.status) ? { sessionStatus: s?.state.status ?? anomaly.status } : {}),
        id: rowId,
        source: 'warden-anomaly',
        subject: ANOMALY_SUBJECT[anomaly.kind] ?? 'A warden flagged this session',
        why: anomaly.detail,
        waitingSince: anomaly.since ?? wardenState.lastSweepAt ?? new Date(now).toISOString(),
        howToResolve: 'Open the session and decide what to do.',
        judgement,
        fromAnomaly: true,
        ...(anomaly.provider ? { provider: anomaly.provider } : {}),
      });
    }
  }

  // Oldest waiting first; deterministic tie-break so the order is stable.
  items.sort(
    (a, b) =>
      parseMs(a.waitingSince) - parseMs(b.waitingSince) ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.id.localeCompare(b.id),
  );

  const boardsWithParseErrors = boards
    .filter(b => b.parseErrors > 0)
    .map(b => ({ sessionId: b.sessionId, parseErrors: b.parseErrors }));
  const hasUnreadableBoards = boardsWithParseErrors.length > 0;

  const intervalMinutes = input.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES;
  const sweepStale =
    wardenState.lastSweepAt !== undefined && now - parseMs(wardenState.lastSweepAt) > intervalMinutes * 3 * 60_000;

  let wardenDegraded: WardenAttentionView['wardenDegraded'];
  if (exhaustedSince) {
    wardenDegraded = {
      since: exhaustedSince,
      reason: 'All warden accounts are exhausted — new judgements are paused.',
    };
  } else if (sweepStale) {
    wardenDegraded = {
      ...(wardenState.lastSweepAt ? { since: wardenState.lastSweepAt } : {}),
      reason: 'Warden sweeps are overdue — judgements may be out of date.',
    };
  } else if (hasUnreadableBoards) {
    wardenDegraded = { reason: 'Some Attention boards could not be read — a waiting agent may be hidden.' };
  }

  // An unreadable board can HIDE a waiting agent, so a sweep with parse errors
  // and no visible rows must NOT read as a clean all-clear — that would tell the
  // human "no one needs you" over a board we could not open. Downgrade to
  // `degraded` instead; `no-sweep` stays reserved for "no sweep ran at all".
  const outcome: WardenAttentionOutcome =
    items.length > 0 ? 'items' : wardenDegraded ? 'degraded' : wardenState.lastSweepAt ? 'clean-sweep' : 'no-sweep';

  return {
    generatedAt: new Date(now).toISOString(),
    ...(wardenState.lastSweepAt ? { lastSweepAt: wardenState.lastSweepAt } : {}),
    outcome,
    ...(wardenDegraded ? { wardenDegraded } : {}),
    items,
    boardsWithParseErrors,
    verdictCoverage,
  };
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

export interface WardenAttentionProviderDeps {
  paths: KTeamPaths;
  list: () => Promise<FleetSessionLike[]>;
  /** Recent warden verdicts, newest first, WITH provenance sidecars attached.
   *  Attention requests 101 through the manager, exposes only the newest 100,
   *  and uses the sentinel solely to report truncation. The manager's default
   *  remains 20 for existing API/UI consumers. Going through the manager also
   *  keeps daemon-owned spawn provenance attached. */
  verdicts: (limit: number) => Promise<WardenVerdict[]>;
  /** Current fleet anomalies. */
  anomalies: () => Promise<WardenAnomaly[]>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Cache TTL — a 30 s browser poll should mostly hit the cache. */
  cacheTtlMs?: number;
  /** Bounded board-read fan-out over ~1000 session dirs. */
  concurrency?: number;
  /** Live getter keeps hot warden-config changes from leaving staleness checks
   *  pinned to the daemon's startup value. A number remains valid for tests. */
  sweepIntervalMinutes?: number | (() => number | Promise<number>);
}

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_CONCURRENCY = 16;

/** Reads the boards/state on demand and hands them to the pure builder. Absent
 *  boards are skipped without a read; a short cache and in-flight coalescing
 *  keep a 30 s poll over a large fleet cheap. */
export class WardenAttentionProvider {
  private readonly ttl: number;
  private readonly concurrency: number;
  private cache?: { at: number; view: WardenAttentionView };
  private inflight?: Promise<WardenAttentionView>;

  constructor(private readonly deps: WardenAttentionProviderDeps) {
    this.ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  }

  async view(): Promise<WardenAttentionView> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cache && now - this.cache.at < this.ttl) return this.cache.view;
    if (this.inflight) return this.inflight;
    this.inflight = this.build(now).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async build(now: number): Promise<WardenAttentionView> {
    // Do NOT swallow a fleet-list, verdict, or anomaly failure into an empty
    // array: an empty view with a recorded sweep reads as a clean sweep, which
    // would tell the human "nothing needs you" when the truth is "we could not
    // check". Let the failure propagate so the API/UI shows an explicit error.
    const [sessions, fetchedVerdicts, anomalies, wardenState, sweepIntervalMinutes] = await Promise.all([
      this.deps.list(),
      this.deps.verdicts(WARDEN_ATTENTION_VERDICT_LIMIT + 1),
      this.deps.anomalies(),
      this.readState(),
      typeof this.deps.sweepIntervalMinutes === 'function'
        ? this.deps.sweepIntervalMinutes()
        : this.deps.sweepIntervalMinutes,
    ]);
    const verdicts = fetchedVerdicts.slice(0, WARDEN_ATTENTION_VERDICT_LIMIT);
    const verdictCoverage: WardenVerdictCoverage = {
      limit: WARDEN_ATTENTION_VERDICT_LIMIT,
      truncated: fetchedVerdicts.length > WARDEN_ATTENTION_VERDICT_LIMIT,
    };
    const boards = await this.readBoards(sessions);
    const view = buildWardenAttentionView({
      now,
      sessions,
      boards,
      verdicts,
      verdictCoverage,
      anomalies,
      wardenState,
      ...(sweepIntervalMinutes !== undefined ? { sweepIntervalMinutes } : {}),
    });
    this.cache = { at: now, view };
    return view;
  }

  private async readState(): Promise<WardenAttentionState> {
    type RawWardenState = {
      lastSweepAt?: string;
      assignments?: WardenAttentionState['assignments'];
      assignedQueue?: WardenAttentionState['assignedQueue'];
      failover?: { exhaustedSince?: string };
    };
    // state.json legitimately absent = no sweep yet: an empty object here yields
    // outcome `no-sweep`, distinct from the fail-loud list/verdict/anomaly path.
    const raw = await readJson<RawWardenState>(this.deps.paths.wardenState).catch(error => {
      if (isMissingPath(error)) return {} as RawWardenState;
      throw error;
    });
    return {
      ...(raw.lastSweepAt ? { lastSweepAt: raw.lastSweepAt } : {}),
      ...(raw.assignments ? { assignments: raw.assignments } : {}),
      ...(raw.assignedQueue ? { assignedQueue: raw.assignedQueue } : {}),
      ...(raw.failover?.exhaustedSince ? { exhaustedSince: raw.failover.exhaustedSince } : {}),
    };
  }

  private async readBoards(sessions: FleetSessionLike[]): Promise<AttentionBoardInput[]> {
    const boards: AttentionBoardInput[] = [];
    await mapWithConcurrency(sessions, this.concurrency, async s => {
      const id = s.config.id;
      const file = attentionFile(this.deps.paths, id);
      try {
        await stat(file);
      } catch (error) {
        if (isMissingPath(error)) return; // absent board: no content read
        // Present/inaccessible path: surface the unknown instead of treating it
        // as absence and potentially producing a clean sweep.
        boards.push({ sessionId: id, parseErrors: 1, items: [] });
        return;
      }
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) {
        // Present but unreadable — surface as a degraded board, never as clean.
        boards.push({ sessionId: id, parseErrors: 1, items: [] });
        return;
      }
      const parsed = parseAttentionFile(text, id);
      if (parsed.file.items.length > 0 || parsed.parseErrors > 0) {
        boards.push({ sessionId: id, parseErrors: parsed.parseErrors, items: parsed.file.items });
      }
    });
    return boards;
  }
}
