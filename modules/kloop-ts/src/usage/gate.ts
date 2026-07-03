// Usage-aware account selection. When `requireUsageLeft` is on, kloop queries
// kfleet's /usage endpoint for a per-account snapshot of 5h + weekly utilization
// and turns it into a per-account WEIGHT MULTIPLIER for the weighted pools:
//
//   - 5-hour window = a HARD GATE: if an account has < `fiveHourFloorPercent` left
//     in its 5h window (≈ maxed for now), its weight is 0 — don't use it, let it
//     recover. Same for a not-logged-in account (it would just fail).
//   - weekly window = a SOFT WEIGHT: the multiplier is the fraction of weekly quota
//     remaining, so picks are balanced across the week (effective weight =
//     configured weight × weekly-left). A fresh account pulls full weight; one at
//     73% weekly pulls ~0.27×.
//
// Plus it BLOCKS before the implementer runs until at least one candidate has
// weight > 0 (the whole pool is gated/exhausted).
//
// Design guarantees:
//  - Disabled by default → zero behavioural change (weight always 1).
//  - A failed/stale fetch never breaks a run: unknown accounts get weight 1.
//  - Only accounts kfleet reports as usage-based + probed are ever scaled/gated.

import type { UsageWeight } from '../types';

/** One account row from kfleet's /usage payload (subset we use). */
export interface UsageAccount {
  binary: string;
  provider: string | null;
  usageBased: boolean;
  ok: boolean;
  atLimit: boolean;
  unavailable?: boolean;
  authOk?: boolean;
  fiveHourPercent?: number; // 0–100 USED
  weeklyPercent?: number; // 0–100 USED
  fiveHourResetAt?: number; // epoch ms
  weeklyResetAt?: number; // epoch ms
}

const DEFAULT_USAGE_ENDPOINT = 'http://127.0.0.1:47318/usage';
const DEFAULT_FIVE_HOUR_FLOOR = 3; // % of the 5h window left, below which we hard-gate

const SNAPSHOT_TTL_MS = 20_000; // reuse a snapshot this fresh without re-fetching
const FETCH_TIMEOUT_MS = 5_000;
const MIN_BLOCK_MS = 5_000;
const MAX_BLOCK_MS = 10 * 60_000; // re-check at least this often while blocked

interface UsageGateOptions {
  enabled: boolean;
  endpoint?: string;
  /** % of the 5h window remaining below which an account is hard-gated (weight 0). */
  fiveHourFloorPercent?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class UsageGate {
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly fiveHourFloor: number;
  private readonly log: (msg: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private snapshot = new Map<string, UsageAccount>();
  private fetchedAt = 0;
  private warned = false;

  constructor(opts: UsageGateOptions) {
    this.enabled = opts.enabled;
    this.endpoint = opts.endpoint || DEFAULT_USAGE_ENDPOINT;
    this.fiveHourFloor = opts.fiveHourFloorPercent ?? DEFAULT_FIVE_HOUR_FLOOR;
    this.log = opts.log ?? (m => console.log(`KLOOP usage: ${m}`));
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Construct from a resolved kloop config (the production path). */
  static fromConfig(
    config: { requireUsageLeft?: boolean; usageEndpoint?: string; usageFiveHourFloorPercent?: number },
    overrides: Partial<UsageGateOptions> = {},
  ): UsageGate {
    return new UsageGate({
      enabled: config.requireUsageLeft === true,
      endpoint: config.usageEndpoint,
      fiveHourFloorPercent: config.usageFiveHourFloorPercent,
      ...overrides,
    });
  }

  /** Per-account weight multiplier in [0, 1]:
   *   - unknown / untracked / unmeasurable ⇒ 1 (never penalize what we can't measure)
   *   - missing key / not logged in ⇒ 0 (it would just fail)
   *   - 5h window with < floor% left ⇒ 0 (hard gate — let it recover)
   *   - otherwise ⇒ weekly fraction remaining (soft, balances across the week) */
  weight: UsageWeight = (binary: string): number => {
    const a = this.snapshot.get(binary);
    if (!a) return 1;
    if (a.unavailable || a.authOk === false) return 0;
    if (!a.usageBased || !a.ok) return 1;
    const fiveHourLeft = 100 - (a.fiveHourPercent ?? 0);
    if (fiveHourLeft < this.fiveHourFloor) return 0; // 5h hard gate
    const weeklyLeft = 100 - (a.weeklyPercent ?? 0);
    return Math.max(0, Math.min(1, weeklyLeft / 100)); // weekly soft weight
  };

  /** True if the account is usable at all (weight > 0). Used for block-until-reset. */
  isAvailable = (binary: string): boolean => this.weight(binary) > 0;

  /** Refresh the snapshot from kfleet, honoring a short TTL. Never throws. */
  async refresh(force = false): Promise<void> {
    if (!this.enabled) return;
    if (!force && this.now() - this.fetchedAt < SNAPSHOT_TTL_MS) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let body: { accounts?: UsageAccount[] };
      try {
        const res = await this.fetchImpl(this.endpoint, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const parsed = await res.json();
        if (!parsed || typeof parsed !== 'object') throw new Error('malformed /usage body');
        body = parsed as { accounts?: UsageAccount[] };
      } finally {
        clearTimeout(timer);
      }
      const next = new Map<string, UsageAccount>();
      for (const a of body.accounts ?? []) next.set(a.binary, a);
      this.snapshot = next;
      this.fetchedAt = this.now();
      this.warned = false;
    } catch (e) {
      // Drop stale data and fail open. A usage outage must not stall runs.
      this.snapshot = new Map();
      this.fetchedAt = 0;
      if (!this.warned) {
        this.log(`/usage unavailable (${(e as Error).message}); proceeding without usage weighting`);
        this.warned = true;
      }
    }
  }

  /** Block until at least one of `binaries` is usable (weight > 0). No-op when
   *  disabled, the list is empty, or one is already usable. Re-fetches each cycle so
   *  kfleet's freshly computed usage (not our arithmetic) decides when a window reset. */
  async awaitCapacity(binaries: string[]): Promise<void> {
    if (!this.enabled || binaries.length === 0) return;
    await this.refresh();
    while (!binaries.some(b => this.isAvailable(b))) {
      const reset = this.soonestResetMs(binaries);
      const waitMs = reset ? Math.min(Math.max(reset - this.now() + 2_000, MIN_BLOCK_MS), MAX_BLOCK_MS) : MAX_BLOCK_MS;
      this.log(`all candidate accounts gated (5h/weekly/login) — waiting ${Math.round(waitMs / 1000)}s for reset…`);
      await this.sleep(waitMs);
      await this.refresh(true);
    }
  }

  /** Soonest future reset (epoch ms) that could lift the gate on a weight-0 candidate. */
  private soonestResetMs(binaries: string[]): number | undefined {
    const now = this.now();
    let soonest: number | undefined;
    for (const b of binaries) {
      if (this.weight(b) > 0) continue; // already usable
      const a = this.snapshot.get(b);
      if (!a) continue;
      for (const t of [a.fiveHourResetAt, a.weeklyResetAt]) {
        if (typeof t === 'number' && t > now && (soonest === undefined || t < soonest)) soonest = t;
      }
    }
    return soonest;
  }
}
