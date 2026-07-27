// The Learning subsystem's data model — the atoms of evidence and the proposals
// that are views over them. Phase 1 ships CATEGORY 1 (global) ONLY. The types
// keep a couple of forward-compatible unions (extra states/kinds) so a phase-2
// aggregator does not have to rewrite the on-disk shape, but nothing in phase 1
// ever WRITES a value outside the phase-1 subset.
//
// The one invariant these types exist to protect: a proposal is a *view over
// verified observations*, never free-standing LLM text. `observationIds` is the
// only link to evidence, and `occurrences`/`crossRepoCount` are COMPUTED by the
// daemon from those observations — the LLM never asserts a count. See
// learning-store.ts (verification + recompute) for the enforcement.

/** Learning subsystem config. Declared HERE (not daemon-config.ts) so the whole
 *  learning module type-checks on its own, independent of concurrent edits to
 *  the shared daemon config. The daemon-config integration (adding this to
 *  DaemonConfig + defaults + deep-merge) is a small wiring patch the lead
 *  applies — see learning.patch.md. Ships OFF by default; apply is ALWAYS manual
 *  in phase 1 regardless of this flag. */
export interface LearningConfig {
  enabled: boolean;
  /** Auto-mode wrapper the miner sessions run under (Opus-class per the routing
   *  table). */
  wrapper: string;
  model?: string;
  intervalMinutes: number;
  /** Sessions per miner session (batch). */
  batchSize: number;
  /** Max miner sessions spawned per run (cost ceiling). */
  maxMinersPerRun: number;
  /** Max sessions scanned per run — bounds a backfill. */
  maxSessionsPerRun: number;
  minSpawnGapMinutes: number;
}

export const defaultLearningConfig = (): LearningConfig => ({
  enabled: false,
  wrapper: 'claude-auto-atomi',
  intervalMinutes: 720,
  batchSize: 25,
  maxMinersPerRun: 4,
  maxSessionsPerRun: 200,
  minSpawnGapMinutes: 180,
});

export type ObservationKind = 'correction' | 'roadblock' | 'preference' | 'recurring_task' | 'tooling_failure';

/** Who produced the human-signal text. A lead/peer steer (channel/inbox with
 *  `from` set) is itself an agent, so the UI labels it "teammate steer" and it
 *  counts at half weight vs a real human message (design §12.1). */
export type ObservationSource = 'human' | 'teammate';

export interface Observation {
  /** Content hash of (sessionId, quote, gist) — makes appends idempotent. */
  id: string;
  sessionId: string;
  teammate?: string;
  mode: 'interactive' | 'auto';
  /** The session's launch cwd, verbatim. */
  cwd: string;
  /** git-toplevel of `cwd` when resolvable, else `cwd`. Distinct `repo` values
   *  are what "seen in N repos" (cross-repo strength) is computed from. */
  repo: string;
  /** Session finishedAt (or extraction time) — the observation's timeline slot. */
  at: string;
  kind: ObservationKind;
  gist: string;
  /** VERBATIM user text, ≤300 chars. Substring-verified against the transcript
   *  by the daemon before this record is ever written; an unverifiable quote is
   *  dropped and counted, never stored. */
  quote: string;
  source: ObservationSource;
  /** Always true on disk — an unverified observation is never appended. The
   *  field is explicit so a future reader can trust it without re-deriving. */
  verified: true;
  /** The run that produced it (provenance / debugging). */
  runId: string;
}

/** Phase 1 is global-only. The union keeps room for phase 2+ categories. */
export type ProposalCategory = 'global' | 'repo' | 'skill' | 'audit';

/** Phase 1 uses pending | accepted | rejected. The rest are declared so the
 *  type is stable across phases; phase 1 never sets them. */
export type ProposalState =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'compacted'
  | 'approved'
  | 'applied'
  | 'superseded'
  | 'blocked';

export interface ProposalTarget {
  /** Phase 1: the two kfleet global-rule files. */
  kind: 'kfleet-claude-md' | 'kfleet-auto-md';
  /** Repo-relative path of the target file (`kfleet/CLAUDE.md` etc.). */
  path: string;
  /** Heading the rule belongs under, best-effort ('## Agent rules' etc.). */
  anchor?: string;
}

export interface ProposalHistoryEntry {
  at: string;
  event: string;
  by: 'miner' | 'user' | 'agent';
  note?: string;
}

export interface Proposal {
  id: string;
  category: ProposalCategory;
  state: ProposalState;
  title: string;
  ruleText: string;
  target: ProposalTarget;
  /** The ONLY link to evidence. Every id must resolve to a stored observation. */
  observationIds: string[];
  /** COMPUTED: distinct sessionId across observationIds. Never LLM-asserted. */
  occurrences: number;
  /** COMPUTED: distinct repo across observationIds. A global rule seen in one
   *  repo only is visibly suspect. */
  crossRepoCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Stable kebab slug for dedup and tombstone matching. */
  identity: string;
  history: ProposalHistoryEntry[];
}

/** Rejected-rule identity. Rejection is permanent: dual enforcement (aggregator
 *  prompt + deterministic post-filter, see learning-store.matchesTombstone). */
export interface Tombstone {
  identity: string;
  titleHash: string;
  ruleGist: string;
  rejectedAt: string;
  note?: string;
}

/** Watermark + scheduler bookkeeping (like warden/state.json). The cursor is
 *  `(watermarkAt, watermarkId)` = the (finishedAt, sessionId) of the newest
 *  session already scanned; re-runs are idempotent because observation ids are
 *  content hashes. */
export interface LearningState {
  watermarkAt?: string;
  watermarkId?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastSpawnAt?: string;
  /** Set while a run holds the chain; cleared when it finishes. */
  runningRunId?: string;
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  sessionsScanned: number;
  sessionsWithSignal: number;
  minerSessions: string[];
  aggregatorSession?: string;
  /** Raw observation count the miners CLAIMED (pre-verification). */
  observationsProposed: number;
  observationsVerified: number;
  /** Quotes dropped because they did not literally appear in the transcript. */
  rejectedQuotes: number;
  /** Miner output files quarantined for bad JSON shape. */
  malformedFiles: number;
  proposalsCreated: number;
  proposalsStrengthened: number;
  proposalsSuppressedByTombstone: number;
  /** Per-harness extraction coverage (codex streams are thinner — stated, not
   *  hidden, per design §7.4). */
  perHarness: { claude: number; codex: number };
  message?: string;
}

// ---- API / UI view types ----

/** An evidence row as the UI renders it: the verified quote plus attribution. */
export interface EvidenceView {
  observationId: string;
  sessionId: string;
  teammate?: string;
  repo: string;
  at: string;
  quote: string;
  source: ObservationSource;
  kind: ObservationKind;
}

/** A proposal joined to its resolved, verified evidence, ready to render. */
export interface ProposalView extends Proposal {
  evidence: EvidenceView[];
}

export interface LearningStatusView {
  enabled: boolean;
  intervalMinutes: number;
  watermarkAt?: string;
  lastRunAt?: string;
  /** Pending proposal counts by strength bucket (design §7.2). */
  pending: { total: number; strong: number; weak: number };
  totals: { observations: number; proposals: number; tombstones: number };
  running: boolean;
  lastRun?: RunManifest;
}
