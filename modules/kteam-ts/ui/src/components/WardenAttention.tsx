// WHO NEEDS YOU — the warden's fleet-wide answer to exactly two questions:
// which agent needs the human, and why. It lives inside /warden (this is a
// warden VIEW over the existing attention ledger, not a second attention
// system) and leads the page, because the outcome is what the reader came for.
//
// THIS SURFACE NEVER SELF-HIDES. Every other warden strip on this page goes
// quiet when its route 404s, which is right for decoration and wrong here:
// silence on a "who needs me" list reads as "nobody does". A missing route, a
// rejected token, a warden that never swept and a warden that could not reach a
// judgement are four different facts, and each one is printed as itself.
//
// It also does not resolve anything. The per-session Attention panel owns
// `howToResolve` and the Mark-done action; duplicating them here would give the
// same item two resolution workflows that can disagree. The whole row is one
// tap through to the session instead.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, Gavel, HelpCircle, LoaderCircle, ShieldQuestion, UserRound } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { Link } from '../lib/router';
import { ReportModal } from './WardenVerdicts';
import type {
  FleetAttentionItem,
  WardenAttentionOutcome,
  WardenAttentionView,
  WardenJudgement,
  WardenJudgementState,
  WardenVerdictKind,
} from '../types';
import { displayCallsign } from '../lib/callsign';
import { cn, fmtAge, fmtRelative } from '../lib/utils';

const POLL_MS = 30_000;

/** What the section is rendering right now. A union, not a pile of booleans:
 *  "loading", "the daemon refused" and "the warden has no judgement" are
 *  distinct answers and must not collapse into one blank panel.
 *
 *  `stale` is the fourth: a view we DID have, whose refresh has since failed.
 *  Keeping it as `ready` was a real hole — a token that expired or a daemon
 *  that went away left a page confidently displaying an answer from an hour
 *  ago, and a previously clean one kept showing a green "nobody needs you"
 *  tick forever. Old rows are still worth reading; pretending they are current
 *  is not. */
export type WardenAttentionState =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'stale'; view: WardenAttentionView; reason: string }
  | { status: 'ready'; view: WardenAttentionView };

/** Headline for a view that could not be refreshed. Deliberately NOT a count
 *  and never an all-clear: what the reader must take away is that this list is
 *  no longer being kept up to date. */
export const STALE_HEADLINE = 'Can’t refresh who needs you';

/** Where a failed poll leaves us. Pure, so the "a 401 after a good load must
 *  not be swallowed" rule is a test and not a hope. */
export function nextStateOnFailure(current: WardenAttentionState, error: unknown): WardenAttentionState {
  const reason = attentionErrorReason(error);
  // A view we already have is worth keeping — labelled, not discarded.
  if (current.status === 'ready') return { status: 'stale', view: current.view, reason };
  // Already stale: keep the rows, adopt the NEWEST reason (a network blip that
  // becomes a 401 is a different problem and must say so).
  if (current.status === 'stale') return { status: 'stale', view: current.view, reason };
  return { status: 'error', reason };
}

/** The "as of" line for a stale view. */
export function staleNote(view: WardenAttentionView): string {
  const stamp = view.generatedAt ?? view.lastSweepAt;
  return stamp ? `Last good answer ${fmtRelative(stamp)} · not refreshed since` : 'Showing the last known answer.';
}

const JUDGEMENT: Record<WardenJudgementState, { label: string; cls: string; Icon: typeof Gavel }> = {
  judged: { label: 'Judged', cls: 'text-accent border-accent bg-accent-soft', Icon: Gavel },
  pending: { label: 'Warden checking', cls: 'text-muted border-border bg-surface-2', Icon: LoaderCircle },
  queued: { label: 'Warden queued', cls: 'text-muted border-border bg-surface-2', Icon: Clock3 },
  failed: { label: 'Warden failed', cls: 'text-err border-err-border bg-err-bg', Icon: CircleAlert },
  // Never dressed up as a clean state — but never overclaimed either. Matching
  // runs against a FINITE recent-verdict window, so the honest statement is
  // "nothing matched", not "no warden judgement exists". The daemon knows which
  // of those it means and says so in `reason`; this chip stays bounded.
  none: { label: 'No matching judgement', cls: 'text-warn border-warn-border bg-warn-bg', Icon: ShieldQuestion },
};

const VERDICT_WORD: Record<WardenVerdictKind, string> = {
  killed: 'killed the session',
  revived: 'revived the session',
  nudged: 'nudged the agent',
  cleared: 'cleared it',
  needs_human: 'needs a human',
  unknown: 'reviewed it',
};

const SOURCE_WORD: Record<string, string> = {
  task: 'Blocked task',
  question: 'Question',
  permission: 'Permission',
  'agent-raised': 'Agent request',
  // A row the warden synthesized from a live anomaly — no board record behind
  // it. Labelled, because "where did this come from" is a fair question.
  'warden-anomaly': 'Warden anomaly',
};

/** Chip metadata for a judgement, falling back to the explicit "none" chip for
 *  a state string a newer daemon invented. Unknown must not render blank. */
export function judgementChip(state?: string): { label: string; cls: string; Icon: typeof Gavel } {
  return JUDGEMENT[state as WardenJudgementState] ?? JUDGEMENT.none;
}

/** DISTINCT AGENTS, not rows. An item is one attention record, and one agent
 *  can raise several — counting rows would tell the reader four agents need
 *  them when one does, which is exactly the kind of number they act on. */
export function attentionAgentCount(items?: FleetAttentionItem[]): number {
  return new Set((items ?? []).map(entry => entry.sessionId).filter(Boolean)).size;
}

const OUTCOMES: readonly WardenAttentionOutcome[] = ['items', 'clean-sweep', 'degraded', 'no-sweep'];

function hasUnknownReportedOutcome(view: WardenAttentionView): boolean {
  return view.outcome !== undefined && !OUTCOMES.includes(view.outcome as WardenAttentionOutcome);
}

/** The daemon states outright why the list is empty. Trust it; infer only when
 *  it says nothing (older daemon), and never guess "clean" from emptiness.
 *
 *  ONE OUTCOME IS ALLOWED TO SAY NOBODY NEEDS YOU: `clean-sweep`. `degraded`
 *  means a board could not be read, so a waiting agent may be hidden behind it;
 *  `no-sweep` means nothing looked at all. Both are unknowns wearing an empty
 *  list, and printing an all-clear over either is the exact failure this
 *  surface exists to prevent. */
export function attentionOutcome(view: WardenAttentionView): WardenAttentionOutcome {
  if (OUTCOMES.includes(view.outcome as WardenAttentionOutcome)) return view.outcome as WardenAttentionOutcome;
  if ((view.items?.length ?? 0) > 0) return 'items';
  // Only ABSENCE means an older daemon. A present value we do not understand
  // belongs to a newer or malformed daemon, so treating it as a legacy clean
  // sweep would turn uncertainty into a false all-clear.
  if (view.outcome !== undefined) return 'degraded';
  // An older daemon reports unreadable boards without the outcome field; the
  // same honesty rule applies to it.
  if ((view.boardsWithParseErrors?.length ?? 0) > 0) return 'degraded';
  return view.lastSweepAt ? 'clean-sweep' : 'no-sweep';
}

/** Outcome first, in one short line. */
export function attentionHeadline(view: WardenAttentionView): string {
  const agents = attentionAgentCount(view.items);
  if (agents > 0) return agents === 1 ? '1 agent needs you' : `${agents} agents need you`;
  const outcome = attentionOutcome(view);
  if (outcome === 'clean-sweep') return 'No agents need you';
  // A sweep ran but could not read everything — say we cannot tell, not that
  // nobody needs you and not that nothing has been judged.
  if (outcome === 'degraded') return 'Can’t say who needs you';
  return 'No warden judgement yet';
}

/** The one supporting line under the headline. Always carries sweep age, since
 *  "nobody needs you" is only worth as much as the sweep behind it. */
export function attentionNote(view: WardenAttentionView): string {
  const count = view.items?.length ?? 0;
  const outcome = attentionOutcome(view);
  // Only worth saying when it differs from the headline's agent count.
  const requests = count > attentionAgentCount(view.items) ? `${count} requests · ` : '';
  if (count === 0 && hasUnknownReportedOutcome(view)) {
    const swept = view.lastSweepAt ? ` · Last sweep ${fmtRelative(view.lastSweepAt)}` : '';
    return `This page does not understand the warden result${swept}`;
  }
  if (count === 0 && outcome === 'degraded') {
    const cause =
      (view.boardsWithParseErrors?.length ?? 0) > 0
        ? 'A board could not be read — someone may be hidden'
        : (view.wardenDegraded?.reason ?? 'The warden could not complete a trustworthy check.');
    const swept = view.lastSweepAt ? ` · Last sweep ${fmtRelative(view.lastSweepAt)}` : '';
    return `${cause}${swept}`;
  }
  if (!view.lastSweepAt) {
    if (count > 0) return `${requests}No warden sweep yet — these come from the attention ledger.`;
    return outcome === 'degraded'
      ? 'A board could not be read. Someone may be waiting behind it.'
      : 'No sweep has run. This is not a clean bill of health.';
  }
  const swept = `Last sweep ${fmtRelative(view.lastSweepAt)}`;
  if (count > 0) return `Oldest first · ${requests}${swept}`;
  if (outcome === 'clean-sweep') return swept;
  // A daemon can report a sweep stamp AND still be unable to vouch for it.
  if (outcome === 'degraded') return `A board could not be read — someone may be hidden · ${swept}`;
  return `No warden judgement yet · ${swept}`;
}

/** Short, plain reason for a failed fetch. Never "something went wrong". */
export function attentionErrorReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This daemon has no warden attention route yet.';
    if (error.status === 401 || error.status === 403) return 'This page is not signed in as an admin.';
    return `The daemon answered HTTP ${error.status}.`;
  }
  return 'Could not reach the daemon.';
}

/** One short line when judgement matching ran against a TRUNCATED window, so
 *  "no matching judgement" on a row below is read as bounded rather than
 *  absolute. Silent when nothing was cut off, and silent on an older daemon
 *  that never reported coverage — announcing a bound we were not told about
 *  would be its own small lie. */
export function verdictCoverageNote(view: WardenAttentionView): string | null {
  const coverage = view.verdictCoverage;
  if (!coverage?.truncated) return null;
  const limit = typeof coverage.limit === 'number' && coverage.limit > 0 ? coverage.limit : null;
  return limit
    ? `Showing the recent ${limit} verdicts. Older judgements may be outside this window.`
    : 'Showing a recent slice of verdicts. Older judgements may be outside this window.';
}

/** Oldest waiting first. The server promises this order; re-sorting keeps the
 *  contract true when it is fed by an older or partial daemon. */
export function orderedAttentionItems(items?: FleetAttentionItem[]): FleetAttentionItem[] {
  const parse = (value?: string): number => {
    const at = Date.parse(value ?? '');
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY; // undated sinks last
  };
  return [...(items ?? [])].sort((a, b) => parse(a.waitingSince) - parse(b.waitingSince));
}

/** What the warden concluded, as one sentence a tired reader can take in. */
export function judgementSummary(judgement: WardenJudgement): string {
  const { state, verdict, reason } = judgement;
  if (state === 'judged') {
    const word = verdict ? VERDICT_WORD[verdict] : undefined;
    const head = `Warden: ${word ?? 'reviewed it'}`;
    return reason ? `${head} — ${reason}` : head;
  }
  if (state === 'pending') return 'Warden is checking this now.';
  if (state === 'queued') return 'Waiting for a warden to pick this up.';
  if (state === 'failed') return `Warden could not judge — ${reason ?? 'reason unknown'}`;
  // THE DAEMON'S SENTENCE WINS. It knows whether nothing matched inside a
  // truncated window, whether nothing applies, or whether nothing has judged
  // yet — three different facts. Overwriting them with one absolute "no warden
  // judgement for this one" is the overclaim this line used to make.
  return reason ?? 'No matching warden judgement for this one.';
}

/** Who judged it, and how long ago. Absence is printed, not skipped. */
export function judgedByCopy(judgement: WardenJudgement): string {
  const wrapper = judgement.judgedBy?.wrapper;
  const wardenSession = judgement.judgedBy?.wardenSessionId;
  const who = wrapper ?? wardenSession;
  const when = judgement.at ? fmtRelative(judgement.at) : 'time unknown';
  if (!who) {
    if (judgement.state === 'judged') return `Judge unknown · ${when}`;
    // `none` means the match came back empty against a bounded window — which
    // is not the same as "nobody has judged this", so the attribution must not
    // say that. pending/queued really are not judged yet, and keep that wording.
    if (judgement.state === 'none') return judgement.at ? `No matching judge · ${when}` : 'No matching judge';
    return judgement.at ? `Not judged · ${when}` : 'Not judged yet';
  }
  const model = judgement.judgedBy?.model;
  const session = wrapper && wardenSession ? ` · ${wardenSession}` : '';
  return `Judged by ${who}${model ? ` (${model})` : ''}${session} · ${when}`;
}

/** Pure section — no fetching, so a test renders exactly what a reader sees. */
export function WardenAttentionSection({
  state,
  onOpenReport,
}: {
  state: WardenAttentionState;
  onOpenReport?: (path: string) => void;
}) {
  return (
    <section
      id="attention"
      aria-labelledby="warden-attention-heading"
      data-testid="warden-attention"
      className="kt-panel flex flex-col gap-3 p-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="warden-attention-heading" className="m-0 flex items-center gap-1.5 text-title font-semibold text-fg">
          <CircleAlert size={16} className="text-warn" aria-hidden="true" />
          Who needs you
        </h2>
      </div>

      {state.status === 'loading' && (
        <p role="status" className="m-0 flex items-center gap-xs text-row font-semibold text-muted">
          <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Checking which agents need you…
        </p>
      )}

      {state.status === 'error' && (
        <div role="alert" className="rounded-control border border-err-border bg-err-bg px-cell-x py-row-y">
          <p className="m-0 text-row font-semibold text-err">No judgement available</p>
          <p className="m-0 mt-xs text-meta leading-base text-muted">{state.reason}</p>
          <p className="m-0 mt-xs text-meta leading-base text-faint">Treat this as unknown, not as all clear.</p>
        </div>
      )}

      {state.status === 'ready' && <ReadyBody view={state.view} onOpenReport={onOpenReport} />}

      {state.status === 'stale' && (
        <ReadyBody view={state.view} onOpenReport={onOpenReport} stale={{ reason: state.reason }} />
      )}
    </section>
  );
}

function ReadyBody({
  view,
  onOpenReport,
  stale,
}: {
  view: WardenAttentionView;
  onOpenReport?: (path: string) => void;
  stale?: { reason: string };
}) {
  const items = orderedAttentionItems(view.items);
  const degraded = view.wardenDegraded;
  const brokenBoards = view.boardsWithParseErrors ?? [];
  const coverageNote = verdictCoverageNote(view);

  return (
    <>
      <div>
        <p className={cn('m-0 text-row font-semibold', stale ? 'text-warn' : 'text-fg')}>
          {stale ? STALE_HEADLINE : attentionHeadline(view)}
        </p>
        <p className="m-0 mt-0.5 text-meta leading-base text-faint">{stale ? staleNote(view) : attentionNote(view)}</p>
      </div>

      {stale && (
        <ul
          role="alert"
          className="m-0 list-disc rounded-control border border-warn-border bg-warn-bg py-1.5 pl-6 pr-cell-x text-meta leading-base text-warn"
        >
          <li>Last result is stale — {stale.reason}</li>
          <li>Not an all-clear: someone may need you since.</li>
        </ul>
      )}

      {degraded && (
        <p
          role="alert"
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-cell-x py-1.5 text-meta leading-base text-warn"
        >
          Warden degraded: {degraded.reason ?? 'reason unknown'}
          {degraded.since ? ` · since ${fmtRelative(degraded.since)}` : ''}
        </p>
      )}

      {brokenBoards.length > 0 && (
        <p className="m-0 text-meta leading-base text-warn">
          {brokenBoards.length} attention board{brokenBoards.length === 1 ? '' : 's'} could not be read — items on them
          are missing here.
        </p>
      )}

      {coverageNote && <p className="m-0 text-meta leading-base text-faint">{coverageNote}</p>}

      {items.length === 0 ? (
        <p className="m-0 flex items-center gap-xs text-cell text-muted">
          {stale ? (
            // A previously CLEAN result must never keep its green tick once the
            // refresh has failed: "nothing is waiting on you" from an answer
            // nobody can renew is the same false all-clear in slower motion.
            <>
              <CircleAlert size={15} className="text-warn" aria-hidden="true" />
              Nobody was waiting at the last check. That check is stale — not an all-clear.
            </>
          ) : (
            <EmptyLine
              outcome={attentionOutcome(view)}
              unknownReported={hasUnknownReportedOutcome(view)}
              boardFailure={brokenBoards.length > 0}
            />
          )}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-sm p-0">
          {items.map((item, index) => (
            <AttentionRow
              key={`${item.sessionId}:${item.id ?? index}`}
              item={item}
              oldest={index === 0}
              onOpenReport={onOpenReport}
            />
          ))}
        </ol>
      )}
    </>
  );
}

/** The empty list, in the three ways it can be empty. `clean-sweep` is the only
 *  one that gets the tick — the other two are unknowns and say so. */
function EmptyLine({
  outcome,
  unknownReported,
  boardFailure,
}: {
  outcome: WardenAttentionOutcome;
  unknownReported: boolean;
  boardFailure: boolean;
}) {
  if (unknownReported) {
    return (
      <>
        <HelpCircle size={15} className="text-warn" aria-hidden="true" />
        This warden result is not understood. This is not an all-clear.
      </>
    );
  }
  if (outcome === 'clean-sweep') {
    return (
      <>
        <Check size={15} className="text-ok" aria-hidden="true" />
        Nothing is waiting on you right now.
      </>
    );
  }
  if (outcome === 'degraded') {
    return (
      <>
        <CircleAlert size={15} className="text-warn" aria-hidden="true" />
        {boardFailure
          ? 'An unreadable board could be hiding someone. This is not an all-clear.'
          : 'The warden check is incomplete. This is not an all-clear.'}
      </>
    );
  }
  return (
    <>
      <HelpCircle size={15} className="text-warn" aria-hidden="true" />
      Nobody has been checked yet.
    </>
  );
}

function AttentionRow({
  item,
  oldest,
  onOpenReport,
}: {
  item: FleetAttentionItem;
  oldest: boolean;
  onOpenReport?: (path: string) => void;
}) {
  const judgement = item.judgement ?? { state: 'none' as const };
  const chip = judgementChip(judgement.state);
  const callsign = displayCallsign(item.teammate) || item.sessionId;
  const reportPath = judgement.reportPath;

  return (
    <li
      className={cn(
        'overflow-hidden rounded-control border bg-surface',
        oldest ? 'border-warn/50 shadow-[inset_3px_0_0_var(--warn)]' : 'border-border-soft',
      )}
    >
      {/* One tap to the session. The report button below is a sibling, never a
          nested control: a button inside a link is unreachable by keyboard and
          ambiguous by touch. */}
      <Link
        to={`/session/${encodeURIComponent(item.sessionId)}`}
        className="flex min-h-[44px] flex-col gap-xs px-cell-x py-row-y no-underline hover:bg-surface-2"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
          {/* The one bold value in the row: WHICH agent needs you. */}
          <span className="min-w-0 truncate text-cell font-semibold text-fg">{callsign}</span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
              chip.cls,
            )}
          >
            <chip.Icon size={11} aria-hidden="true" />
            {chip.label}
          </span>
          {judgement.stale && (
            <span className="kt-label shrink-0 text-warn" title="Judged before this request appeared">
              stale
            </span>
          )}
          {oldest && <span className="kt-label shrink-0 text-warn">oldest</span>}
        </span>

        {item.subject && <span className="text-cell font-medium leading-snug text-fg-soft">{item.subject}</span>}
        <span className="text-cell leading-base text-muted">{item.why ?? 'No reason recorded.'}</span>
        <span className="text-meta leading-base text-muted">{judgementSummary(judgement)}</span>

        <span className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs text-meta text-faint">
          <span className="inline-flex items-center gap-xs">
            <UserRound size={11} aria-hidden="true" />
            {judgedByCopy(judgement)}
          </span>
          <span className="inline-flex items-center gap-xs">
            <Clock3 size={11} aria-hidden="true" />
            waiting {fmtAge(item.waitingSince)}
          </span>
          {item.source && <span className="kt-label text-faint">{SOURCE_WORD[item.source] ?? item.source}</span>}
        </span>
      </Link>

      {reportPath && onOpenReport && (
        <div className="border-t border-border-soft">
          <button
            type="button"
            onClick={() => onOpenReport(reportPath)}
            className="flex min-h-[44px] w-full items-center gap-1.5 px-cell-x py-1.5 text-left text-meta text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Gavel size={12} aria-hidden="true" />
            Open warden report
          </button>
        </div>
      )}
    </li>
  );
}

/** Live section: polls the admin-only fleet view and owns the report modal. */
export function WardenAttention() {
  const [state, setState] = useState<WardenAttentionState>({ status: 'loading' });
  const [report, setReport] = useState<{ title: string; body: string | null } | null>(null);
  const timer = useRef<number | null>(null);
  const closeReport = useCallback(() => setReport(null), []);

  useEffect(() => {
    let cancelled = false;
    // A failed poll does not throw away a view we already have — it MARKS it.
    // Replacing a good list with an error banner on one dropped request is how
    // a reader ends up staring at "no judgement available" for a fleet that is
    // fine; leaving it silently `ready` is how they trust an hour-old answer
    // from a session whose token expired. `nextStateOnFailure` owns that call.
    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const view = await api.wardenAttention();
        if (!cancelled) setState({ status: 'ready', view });
      } catch (error) {
        if (!cancelled) setState(current => nextStateOnFailure(current, error));
      }
    };
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);

  const openReport = useCallback(async (path: string) => {
    const title = path.split('/').pop() ?? 'report';
    setReport({ title, body: null });
    try {
      setReport({ title, body: await api.wardenReport(path) });
    } catch {
      setReport({ title, body: '_Could not load this report._' });
    }
  }, []);

  return (
    <>
      <WardenAttentionSection state={state} onOpenReport={path => void openReport(path)} />
      <ReportModal
        open={report !== null}
        title={report?.title ?? ''}
        body={report?.body ?? null}
        onClose={closeReport}
      />
    </>
  );
}
