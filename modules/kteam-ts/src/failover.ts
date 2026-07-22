import { confirmedUsableAgent, inferHarness, modelHint, usableAgent, usageScore, type AgentUsage } from './core';
import type { Harness } from './types';

export interface FailoverCandidateInput {
  /** The wrapper the session is currently on (excluded from the result). */
  currentBinary: string;
  /** The session's harness kind — candidates must match (no cross-kind). */
  harness: Harness;
  /** All auto-mode wrappers on the box (e.g. `discoverAutoAgents`). */
  agents: string[];
  /** Per-account health from the kfleet usage feed. */
  usage: AgentUsage[];
  /** When true, only accounts with POSITIVELY confirmed headroom (atLimit ===
   *  false && authOk !== false) qualify — accounts with absent/unknown usage are
   *  excluded. Automatic (unattended) failover sets this; the warden's advisory
   *  candidate list keeps the looser default so it can still suggest accounts the
   *  feed hasn't scored. */
  requireConfirmedUsage?: boolean;
}

/** Usable same-KIND wrappers other than the current one, ranked for failover:
 *  same model family first (a glm52a → glm52b swap keeps the model), then the
 *  least-used account within each group. Pure — no I/O, deterministic.
 *
 *  Cross-KIND (claude↔codex) is never a candidate: harness session state only
 *  pools within a kind, so a codex wrapper cannot `--resume` a claude session. */
export function rankFailoverCandidates(input: FailoverCandidateInput): string[] {
  const usageByBinary = new Map(input.usage.map(item => [item.binary, item]));
  const family = modelHint(input.currentBinary);
  const isUsable = input.requireConfirmedUsage ? confirmedUsableAgent : usableAgent;
  const pool = input.agents.filter(agent => {
    if (agent === input.currentBinary) return false;
    let kind: Harness;
    try {
      kind = inferHarness(agent);
    } catch {
      return false;
    }
    if (kind !== input.harness) return false;
    return isUsable(usageByBinary.get(agent));
  });
  return pool.sort((a, b) => {
    const sameFamilyA = modelHint(a) === family ? 0 : 1;
    const sameFamilyB = modelHint(b) === family ? 0 : 1;
    if (sameFamilyA !== sameFamilyB) return sameFamilyA - sameFamilyB;
    const usageDelta = usageScore(usageByBinary.get(a)) - usageScore(usageByBinary.get(b));
    if (usageDelta !== 0) return usageDelta;
    // Stable, deterministic tiebreak so selection never depends on readdir order.
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** The single best failover target, or undefined when none is usable. */
export function selectFailoverCandidate(input: FailoverCandidateInput): string | undefined {
  return rankFailoverCandidates(input)[0];
}
