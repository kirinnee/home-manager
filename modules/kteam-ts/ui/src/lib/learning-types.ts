// UI-side mirror of the daemon's learning view types (src/learning-types.ts).
// Kept in its OWN file (not ui/src/types.ts) so the Learning slice never touches
// a file another teammate owns. These are structural mirrors — the daemon is the
// source of truth; keep them in sync when the API view types change.

export type ObservationKind = 'correction' | 'roadblock' | 'preference' | 'recurring_task' | 'tooling_failure';
export type ObservationSource = 'human' | 'teammate';
export type ProposalCategory = 'global' | 'repo' | 'skill' | 'audit';
export type ProposalState =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'compacted'
  | 'approved'
  | 'applied'
  | 'superseded'
  | 'blocked';

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

export interface ProposalTarget {
  kind: 'kfleet-claude-md' | 'kfleet-auto-md';
  path: string;
  anchor?: string;
}

export interface ProposalView {
  id: string;
  category: ProposalCategory;
  state: ProposalState;
  title: string;
  ruleText: string;
  target: ProposalTarget;
  observationIds: string[];
  occurrences: number;
  crossRepoCount: number;
  firstSeen: string;
  lastSeen: string;
  identity: string;
  evidence: EvidenceView[];
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  sessionsScanned: number;
  sessionsWithSignal: number;
  minerSessions: string[];
  observationsProposed: number;
  observationsVerified: number;
  rejectedQuotes: number;
  malformedFiles: number;
  proposalsCreated: number;
  proposalsStrengthened: number;
  proposalsSuppressedByTombstone: number;
  perHarness: { claude: number; codex: number };
  message?: string;
}

export interface LearningStatusView {
  enabled: boolean;
  intervalMinutes: number;
  watermarkAt?: string;
  lastRunAt?: string;
  pending: { total: number; strong: number; weak: number };
  totals: { observations: number; proposals: number; tombstones: number };
  running: boolean;
  lastRun?: RunManifest;
}

export type Strength = 'weak' | 'normal' | 'strong';
export function strengthOf(occurrences: number): Strength {
  if (occurrences >= 5) return 'strong';
  if (occurrences <= 1) return 'weak';
  return 'normal';
}
