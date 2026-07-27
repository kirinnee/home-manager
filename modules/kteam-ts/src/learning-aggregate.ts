// Aggregation — the deterministic half of stages (C)+(D). Phase 1 collapses the
// miner and aggregator into ONE LLM path (design §11: "ONE miner+aggregator
// path"): a single session per batch emits observations grouped into candidate
// GLOBAL rules, and THIS module — pure, no I/O, no LLM — does the trustworthy
// part:
//
//   1. VERIFY every quote against the session's own corpus. An unverifiable
//      quote is dropped and counted (rejectedQuotes); it never becomes an
//      observation, so a proposal can never cite fabricated evidence.
//   2. COMPUTE ids, repo, occurrence and cross-repo counts from the verified
//      observations — the LLM's asserted counts are discarded.
//   3. Enforce PERMANENT rejection: a candidate matching a tombstone is
//      suppressed (dual enforcement with the aggregator prompt, design §7.3).
//   4. MERGE by identity: a candidate that matches a live proposal strengthens
//      it (observationIds union, counts recomputed) instead of multiplying —
//      the deterministic backstop for "near-duplicate every run" (§10.1).
//
// The manager (learning.ts) owns the I/O around this: reading digests, spawning
// the miner, appending observations, saving proposals.

import type { SessionDigest } from './learning-extract';
import type { Observation, ObservationKind, ObservationSource, Proposal, Tombstone } from './learning-types';
import { matchesTombstone, observationId, recomputeProposal, slugify, verifyQuote } from './learning-store';

/** Raw observation as a miner session emits it (untrusted). */
export interface MinerObservation {
  key: string;
  sessionId: string;
  kind: ObservationKind;
  gist: string;
  quote: string;
  source?: ObservationSource;
}

/** Raw candidate rule as a miner session emits it (untrusted). */
export interface MinerProposal {
  identity?: string;
  title: string;
  ruleText: string;
  /** Which kfleet global file it belongs in. */
  target?: 'claude-md' | 'auto-md';
  anchor?: string;
  observationKeys: string[];
}

export interface MinerOutput {
  observations?: MinerObservation[];
  proposals?: MinerProposal[];
}

export interface AggregateStats {
  observationsProposed: number;
  observationsVerified: number;
  rejectedQuotes: number;
  proposalsCreated: number;
  proposalsStrengthened: number;
  proposalsSuppressedByTombstone: number;
}

export interface AggregateResult {
  /** Verified observations to append (already deduped by the store on write). */
  observations: Observation[];
  /** The full new proposal set (existing merged with new). */
  proposals: Proposal[];
  stats: AggregateStats;
}

const KINDS: ReadonlySet<string> = new Set<ObservationKind>([
  'correction',
  'roadblock',
  'preference',
  'recurring_task',
  'tooling_failure',
]);

function normalizeKind(kind: string): ObservationKind {
  return KINDS.has(kind) ? (kind as ObservationKind) : 'correction';
}

function targetFor(target: MinerProposal['target'], anchor?: string): Proposal['target'] {
  return target === 'auto-md'
    ? { kind: 'kfleet-auto-md', path: 'kfleet/CLAUDE.auto.md', anchor }
    : { kind: 'kfleet-claude-md', path: 'kfleet/CLAUDE.md', anchor: anchor ?? '## Agent rules' };
}

/** Apply one miner session's output. Pure: caller persists `observations` and
 *  `proposals`. `digestsById` provides the per-session verification corpus and
 *  the trustworthy attribution (repo/mode/teammate/at) the LLM cannot fake. */
export function applyMinerOutput(
  existing: Proposal[],
  tombstones: Tombstone[],
  output: MinerOutput,
  digestsById: Map<string, SessionDigest>,
  /** Every observation already on disk, so recompute sees existing evidence
   *  (not just this batch's) when it strengthens a live proposal. */
  knownObservations: Map<string, Observation>,
  runId: string,
  at: string,
): AggregateResult {
  const rawObs = output.observations ?? [];
  const rawProps = output.proposals ?? [];
  const stats: AggregateStats = {
    observationsProposed: rawObs.length,
    observationsVerified: 0,
    rejectedQuotes: 0,
    proposalsCreated: 0,
    proposalsStrengthened: 0,
    proposalsSuppressedByTombstone: 0,
  };

  // (1)+(2) verify quotes, build trustworthy observations keyed by the miner's
  // local key so proposals can resolve to real, verified ids.
  const verifiedByKey = new Map<string, Observation>();
  const verified: Observation[] = [];
  for (const raw of rawObs) {
    const digest = digestsById.get(raw.sessionId);
    if (!digest) {
      stats.rejectedQuotes += 1; // quote for a session not in this batch — untrusted
      continue;
    }
    if (!raw.quote || !verifyQuote(raw.quote, digest.corpus)) {
      stats.rejectedQuotes += 1;
      continue;
    }
    const quote = raw.quote.slice(0, 300);
    const obs: Observation = {
      id: observationId(raw.sessionId, quote, raw.gist ?? ''),
      sessionId: raw.sessionId,
      teammate: digest.teammate,
      mode: digest.mode,
      cwd: digest.cwd,
      repo: digest.repo,
      at: digest.at || at,
      kind: normalizeKind(raw.kind),
      gist: (raw.gist ?? '').slice(0, 400),
      quote,
      // The LLM may hint source, but the digest's own signal is authoritative:
      // a session with no human sends can only carry teammate-steer evidence.
      source: raw.source === 'teammate' || digest.humanMessages === 0 ? 'teammate' : (raw.source ?? 'human'),
      verified: true,
      runId,
    };
    verified.push(obs);
    verifiedByKey.set(raw.key, obs);
    stats.observationsVerified += 1;
  }

  // Index existing live proposals by identity for merge-by-identity.
  const proposals = existing.map(p => ({ ...p }));
  const liveByIdentity = new Map<string, Proposal>();
  for (const p of proposals) {
    if (p.state === 'pending' || p.state === 'accepted') liveByIdentity.set(p.identity, p);
  }
  // Full observation index = everything on disk + this batch's newly verified.
  // recomputeProposal reads counts from here, so existing evidence survives a
  // strengthen and never silently zeroes out.
  const allObsIndex = new Map<string, Observation>(knownObservations);
  for (const o of verified) allObsIndex.set(o.id, o);

  for (const raw of rawProps) {
    const resolvedIds = raw.observationKeys
      .map(k => verifiedByKey.get(k)?.id)
      .filter((id): id is string => Boolean(id));
    if (resolvedIds.length === 0) continue; // no verified evidence → not a proposal

    const identity = slugify(raw.identity || raw.title);
    if (!identity) continue;

    // (3) permanent-rejection post-filter.
    if (matchesTombstone({ identity, title: raw.title }, tombstones)) {
      stats.proposalsSuppressedByTombstone += 1;
      continue;
    }

    const live = liveByIdentity.get(identity);
    if (live) {
      // (4) strengthen: union the evidence, recompute counts.
      const union = Array.from(new Set([...live.observationIds, ...resolvedIds]));
      const before = live.observationIds.length;
      live.observationIds = union;
      const recomputed = recomputeProposal(live, allObsIndex);
      Object.assign(live, recomputed);
      if (union.length > before) {
        live.history.push({ at, event: `strengthened:${runId}`, by: 'miner' });
        stats.proposalsStrengthened += 1;
      }
    } else {
      const base: Proposal = {
        id: `prop_${slugify(identity)}_${runId}`,
        category: 'global',
        state: 'pending',
        title: raw.title.slice(0, 200),
        ruleText: raw.ruleText.trim(),
        target: targetFor(raw.target, raw.anchor),
        observationIds: resolvedIds,
        occurrences: 0,
        crossRepoCount: 0,
        firstSeen: at,
        lastSeen: at,
        identity,
        history: [{ at, event: `proposed:${runId}`, by: 'miner' }],
      };
      const recomputed = recomputeProposal(base, allObsIndex);
      proposals.push(recomputed);
      liveByIdentity.set(identity, recomputed);
      stats.proposalsCreated += 1;
    }
  }

  return { observations: verified, proposals, stats };
}
