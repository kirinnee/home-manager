// SESSION DETAILS — the drawer behind the header's "Details" button.
//
// The header used to be a badge wall: mode, RC, status, nudged, needs-human,
// wrapper, model, turn, context, five liveness ages, quota and the socket state,
// all spelled out across two rows of every screen. Every one of those is a fact
// somebody needs — none of them is a fact everybody needs all the time, and
// together they cost two lines of transcript on a 100dvh page and read as noise.
//
// They live here instead, in four LABELLED groups. The header keeps only what
// you steer by (who, status, tabs, controls) and this answers "what exactly am I
// looking at".
//
// Rules this file follows:
//   - a group is never identified by colour alone: icon + written heading, with
//     the tone as reinforcement
//   - decorative icons are aria-hidden; the adjacent text is the name
//   - it is a real dialog: Escape, backdrop click and an explicit labelled close
//     button all dismiss it, focus moves in and is restored on the way out
//   - it is an OVERLAY with its own scroller, so the page keeps exactly one
//     pane scroller (the transcript) and the 100dvh shell never scrolls
//   - no navigation: the only link is the session's own RC surface, which is
//     external and explicitly opens in a new tab

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Bot, Gauge, Radio, Sparkles, UserRound, X, ExternalLink, AlertTriangle, Zap } from 'lucide-react';
import type { SessionView } from '../types';
import type { Quota } from '../lib/usage';
import { cn, fmtAbsolute, fmtAge, fmtRelative } from '../lib/utils';
import { MODE_HINT } from './ModeBadge';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { Button } from './Primitives';

export type LiveStatus = 'connecting' | 'open' | 'closed';

interface Props {
  view: SessionView;
  quota: Quota | null;
  liveStatus: LiveStatus;
  open: boolean;
  onClose: () => void;
  /** Id of the button that opens this, so focus can be handed back to it. */
  labelledBy?: string;
  /** Session controls (Interrupt / Stop / Resume) when the caller has nowhere to
   *  put them — the phone header is a single nowrap row and cannot hold three
   *  more 44px targets. They go FIRST, above the read-only groups, because a
   *  drawer opened to stop a session should not need a scroll to do it. This is
   *  the whole reason the drawer is the overflow: it already traps focus,
   *  restores it and answers Escape, so the controls lose nothing by moving. */
  actions?: ReactNode;
}

/** Group tones. Colour is the SECOND signal in every case — the icon and the
 *  heading text carry the identity. */
const GROUP_TONE = {
  identity: 'text-accent border-accent',
  runtime: 'text-fg-soft border-border',
  progress: 'text-warn border-warn-border',
  budget: 'text-ok border-ok-border',
} as const;

export function SessionDetails({ view, quota, liveStatus, open, onClose, labelledBy, actions }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Escape, focus-in, focus-restore and the Tab trap — the same contract the
  // fleet drawer now uses (hooks/useDialogFocus.ts).
  const { onKeyDown } = useDialogFocus(open, panelRef, onClose);

  if (!open) return null;

  const { config, state } = view;
  const observedModel = config.model?.trim();
  const requestedModel = config.modelHint?.trim();

  return (
    <>
      {/* Backdrop. A plain button so a click OR a keyboard activation dismisses,
          and screen readers are told what it does rather than meeting a div. */}
      <button
        type="button"
        aria-label="Close session details"
        onClick={onClose}
        className="kt-overlay fixed inset-0 z-40 cursor-default bg-scrim"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : 'Session details'}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn('kt-overlay kt-panel kt-details fixed right-0 z-50 flex w-full flex-col font-ui', 'sm:w-[400px]')}
      >
        <div className="kt-panel__header shrink-0">
          <span className="min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg">
            {config.teammate || config.name || config.id}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close session details"
            title="Close (Esc)"
          >
            <X size={15} aria-hidden="true" />
          </Button>
        </div>

        {/* The drawer's OWN scroller. The page below still owns exactly one
            (the transcript); this one is an overlay and never nests inside it. */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          {actions && (
            <section className="kt-details__group">
              <h2
                className={cn(
                  'kt-label m-0 mb-xs flex items-center gap-xs border-l-heavy pl-cell-x',
                  GROUP_TONE.progress,
                )}
              >
                <Zap size={13} aria-hidden="true" />
                Controls
              </h2>
              <div className="flex flex-wrap items-center gap-sm">{actions}</div>
            </section>
          )}

          <Group icon={<UserRound size={13} aria-hidden="true" />} title="Identity" tone="identity">
            <Row label="Teammate" value={config.teammate} />
            <Row label="Task" value={config.name} />
            <Row label="Label" value={config.label} />
            <Row label="Folder" value={config.cwd} mono />
            <Row label="Session id" value={config.id} mono />
            <Row label="Started" value={state.startedAt ? fmtAbsolute(state.startedAt) : undefined} mono />
            {state.finishedAt && <Row label="Finished" value={fmtAbsolute(state.finishedAt)} mono />}
          </Group>

          <Group
            icon={
              config.harness === 'claude' ? (
                <Bot size={13} aria-hidden="true" />
              ) : (
                <Sparkles size={13} aria-hidden="true" />
              )
            }
            title="Runtime"
            tone="runtime"
          >
            <Row label="CLI wrapper" value={config.binary} mono />
            <Row label="Harness" value={config.harness} />
            <Row label="Model (observed)" value={observedModel} mono />
            <Row
              label="Model (requested)"
              value={requestedModel && requestedModel !== observedModel ? requestedModel : undefined}
              mono
            />
            <Row label="Mode" value={config.mode} hint={MODE_HINT[config.mode]} />
            <Row label="tmux session" value={config.tmuxSession} mono />
            {config.remoteControl && (
              <div className="flex items-baseline gap-sm">
                <dt className="w-[104px] shrink-0 text-meta text-muted">Remote control</dt>
                <dd className="m-0 min-w-0 flex-1 text-cell text-fg-soft">
                  {state.remoteControlUrl ? (
                    <a
                      href={state.remoteControlUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={state.remoteControlUrl}
                      className="inline-flex min-w-0 items-center gap-xs text-accent hover:underline"
                    >
                      <Radio size={11} aria-hidden="true" />
                      <span className="min-w-0 truncate">open RC surface</span>
                      <ExternalLink size={10} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="text-faint" title="launched with --rc; the surface has not announced itself yet">
                      enabled · link pending
                    </span>
                  )}
                </dd>
              </div>
            )}
          </Group>

          <Group icon={<Activity size={13} aria-hidden="true" />} title="Progress" tone="progress">
            <ProgressRows view={view} liveStatus={liveStatus} />
          </Group>

          <Group icon={<Gauge size={13} aria-hidden="true" />} title="Budget" tone="budget">
            <BudgetRows view={view} quota={quota} />
          </Group>
        </div>
      </div>
    </>
  );
}

function Group({
  icon,
  title,
  tone,
  children,
}: {
  icon: ReactNode;
  title: string;
  tone: keyof typeof GROUP_TONE;
  children: ReactNode;
}) {
  return (
    <section className="kt-details__group">
      <h2 className={cn('kt-label m-0 mb-xs flex items-center gap-xs border-l-heavy pl-cell-x', GROUP_TONE[tone])}>
        {icon}
        {title}
      </h2>
      <dl className="m-0 grid gap-xs">{children}</dl>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  hint,
  tone,
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
  hint?: string;
  /** Extra colour on the VALUE only, always alongside the value's own words. */
  tone?: string;
}) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value);
  return (
    <div className="flex items-baseline gap-sm">
      <dt className="w-[104px] shrink-0 text-meta text-muted" title={hint}>
        {label}
      </dt>
      <dd
        className={cn(
          'm-0 min-w-0 flex-1 break-words text-cell',
          text === '—' ? 'text-faint' : (tone ?? 'text-fg-soft'),
          mono && 'mono',
        )}
        title={typeof value === 'string' && value.length > 40 ? value : undefined}
      >
        {text}
      </dd>
    </div>
  );
}

/** Liveness ages tick every second, so they are isolated in their own memo —
 *  the same pattern the old header strip used, and the reason a 1s interval
 *  here does not re-render the drawer's other three groups. */
const ProgressRows = memo(function ProgressRows({ view, liveStatus }: { view: SessionView; liveStatus: LiveStatus }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { state } = view;
  const ctx = state.contextPercent;
  const ctxTone = ctx == null ? undefined : ctx >= 90 ? 'text-err' : ctx >= 75 ? 'text-warn' : undefined;

  return (
    <>
      <Row label="Status" value={state.status} />
      {state.waiting && (
        <Row
          label="Parked on"
          value={`${state.waiting.condition ?? 'external condition'}${
            state.waiting.until ? ` · until ${fmtAbsolute(state.waiting.until)}` : ''
          }`}
          tone="text-warn"
        />
      )}
      {state.waiting?.peer && (
        <Row label="Waiting for" value={state.waiting.peerName ?? state.waiting.peer} mono tone="text-warn" />
      )}
      <Row label="Health" value={state.health} />
      <Row label="Turn" value={state.turn} />
      <Row label="Context used" value={ctx == null ? undefined : `${ctx}%`} tone={ctxTone} />
      <Row label="Activity" value={state.activity} />
      <Row label="Last activity" value={state.lastActivityAt ? fmtRelative(state.lastActivityAt) : undefined} />
      {state.nudgedAt && <Row label="Nudged" value={fmtRelative(state.nudgedAt)} tone="text-warn" />}
      {state.needsHuman && <Row label="Needs human" value={state.needsHuman} tone="text-err" />}
      {state.retryAttempt != null && state.retryAttempt > 0 && <Row label="Retry attempt" value={state.retryAttempt} />}
      {/* The A6 liveness ledger: which life-signs the daemon has seen and how
          long ago. Written out with names rather than the old `txn 4s · tok 9s`
          shorthand, which needed a tooltip to be readable at all. */}
      <Row
        label="Transcript"
        value={ageOf(state.lastTranscriptAt)}
        mono
        hint="seconds since the last transcript write"
      />
      <Row
        label="Tokens"
        value={ageOf(state.lastTokenAdvanceAt)}
        mono
        hint="seconds since the token counter advanced"
      />
      <Row
        label="Counters"
        value={ageOf(state.lastCounterAdvanceAt)}
        mono
        hint="seconds since a pane counter advanced"
      />
      <Row label="Subprocess" value={ageOf(state.lastSubprocessAt)} mono hint="seconds since a subprocess life-sign" />
      <Row label="Pane" value={ageOf(state.lastPaneAt)} mono hint="seconds since the tmux pane changed" />
      <Row
        label="Socket"
        value={liveStatus}
        tone={liveStatus === 'open' ? 'text-ok' : liveStatus === 'connecting' ? 'text-warn' : 'text-err'}
        hint="live event stream to the daemon"
      />
    </>
  );
});

const BudgetRows = memo(function BudgetRows({ view, quota }: { view: SessionView; quota: Quota | null }) {
  const { config } = view;
  const nothing =
    !quota ||
    (quota.authOk !== false &&
      quota.fiveHourPercent == null &&
      quota.weeklyPercent == null &&
      quota.atLimit !== true &&
      quota.fiveHourResetAt == null &&
      quota.weeklyResetAt == null);

  if (nothing) {
    return (
      <>
        <Row label="Account" value={config.binary} mono />
        <Row label="Quota" value={undefined} hint="the usage feed has no record for this wrapper yet" />
        <p className="m-0 text-meta leading-base text-faint">
          No usage data for this wrapper yet — that is “unknown”, not “nothing used”.
        </p>
      </>
    );
  }

  return (
    <>
      <Row label="Account" value={config.binary} mono />
      {quota.authOk === false && <Row label="Auth" value="login required" tone="text-err" />}
      <Row
        label="5-hour window"
        value={quota.fiveHourPercent == null ? undefined : `${quota.fiveHourPercent}% used`}
        tone={pctTone(quota.fiveHourPercent)}
      />
      <Row label="5-hour resets" value={resetAt(quota.fiveHourResetAt)} mono />
      <Row
        label="Weekly window"
        value={quota.weeklyPercent == null ? undefined : `${quota.weeklyPercent}% used`}
        tone={pctTone(quota.weeklyPercent)}
      />
      <Row label="Weekly resets" value={resetAt(quota.weeklyResetAt)} mono />
      {quota.atLimit === true && (
        <div className="flex items-center gap-xs text-meta text-err">
          <AlertTriangle size={12} aria-hidden="true" />
          at limit — the wrapper is rate-limited until the window rolls over
        </div>
      )}
    </>
  );
});

function pctTone(pct?: number): string | undefined {
  if (pct == null) return undefined;
  return pct >= 90 ? 'text-err' : pct >= 75 ? 'text-warn' : undefined;
}

function resetAt(at?: number): string | undefined {
  if (at == null) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toLocaleTimeString()} · ${fmtRelative(date.toISOString())}`;
}

function ageOf(at?: string): string | undefined {
  return at ? fmtAge(at) : undefined;
}
