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
// Network budget (round 5): this page owns NO socket and NO poll. The shared
// store (lib/store.tsx) holds the one fleet socket, applies state deltas and
// batches a targeted `getSession` per session; this page subscribes to its
// session's event stream (buffered, so history→subscribe has no gap), reads the
// cached SessionView, and fetches only chat history. What it removed: a second
// WebSocket, an 8s `getSession` poll and a 20s `listSessions` poll for folder
// neighbours — all three ran per open session, forever.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Terminal } from 'lucide-react';
import { api, ApiError, HAS_TOKEN } from '../lib/api';
import { useFleet, useSession, useSessionEvents, useStore } from '../lib/store';
import type { ChatRecord, KTeamEvent } from '../types';
import { Composer } from '../components/Composer';
import { QuestionForm } from '../components/QuestionForm';
import { TerminalView } from '../components/TerminalView';
import { ViewTabs } from '../components/ViewTabs';
import { SessionHeader } from '../components/SessionHeader';
import { Transcript } from '../components/Transcript';
import { ThinkingIndicator } from '../components/Harness';
import { buildTranscript, latestPendingQuestion } from '../lib/transcript';
import { useUsage } from '../hooks/useUsage';
import { quotaFor } from '../lib/usage';
import { FolderSidebar, FolderSidebarToggle, folderNeighbours } from '../components/FolderSidebar';
import { TERMINAL_STATUSES, WAITING_STATUSES, cn, fmtAbsolute, isBusy } from '../lib/utils';

const PAGE_SIZE = 200;
/** Slack when matching an optimistic send against the real chat.user record it
 *  became. The record's timestamp comes from the harness's own clock, which can
 *  sit slightly behind the browser's. */
const RECORD_CLOCK_SLACK_MS = 5_000;

type PendingStatus = 'sending' | 'queued' | 'delivered' | 'error';
interface PendingSend {
  key: string;
  text: string;
  status: PendingStatus;
  /** Idempotency key for the LOGICAL message. Every attempt to deliver this
   *  message — the first, a retry after an error, the interrupt-then-send path —
   *  carries this same id, so the daemon applies it exactly once. */
  requestId: string;
  /** When the reader sent it. Used to reap against chat.user records that
   *  arrived AFTER this send, never against an identical older message. */
  at: number;
}

export function SessionChatPage({ sessionId }: { sessionId: string }) {
  const store = useStore();
  // The cached SessionView. Navigating to a session you have seen paints its
  // header immediately instead of after a round trip; the store keeps it fresh
  // from the socket (deltas + one batched GET per burst).
  const view = useSession(sessionId);
  const { sessions, status: liveStatus } = useFleet();
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const [draft, setDraft] = useState('');
  const [actionNotice, setActionNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  // Bumped to (re-)pin the transcript to the true tail and re-engage follow.
  // Two occasions, both of which mean "the reader's attention is at the bottom":
  //   - the initial page has loaded (open a session → you want the latest)
  //   - the reader just SENT something (you want to watch the reply arrive, even
  //     if you had scrolled up to re-read something while composing)
  const [pinSignal, setPinSignal] = useState(0);
  const pinToBottom = useCallback(() => setPinSignal(n => n + 1), []);

  const seenKeys = useRef<Set<string>>(new Set());
  /** True once the initial history page has settled — gates the reconnect
   *  catch-up so it can never race the first load. */
  const loadedRef = useRef(false);

  /** Merge a freshly fetched tail page into the record list. Content dedupe
   *  (`seenKeys`) does the work: anything already on screen is dropped, so a
   *  re-fetch of the same page is a no-op and only genuinely missed records
   *  land — which, being a tail, belong at the end. */
  const mergeTail = useCallback((page: { total: number; records: ChatRecord[] }) => {
    setTotal(page.total);
    setRecords(rs => {
      const fresh = page.records.filter(r => !seenKeys.current.has(recordKey(r)));
      if (fresh.length === 0) return rs;
      for (const r of fresh) seenKeys.current.add(recordKey(r));
      return [...rs, ...fresh];
    });
  }, []);

  // ---- initial load: cached/fetched view + first history page --------------
  useEffect(() => {
    let cancelled = false;
    setRecords([]);
    setError(null);
    setNextBefore(null);
    setLoadingInitial(true);
    setAtStart(false);
    setPinSignal(0);
    seenKeys.current.clear();
    loadedRef.current = false;

    (async () => {
      try {
        // The view goes through the store (one inflight request per session,
        // shared with the socket-driven refresh) so a deep link and the fleet
        // hydration cannot both GET the same session.
        const [, page] = await Promise.all([
          store.fetchSession(sessionId),
          api.chatHistory(sessionId, undefined, PAGE_SIZE),
        ]);
        if (cancelled) return;
        setTotal(page.total);
        // MERGE, don't replace. The subscription is live while this fetch is in
        // flight (and replays the store's buffer the moment it attaches), so
        // records can already be on screen — a plain `setRecords(page.records)`
        // threw away anything that streamed in during the round trip. History is
        // older than anything appended live, so the fresh half goes in front.
        setRecords(live => {
          const fresh = page.records.filter(r => !seenKeys.current.has(recordKey(r)));
          for (const r of fresh) seenKeys.current.add(recordKey(r));
          return live.length === 0 ? fresh : [...fresh, ...live];
        });
        setNextBefore(page.offset);
        setAtStart(page.offset === 0);
        setPinSignal(n => n + 1);
        loadedRef.current = true;
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingInitial(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, store]);

  // ---- live events: the store's per-session subscription -------------------
  //
  // Buffered-then-live: the store replays its bounded recent window for this
  // session the moment we subscribe, so an event that arrived while the history
  // fetch was in flight is not lost between the two.
  //
  // Only transcript records are handled here. State — terminal.frame fields,
  // status/health transitions, quota — is applied by the store to the cached
  // SessionView this page reads, so there is no second copy to keep in sync and
  // no per-page refresh timer.
  useSessionEvents(sessionId, (ev: KTeamEvent) => {
    // SEQUENCE 0 MEANS "NOT IN THE JOURNAL", NOT "OLD".
    //
    // Two whole event classes are broadcast live but never journalled, and both
    // carry sequence 0 by construction:
    //   - terminal.frame            (liveness only; 6.5k/session on disk)
    //   - every harness-derived chat event — chat.user, chat.assistant.*,
    //     tool.use, tool.result (commit 03ff676: indexed by byte pointer in the
    //     harness's own transcript, never copied into events.jsonl)
    //
    // A monotonic sequence guard is only meaningful for JOURNALLED events;
    // applying it to sequence-0 events discarded 100% of streaming chat. The
    // store dedupes journalled events by (session, sequence) and lets every
    // sequence-0 frame through; CONTENT dedupe (`seenKeys`) is the correct
    // mechanism for these, and it runs below.
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
      // Append only — the MessageScroller auto-follows the tail when the reader
      // is at the bottom, and leaves them put otherwise.
      setRecords(rs => [...rs, rec]);
    }
  });

  // ---- reconnect catch-up --------------------------------------------------
  //
  // The socket's own backfill is a JOURNAL tail, and chat frames are not
  // journalled (sequence 0, byte-pointer indexed in the harness transcript). So
  // a drop of any length loses exactly the messages the reader cares about, and
  // nothing replays them. On every reopen, re-fetch the newest history page and
  // merge it: everything already on screen is dropped by content dedupe, so the
  // cost of a redundant catch-up is one request.
  const previousStatus = useRef(liveStatus);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = liveStatus;
    if (liveStatus !== 'open' || previous === 'open' || !loadedRef.current) return;
    void api
      .chatHistory(sessionId, undefined, PAGE_SIZE)
      .then(mergeTail)
      .catch(() => undefined);
  }, [liveStatus, mergeTail, sessionId]);

  // ---- infinite scroll-up: load older pages via `before` -------------------
  // The guard is a REF, not the `loadingOlder` state. The transcript calls this
  // from its scroll handler, which fires several times per tick near the top;
  // `setLoadingOlder(true)` does not take effect until the next render, so every
  // one of those calls passed the state guard and fetched the SAME page.
  // Measured: the duplicate prepends land in one commit, scrollHeight spikes to
  // +2× the page before settling back, and the scroll controller's prepend
  // correction — which reads scrollHeight in that commit — over-corrects by the
  // whole spike and throws the reader to the bottom (see Transcript.tsx).
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || nextBefore == null) return;
    loadingOlderRef.current = true;
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
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [nextBefore, sessionId]);

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

  // Account quota for this session's wrapper. The feed is fleet-wide and
  // joined by binary, so the badge is populated on the first paint rather than
  // waiting for this session's own 60s quota tick (see lib/usage.ts).
  const { index: usageIdx } = useUsage();
  const quota = useMemo(() => (view ? quotaFor(view, usageIdx) : null), [view, usageIdx]);

  // ---- folder neighbours: who else is working in this cwd ------------------
  // Straight off the store's fleet cache — no poll of its own. This used to be
  // a 20s `listSessions()` per open session purely to answer "who else is in
  // this folder", a question the shared list already answers.
  const neighbours = useMemo(() => folderNeighbours(sessions ?? [], view ?? null), [sessions, view]);
  // Closed by default: the sidebar is a lookup, not the reason you opened the
  // page, and opening it narrows the transcript.
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
  // Mirror, so send() can consult the CURRENT list without closing over a
  // render-old copy (it needs the requestId of a still-failed identical send).
  const pendingRef = useRef<PendingSend[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // REAPING. The real chat.user record IS the proof of delivery, so it retires
  // the optimistic box whatever the box currently claims — including 'sending'
  // (the POST can outlive the record: the harness writes its transcript entry as
  // soon as the text is submitted, while the daemon is still polling the pane for
  // turn-started evidence) and including 'error' (measured: a send whose response
  // was lost had in fact landed, and the box sat there reading "failed to send"
  // next to the delivered message forever). Keeping either of those was the
  // visible half of "message double send": the same text rendered twice.
  //
  // Matched only against records that arrived AFTER this send, so re-sending
  // text that already appears earlier in the transcript ("continue", "ok") is not
  // reaped by its own predecessor.
  useEffect(() => {
    if (!pending.length) return;
    const userMsgs = records
      .filter(r => r.type === 'chat.user')
      .map(r => ({
        text: String((r.data as { text?: unknown } | undefined)?.text ?? '').trim(),
        at: Date.parse(r.timestamp ?? '') || 0,
      }));
    setPending(p => {
      const next = p.filter(x => !userMsgs.some(m => m.text === x.text && m.at >= x.at - RECORD_CLOCK_SLACK_MS));
      return next.length === p.length ? p : next;
    });
  }, [records, pending.length]);

  // Send lock: a SYNCHRONOUS ref guard blocks a CONCURRENT second call (Enter +
  // click in one gesture, rapid double-Enter, a stray re-fire) before the first
  // yields at its await. `sending` mirrors it for the composer's disabled state.
  //
  // What it cannot do — and this is why the bug survived three rounds — is stop
  // a SEQUENTIAL repeat: the reader sends, the call fails (or its response is
  // lost), the guard is released in `finally`, and the reader sends the same
  // message again. Two attempts, no overlap, so no lock can see the connection.
  // Only an idempotency key spanning both attempts can, which is what
  // `identityFor` resolves and what api.send now carries.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);

  /** The identity a logical message should be sent under.
   *
   *  If the same text is still sitting there as FAILED, this send IS that message
   *  again — the reader retyping instead of pressing retry — so it inherits both
   *  the original request id (the daemon then recognises the repeat and does not
   *  apply it twice; measured double delivery, 2026-07-25) and the original row
   *  (one message, one box). Any other send, including a deliberate repeat of
   *  text that already went through, gets a fresh id and is delivered normally. */
  const identityFor = useCallback((text: string): { requestId: string; key?: string } => {
    const failed = pendingRef.current.find(p => p.text === text && p.status === 'error');
    return failed ? { requestId: failed.requestId, key: failed.key } : { requestId: crypto.randomUUID() };
  }, []);

  // ---- actions -------------------------------------------------------------
  const deliver = useCallback(
    async (msg: string, opts: { interruptFirst: boolean; requestId: string; key?: string }) => {
      if (sendingRef.current) return;
      if (!msg || !HAS_TOKEN) return;
      sendingRef.current = true;
      setSending(true);
      setActionNotice(null);
      const key = opts.key ?? `send-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      // A retry re-uses its own row rather than stacking a second box for the
      // same message.
      setPending(p =>
        p.some(x => x.key === key)
          ? p.map(x => (x.key === key ? { ...x, status: 'sending' as PendingStatus } : x))
          : [...p, { key, text: msg, status: 'sending' as PendingStatus, requestId: opts.requestId, at: Date.now() }],
      );
      // The reader just spoke: put them at the bottom and resume following, so the
      // reply streams in under their eyes instead of somewhere off-screen.
      pinToBottom();
      try {
        if (opts.interruptFirst) await api.interrupt(sessionId);
        const next = await api.send(sessionId, msg, false, opts.requestId);
        // Straight into the shared cache: this page, the dashboard behind it and
        // the folder sidebar all read the same record.
        store.upsertSession(next);
        const queued = !opts.interruptFirst && (busy || isBusy(next));
        setPending(p => p.map(x => (x.key === key ? { ...x, status: queued ? 'queued' : 'delivered' } : x)));
      } catch (e) {
        setPending(p => p.map(x => (x.key === key ? { ...x, status: 'error' } : x)));
        setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [busy, pinToBottom, sessionId],
  );

  function send() {
    const msg = draft.trim();
    if (!msg || sendingRef.current) return;
    setDraft('');
    void deliver(msg, { interruptFirst: false, ...identityFor(msg) });
  }

  function interruptAndSend() {
    const msg = draft.trim();
    if (!msg || sendingRef.current) return;
    setDraft('');
    void deliver(msg, { interruptFirst: true, ...identityFor(msg) });
  }

  /** Retry a failed optimistic send with its ORIGINAL request id, so a first
   *  attempt that actually landed (and only lost its response) is recognised by
   *  the daemon and not applied a second time. */
  const retryPending = useCallback(
    (entry: PendingSend) => {
      void deliver(entry.text, { interruptFirst: false, requestId: entry.requestId, key: entry.key });
    },
    [deliver],
  );

  const dismissPending = useCallback((key: string) => {
    setPending(p => p.filter(x => x.key !== key));
  }, []);

  const interrupt = useCallback(async () => {
    setActionNotice(null);
    try {
      store.upsertSession(await api.interrupt(sessionId));
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }, [sessionId, store]);

  const stop = useCallback(async () => {
    const reason = window.prompt('Reason for stopping this session:', 'stopped from browser');
    if (reason == null) return;
    setActionNotice(null);
    try {
      store.upsertSession(await api.stop(sessionId, reason.trim() || 'stopped from browser'));
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }, [sessionId, store]);

  const resume = useCallback(async () => {
    setActionNotice(null);
    try {
      store.upsertSession(await api.resume(sessionId));
    } catch (e) {
      setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
    }
  }, [sessionId, store]);

  // ---- transcript header / footer slots ------------------------------------
  const transcriptHeader = (
    <>
      {loadingOlder && <div className="py-1 text-center text-[11.5px] text-muted">loading older messages…</div>}
      {atStart && records.length > 0 && (
        <div className="py-1 text-center text-[11px] text-faint">start of conversation · {total} records</div>
      )}
      {view && WAITING_STATUSES.has(view.state.status) && (
        <div className="mx-auto mb-1 max-w-[640px] rounded-md border border-warn-border bg-warn-bg px-2.5 py-1 text-[12px] text-warn">
          waiting for input — <code className="mono">{view.state.status}</code> since{' '}
          {fmtAbsolute(view.state.lastActivityAt)}
        </div>
      )}
    </>
  );
  const transcriptFooter =
    pending.length || busy ? (
      <div className="space-y-1 px-1 py-1">
        {pending.map(p => (
          <PendingMessage
            key={p.key}
            text={p.text}
            status={p.status}
            onRetry={() => retryPending(p)}
            onDismiss={() => dismissPending(p.key)}
          />
        ))}
        {busy && <ThinkingIndicator activity={view?.state.activity ?? null} since={busySince} />}
      </div>
    ) : null;

  // h-full/min-h-0 — the shell (App.tsx) owns the viewport height now; this page
  // just fills what it is given. A hardcoded calc() here is what made the page
  // itself scrollable on top of the transcript.
  //
  // The folder sidebar is a SIBLING column (lg+) rather than anything nested in
  // the transcript, so opening it narrows the conversation instead of adding a
  // second scroller inside it.
  return (
    <div className="flex h-full min-h-0 flex-col pb-2">
      {view && (
        <SessionHeader
          view={view}
          quota={quota}
          liveStatus={liveStatus}
          isTerminal={isTerminal}
          isKillFailed={isKillFailed}
          hasToken={HAS_TOKEN}
          onInterrupt={() => void interrupt()}
          onStop={() => void stop()}
          onResume={() => void resume()}
          folderToggle={
            <FolderSidebarToggle count={neighbours.total} open={sidebarOpen} onToggle={() => setSidebarOpen(v => !v)} />
          }
          // The Chat/Terminal switch rides in the header rather than owning a
          // row of its own — one two-item segmented control did not justify
          // ~34px of every screen.
          tabs={
            <ViewTabs<'chat' | 'terminal'>
              tabs={[
                { id: 'chat', label: 'Chat', icon: <MessageSquare size={11} /> },
                { id: 'terminal', label: 'Terminal', icon: <Terminal size={11} /> },
              ]}
              current={tab}
              onChange={setTab}
            />
          }
        />
      )}

      {error && (
        <div className="mb-1 rounded-md border border-err-border bg-err-bg px-2.5 py-1 text-[12.5px] text-err">
          {error}
        </div>
      )}
      {actionNotice && (
        <div
          className={
            actionNotice.kind === 'err'
              ? 'mb-1 rounded-md border border-err-border bg-err-bg px-2.5 py-1 text-[12px] text-err'
              : 'mb-1 rounded-md border border-ok-border bg-ok-bg px-2.5 py-1 text-[12px] text-ok'
          }
        >
          {actionNotice.text}
        </div>
      )}

      {tab === 'terminal' ? (
        <TerminalView sessionId={sessionId} tmuxSession={view?.config.tmuxSession ?? ''} />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 gap-2">
            <FolderSidebar
              current={view ?? null}
              neighbours={neighbours}
              usage={usageIdx}
              open={sidebarOpen}
              onToggle={() => setSidebarOpen(v => !v)}
            />
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
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
          </div>

          {!awaitingQ && HAS_TOKEN && (
            <div className="mt-2">
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
            <div className="mt-2">
              <QuestionForm
                sessionId={sessionId}
                question={pendingQ}
                onSubmit={() => void store.fetchSession(sessionId).catch(() => undefined)}
              />
            </div>
          )}
          {!HAS_TOKEN && (
            <div className="mt-2 rounded-md border border-warn-border bg-warn-bg px-2.5 py-1.5 text-[12.5px] text-warn">
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
// delivered/queued/failed state badge so the send never feels lost.
//
// The status used to be a bare run of coloured monospace text hard against the
// box's right edge, which read as a glitch rather than a label: at 10.5px, full
// --warn on --user-bg with no padding and no container looks like an inverted
// selection block, and it was the only element in the transcript styled that
// way. It is now the same quiet chip the rest of the UI uses — soft tonal
// background, hairline border, rounded, padded, non-selectable, inset from the
// edge like every other piece of row metadata. Widths are stable across the four
// states (the label text changes, nothing around it moves), so the pending →
// delivered transition cannot jump the layout.
const PENDING_BADGE: Record<PendingStatus, { label: string; tone: string }> = {
  sending: { label: 'sending', tone: 'border-border bg-surface-2 text-muted' },
  queued: { label: 'queued for next turn', tone: 'border-warn-border bg-warn-bg text-warn' },
  delivered: { label: 'delivered', tone: 'border-ok-border bg-ok-bg text-ok' },
  error: { label: 'failed to send', tone: 'border-err-border bg-err-bg text-err' },
};

function PendingMessage({
  text,
  status,
  onRetry,
  onDismiss,
}: {
  text: string;
  status: PendingStatus;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const { label, tone } = PENDING_BADGE[status];
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-l-[2.5px] border-border border-l-user-border bg-user-bg',
        status === 'delivered' && 'opacity-80',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 pt-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-accent">you</span>
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 select-none items-center gap-1 rounded-sm border px-1.5 py-px text-[10.5px] font-medium leading-[1.5]',
            tone,
          )}
        >
          {status === 'sending' && (
            <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
          )}
          {label}
        </span>
        {status === 'error' && (
          <>
            {/* Retry re-uses this message's original request id, so a first
                attempt that DID land is recognised by the daemon and dropped
                rather than delivered twice (see requestIdFor). */}
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-sm border border-border px-1.5 py-px text-[10.5px] font-medium text-muted hover:bg-surface-2 hover:text-fg"
              title="Send this message again with the same idempotency key — if the first attempt actually landed, the daemon will not deliver it twice"
            >
              retry
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="shrink-0 rounded-sm px-1 py-px text-[10.5px] text-faint hover:text-fg"
              title="Remove this box"
            >
              dismiss
            </button>
          </>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words px-2.5 pb-1.5 pt-0.5 text-[13px] leading-snug text-fg">
        {text}
      </div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col gap-3 p-3">
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
  const meta = ev as unknown as { recordUuid?: string; blockIndex?: number };
  return {
    source: sourceTyped,
    timestamp: typeof d['timestamp'] === 'string' ? (d['timestamp'] as string) : ev.time,
    type,
    data: d,
    // Carried so this live record and its /chat twin share one identity key.
    ...(meta.recordUuid === undefined ? {} : { recordUuid: meta.recordUuid }),
    ...(meta.blockIndex === undefined ? {} : { blockIndex: meta.blockIndex }),
  } as ChatRecord;
}

// Identity of one chat record, for live-vs-history dedupe.
//
// PREFIX TRUNCATION IS NOT ALLOWED HERE. The old key hashed only the first 256
// chars of the body, so two long assistant messages sharing an opening (very
// common: "Let me check the...", a repeated tool preamble) collided and the
// second was silently dropped as "already seen" — losing whole streamed
// paragraphs. `recordUuid` is the harness's own per-record id and is exact when
// present; otherwise fall back to a full-length content hash.
function fieldHash(value: unknown): string {
  const s = String(value ?? '');
  // djb2 over the WHOLE string, plus the length as a cheap collision guard.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${s.length}`;
}

function recordKey(rec: ChatRecord): string {
  const t = rec.timestamp ?? '';
  const type = rec.type;
  const data = rec.data as Record<string, unknown> | undefined;
  // `recordUuid` + `blockIndex` sit at the TOP level of a chat record (history)
  // and of a live chat frame (broadcastChat forwards them) — one exact identity
  // shared by both paths, so a reconnect's backfill never re-appends the tail.
  const meta = rec as unknown as { recordUuid?: unknown; blockIndex?: unknown };
  if (typeof meta.recordUuid === 'string' && meta.recordUuid)
    return `${rec.source}|${type}|${meta.recordUuid}|${String(meta.blockIndex ?? '')}`;
  let sig = '';
  if (data) {
    if ('text' in data) sig += `t=${fieldHash(data['text'])}`;
    if ('thinking' in data) sig += `th=${fieldHash(data['thinking'])}`;
    if ('reasoning' in data) sig += `r=${fieldHash(data['reasoning'])}`;
    if ('toolUseId' in data) sig += `id=${String(data['toolUseId'] ?? '')}`;
    if ('isError' in data) sig += `e=${String(data['isError'] ?? '')}`;
  }
  return `${rec.source}|${type}|${t}|${sig}`;
}
