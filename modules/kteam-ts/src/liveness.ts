/** A6 liveness ledger + reflex rule (pure — no I/O, no clock, no globals).
 *
 *  Two layers, per the locked design:
 *
 *  REFLEX (per-session monitor, dumb): life-signs are conversation growth,
 *  ANY pane change, and subprocess/background activity — this layer only
 *  catches totally-frozen agents. Zero life-signs for nudgeAfterSeconds →
 *  nudge once per episode; still zero at killAfterSeconds → kill.
 *
 *  SUS LIST (daemon sweep, smart): alive-but-weird sessions — thinking with
 *  counters active but no transcript growth for susThinkingSeconds, or a
 *  subprocess running continuously for susSubprocessSeconds — get ONE
 *  assigned warden each to investigate and deliver a verdict
 *  (leave / nudge / resume / kill).
 */

/** Per-life-sign timestamps, persisted on SessionState and surfaced through
 *  status/API/UI and warden detect. */
export interface LivenessLedger {
  /** Conversation file grew. */
  lastTranscriptAt?: string;
  /** Recognized work vocabulary with ADVANCING counters (elapsed/tokens).
   *  Not a reflex life-sign — powers the sus_thinking classifier. */
  lastCounterAdvanceAt?: string;
  /** The TOKEN count specifically climbed (claude renders one; codex has no
   *  token field). Token exemption: climbing tokens = certain progress —
   *  never sus, however long the think runs. */
  lastTokenAdvanceAt?: string;
  /** A harness tool/subprocess was observed alive. */
  lastSubprocessAt?: string;
  /** Any visible frame change. Counts as a reflex life-sign. */
  lastPaneChangeAt?: string;
  /** Start of the current continuous subprocess episode (set when a
   *  subprocess is first observed after an absence, cleared when absent). */
  subprocessSince?: string;
}

export type LivenessSignal = 'transcript' | 'counterAdvance' | 'tokenAdvance' | 'subprocess' | 'paneChange';

const LEDGER_FIELDS: Record<LivenessSignal, keyof LivenessLedger> = {
  transcript: 'lastTranscriptAt',
  counterAdvance: 'lastCounterAdvanceAt',
  tokenAdvance: 'lastTokenAdvanceAt',
  subprocess: 'lastSubprocessAt',
  paneChange: 'lastPaneChangeAt',
};

function parseMs(value: string | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** secondsSince for every ledger signal, floored by `anchorMs` (turn start)
 *  so a fresh turn never reads as frozen. Infinity = never seen, no anchor. */
export function ledgerAges(ledger: LivenessLedger, nowMs: number, anchorMs = 0): Record<LivenessSignal, number> {
  const ages = {} as Record<LivenessSignal, number>;
  for (const signal of Object.keys(LEDGER_FIELDS) as LivenessSignal[]) {
    const at = Math.max(parseMs(ledger[LEDGER_FIELDS[signal]]), anchorMs);
    ages[signal] = at > 0 ? Math.max(0, (nowMs - at) / 1000) : Number.POSITIVE_INFINITY;
  }
  return ages;
}

export type ReflexVerdict = 'alive' | 'nudge' | 'kill';

export interface ReflexAssessment {
  verdict: ReflexVerdict;
  /** The "quietest" age: seconds since the freshest life-sign of ANY kind
   *  (conversation, tokens, thinking, pane; 0 while a subprocess runs). */
  zeroSeconds: number;
  /** Same MIN but EXCLUDING pane change — the strong life-signs only. The
   *  nudge's own typed message repaints the pane, so pane flicker can never
   *  end a nudge episode or postpone the kill (observed live: an injection
   *  loop of 4 nudges with no kill on a fully frozen agent). */
  strongSeconds: number;
  secondsSince: Record<LivenessSignal, number>;
}

/** REFLEX rule (normative, turn-010): every tick compute
 *  quietest = min over non-null of {conversation, tokens, thinking, pane,
 *  subprocess-running ? 0 : excluded}. quietest >= nudgeAfterSeconds → nudge
 *  once per episode; after the nudge, STRONG quietest (pane excluded — the
 *  nudge itself repaints the pane) >= killAfterSeconds → kill. The caller
 *  clears `nudgedAtMs` when a strong sign returns. Never-seen signals are
 *  floored by `anchorMs` (turn start) so a fresh turn is never instantly
 *  frozen. Pane flicker counts ONLY here, never toward sus relief. */
export function reflexAssess(input: {
  ledger: LivenessLedger;
  nowMs: number;
  anchorMs?: number;
  /** Monitor tick, seconds — a subprocess seen within 2 ticks counts as
   *  running now (contributes 0 to the quietest age). */
  tickSeconds?: number;
  nudgeAfterSeconds: number;
  killAfterSeconds: number;
  nudgedAtMs?: number;
}): ReflexAssessment {
  const secondsSince = ledgerAges(input.ledger, input.nowMs, input.anchorMs ?? 0);
  const tick = input.tickSeconds ?? 30;
  const subprocessRunning = secondsSince.subprocess <= 2 * tick;
  const strongSeconds = Math.min(
    secondsSince.transcript,
    secondsSince.tokenAdvance,
    secondsSince.counterAdvance,
    subprocessRunning ? 0 : Number.POSITIVE_INFINITY,
  );
  const zeroSeconds = Math.min(strongSeconds, secondsSince.paneChange);
  if (strongSeconds >= input.killAfterSeconds && input.nudgedAtMs !== undefined)
    return { verdict: 'kill', zeroSeconds, strongSeconds, secondsSince };
  if (zeroSeconds >= input.nudgeAfterSeconds && input.nudgedAtMs === undefined)
    return { verdict: 'nudge', zeroSeconds, strongSeconds, secondsSince };
  return { verdict: 'alive', zeroSeconds, strongSeconds, secondsSince };
}

/** Human-readable per-session liveness view, atomically rewritten every
 *  monitor tick to <session dir>/liveness.yaml — the always-fresh on-disk
 *  ledger the user (and assigned wardens) can read directly. Pure renderer;
 *  hand-rolled YAML (flat, two levels) to avoid a dependency. */
export function renderLivenessYaml(input: {
  updatedAt: string;
  secondsSince: Record<LivenessSignal, number>;
  triggers: { nudge: boolean; kill: boolean; sus: boolean };
}): string {
  const seconds = (value: number) => (Number.isFinite(value) ? String(Math.floor(value)) : 'null');
  const yesNo = (value: boolean) => (value ? 'yes' : 'no');
  return [
    `updatedAt: ${input.updatedAt}`,
    'secondsSince:',
    `  conversation: ${seconds(input.secondsSince.transcript)}`,
    `  tokens: ${seconds(input.secondsSince.tokenAdvance)}`,
    `  thinking: ${seconds(input.secondsSince.counterAdvance)}`,
    `  subprocess: ${seconds(input.secondsSince.subprocess)}`,
    `  pane: ${seconds(input.secondsSince.paneChange)}`,
    'triggers:',
    `  nudge: ${yesNo(input.triggers.nudge)}`,
    `  kill: ${yesNo(input.triggers.kill)}`,
    `  sus: ${yesNo(input.triggers.sus)}`,
    '',
  ].join('\n');
}

export type SusKind = 'sus_thinking' | 'sus_subprocess';

export interface SusFinding {
  kind: SusKind;
  /** Whole seconds the weirdness has been going on. */
  forSeconds: number;
  detail: string;
}

/** SUS classifiers (normative, turn-010) — alive but weird, judged by an
 *  assigned warden:
 *  (a) sus_thinking: thinkingNow (thinking indicator seen within 2 ticks) AND
 *      NOT tokensClimbing (token counter seen climbing within 2 ticks —
 *      null-safe: no token field = not climbing) AND the conversation has not
 *      grown for susThinkingSeconds (or never).
 *  (b) sus_subprocess: a subprocess is running NOW (seen within 2 ticks) and
 *      its continuous episode is at least susSubprocessSeconds old. */
export function susFindings(
  ledger: LivenessLedger,
  nowMs: number,
  options: {
    susThinkingSeconds: number;
    susSubprocessSeconds: number;
    /** Monitor tick, seconds — "now" means within 2 ticks. */
    tickSeconds?: number;
    anchorMs?: number;
  },
): SusFinding[] {
  const activeWithin = 2 * (options.tickSeconds ?? 30);
  const ages = ledgerAges(ledger, nowMs, options.anchorMs ?? 0);
  const findings: SusFinding[] = [];
  // TOKEN EXEMPTION: a climbing token count is certain progress — never sus,
  // regardless of how long the think runs. Only harnesses that render a token
  // counter (claude) can earn it; codex (duration only) stays sus-eligible and
  // the assigned warden compensates with deeper inspection.
  const thinkingNow = ages.counterAdvance <= activeWithin;
  const tokensClimbing = ages.tokenAdvance <= activeWithin;
  if (thinkingNow && !tokensClimbing && ages.transcript >= options.susThinkingSeconds) {
    const forSeconds = Number.isFinite(ages.transcript) ? Math.floor(ages.transcript) : -1;
    findings.push({
      kind: 'sus_thinking',
      forSeconds,
      detail: `the work indicator is active (duration climbing, tokens flat or absent) but the transcript has not grown for ${forSeconds >= 0 ? `${Math.floor(forSeconds / 60)}m` : 'the whole turn'}`,
    });
  }
  const since = parseMs(ledger.subprocessSince);
  if (ages.subprocess <= activeWithin && since > 0 && nowMs - since >= options.susSubprocessSeconds * 1000) {
    const forSeconds = Math.floor((nowMs - since) / 1000);
    findings.push({
      kind: 'sus_subprocess',
      forSeconds,
      detail: `a background subprocess has been running continuously for ${Math.floor(forSeconds / 60)}m`,
    });
  }
  return findings;
}
