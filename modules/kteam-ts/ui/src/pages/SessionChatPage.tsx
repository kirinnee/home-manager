// Single-session chat page:
//  - tail-first loading with infinite scroll-up pagination via `before`
//  - transcript rendering (role-marked blocks, tools collapsed) built by
//    buildTranscript()
//  - live tail-follow via WS chat.* events (deduped); the MessageScroller
//    owns sticky-bottom + jump-to-latest, so there is no manual scrolling here
//  - composer (Enter send / Shift+Enter newline), queued-notice when busy,
//    disabled while awaiting_question (the question form is the input then)
//  - compact two-row header; Terminal tab retains its own snapshot polling
//
// Network budget (turn-003): the WS /v1/events feed drives live updates; the
// only poll left here is a slow (8s) visibility-gated state fallback.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Terminal } from 'lucide-react';
import { api, ApiError, HAS_TOKEN } from '../lib/api';
import { openEventStream } from '../lib/ws';
import type { SessionView, ChatRecord, KTeamEvent } from '../types';
import { Composer } from '../components/Composer';
import { QuestionForm } from '../components/QuestionForm';
import { TerminalView } from '../components/TerminalView';
import { ViewTabs } from '../components/ViewTabs';
import { SessionHeader } from '../components/SessionHeader';
import { Transcript } from '../components/Transcript';
import { ThinkingIndicator } from '../components/Harness';
import { buildTranscript, latestPendingQuestion } from '../lib/transcript';
import { TERMINAL_STATUSES, WAITING_STATUSES, fmtAbsolute, isBusy } from '../lib/utils';

const PAGE_SIZE = 200;

type PendingStatus = 'sending' | 'queued' | 'delivered' | 'error';
interface PendingSend {
  key: string;
  text: string;
  status: PendingStatus;
}

export function SessionChatPage({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [draft, setDraft] = useState('');
  const [actionNotice, setActionNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  // Bumped after the initial page loads to settle the MessageScroller at the
  // true tail once dynamic (markdown/code) heights have laid out.
  const [pinSignal, setPinSignal] = useState(0);

  const seenKeys = useRef<Set<string>>(new Set());
  const lastSeq = useRef<number>(-1);
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
    setPinSignal(0);
    seenKeys.current.clear();
    lastSeq.current = -1;

    (async () => {
      try {
        const [v, page] = await Promise.all([
          api.getSession(sessionId),
          api.chatHistory(sessionId, undefined, PAGE_SIZE),
        ]);
        if (cancelled) return;
        setView(v);
        setTotal(page.total);
        setRecords(page.records);
        setNextBefore(page.offset);
        for (const r of page.records) seenKeys.current.add(recordKey(r));
        setAtStart(page.offset === 0);
        setPinSignal(n => n + 1);
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

  // ---- state refresh: WS-driven, with a slow visibility-gated fallback -----
  const refreshView = useCallback(async () => {
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

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshView();
    }, 1100);
  }, [refreshView]);

  useEffect(() => {
    // Fallback poll only — the WS state events are the primary path. Paused
    // whenever the tab is hidden (turn-003 network budget).
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshView();
    }, 8000);
    return () => window.clearInterval(id);
  }, [refreshView]);

  // ---- websocket: live chat events + terminal.frame → activity / context% --
  useEffect(() => {
    const handle = openEventStream(
      sessionId,
      -200,
      (ev: KTeamEvent) => {
        if (typeof ev.sequence === 'number' && ev.sequence <= lastSeq.current) return;
        if (typeof ev.sequence === 'number') lastSeq.current = ev.sequence;

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

        if (ev.type === 'state' || ev.type === 'session.state') {
          scheduleRefresh();
          return;
        }

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
          // Append only — the MessageScroller auto-follows the tail when the
          // reader is at the bottom, and leaves them put otherwise.
          setRecords(rs => [...rs, rec]);
        }
      },
      setLiveStatus,
    );
    return () => handle.close();
  }, [sessionId, scheduleRefresh]);

  // ---- infinite scroll-up: load older pages via `before` -------------------
  const loadOlder = useCallback(async () => {
    if (loadingOlder || nextBefore == null) return;
    setLoadingOlder(true);
    try {
      const page = await api.chatHistory(sessionId, nextBefore, PAGE_SIZE);
      setTotal(page.total);
      setRecords(rs => {
        const fresh = page.records.filter(r => !seenKeys.current.has(recordKey(r)));
        for (const r of fresh) seenKeys.current.add(recordKey(r));
        return [...fresh, ...rs];
      });
      setNextBefore(page.offset);
      setAtStart(page.offset === 0);
    } catch {
      /* leave as-is */
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, nextBefore, sessionId]);

  // ---- derived -------------------------------------------------------------
  const blocks = useMemo(() => buildTranscript(records), [records]);
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

  // Fluid "working" elapsed: stamp when the session became busy, clear when it
  // idles. The footer ticks locally from this (no extra network).
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(prev => (busy ? (prev ?? Date.now()) : null));
  }, [busy]);

  // Optimistic sends: a message shows immediately as a "sent" box with a
  // pending → delivered/queued state; it's reaped once the real chat.user
  // record lands via WS/history.
  const [pending, setPending] = useState<PendingSend[]>([]);
  useEffect(() => {
    if (!pending.length) return;
    const userTexts = new Set(
      records
        .filter(r => r.type === 'chat.user')
        .map(r => String((r.data as { text?: unknown } | undefined)?.text ?? '').trim()),
    );
    setPending(p => {
      const next = p.filter(x => x.status === 'sending' || x.status === 'error' || !userTexts.has(x.text));
      return next.length === p.length ? p : next;
    });
  }, [records, pending.length]);

  // Send lock: a SYNCHRONOUS ref guard is the authoritative double-send fix —
  // it blocks the second call (Enter+click race, rapid double-Enter, a stray
  // re-fire) before the first yields at its await. `sending` mirrors it for the
  // composer's disabled state. The x-kteam-request-id header (lib/api) is the
  // server-side backstop.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);

  // ---- actions -------------------------------------------------------------
  async function send() {
    if (sendingRef.current) return;
    if (!draft.trim() || !HAS_TOKEN) return;
    sendingRef.current = true;
    setSending(true);
    const msg = draft.trim();
    setDraft('');
    setActionNotice(null);
    const key = `send-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setPending(p => [...p, { key, text: msg, status: 'sending' }]);
    try {
      const next = await api.send(sessionId, msg);
      setView(next);
      const queued = busy || isBusy(next);
      setPending(p => p.map(x => (x.key === key ? { ...x, status: queued ? 'queued' : 'delivered' } : x)));
    } catch (e) {
      setPending(p => p.map(x => (x.key === key ? { ...x, status: 'error' } : x)));
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function interruptAndSend() {
    if (sendingRef.current) return;
    if (!draft.trim() || !HAS_TOKEN) return;
    sendingRef.current = true;
    setSending(true);
    const msg = draft.trim();
    setDraft('');
    setActionNotice(null);
    const key = `int-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setPending(p => [...p, { key, text: msg, status: 'sending' }]);
    try {
      await api.interrupt(sessionId);
      const next = await api.send(sessionId, msg);
      setView(next);
      setPending(p => p.map(x => (x.key === key ? { ...x, status: 'delivered' } : x)));
    } catch (e) {
      setPending(p => p.map(x => (x.key === key ? { ...x, status: 'error' } : x)));
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const interrupt = useCallback(async () => {
    setActionNotice(null);
    try {
      setView(await api.interrupt(sessionId));
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }, [sessionId]);

  const stop = useCallback(async () => {
    const reason = window.prompt('Reason for stopping this session:', 'stopped from browser');
    if (reason == null) return;
    setActionNotice(null);
    try {
      setView(await api.stop(sessionId, reason.trim() || 'stopped from browser'));
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }, [sessionId]);

  const resume = useCallback(async () => {
    setActionNotice(null);
    try {
      setView(await api.resume(sessionId));
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }, [sessionId]);

  // ---- transcript header / footer slots ------------------------------------
  const transcriptHeader = (
    <>
      {loadingOlder && <div className="py-2 text-center text-[12px] text-muted">loading older messages…</div>}
      {atStart && records.length > 0 && (
        <div className="py-2 text-center text-[11.5px] text-faint">start of conversation · {total} records</div>
      )}
      {view && WAITING_STATUSES.has(view.state.status) && (
        <div className="mx-auto mb-2 max-w-[640px] rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
          <div className="mb-0.5 font-semibold">Waiting for input</div>
          <span>
            harness is <code className="mono">{view.state.status}</code> since {fmtAbsolute(view.state.lastActivityAt)}.
          </span>
        </div>
      )}
    </>
  );
  const transcriptFooter =
    pending.length || busy ? (
      <div className="space-y-1.5 px-2 py-2">
        {pending.map(p => (
          <PendingMessage key={p.key} text={p.text} status={p.status} />
        ))}
        {busy && <ThinkingIndicator activity={view?.state.activity ?? null} since={busySince} />}
      </div>
    ) : null;

  return (
    <div className="flex h-[calc(100vh-44px)] flex-col">
      {view && (
        <SessionHeader
          view={view}
          liveStatus={liveStatus}
          isTerminal={isTerminal}
          isKillFailed={isKillFailed}
          hasToken={HAS_TOKEN}
          onInterrupt={() => void interrupt()}
          onStop={() => void stop()}
          onResume={() => void resume()}
        />
      )}

      <div className="mb-2 flex items-center gap-2">
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
        <div className="mb-2 rounded-md border border-err-border bg-err-bg px-3 py-2 text-[13px] text-err">{error}</div>
      )}
      {actionNotice && (
        <div
          className={
            actionNotice.kind === 'err'
              ? 'mb-2 rounded-md border border-err-border bg-err-bg px-3 py-1.5 text-[12.5px] text-err'
              : 'mb-2 rounded-md border border-ok-border bg-ok-bg px-3 py-1.5 text-[12.5px] text-ok'
          }
        >
          {actionNotice.text}
        </div>
      )}

      {tab === 'terminal' ? (
        <TerminalView sessionId={sessionId} tmuxSession={view?.config.tmuxSession ?? ''} />
      ) : (
        <>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
            {loadingInitial ? (
              <ThreadSkeleton />
            ) : (
              <Transcript
                blocks={blocks}
                live={busy}
                hasOlder={nextBefore != null}
                loadingOlder={loadingOlder}
                onLoadOlder={() => void loadOlder()}
                pinSignal={pinSignal}
                header={transcriptHeader}
                footer={transcriptFooter}
              />
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
                sending={sending}
              />
            </div>
          )}
          {awaitingQ && pendingQ && HAS_TOKEN && (
            <div className="mt-3">
              <QuestionForm sessionId={sessionId} question={pendingQ} onSubmit={() => void refreshView()} />
            </div>
          )}
          {!HAS_TOKEN && (
            <div className="mt-3 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
              Read-only: this origin did not receive an embedding token from the daemon, so messages, answers, and
              control actions are disabled.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Optimistic "sent" box — mirrors the user-block styling with a pending →
// delivered/queued/failed state chip so the send never feels lost.
function PendingMessage({ text, status }: { text: string; status: PendingStatus }) {
  const label =
    status === 'sending'
      ? 'sending…'
      : status === 'queued'
        ? 'queued for next turn'
        : status === 'delivered'
          ? 'delivered'
          : 'failed to send';
  const tone =
    status === 'error'
      ? 'text-err'
      : status === 'delivered'
        ? 'text-ok'
        : status === 'queued'
          ? 'text-warn'
          : 'text-muted';
  return (
    <div
      className={`overflow-hidden rounded-md border border-l-[2.5px] border-border border-l-user-border bg-user-bg ${
        status === 'delivered' ? 'opacity-80' : ''
      }`}
    >
      <div className="flex items-center gap-2 px-3 pt-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-accent">you</span>
        <span className={`mono ml-auto inline-flex items-center gap-1 text-[10.5px] ${tone}`}>
          {status === 'sending' && (
            <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
          )}
          {label}
        </span>
      </div>
      <div className="whitespace-pre-wrap break-words px-3 pb-2 pt-0.5 text-[13px] leading-relaxed text-fg">{text}</div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col gap-4 p-5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="animate-pulse space-y-2">
          <div className="h-2.5 w-24 rounded bg-surface-2" />
          <div className="h-3 w-4/5 rounded bg-surface-2" />
          <div className="h-3 w-3/5 rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

// Map a WS event envelope onto a ChatRecord.
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
