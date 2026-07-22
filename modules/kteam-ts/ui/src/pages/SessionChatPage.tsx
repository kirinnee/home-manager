// Single-session chat page. The center of the brief:
//  - tail-first loading with infinite scroll-up pagination via `before`
//  - bubble rendering via pairing + markdown + tool cards + thinking blocks
//  - live tail-follow via WS chat.* events (deduped)
//  - sticky scroll (stay-at-bottom follows new messages; readers scrolled up
//    stay exactly where they are; "Jump to latest" pill when detached)
//  - composer (Enter send / Shift+Enter newline), queued-notice when busy,
//    disabled while awaiting_question (the question form is the input then)
//  - header (status / context / Interrupt / Stop / Resume), snapshot drawer,
//    thinking indicator while busy
//  - WINDOWED thread (react-virtuoso) — the brief says "virtualize if >500
//    messages rendered", and live sessions already carry 7k+ records.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import {
  ArrowDown,
  Pause,
  Play,
  StopCircle,
  ZapOff,
  ChevronLeft,
  Rows3,
  Maximize2,
  MessageSquare,
  Terminal,
} from 'lucide-react';
import { api, ApiError, HAS_TOKEN } from '../lib/api';
import { openEventStream } from '../lib/ws';
import type { SessionView, ChatRecord, KTeamEvent } from '../types';
import { ActionGroup, Badge, Button } from '../components/Primitives';
import { Link } from '../lib/router';
import { ThinkingIndicator } from '../components/Harness';
import { MessageBubble } from '../components/Primitives.MessageBubble';
import { Composer } from '../components/Composer';
import { QuestionForm } from '../components/QuestionForm';
import { PaneSnapshotDrawer } from '../components/Question';
import { TerminalView } from '../components/TerminalView';
import { ViewTabs } from '../components/ViewTabs';
import { pairRecordsToBubbles, latestPendingQuestion } from '../lib/pairing';
import { useDensity } from '../hooks/useDensity';
import { TERMINAL_STATUSES, WAITING_STATUSES, fmtAbsolute, isBusy, toneFor } from '../lib/utils';

const PAGE_SIZE = 200;

export function SessionChatPage({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  // Loading-state trio: initial fetch (shows skeleton), pagination (top pill
  // inside the thread), and "has the API returned offset 0 yet?" gates the
  // "start of chat" sentinel.
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false); // true when we know offset===0
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [draft, setDraft] = useState('');
  const [showJump, setShowJump] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [density, toggleDensity] = useDensity();
  // View toggle: chat-thread (default) vs. the cached tmux pane snapshot.
  // Polling for the terminal view is gated on this state + document.hidden,
  // see TerminalView.tsx.
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');

  // react-virtuoso expects a stable sequential firstItemIndex when data
  // pre-pends so internal offsets stay correct.
  const [firstIndex, setFirstIndex] = useState(0);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const seenKeys = useRef<Set<string>>(new Set());
  const lastSeq = useRef<number>(-1);
  // dedupe WS-driven refetches: ≥1s trailing debounce + single-flight.
  const refreshTimer = useRef<number | null>(null);
  const refreshInflight = useRef<Promise<void> | null>(null);

  // ---- initial load: view + first page + first WS connection (after=-200) ----
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setRecords([]);
    setError(null);
    setNextBefore(null);
    setLoadingInitial(true);
    setAtStart(false);
    seenKeys.current.clear();
    lastSeq.current = -1;
    setFirstIndex(0);

    (async () => {
      try {
        const [v, page] = await Promise.all([
          api.getSession(sessionId),
          api.chatHistory(sessionId, undefined, PAGE_SIZE),
        ]);
        if (cancelled) return;
        setView(v);
        setTotal(page.total);
        const fresh = page.records;
        setRecords(fresh);
        setNextBefore(page.offset);
        for (const r of fresh) seenKeys.current.add(recordKey(r));
        // "Start of chat" only becomes true once we've actually loaded a
        // page that proves offset === 0 (i.e. there is no older page).
        setAtStart(page.offset === 0);
        // start at the tail (most recent message) on first load
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingInitial(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // ---- periodic state refresh (5s) — the daemon terminal frame may lag this;
  // ---- the WS path covers terminal.frame live updates too.
  const refreshView = useCallback(async () => {
    // Single-flight: coalesce re-entrant calls into one in-flight promise.
    if (refreshInflight.current) return refreshInflight.current;
    const p = (async () => {
      try {
        const v = await api.getSession(sessionId);
        setView(v);
      } catch {
        /* keep prior */
      }
    })().finally(() => {
      refreshInflight.current = null;
    });
    refreshInflight.current = p;
    return p;
  }, [sessionId]);

  // Debounce-triggered refresh — the WS handler funnels its state events here
  // so the daemon isn't hammered by N refetches per second of frame pings.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshView();
    }, 1100);
  }, [refreshView]);

  useEffect(() => {
    const id = window.setInterval(() => void refreshView(), 5000);
    return () => window.clearInterval(id);
  }, [refreshView]);

  // ---- websocket: live chat events + terminal.frame → activity / context% ----
  useEffect(() => {
    const handle = openEventStream(
      sessionId,
      -200,
      (ev: KTeamEvent) => {
        if (typeof ev.sequence === 'number' && ev.sequence <= lastSeq.current) return;
        if (typeof ev.sequence === 'number') lastSeq.current = ev.sequence;

        // terminal.frame carries the latest pane activity/context; apply it
        // immediately rather than waiting for the 5s poll.
        if (ev.type === 'terminal.frame') {
          const data = ev.data as { activity?: string; contextPercent?: number; promptReady?: boolean };
          setView(v =>
            v
              ? {
                  ...v,
                  state: {
                    ...v.state,
                    activity: data.activity ?? v.state.activity,
                    contextPercent: data.contextPercent ?? v.state.contextPercent,
                    promptReady: data.promptReady ?? v.state.promptReady,
                  },
                }
              : v,
          );
          return;
        }

        // State-patch events from the daemon. Debounced (trailing) + single-
        // flight — see scheduleRefresh — so a busy daemon emitting dozens of
        // terminal frames per second collapses to one GET /v1/sessions/:id.
        if (ev.type === 'state' || ev.type === 'session.state') {
          scheduleRefresh();
          return;
        }

        // Live chat events. Promote the embedded record to ChatRecord.
        if (
          ev.type.startsWith('chat.') ||
          ev.type === 'tool.use' ||
          ev.type === 'tool.result' ||
          ev.type.startsWith('interaction.') ||
          ev.type.startsWith('turn.')
        ) {
          const rec = eventToRecord(ev);
          if (!rec) return;
          const key = recordKey(rec);
          if (seenKeys.current.has(key)) return;
          seenKeys.current.add(key);
          setRecords(rs => [...rs, rec]);
          // Auto-stick to the bottom when the reader was already pinned.
          requestAnimationFrame(() => {
            virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
          });
        }
      },
      setLiveStatus,
    );
    return () => handle.close();
  }, [sessionId, scheduleRefresh]);

  // ---- infinite scroll-up: load older pages via `before` ----
  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    if (nextBefore == null) return;
    setLoadingOlder(true);
    try {
      const page = await api.chatHistory(sessionId, nextBefore, PAGE_SIZE);
      setTotal(page.total);
      setRecords(rs => {
        for (const r of page.records) seenKeys.current.add(recordKey(r));
        return [...page.records, ...rs];
      });
      setNextBefore(page.offset);
      setAtStart(page.offset === 0);
      // Keep Virtuoso's firstItemIndex in sync so its in-DOM window stays
      // anchored on the same visible record as the page prepends above.
      setFirstIndex(n => n - page.records.length);
    } catch {
      /* leave as-is */
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, nextBefore, sessionId]);

  // ---- derived: paired bubbles + pending question ----
  const bubbles = useMemo(() => pairRecordsToBubbles(records), [records]);
  const pendingQ = useMemo(
    () =>
      view?.state.pendingQuestion
        ? ({
            source: 'claude' as const,
            type: 'interaction.question' as const,
            data: {
              questions: view.state.pendingQuestion.questions,
              toolUseId: view.state.pendingQuestion.toolUseId,
            },
          } as ChatRecord)
        : latestPendingQuestion(records),
    [view, records],
  );

  const busy = useMemo(() => (view ? isBusy(view) : false), [view]);
  const awaitingQ = view?.state.status === 'awaiting_question';
  const isTerminal = view ? TERMINAL_STATUSES.has(view.state.status) : false;
  const isKillFailed = view?.state.status === 'kill_failed';

  // ---- actions ----
  async function send() {
    if (!draft.trim() || !HAS_TOKEN) return;
    const msg = draft.trim();
    setDraft('');
    setActionNotice(null);
    try {
      const next = await api.send(sessionId, msg);
      setView(next);
      if (busy || isBusy(next)) {
        setActionNotice({ kind: 'ok', text: 'Message queued for the next turn boundary.' });
      }
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }

  // Interrupt the running turn (safe Escape daemon-side), then deliver the
  // draft immediately — the composer's explicit alternative to queueing.
  async function interruptAndSend() {
    if (!draft.trim() || !HAS_TOKEN) return;
    const msg = draft.trim();
    setDraft('');
    setActionNotice(null);
    try {
      await api.interrupt(sessionId);
      const next = await api.send(sessionId, msg);
      setView(next);
      setActionNotice({ kind: 'ok', text: 'Turn interrupted — message delivered.' });
    } catch (e) {
      setDraft(msg); // never eat the draft on failure
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }

  async function interrupt() {
    setActionNotice(null);
    try {
      const next = await api.interrupt(sessionId);
      setView(next);
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }

  async function stop() {
    const reason = window.prompt('Reason for stopping this session:', 'stopped from browser');
    if (reason == null) return;
    setActionNotice(null);
    try {
      const next = await api.stop(sessionId, reason.trim() || 'stopped from browser');
      setView(next);
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }

  async function resume() {
    setActionNotice(null);
    try {
      const next = await api.resume(sessionId);
      setView(next);
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }

  // Virtuoso "tail-follow" toggle: when the user is within 80px of the bottom,
  // new live records yank them down; otherwise they stay put.
  const [atBottom, setAtBottom] = useState(true);
  function onAtBottomChange(b: boolean) {
    setAtBottom(b);
    setShowJump(!b);
  }

  // ---- header --------------------------------------------------------------
  const header = view ? (
    <div className="flex flex-wrap items-center gap-3 mt-4 mb-3">
      <Link to="/" className="inline-flex items-center gap-1 text-muted hover:text-fg text-[13px]">
        <ChevronLeft size={14} /> Sessions
      </Link>
      <h1 className="text-[1.3rem] tracking-tight m-0">{view.config.teammate || view.config.name || sessionId}</h1>
      {/* The TASK is the whole point of the session — keep it visible next to
          the callsign, with the label chip for grouping context. */}
      {view.config.teammate && view.config.name && (
        <span className="text-[13px] text-fg-soft truncate max-w-[28rem]" title={view.config.name}>
          {view.config.name}
        </span>
      )}
      {view.config.label && <Badge tone="accent">{view.config.label}</Badge>}
      <Badge tone={toneFor(view.state.status)}>{view.state.status}</Badge>
      <span className="mono text-[11.5px] text-muted">
        {view.config.model || view.config.modelHint || 'default'} · turn {view.state.turn}
      </span>
      {/* Wrapper binary + harness kind. Soft foreground, small text, truncated
          (binary names like `claude-auto-loge` can be long on narrow viewports). */}
      <span
        className="mono text-[11.5px] text-fg-soft truncate min-w-0 max-w-[22rem]"
        title={`${view.config.binary} (${view.config.harness} TUI)`}
      >
        {view.config.binary} · {view.config.harness} TUI
      </span>
      {view.state.contextPercent != null && (
        <span className="mono text-[12px] text-fg-soft">context {view.state.contextPercent}%</span>
      )}
      <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted mono">
        <span
          className={
            liveStatus === 'open'
              ? 'w-1.5 h-1.5 rounded-full bg-ok inline-block'
              : liveStatus === 'connecting'
                ? 'w-1.5 h-1.5 rounded-full bg-warn inline-block'
                : 'w-1.5 h-1.5 rounded-full bg-err inline-block'
          }
        />
        ws {liveStatus}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={toggleDensity}
        title={
          density === 'compact'
            ? 'Showing compact view (titles + chips only) — click for full bodies'
            : 'Showing comfortable view (full bodies) — click to compact'
        }
      >
        {density === 'compact' ? <Rows3 size={12} /> : <Maximize2 size={12} />}
        {density === 'compact' ? 'compact' : 'comfortable'}
      </Button>
      <ActionGroup className="ml-2">
        {!isTerminal && HAS_TOKEN && (
          <Button size="sm" variant="outline" onClick={interrupt} title="Interrupt the active turn">
            <Pause size={12} /> Interrupt
          </Button>
        )}
        {(!isTerminal || isKillFailed) && HAS_TOKEN && (
          <Button size="sm" variant="danger" onClick={stop} title="Stop the session">
            <StopCircle size={12} /> Stop
          </Button>
        )}
        {isTerminal && !isKillFailed && HAS_TOKEN && (
          <Button size="sm" variant="primary" onClick={resume} title="Resume a finished session">
            <Play size={12} /> Resume
          </Button>
        )}
        {isKillFailed && (
          <span className="inline-flex items-center gap-1 text-warn text-[12px]">
            <ZapOff size={12} /> failed to kill — issue Stop first
          </span>
        )}
      </ActionGroup>
    </div>
  ) : null;

  // ---- main view -----------------------------------------------------------
  const headerSlot = (
    <>
      {loadingOlder && <div className="text-center text-muted text-[12px] py-2">loading older messages…</div>}
      {atStart && records.length > 0 && (
        <div className="text-center text-muted text-[12px] py-2">start of chat · {total} records total</div>
      )}
      {view && WAITING_STATUSES.has(view.state.status) && (
        <div className="mx-auto mb-2 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-[12.5px] text-warn max-w-[640px]">
          <div className="font-semibold mb-0.5">Waiting for input</div>
          <span>
            harness is in <code className="mono">{view.state.status}</code> since{' '}
            {fmtAbsolute(view.state.lastActivityAt)}.
          </span>
        </div>
      )}
    </>
  );
  const footerSlot = busy ? (
    <div className="mt-3 flex justify-start">
      <div className="max-w-[min(720px,85%)] rounded-lg border border-border bg-surface px-3 py-2.5">
        <ThinkingIndicator activity={view?.state.activity ?? null} />
      </div>
    </div>
  ) : null;

  return (
    <div className="flex flex-col h-[calc(100vh-44px)]">
      {header}
      <div className="flex items-center gap-2 mb-2">
        <ViewTabs<'chat' | 'terminal'>
          tabs={[
            { id: 'chat', label: 'Chat', icon: <MessageSquare size={12} /> },
            { id: 'terminal', label: 'Terminal', icon: <Terminal size={12} /> },
          ]}
          current={tab}
          onChange={setTab}
        />
      </div>
      {error && (
        <div className="rounded-md border border-err-border bg-err-bg px-3 py-2 text-err text-[13px] mb-2">{error}</div>
      )}
      {actionNotice && (
        <div
          className={
            actionNotice.kind === 'err'
              ? 'rounded-md border border-err-border bg-err-bg px-3 py-1.5 text-err text-[12.5px] mb-2'
              : 'rounded-md border border-ok-border bg-ok-bg px-3 py-1.5 text-ok text-[12.5px] mb-2'
          }
        >
          {actionNotice.text}
        </div>
      )}

      {tab === 'terminal' ? (
        // Terminal tab handles its own polling + sticky-scroll; no composer,
        // jump-to-latest, or snapshot drawer while it's mounted (it's the
        // snapshot, no need to duplicate it).
        <TerminalView sessionId={sessionId} tmuxSession={view?.config.tmuxSession ?? ''} />
      ) : (
        <>
          <div className="flex-1 min-h-0 rounded-md border border-border bg-surface flex flex-col overflow-hidden relative">
            {loadingInitial ? (
              <ThreadSkeleton />
            ) : (
              <Virtuoso
                ref={virtuosoRef}
                firstItemIndex={firstIndex}
                initialTopMostItemIndex={Math.max(firstIndex + bubbles.length - 1, 0)}
                data={bubbles}
                followOutput={atBottom ? 'smooth' : false}
                atBottomStateChange={onAtBottomChange}
                startReached={() => void loadOlder()}
                increaseViewportBy={{ top: 600, bottom: 600 }}
                itemContent={(_, bubble) => <BubbleRow bubble={bubble} density={density} />}
                components={{ Header: () => <>{headerSlot}</>, Footer: () => <>{footerSlot}</> }}
                className="flex-1 min-h-0"
                style={{ height: '100%' }}
              />
            )}
            {showJump && !loadingInitial && (
              <button
                type="button"
                onClick={() => {
                  virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
                }}
                className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border border-accent-border bg-accent text-accent-fg px-3 py-1 text-[12px] font-semibold shadow-md hover:opacity-90"
              >
                <ArrowDown size={12} className="inline mr-1" /> jump to latest
              </button>
            )}
          </div>

          {!awaitingQ && HAS_TOKEN && (
            <div className="mt-3">
              <Composer
                draft={draft}
                onDraftChange={setDraft}
                onSubmit={() => void send()}
                onInterruptAndSend={() => void interruptAndSend()}
                disabled={!view || loadingInitial}
                busy={busy}
              />
            </div>
          )}
          {awaitingQ && pendingQ && HAS_TOKEN && (
            <div className="mt-3">
              <QuestionForm
                sessionId={sessionId}
                question={pendingQ}
                onSubmit={() => {
                  void refreshView();
                }}
              />
            </div>
          )}
          {!HAS_TOKEN && (
            <div className="mt-3 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-warn text-[13px]">
              Read-only: this origin did not receive an embedding token from the daemon, so messages, answers, and
              control actions are disabled.
            </div>
          )}

          <div className="mt-3">
            <PaneSnapshotDrawer sessionId={sessionId} />
          </div>
        </>
      )}
    </div>
  );
}

function BubbleRow({
  bubble,
  density,
}: {
  bubble: ReturnType<typeof pairRecordsToBubbles>[number];
  density: 'comfortable' | 'compact';
}) {
  return <MessageBubble bubble={bubble} density={density} />;
}

function ThreadSkeleton() {
  return (
    <div className="flex-1 min-h-0 overflow-hidden p-4 space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex animate-pulse">
          <div className="h-12 w-3/5 rounded-md bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

// Map a WS event envelope onto a ChatRecord. The daemon sometimes sends the
// full record as `data`, other times flattens fields. Best-effort: prefer
// `data`, fall back to envelope fields.
function eventToRecord(ev: KTeamEvent): ChatRecord | null {
  const d = ev.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  const type = ev.type;
  if (
    type !== 'chat.user' &&
    type !== 'chat.assistant.text' &&
    type !== 'chat.assistant.thinking' &&
    type !== 'chat.assistant.reasoning' &&
    type !== 'tool.use' &&
    type !== 'tool.result' &&
    type !== 'interaction.question' &&
    type !== 'interaction.answer' &&
    type !== 'turn.started' &&
    type !== 'turn.completed' &&
    type !== 'turn.aborted'
  )
    return null;
  const source = (typeof d['source'] === 'string' ? d['source'] : ev.source) as string;
  const sourceTyped = (source === 'claude' || source === 'codex' ? source : 'claude') as 'claude' | 'codex';
  return {
    source: sourceTyped,
    timestamp: typeof d['timestamp'] === 'string' ? (d['timestamp'] as string) : ev.time,
    type,
    data: d,
  } as ChatRecord;
}

function recordKey(rec: ChatRecord): string {
  const t = rec.timestamp ?? '';
  const type = rec.type;
  const data = rec.data;
  let sig = '';
  if (data && typeof data === 'object') {
    if ('text' in data) sig += `t=${String((data as { text?: unknown }).text ?? '').slice(0, 256)}`;
    if ('thinking' in data) sig += `th=${String((data as { thinking?: unknown }).thinking ?? '').slice(0, 256)}`;
    if ('reasoning' in data) sig += `r=${String((data as { reasoning?: unknown }).reasoning ?? '').slice(0, 256)}`;
    if ('toolUseId' in data) sig += `id=${String((data as { toolUseId?: unknown }).toolUseId ?? '')}`;
    if ('isError' in data) sig += `e=${String((data as { isError?: unknown }).isError ?? '')}`;
  }
  return `${rec.source}|${type}|${t}|${sig}`;
}
