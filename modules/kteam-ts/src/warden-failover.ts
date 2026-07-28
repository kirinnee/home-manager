// Warden account failover — the pure selection/hysteresis engine.
//
// Wardens run as ephemeral sessions on agent wrappers backed by provider
// accounts, and accounts fail: rate limits, auth expiry, a provider 400ing.
// Historically WardenConfig named ONE wrapper, so one bad account meant no
// supervision at all — and the assigned-warden catch punished the TARGET's
// cooldown, silently starving every sus target one by one.
//
// This module owns choosing WHICH configured account each warden spawn uses
// (fallback or round_robin over an ordered list) and the per-wrapper strike /
// demotion bookkeeping that decides "healthy". It is pure — no I/O, no clock
// reads, no globals — mirroring failover.ts (teammate migration), which solves
// the different problem of moving a live conversation between accounts.
//
// The hysteresis doctrine (learned from kfleet c409fd5, where ONE transient
// probe failure condemned a valid API key): corroborate at the SOURCE of a
// signal, damp at the CONSUMER. kfleet already triple-probes before reporting
// atLimit/authOk, so feed-corroborated evidence demotes in one strike here;
// kteam-local generic launch failures are raw and need `failureThreshold`
// consecutive strikes. Demotion is always a cooldown, never a latch — recovery
// is automatic, and positive feed evidence clears a demotion early.

import { confirmedUsableAgent, usableAgent, type AgentUsage } from './core';
import {
  defaultWardenFailoverConfig,
  type WardenAccount,
  type WardenConfig,
  type WardenFailoverPolicy,
} from './daemon-config';

/** Durable per-wrapper failover bookkeeping, persisted inside
 *  WardenRuntimeState so a daemon restart cannot amnesty a demotion or reset a
 *  strike count. All records are keyed by wrapper name. */
export interface WardenFailoverState {
  /** round_robin cursor: index INTO THE CONFIGURED LIST of the last selected
   *  account. Scanning starts after it, so the turn order stays stable when
   *  eligibility fluctuates. */
  rrCursor?: number;
  /** Consecutive uncorroborated (generic launch) failures + last evidence. */
  strikes?: Record<string, { count: number; lastAt: string; lastReason: string }>;
  /** Demotion expiry (ISO). Absent or past = eligible again — that IS the
   *  fail-back under `fallback`, no separate mechanism. */
  demotedUntil?: Record<string, string>;
  /** Last selection, for wardenStatus and the UI. */
  lastSelection?: { wrapper: string; policy: WardenFailoverPolicy; at: string; reason: string };
  /** Set while EVERY configured account is ineligible; cleared on the first
   *  successful selection. Edge-triggers the fleet.warden_exhausted event. */
  exhaustedSince?: string;
}

export interface WardenSelectionInput {
  config: WardenConfig;
  /** Wrappers actually present in ~/.kfleet/bin right now. */
  installedAgents: readonly string[];
  /** Per-account health from the kfleet usage feed. */
  usage: readonly AgentUsage[];
  state: WardenFailoverState;
  nowMs: number;
}

export type WardenSelection =
  | {
      exhausted: false;
      account: WardenAccount;
      /** State updated with the new rrCursor/lastSelection (exhaustedSince cleared). */
      state: WardenFailoverState;
      /** Why this account: 'preferred' (fallback #0), 'failover' (fallback
       *  skipped earlier entries), 'rotation' (round_robin). */
      reason: 'preferred' | 'failover' | 'rotation';
      /** Exact ineligibility reasons computed for every skipped wrapper. */
      skipped: Record<string, string>;
    }
  | {
      exhausted: true;
      state: WardenFailoverState;
      /** Per-wrapper explanation for status/events. */
      reasons: Record<string, string>;
    };

/** The failover knobs with defaults applied — old config.json files (and
 *  partial PATCHes) may omit the block entirely. */
export function effectiveFailoverConfig(config: WardenConfig): Required<WardenConfig>['failover'] {
  return { ...defaultWardenFailoverConfig(), ...(config.failover ?? {}) };
}

/** The effective ordered account list. `accounts` (with string shorthand)
 *  wins when present and non-empty; otherwise the legacy single
 *  `wrapper`/`model` pair — today's behavior, byte-for-byte. Deduped by
 *  wrapper name keeping the FIRST occurrence (its `model` wins). */
export function normalizeWardenAccounts(config: WardenConfig): WardenAccount[] {
  const raw: (WardenAccount | string)[] =
    config.accounts && config.accounts.length > 0
      ? config.accounts
      : [{ wrapper: config.wrapper, ...(config.model !== undefined ? { model: config.model } : {}) }];
  const seen = new Set<string>();
  const accounts: WardenAccount[] = [];
  for (const entry of raw) {
    const account = typeof entry === 'string' ? { wrapper: entry } : entry;
    const wrapper = account.wrapper?.trim();
    if (!wrapper || seen.has(wrapper)) continue;
    seen.add(wrapper);
    accounts.push({ wrapper, ...(account.model !== undefined ? { model: account.model } : {}) });
  }
  return accounts;
}

const parseMs = (value: string | undefined): number => {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
};

/** Is this wrapper currently demoted (cooldown not yet elapsed)? */
export function isDemoted(state: WardenFailoverState, wrapper: string, nowMs: number): boolean {
  return parseMs(state.demotedUntil?.[wrapper]) > nowMs;
}

/** Why an account is ineligible right now, or undefined when it IS eligible.
 *  `usableAgent` (loose), not `confirmedUsableAgent`: a warden spawn is cheap,
 *  rate-limited by the spawn gap, and backstopped by the launch preflight —
 *  an account the feed hasn't scored (fresh wrapper, feed outage) must stay
 *  reachable. Unknown is usable; a feed outage can neither demote nor
 *  un-demote anyone. */
export function ineligibilityReason(
  account: WardenAccount,
  input: Pick<WardenSelectionInput, 'installedAgents' | 'usage' | 'state' | 'nowMs'>,
): string | undefined {
  // An EMPTY inventory is not evidence against anyone: it means kfleet is
  // absent or unreadable (hermetic tests, a box mid-provision), and skipping
  // every account on that would disable supervision exactly when the feed is
  // also blind. Only a non-empty listing that omits the wrapper condemns it.
  if (input.installedAgents.length > 0 && !input.installedAgents.includes(account.wrapper)) {
    return 'not installed in ~/.kfleet/bin';
  }
  const usage = input.usage.find(item => item.binary === account.wrapper);
  if (usage?.authOk === false) return 'credentials rejected (kfleet feed)';
  if (usage?.unavailable === true) {
    const cause = usage.unavailableReason?.replaceAll('_', ' ') ?? 'provider';
    const retry = typeof usage.retryAt === 'number' ? `; retry after ${new Date(usage.retryAt).toISOString()}` : '';
    return `CLIProxy unavailable: ${cause}${retry} (kfleet feed)`;
  }
  if (usage?.atLimit === true) return 'at its usage limit (kfleet feed)';
  if (isDemoted(input.state, account.wrapper, input.nowMs)) {
    return `demoted until ${input.state.demotedUntil?.[account.wrapper]}`;
  }
  return undefined;
}

/** Pick the account for the NEXT warden spawn. Eligibility is recomputed per
 *  call, so fail-back is automatic: the moment a preferred account leaves
 *  demotion (cooldown expiry or early clear), fallback returns to it. */
export function selectWardenAccount(input: WardenSelectionInput): WardenSelection {
  const accounts = normalizeWardenAccounts(input.config);
  const policy: WardenFailoverPolicy = input.config.failover?.policy ?? 'fallback';
  const reasons: Record<string, string> = {};
  const eligible: number[] = [];
  for (const [index, account] of accounts.entries()) {
    const reason = ineligibilityReason(account, input);
    if (reason === undefined) eligible.push(index);
    else reasons[account.wrapper] = reason;
  }
  if (eligible.length === 0) {
    return {
      exhausted: true,
      reasons,
      state: {
        ...input.state,
        exhaustedSince: input.state.exhaustedSince ?? new Date(input.nowMs).toISOString(),
      },
    };
  }

  let index: number;
  let reason: 'preferred' | 'failover' | 'rotation';
  if (policy === 'round_robin') {
    // Scan the FULL configured list starting after the cursor, wrapping, and
    // take the first eligible entry. Anchoring the cursor to configured
    // positions (not the eligible sublist) keeps everyone's turn order stable
    // when an account drops out or rejoins.
    const cursor = typeof input.state.rrCursor === 'number' ? input.state.rrCursor : -1;
    const eligibleSet = new Set(eligible);
    index = eligible[0]!;
    for (let step = 1; step <= accounts.length; step += 1) {
      const candidate = (((cursor + step) % accounts.length) + accounts.length) % accounts.length;
      if (eligibleSet.has(candidate)) {
        index = candidate;
        break;
      }
    }
    reason = 'rotation';
  } else {
    index = eligible[0]!;
    reason = index === 0 ? 'preferred' : 'failover';
  }

  const account = accounts[index]!;
  const nextState: WardenFailoverState = {
    ...input.state,
    ...(policy === 'round_robin' ? { rrCursor: index } : {}),
    lastSelection: {
      wrapper: account.wrapper,
      policy,
      at: new Date(input.nowMs).toISOString(),
      reason,
    },
  };
  delete nextState.exhaustedSince;
  return { exhausted: false, account, state: nextState, reason, skipped: reasons };
}

/** Evidence classes a spawn failure can carry. `quota`/`auth` are
 *  feed-corroborated at the source (kfleet triple-probes) and demote in ONE
 *  strike; `generic` (tmux error, wrapper crash, anything else start() threw)
 *  is raw and needs `failureThreshold` consecutive strikes. */
export type WardenFailureKind = 'quota' | 'auth' | 'provider' | 'generic';

/** Classify a start() error by its message. The preflight throws distinctive
 *  wording for both corroborated classes (session-manager start() preflight);
 *  anything else is generic. Message-shape coupling is deliberate and pinned
 *  by tests — a typed error would be nicer, but start()'s errors cross the
 *  spawn-site catch blocks as plain Errors today. */
export function classifyWardenFailure(message: string): WardenFailureKind {
  if (/at its usage limit/i.test(message)) return 'quota';
  if (/credentials were rejected|auth failure/i.test(message)) return 'auth';
  if (/CLI\/provider is unavailable|CLIProxy unavailable|proxy\/provider is unavailable/i.test(message))
    return 'provider';
  return 'generic';
}

export interface WardenFailureRecord {
  state: WardenFailoverState;
  /** True when this failure crossed the threshold and demoted the wrapper. */
  demoted: boolean;
  strikes: number;
}

/** Record a spawn failure against the WRAPPER (never the target). Corroborated
 *  evidence (quota/auth) demotes immediately; generic failures accumulate
 *  consecutive strikes and demote at `failureThreshold`. */
export function recordWardenFailure(
  state: WardenFailoverState,
  wrapper: string,
  kind: WardenFailureKind,
  reason: string,
  nowMs: number,
  failover: { failureThreshold: number; cooldownMinutes: number },
): WardenFailureRecord {
  const at = new Date(nowMs).toISOString();
  const previous = state.strikes?.[wrapper]?.count ?? 0;
  const count = previous + 1;
  const threshold = Math.max(1, Math.floor(failover.failureThreshold));
  const demoted = kind !== 'generic' || count >= threshold;
  const next: WardenFailoverState = {
    ...state,
    strikes: { ...(state.strikes ?? {}), [wrapper]: { count, lastAt: at, lastReason: reason } },
  };
  if (demoted) {
    const until = new Date(nowMs + Math.max(0, failover.cooldownMinutes) * 60_000).toISOString();
    next.demotedUntil = { ...(next.demotedUntil ?? {}), [wrapper]: until };
  }
  return { state: next, demoted, strikes: count };
}

/** A successful spawn resets the wrapper's consecutive-strike counter (and any
 *  demotion record — it evidently works). */
export function recordWardenSuccess(state: WardenFailoverState, wrapper: string): WardenFailoverState {
  if (!state.strikes?.[wrapper] && !state.demotedUntil?.[wrapper]) return state;
  const strikes = { ...(state.strikes ?? {}) };
  delete strikes[wrapper];
  const demotedUntil = { ...(state.demotedUntil ?? {}) };
  delete demotedUntil[wrapper];
  return { ...state, strikes, demotedUntil };
}

/** Clear demotions the usage feed POSITIVELY contradicts: a wrapper reported
 *  `confirmedUsableAgent` (atLimit===false && authOk!==false — confirmed, not
 *  merely unknown) is restored immediately, so a 5-hour window reset never
 *  waits out an unrelated cooldown timer. Expired demotions are also pruned
 *  (they are already inert; pruning keeps state and status honest). Returns
 *  the restored wrapper names so the caller can emit events. */
export function reconcileDemotions(
  state: WardenFailoverState,
  usage: readonly AgentUsage[],
  nowMs: number,
): { state: WardenFailoverState; restored: { wrapper: string; how: 'feed' | 'cooldown' }[] } {
  const demoted = Object.entries(state.demotedUntil ?? {});
  if (demoted.length === 0) return { state, restored: [] };
  const usageByBinary = new Map(usage.map(item => [item.binary, item]));
  const restored: { wrapper: string; how: 'feed' | 'cooldown' }[] = [];
  const demotedUntil = { ...(state.demotedUntil ?? {}) };
  const strikes = { ...(state.strikes ?? {}) };
  for (const [wrapper, until] of demoted) {
    const account = usageByBinary.get(wrapper);
    if (account && confirmedUsableAgent(account) && usableAgent(account)) {
      delete demotedUntil[wrapper];
      delete strikes[wrapper];
      restored.push({ wrapper, how: 'feed' });
    } else if (parseMs(until) <= nowMs) {
      delete demotedUntil[wrapper];
      restored.push({ wrapper, how: 'cooldown' });
    }
  }
  if (restored.length === 0) return { state, restored };
  return { state: { ...state, demotedUntil, strikes }, restored };
}
