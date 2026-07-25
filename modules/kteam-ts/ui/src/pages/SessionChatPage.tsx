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
import { displayCallsign } from '../lib/callsign';
import { buildTranscript, latestPendingQuestion, peerFrom } from '../lib/transcript';
import { classifySystemText } from '../lib/system-blocks';
import { useUsage } from '../hooks/useUsage';
import { useDebouncedEffect } from '../hooks/useDebounce';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { quotaFor } from '../lib/usage';
import { TERMINAL_STATUSES, WAITING_STATUSES, cn, fmtAbsolute, isBusy, toneFor } from '../lib/utils';

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

/** A pending local send is confirmed only by a record that the transcript will
 * render as the same genuine human voice. Peer banners and harness-injected
 * system text share the chat.user channel but are not delivery evidence. */
export function recordConfirmsPending(record: ChatRecord, pending: { text: string; at: number }): boolean {
  if (record.type !== 'chat.user') return false;
  const raw = String((record.data as { text?: unknown } | undefined)?.text ?? '');
  const { from, body } = peerFrom(raw);
  if (from || classifySystemText(body)) return false;
  const at = Date.parse(record.timestamp ?? '') || 0;
  return body.trim() === pending.text && at >= pending.at - RECORD_CLOCK_SLACK_MS;
}

export function SessionChatPage({
  sessionId,
  active,
  onOpenSidebar,
}: {
  sessionId: string;
  /** Is this the pane the reader is looking at? Panes stay MOUNTED when you
   *  navigate away (see App.tsx), which is what preserves their draft, scroll
   *  and loaded history — but it also means anything single-instance must not be
   *  rendered by a retained pane. */
  active?: boolean;
  onOpenSidebar?: () => void;
}) {
  const store = useStore();
  // Below DRAWER_MAX the app bar is suppressed (App.tsx) and this page's header
  // becomes the app's only top row, so it inherits the drawer trigger and the
  // theme picker. `matchMedia`-driven: it fires on the crossing, not per pixel.
  const compact = useLayoutMode() === 'drawer';
  // The cached SessionView. Navigating to a session you have seen paints its
  // header immediately instead of after a round trip; the store keeps it fresh
  // from the socket (deltas + one batched GET per burst).
  const view = useSession(sessionId);
  // Only the socket state is read from the fleet snapshot now — the folder
  // neighbour list moved to the global sidebar, so this page no longer
  // re-renders when some other session's row changes.
  const { status: liveStatus } = useFleet();
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

  // DELIBERATELY NOT PINNED ON KEYBOARD-OPEN. It is tempting — the reader who
  // taps the composer is usually replying to the latest message — but "usually"
  // is not "always": scrolling up to quote older context and THEN tapping the
  // composer is the exact case, and a forced re-pin would throw away a detach
  // the reader made with their own thumb. Opening the keyboard changes chrome
  // only; it never issues a scroll intent. The transcript's own follow logic
  // already handles the geometry change when it is attached.
  const seenKeys = useRef<Set<string>>(new Set());
  /** True once the initial history page has settled — gates the reconnect
   *  catch-up so it can never race the first load. */
  const loadedRef = useRef(false);
  /** Monotonic id of the CURRENT load. Every async continuation checks it before
   *  touching state, so a response from a load that has been superseded — a
   *  StrictMode setup→cleanup→setup, a navigation to another session, a slow
   *  first request landing after a fast second one — is dropped instead of
   *  overwriting newer state. A boolean `cancelled` per effect run could only say
   *  "my run ended", never "someone else's run is now authoritative". */
  const loadId = useRef(0);
  /** Tools this page WATCHED run, monotonic for the life of the mounted session.
   *  Read only by the screen-reader turn summary further down. It counts from the
   *  live event stream and not from `records` on purpose: `records` also grows
   *  when the reader pages BACKWARDS, and a history page of old tool calls must
   *  never be announced as work that just happened. */
  const liveTools = useRef(0);

  /** STATE UPDATERS HERE MUST BE PURE — see the round-7 note on the initial
   *  load. `fresh` is computed and `seenKeys` is mutated OUTSIDE the updater;
   *  the updater itself only concatenates. */
  const takeFresh = useCallback((records: ChatRecord[]): ChatRecord[] => {
    const fresh = records.filter(r => !seenKeys.current.has(recordKey(r)));
    for (const r of fresh) seenKeys.current.add(recordKey(r));
    return fresh;
  }, []);

  /** Merge a freshly fetched tail page into the record list. Content dedupe
   *  (`seenKeys`) does the work: anything already on screen is dropped, so a
   *  re-fetch of the same page is a no-op and only genuinely missed records
   *  land — which, being a tail, belong at the end. */
  const mergeTail = useCallback(
    (page: { total: number; records: ChatRecord[] }) => {
      setTotal(page.total);
      const fresh = takeFresh(page.records);
      if (fresh.length === 0) return;
      setRecords(rs => [...rs, ...fresh]);
    },
    [takeFresh],
  );

  // ---- initial load: cached/fetched view + first history page --------------
  //
  // ROUND 7 — WHY THE TRANSCRIPT WAS EMPTY IN `vite dev`.
  //
  // Measured: production rendered 79 blocks for a session, `bun run dev`
  // rendered 0, and the chat request returned 200 in both. The cause was not the
  // fetch and not the socket — it was an IMPURE STATE UPDATER.
  //
  // The merge below used to run inside `setRecords(live => …)` and mutate
  // `seenKeys` from there. React StrictMode DOUBLE-INVOKES updater functions in
  // development, precisely to surface impurity. The first invocation filtered the
  // page against an empty `seenKeys`, added all 200 keys, and returned them; the
  // second invocation ran with those keys already present, filtered every record
  // out, and returned an EMPTY array — which is the one React kept. Same code in
  // production, where updaters run once, worked perfectly. Every dedupe-and-merge
  // path had the same shape (initial load, reconnect catch-up, older-page
  // prepend), so all three now compute `fresh` and mutate the ref OUTSIDE the
  // updater via `takeFresh`, leaving updaters that only concatenate.
  useEffect(() => {
    const generation = ++loadId.current;
    const superseded = () => loadId.current !== generation;
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
        if (superseded()) return;
        setTotal(page.total);
        // MERGE, don't replace. The subscription is live while this fetch is in
        // flight (and replays the store's buffer the moment it attaches), so
        // records can already be on screen — a plain `setRecords(page.records)`
        // threw away anything that streamed in during the round trip. History is
        // older than anything appended live, so the fresh half goes in front.
        const fresh = takeFresh(page.records);
        setRecords(live => (live.length === 0 ? fresh : [...fresh, ...live]));
        setNextBefore(page.offset);
        setAtStart(page.offset === 0);
        setPinSignal(n => n + 1);
        loadedRef.current = true;
      } catch (e) {
        if (!superseded()) setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!superseded()) setLoadingInitial(false);
      }
    })();

    // No cleanup flag: the generation IS the guard, and it keeps working after
    // this run's cleanup has gone (a late response from the previous session
    // must not clear the new one's state).
    return undefined;
  }, [sessionId, store, takeFresh]);

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
      // Counted once per deduped tool, for the spoken turn summary only. A ref
      // bump: it feeds no render, and it neither reorders nor filters anything
      // below it.
      if (rec.type === 'tool.use') liveTools.current += 1;
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
      // Pure updater; the dedupe and the ref mutation happen in `takeFresh`.
      const fresh = takeFresh(page.records);
      setRecords(rs => [...fresh, ...rs]);
      setNextBefore(page.offset);
      setAtStart(page.offset === 0);
    } catch {
      /* leave as-is */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [nextBefore, sessionId, takeFresh]);

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

  // The per-page folder sidebar is GONE (round 6). "Who else is working here"
  // is now answered by the persistent global agent sidebar, which is on screen
  // on every route and groups the whole fleet by folder — a drawer inside the
  // chat page that narrowed the transcript to say the same thing was a second
  // answer to a question that already had one.

  const busy = useMemo(() => (view ? isBusy(view) : false), [view]);
  // The composer's context strip. Fixed-height and always fully populated (an
  // unknown field renders as "—"), so it can never resize the transcript
  // viewport mid-stream — see the height note in Composer.tsx.
  const composerContext = useMemo(
    () => ({
      model: view?.config.model || view?.config.modelHint || undefined,
      turn: view?.state.turn,
      contextPercent: view?.state.contextPercent,
      status: view?.state.waiting ? 'parked' : view?.state.status,
      statusTone: view ? toneFor(view.state.status) : undefined,
      liveStatus,
    }),
    [view, liveStatus],
  );
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
    setPending(p => {
      const next = p.filter(x => !records.some(record => recordConfirmsPending(record, x)));
      return next.length === p.length ? p : next;
    });
  }, [records, pending.length]);

  // ---- what a screen reader is told -----------------------------------------
  //
  // The transcript itself must NOT be a live region. A streaming token feed on
  // `polite` is unusable — it re-reads, it never finishes, and it buries the one
  // fact the reader wanted. So this page carries two small visually-hidden
  // regions instead, and the transcript stays silent:
  //
  //   POLITE   a one-line summary of the session's COARSE state — started
  //            answering, finished, waiting on a question, socket dropped. It
  //            changes a handful of times per turn, never per token, and it is
  //            `aria-atomic` so the whole sentence is read rather than a diff.
  //   ALERT    reserved for the errors that interrupt what the reader was doing:
  //            a send that failed, a control action that failed, a conversation
  //            that would not load. Everything else stays polite.
  //
  // Both are named, because more than one session pane can be mounted at once
  // and "is responding" from an unidentified region is worse than silence.
  //
  // Every input below is already-derived coarse state. Nothing here reads
  // `records`, subscribes to anything, or touches the fetch, merge and scroll
  // paths above.
  const who = displayCallsign(view?.config.teammate) || view?.config.name || 'This session';

  // Socket trouble is only worth announcing to someone who HAD a connection.
  // Every page starts at `connecting`, and narrating the normal first handshake
  // as "reconnecting" would make the first thing a reader hears a false alarm.
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (liveStatus === 'open') setEverConnected(true);
  }, [liveStatus]);

  // Coarse turn boundaries. `busy` rising starts a turn and `busy` falling ends
  // one; the tool count is the tools seen between those two edges, so a turn
  // already in flight when the page opened reports completion without a count
  // rather than a wrong one.
  const [turnSummary, setTurnSummary] = useState<string | null>(null);
  const turnToolBase = useRef(0);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy === wasBusy.current) return;
    wasBusy.current = busy;
    if (busy) {
      turnToolBase.current = liveTools.current;
      setTurnSummary(null);
      return;
    }
    const tools = liveTools.current - turnToolBase.current;
    setTurnSummary(tools > 0 ? `Turn complete. ${tools} tool${tools === 1 ? '' : 's'} ran.` : 'Turn complete.');
  }, [busy]);

  // Counters and any leftover summary belong to the session that produced them.
  useEffect(() => {
    liveTools.current = 0;
    turnToolBase.current = 0;
    wasBusy.current = false;
    setTurnSummary(null);
  }, [sessionId]);

  const statusMessage = useMemo(() => {
    if (!view) return '';
    if (everConnected && liveStatus !== 'open') return `${who}: live connection lost, reconnecting.`;
    if (awaitingQ) return `${who} is waiting for an answer to a question.`;
    if (busy) return `${who} is responding.`;
    if (isTerminal) return `${who} has stopped. Status: ${view.state.status.replace(/_/g, ' ')}.`;
    return turnSummary ? `${who}: ${turnSummary}` : '';
  }, [view, everConnected, liveStatus, awaitingQ, busy, isTerminal, who, turnSummary]);

  // Debounced, which is the whole reason this is a separate piece of state: a
  // status that flickers (busy → idle → busy across one tool boundary) must
  // produce ONE announcement, not three. It also leaves the region mounted and
  // empty on the first paint, which is what makes assistive tech treat later
  // writes as updates rather than as initial content.
  const [announcement, setAnnouncement] = useState('');
  useDebouncedEffect(() => setAnnouncement(statusMessage), [statusMessage], 600);

  const sendFailed = pending.some(p => p.status === 'error');
  const alertMessage = useMemo(() => {
    if (error) return `${who}: this conversation could not be loaded. ${error}`;
    if (actionNotice?.kind === 'err') return `${who}: ${actionNotice.text}`;
    if (sendFailed) return `${who}: your message failed to send.`;
    return '';
  }, [error, actionNotice, sendFailed, who]);

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
  // The global fleet sidebar is a shell sibling; this page keeps only the
  // transcript scroller and fixed details overlay in its own layout.
  return (
    <div className="flex h-full min-h-0 flex-col pb-2">
      {/* Spoken status. Outside the tab switch, so a reader on the Terminal tab
          still hears that the session started answering or dropped its socket.
          `sr-only` and not `hidden`: display:none would take these straight back
          out of the accessibility tree. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {alertMessage}
      </div>
      {view && (
        <SessionHeader
          view={view}
          active={active}
          quota={quota}
          liveStatus={liveStatus}
          isTerminal={isTerminal}
          isKillFailed={isKillFailed}
          hasToken={HAS_TOKEN}
          onInterrupt={() => void interrupt()}
          onStop={() => void stop()}
          onResume={() => void resume()}
          compact={compact}
          showTheme={active !== false}
          onOpenSidebar={onOpenSidebar}
          // The Chat/Terminal switch rides in the header rather than owning a
          // row of its own — one two-item segmented control did not justify
          // ~34px of every screen. On a phone it also drops its words: two 44px
          // icon targets instead of ~96px of `CHAT`/`TERMINAL`, which is what
          // buys the single nowrap row.
          tabs={
            <ViewTabs<'chat' | 'terminal'>
              tabs={[
                { id: 'chat', label: 'Chat', icon: <MessageSquare size={compact ? 15 : 11} /> },
                { id: 'terminal', label: 'Terminal', icon: <Terminal size={compact ? 15 : 11} /> },
              ]}
              current={tab}
              onChange={setTab}
              iconOnly={compact}
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
          {/* ONE pane scroller: the transcript. The details drawer is a fixed
              overlay with its own internal scroller, so this stays true. */}
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
                context={composerContext}
                compact={compact}
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

// Optimistic "sent" bubble — mirrors the human styling with a pending →
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
    <div className="kt-bubble-row">
      <span className="sr-only">You said:</span>
      <div className="kt-bubble">
        <div className="flex min-w-0 items-center gap-2 px-panel pt-1">
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
                className="shrink-0 rounded-sm px-1 py-px text-[10.5px] text-muted hover:text-fg"
                title="Remove this box"
              >
                dismiss
              </button>
            </>
          )}
        </div>
        <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-1.5 pt-0.5 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
          {text}
        </div>
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
