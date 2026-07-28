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
import { ImageOff, Loader2, MessageSquare, RotateCcw, Terminal, X } from 'lucide-react';
import { api, ApiError, HAS_TOKEN } from '../lib/api';
import { useFleet, useSession, useSessionEvents, useStore, useUiControls } from '../lib/store';
import type { ChatRecord, KTeamEvent, SendRecord, SessionView } from '../types';
import { Composer } from '../components/Composer';
import { ComposerRuntime } from '../components/ComposerRuntime';
import {
  QuestionForm,
  isQuestionSuppressed,
  questionDismissalKey,
  shouldClearQuestionSuppression,
} from '../components/QuestionForm';
import { TerminalView } from '../components/TerminalView';
import { ViewTabs } from '../components/ViewTabs';
import { SessionHeader } from '../components/SessionHeader';
import { Transcript } from '../components/Transcript';
import { LedgerMessage } from '../components/LedgerMessage';
import { SidePaneWorkspace } from '../components/SidePane';
import { appendSkillInvocation } from '../components/SkillsSurface';
import { ThinkingIndicator } from '../components/Harness';
import { displayCallsign } from '../lib/callsign';
import {
  buildTranscript,
  buildSendIndex,
  isTranscriptJournalEvent,
  latestPendingQuestion,
  placeLedgerBlocks,
  peerFrom,
  type TranscriptBlock,
} from '../lib/transcript';
import {
  foldSendRecords,
  isSendLedgerEvent,
  nextLedgerViewDeadline,
  parseSendsResponse,
  partitionLedgerChips,
  reconcileLocalSends,
  selectLedgerChips,
  visibleUserRows,
} from '../lib/sends';
import {
  applyTranscriptBoundaries,
  deriveJournalClearBoundaries,
  deriveLedgerClearBoundaries,
  deriveTranscriptClearBoundaries,
  mergeTranscriptBoundaries,
  rememberTranscriptBoundaries,
  revealTranscriptHistory,
  useTranscriptBoundarySession,
} from '../lib/transcript-boundaries';
import {
  attachmentErrorCopy,
  attachmentErrorMessage,
  attachmentFromView,
  formatAttachmentSize,
  sameAttachmentIds,
  validateAttachmentFile,
  type AttachmentView,
  type StoredTranscriptImage,
} from '../lib/attachments';
import { AttachmentImageProvider, TranscriptImageGallery } from '../components/AttachmentImage';
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
  attachmentIds: string[];
  attachments: StoredTranscriptImage[];
  localAttachmentIds: string[];
}

type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed';
interface PendingAttachment {
  localId: string;
  file: File;
  objectUrl?: string;
  status: PendingAttachmentStatus;
  view?: AttachmentView;
  error?: string;
}

/** A pending local send is confirmed by a same-text, in-window chat.user record
 * unless peer metadata proves another author sent it. Content classification
 * controls presentation, so it must not strand a locally typed system-like
 * phrase in the optimistic bubble forever. */
export function recordConfirmsPending(record: ChatRecord, pending: { text: string; at: number }): boolean {
  if (record.type !== 'chat.user') return false;
  const raw = String((record.data as { text?: unknown } | undefined)?.text ?? '');
  const { from, body } = peerFrom(raw);
  if (from) return false;
  const at = Date.parse(record.timestamp ?? '') || 0;
  return body.trim() === pending.text && at >= pending.at - RECORD_CLOCK_SLACK_MS;
}

export function blockConfirmsPending(
  block: TranscriptBlock,
  pending: { text: string; at: number; attachmentIds?: readonly string[] },
): boolean {
  if (block.kind !== 'user' || block.from) return false;
  const at = Date.parse(block.ts ?? '') || 0;
  if (at < pending.at - RECORD_CLOCK_SLACK_MS) return false;
  const pendingIds = pending.attachmentIds ?? [];
  const blockIds = (block.attachments ?? []).map(image => image.attachmentId);
  if (!sameAttachmentIds(blockIds, pendingIds)) return false;
  const text = pending.text.trim();
  return (text.length > 0 || pendingIds.length > 0) && block.text.trim() === text;
}

/** A resend is a new delivery attempt and therefore may never inherit the old
 * ledger identity. The second mint handles an injected/test mint collision; a
 * repeated collision refuses rather than quietly mutating the audit trail. */
export function requestIdForLedgerResend(oldSendId: string, mint: () => string = () => crypto.randomUUID()): string {
  const first = mint();
  if (first !== oldSendId) return first;
  const second = mint();
  if (second !== oldSendId) return second;
  throw new Error('could not mint a new send identity');
}

/** Is the session — as far as this client AUTHORITATIVELY knows — waiting on an
 *  OPEN structured question? True when the daemon's view state says so, either
 *  via the `awaiting_question` status OR a `pendingQuestion` object it left in
 *  the state. Both come from `getSession`/`listSessions`, which carry the whole
 *  state atomically, so this heals the moment a reconnect/visibility refresh
 *  lands (see the store's forced reconcile) even if the live `interaction.question`
 *  push flipped neither field (it carries no status — dale's diagnosis, Rank 4).
 *
 *  DELIBERATELY NOT derived from the transcript records: `latestPendingQuestion`
 *  returns the last question whether or not it was answered, so gating on it
 *  would resurrect a form — and block free-text sends — for a session that has
 *  already answered and moved on. A terminal session is never awaiting anything,
 *  so a stale question is never shown for one. */
export function hasOpenQuestion(view: SessionView | undefined): boolean {
  if (!view) return false;
  if (TERMINAL_STATUSES.has(view.state.status)) return false;
  return view.state.status === 'awaiting_question' || !!view.state.pendingQuestion;
}

/** The status can lead the question payload during reconnect/reconciliation.
 *  Mount a malformed-but-escapable record in that gap instead of hiding both
 *  the form and Composer. Its turn-bound key is stable across store refreshes. */
export function questionSurfaceRecord(
  view: SessionView | undefined,
  pendingQuestion: ChatRecord | null | undefined,
): ChatRecord | undefined {
  if (pendingQuestion) return pendingQuestion;
  if (!view || !hasOpenQuestion(view)) return undefined;
  return {
    source: view.config?.harness ?? 'claude',
    timestamp: `status-only:${view.state.id}:${view.state.turn}`,
    type: 'interaction.question',
    data: { question: 'Question details have not loaded yet.' },
  };
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
  // CHAT WIDTH (item 5). The mechanism lives here; the settings control and the
  // persisted store field are nina's (`SettingsPage.tsx` / `lib/store.tsx`). We
  // read the value DEFENSIVELY off `UiControls` so that the day nina lands
  // `chatWidth` on the additive `kteam-ui-controls-v1` payload it flows straight
  // through with no further edit here. Until then the field is absent and we
  // default to 'full' — full-bleed, exactly today's behaviour — so the mechanism
  // is correct and invisible. 'readable' caps the whole chat column (transcript
  // AND composer, so they stay aligned) at a reading measure; see `.kt-chat-surface`
  // in index.css. It is a no-op below that measure, which is why this is "mostly
  // for desktop": a phone viewport is already narrower than the cap.
  const [uiControls] = useUiControls();
  const chatWidth: 'full' | 'readable' =
    (uiControls as { chatWidth?: 'full' | 'readable' }).chatWidth === 'readable' ? 'readable' : 'full';
  // The cached SessionView. Navigating to a session you have seen paints its
  // header immediately instead of after a round trip; the store keeps it fresh
  // from the socket (deltas + one batched GET per burst).
  const view = useSession(sessionId);
  // Only the socket state is read from the fleet snapshot now — the folder
  // neighbour list moved to the global sidebar, so this page no longer
  // re-renders when some other session's row changes.
  const { status: liveStatus } = useFleet();
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [journalEvents, setJournalEvents] = useState<KTeamEvent[]>([]);
  // THE DURABLE SEND LEDGER. Existence and fate of every message sent to this
  // session, fetched from `GET /sends` and refreshed on live `control.send_*`
  // events — NOT derived from the bounded journal tail below, which is exactly why
  // a send older than that tail no longer loses its badge on refresh.
  const [ledger, setLedger] = useState<SendRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [actionNotice, setActionNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Escape suppresses ONE exact ask locally before its background interrupt can
  // succeed or fail. Store refreshes are authoritative, but must not remount the
  // same trap; a new toolUseId is never covered by this key.
  const [dismissedQuestionKey, setDismissedQuestionKey] = useState<string | null>(null);
  // FILES MOVED TO THE SIDE PANE. It was a third center tab here; it is now a
  // session-scoped surface in the unified side pane (SidePane.tsx), opened from
  // the header beside Pins, so reading the working tree no longer replaces the
  // conversation. The capability probe moved with the trigger (SessionHeader);
  // the probe cache in files-api.ts means neither mount costs a second request.
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
  const seenJournalKeys = useRef<Set<string>>(new Set());
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

  const takeFreshJournal = useCallback((events: KTeamEvent[]): KTeamEvent[] => {
    const fresh = events.filter(event => !seenJournalKeys.current.has(journalEventKey(event)));
    for (const event of fresh) seenJournalKeys.current.add(journalEventKey(event));
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
    setJournalEvents([]);
    setLedger([]);
    setError(null);
    setNextBefore(null);
    setLoadingInitial(true);
    setAtStart(false);
    setPinSignal(0);
    seenKeys.current.clear();
    seenJournalKeys.current.clear();
    loadedRef.current = false;

    (async () => {
      try {
        // The view goes through the store (one inflight request per session,
        // shared with the socket-driven refresh) so a deep link and the fleet
        // hydration cannot both GET the same session.
        const [, page, eventTail, sendLedger] = await Promise.all([
          store.fetchSession(sessionId),
          api.chatHistory(sessionId, undefined, PAGE_SIZE),
          // UI-only bounded fallback: full journals reach 19–47 MB and the
          // current daemon has no server-side type filter. The newest 2,000
          // durable events cover active/recent sends; older misses deliberately
          // degrade to today's slim turn-prompt row instead of downloading the
          // whole journal on every open. Named follow-up: add an indexed
          // server-side `types=` filter before widening or removing this tail.
          //
          // This tail is now used ONLY for transcript message placement. Badge and
          // existence state come from the ledger below, so an eviction here costs a
          // rewritten row at worst and can no longer lose a send.
          api.replay(sessionId, -2_000, 2_000).catch(() => []),
          // Bounded and complete: whatever is still open plus recent settled rows.
          // A daemon too old to serve the route 404s, which degrades to an empty
          // ledger — i.e. exactly the pre-ledger behaviour, never a crash.
          api.sends(sessionId).catch(() => []),
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
        const freshEvents = takeFreshJournal(eventTail.filter(isTranscriptJournalEvent));
        setJournalEvents(live => (live.length === 0 ? freshEvents : [...freshEvents, ...live]));
        // Folded, so a live `send_*` refresh that raced this initial fetch is not
        // thrown away: last snapshot per sendId wins, and the fresher fetch is
        // folded LAST. That ordering is what makes the UNACCOUNTED → DELIVERED
        // promotion monotonic instead of dependent on which response landed first.
        setLedger(live => foldSendRecords(live, parseSendsResponse(sendLedger)));
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
  }, [sessionId, store, takeFresh, takeFreshJournal]);

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
  // LEDGER REFRESH ON LIVE TRANSITIONS.
  //
  // The event is a TRIGGER, not the data: badge state is always something the
  // daemon confirmed on disk, so a `send_accepted`/`send_delivered`/
  // `send_unaccounted`/`send_withdrawn` push causes a re-read of `GET /sends`
  // rather than being folded in directly. That is what keeps one source of truth
  // and makes a missed push self-healing (the next transition re-reads everything).
  //
  // Coalesced on a short timer because a batch drain settles several sends at
  // once — three `send_delivered` pushes in one tick must cost one request, not
  // three. The generation check drops a response that belongs to a session the
  // reader has already navigated away from, matching the initial load's guard.
  const ledgerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshLedger = useCallback(() => {
    if (ledgerTimer.current) return;
    const generation = loadId.current;
    ledgerTimer.current = setTimeout(() => {
      ledgerTimer.current = null;
      void api
        .sends(sessionId)
        .then(payload => {
          if (loadId.current !== generation) return;
          setLedger(live => foldSendRecords(live, parseSendsResponse(payload)));
        })
        .catch(() => undefined);
    }, 250);
  }, [sessionId]);

  useEffect(
    () => () => {
      if (ledgerTimer.current) clearTimeout(ledgerTimer.current);
      ledgerTimer.current = null;
    },
    [sessionId],
  );

  useSessionEvents(sessionId, (ev: KTeamEvent) => {
    if (isSendLedgerEvent(ev)) refreshLedger();
    if (isTranscriptJournalEvent(ev)) {
      const key = journalEventKey(ev);
      if (!seenJournalKeys.current.has(key)) {
        seenJournalKeys.current.add(key);
        setJournalEvents(events => [...events, ev]);
      }
    }
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
    // Fix 1 (dale, Rank 1): the socket's reconnect backfill is a 200-event
    // GLOBAL fleet tail, so a `interaction.question` raised for THIS session
    // while we were disconnected is never re-pushed and the question is lost.
    // The store's reconnect `reconcile(true)` heals the whole fleet, but that is
    // 45s-throttled and can be pre-empted; a targeted `getSession` for the open
    // session guarantees THIS view's `status`/`pendingQuestion` are authoritative
    // the instant the socket reopens. One request, not a poll.
    void store.fetchSession(sessionId).catch(() => undefined);
  }, [liveStatus, mergeTail, sessionId, store]);

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
  // The ledger is passed in so a send older than the bounded journal tail keeps
  // its logical message text on screen. It is a REPLACEMENT source only — it never
  // adds a row the harness did not write.
  const sendIndex = useMemo(() => buildSendIndex(journalEvents, sessionId, ledger), [journalEvents, sessionId, ledger]);
  // NO CURRENT TURN. `buildTranscript` used to take it and synthesize a delivered
  // user block for any inline queued send whose turn had advanced. The corpus
  // showed drains happen mid-turn and in batches, so turn advancement proves
  // nothing about a specific message; an unproven send is now a ledger row that
  // can honestly say "unconfirmed" instead of a transcript row that lies.
  const blocks = useMemo(() => buildTranscript(records, sendIndex, sessionId), [records, sendIndex, sessionId]);
  // `/clear` is a VIEW boundary, never a mutation of the audit transcript.
  // Journal + ledger evidence covers Composer/runtime sends; a real harness
  // marker wins placement by exact block id when one reaches the stream.
  const observedClearBoundaries = useMemo(
    () =>
      mergeTranscriptBoundaries(
        deriveJournalClearBoundaries(journalEvents, sessionId),
        deriveLedgerClearBoundaries(ledger),
        deriveTranscriptClearBoundaries(blocks),
      ),
    [blocks, journalEvents, ledger, sessionId],
  );
  const storedClearBoundaries = useTranscriptBoundarySession(sessionId);
  useEffect(() => {
    rememberTranscriptBoundaries(sessionId, observedClearBoundaries);
  }, [observedClearBoundaries, sessionId]);
  // HOTFIX 2026-07-28: boundary detection was hiding agent rows, leaving a
  // transcript of only the human's own messages. Observation and storage above
  // are left intact so no evidence is lost, but NOTHING is filtered out of the
  // view until the false-positive source is identified. Passing an empty
  // boundary list keeps the real return shape rather than faking it.
  const transcriptView = useMemo(
    () => applyTranscriptBoundaries(blocks, [], storedClearBoundaries.revealedBoundaryId),
    [blocks, storedClearBoundaries.revealedBoundaryId],
  );
  // Only this array is filtered. Ledger-chip retirement, pins, questions, and
  // every other state consumer below continue to read the complete `blocks`.
  const visibleBlocks = transcriptView.blocks;
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
  const questionSurface = useMemo(() => questionSurfaceRecord(view, pendingQ), [pendingQ, view]);
  const pendingQuestionKey = questionSurface ? questionDismissalKey(questionSurface) : undefined;
  const questionSuppressed = isQuestionSuppressed(pendingQuestionKey, dismissedQuestionKey);

  // A page reload deliberately forgets this component-local state: if the
  // daemon never accepted the decline, its real pending question comes back and
  // can be dismissed again. Within one page lifetime, only a DIFFERENT ask
  // clears suppression; refreshes of the same server state cannot snap it back.
  useEffect(() => {
    if (shouldClearQuestionSuppression(pendingQuestionKey, dismissedQuestionKey)) {
      setDismissedQuestionKey(null);
    }
  }, [dismissedQuestionKey, pendingQuestionKey]);

  useEffect(() => setDismissedQuestionKey(null), [sessionId]);

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
  // Fix 2 (dale, Rank 4): the live `interaction.question` push carries neither
  // `status` nor `health`, so `transitionPatch` leaves `status` on its old value
  // until the debounced `getSession` lands — during which `awaitingQ` is false
  // and the form stays hidden even though a real question is open. Gate the form
  // on `hasOpenQuestion`, which ALSO fires on a non-null `pendingQuestion`, so
  // the form surfaces the instant EITHER field is authoritative. It is keyed
  // strictly on `view.state` (never the records fallback) and returns false for
  // any terminal session, so a stale/answered question is never resurrected.
  const showQuestion = HAS_TOKEN && hasOpenQuestion(view) && !questionSuppressed;

  // ---- eager attachment uploads -------------------------------------------
  const attachmentObjectUrls = useRef<Set<string>>(new Set());
  const previousAttachmentSession = useRef(sessionId);
  const revokeObjectUrl = useCallback((url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    attachmentObjectUrls.current.delete(url);
  }, []);

  useEffect(
    () => () => {
      for (const url of attachmentObjectUrls.current) URL.revokeObjectURL(url);
      attachmentObjectUrls.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (previousAttachmentSession.current === sessionId) return;
    previousAttachmentSession.current = sessionId;
    for (const entry of pendingAttachments) revokeObjectUrl(entry.objectUrl);
    setPendingAttachments([]);
  }, [pendingAttachments, revokeObjectUrl, sessionId]);

  const uploadAttachment = useCallback(
    async (localId: string, file: File) => {
      const validation = validateAttachmentFile(file);
      if (validation) {
        setPendingAttachments(entries =>
          entries.map(entry =>
            entry.localId === localId ? { ...entry, status: 'failed', error: attachmentErrorCopy(validation) } : entry,
          ),
        );
        return;
      }
      setPendingAttachments(entries =>
        entries.map(entry =>
          entry.localId === localId ? { ...entry, status: 'uploading', error: undefined, view: undefined } : entry,
        ),
      );
      try {
        const uploaded = await api.upload(sessionId, file);
        setPendingAttachments(entries =>
          entries.map(entry =>
            entry.localId === localId ? { ...entry, status: 'ready', view: uploaded, error: undefined } : entry,
          ),
        );
      } catch (uploadError) {
        setPendingAttachments(entries =>
          entries.map(entry =>
            entry.localId === localId
              ? { ...entry, status: 'failed', view: undefined, error: attachmentErrorMessage(uploadError) }
              : entry,
          ),
        );
      }
    },
    [sessionId],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (!HAS_TOKEN || files.length === 0) return;
      const entries = files.map(file => {
        const localId = `attachment-${crypto.randomUUID()}`;
        const validation = validateAttachmentFile(file);
        let objectUrl: string | undefined;
        if (file.type.startsWith('image/')) {
          objectUrl = URL.createObjectURL(file);
          attachmentObjectUrls.current.add(objectUrl);
        }
        return {
          localId,
          file,
          ...(objectUrl ? { objectUrl } : {}),
          status: validation ? ('failed' as const) : ('uploading' as const),
          ...(validation ? { error: attachmentErrorCopy(validation) } : {}),
        };
      });
      setPendingAttachments(current => [...current, ...entries]);
      for (const entry of entries) if (entry.status === 'uploading') void uploadAttachment(entry.localId, entry.file);
    },
    [uploadAttachment],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      revokeObjectUrl(pendingAttachments.find(entry => entry.localId === localId)?.objectUrl);
      setPendingAttachments(current => current.filter(entry => entry.localId !== localId));
    },
    [pendingAttachments, revokeObjectUrl],
  );

  const clearAttachments = useCallback(
    (localIds: readonly string[]) => {
      const ids = new Set(localIds);
      for (const entry of pendingAttachments) if (ids.has(entry.localId)) revokeObjectUrl(entry.objectUrl);
      setPendingAttachments(current => current.filter(entry => !ids.has(entry.localId)));
    },
    [pendingAttachments, revokeObjectUrl],
  );

  const readyAttachments = useMemo(
    () =>
      pendingAttachments.filter(
        (entry): entry is PendingAttachment & { view: AttachmentView } => entry.status === 'ready' && !!entry.view,
      ),
    [pendingAttachments],
  );
  const hasUploadingAttachments = pendingAttachments.some(entry => entry.status === 'uploading');

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

  // THE GENERIC CONTENT-BASED REAPER IS GONE. DO NOT REINTRODUCE IT.
  //
  // It used to DELETE pending rows from state whenever any `chat.user` block matched
  // on text + time + attachments (`blockConfirmsPending`). Two things made that
  // unsafe, and the second is why removing it is not optional:
  //
  //   1. Text is not identity. A later message that merely QUOTES an earlier send —
  //      or a second send of the same words — satisfies the match, so an ACCEPTED or
  //      UNACCOUNTED send could be retired by a row that is not it. That is the same
  //      class of bug as the daemon's old substring matcher, which produced a
  //      confirmed false delivery in the corpus.
  //   2. It was DESTRUCTIVE. Because it removed the row from `pending` state, no
  //      later correction could bring it back: `reconciled.unclaimedLocal` can only
  //      re-render a row that still exists. So a wrongly reaped send was gone for
  //      good, including its retry affordance.
  //
  // Local retirement is now owned entirely by the exact `requestId → sendId` ledger
  // handover in `reconcileLocalSends`, which is IDENTITY-based and, crucially,
  // NON-DESTRUCTIVE: a claimed row is merely hidden from the footer while its
  // durable row renders in its place. If that durable row later retracts — a
  // synchronous injection failure appends a tombstone and the fold drops it — the
  // local row becomes unclaimed again and its "failed to send" chip and retry button
  // reappear on their own. Deleting from state would have forfeited that.
  //
  // `pending` therefore accumulates claimed-but-hidden rows for the life of the
  // mounted session. That is deliberate: they are small, bounded by how many messages
  // one reader sends, and keeping them is what makes retraction recoverable.

  // LOCAL ↔ DURABLE HANDOVER.
  //
  // An optimistic row is this browser's promise that it sent something; a durable
  // row is the daemon's record that it did. Once the durable row exists it is
  // strictly better information — it survives refresh, it carries a fate, and it is
  // the same row every other client sees — so the local chip stands down and the
  // ledger chip takes over.
  //
  // The join is exact where it can be (the daemon reuses this browser's request id
  // as the send id) and conservative where it cannot: equal text, identical
  // attachments, a forward-only time window, one-to-one. `PendingSend` structurally
  // satisfies `LocalSend`, so `unclaimedLocal` comes back as the full rows the
  // footer needs.
  const reconciled = useMemo(() => reconcileLocalSends(pending, ledger), [pending, ledger]);
  // Which durable rows still need a chip. Delivered rows are retired ONLY when
  // their proof-backed row is actually on screen — chat history is paginated, so
  // retiring on fate alone would render a delivered send whose row has scrolled out
  // of the loaded page as nothing at all.
  const [ledgerNow, setLedgerNow] = useState(() => Date.now());
  useEffect(() => setLedgerNow(Date.now()), [sessionId]);
  useEffect(() => {
    const next = nextLedgerViewDeadline(ledger, ledgerNow);
    if (next === undefined) return undefined;
    // Browsers clamp larger timeouts inconsistently. A capped wake simply
    // recomputes and schedules the remainder; it is still one timer, never a poll.
    const delay = Math.max(0, Math.min(2_147_000_000, next - Date.now() + 25));
    const timer = setTimeout(() => setLedgerNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [ledger, ledgerNow]);

  const ledgerChips = useMemo(
    () => selectLedgerChips(ledger, visibleUserRows(blocks), ledgerNow),
    [ledger, blocks, ledgerNow],
  );
  const ledgerPartition = useMemo(() => partitionLedgerChips(ledgerChips, ledgerNow), [ledgerChips, ledgerNow]);
  // Only current accepts stay at the tail. Oldest-first preserves send order
  // among several in-flight rows.
  const ledgerRows = useMemo(() => [...ledgerPartition.inFlight].reverse(), [ledgerPartition.inFlight]);
  const displayedBlocks = useMemo(
    () => placeLedgerBlocks(visibleBlocks, ledgerPartition.chronological, ledgerNow),
    [visibleBlocks, ledgerPartition.chronological, ledgerNow],
  );

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

  // Only a send with NO durable row is a failure worth interrupting a screen
  // reader for. A local row that errored because its RESPONSE was lost, while the
  // daemon durably accepted it, is claimed by its ledger row and is not a failure.
  const sendFailed = reconciled.unclaimedLocal.some(p => p.status === 'error');
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
  const identityFor = useCallback((text: string, attachmentIds: string[]): { requestId: string; key?: string } => {
    const failed = pendingRef.current.find(
      p => p.text === text && p.status === 'error' && sameAttachmentIds(p.attachmentIds, attachmentIds),
    );
    return failed ? { requestId: failed.requestId, key: failed.key } : { requestId: crypto.randomUUID() };
  }, []);

  // ---- actions -------------------------------------------------------------
  const deliver = useCallback(
    async (
      msg: string,
      opts: {
        interruptFirst: boolean;
        requestId: string;
        key?: string;
        attachmentIds: string[];
        attachments: StoredTranscriptImage[];
        localAttachmentIds: string[];
      },
    ) => {
      if (sendingRef.current) return false;
      if ((!msg && opts.attachmentIds.length === 0) || !HAS_TOKEN) return false;
      // Fix 3 (dale, Rank 2): a plain free-text send that lands on an open
      // question is rejected by the daemon, but silently — the reader typed
      // because they could not see the form, and their message vanishes with no
      // trace of why. Refuse it on the client with a visible notice that names
      // the form and the interrupt-and-send escape hatch, and heal the view so
      // the form surfaces. `interruptFirst` is the deliberate supersede path and
      // is allowed through — that one replaces the question loudly.
      if (!opts.interruptFirst && hasOpenQuestion(view) && !questionSuppressed) {
        setActionNotice({
          kind: 'err',
          text: 'This session is waiting for an answer to a structured question. Answer it in the form below, or use interrupt-and-send to replace it.',
        });
        void store.fetchSession(sessionId).catch(() => undefined);
        return false;
      }
      sendingRef.current = true;
      setSending(true);
      setActionNotice(null);
      const key = opts.key ?? `send-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      // A retry re-uses its own row rather than stacking a second box for the
      // same message.
      setPending(p =>
        p.some(x => x.key === key)
          ? p.map(x => (x.key === key ? { ...x, status: 'sending' as PendingStatus } : x))
          : [
              ...p,
              {
                key,
                text: msg,
                status: 'sending' as PendingStatus,
                requestId: opts.requestId,
                at: Date.now(),
                attachmentIds: opts.attachmentIds,
                attachments: opts.attachments,
                localAttachmentIds: opts.localAttachmentIds,
              },
            ],
      );
      // The reader just spoke: put them at the bottom and resume following, so the
      // reply streams in under their eyes instead of somewhere off-screen.
      pinToBottom();
      try {
        if (opts.interruptFirst) await api.interrupt(sessionId);
        const next = await api.send(sessionId, msg, false, opts.requestId, opts.attachmentIds);
        // Straight into the shared cache: this page, the dashboard behind it and
        // the folder sidebar all read the same record.
        store.upsertSession(next);
        const queued =
          next.disposition === 'queued' ||
          next.disposition === 'queued-for-revive' ||
          (!opts.interruptFirst && !next.disposition && (busy || isBusy(next)));
        setPending(p => p.map(x => (x.key === key ? { ...x, status: queued ? 'queued' : 'delivered' } : x)));
        clearAttachments(opts.localAttachmentIds);
        return true;
      } catch (e) {
        setPending(p => p.map(x => (x.key === key ? { ...x, status: 'error' } : x)));
        setActionNotice({ kind: 'err', text: e instanceof ApiError ? e.message : String(e) });
        // A send can fail precisely because the daemon flipped to
        // `awaiting_question` between paint and submit (the race Fix 3 guards on
        // the client). Re-fetch the authoritative view so, if that is what
        // happened, the question form replaces the composer instead of leaving
        // the reader staring at a bare "message failed".
        void store.fetchSession(sessionId).catch(() => undefined);
        return false;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [busy, clearAttachments, pinToBottom, questionSuppressed, sessionId, store, view],
  );

  function send() {
    const msg = draft.trim();
    if ((!msg && readyAttachments.length === 0) || hasUploadingAttachments || sendingRef.current) return;
    const attachmentIds = readyAttachments.map(entry => entry.view.id);
    const attachments = readyAttachments.map(entry => attachmentFromView(sessionId, entry.view));
    const localAttachmentIds = readyAttachments.map(entry => entry.localId);
    setDraft('');
    void deliver(msg, {
      interruptFirst: false,
      ...identityFor(msg, attachmentIds),
      attachmentIds,
      attachments,
      localAttachmentIds,
    });
  }

  function interruptAndSend() {
    const msg = draft.trim();
    if ((!msg && readyAttachments.length === 0) || hasUploadingAttachments || sendingRef.current) return;
    const attachmentIds = readyAttachments.map(entry => entry.view.id);
    const attachments = readyAttachments.map(entry => attachmentFromView(sessionId, entry.view));
    const localAttachmentIds = readyAttachments.map(entry => entry.localId);
    setDraft('');
    void deliver(msg, {
      interruptFirst: true,
      ...identityFor(msg, attachmentIds),
      attachmentIds,
      attachments,
      localAttachmentIds,
    });
  }

  /** Retry a failed optimistic send with its ORIGINAL request id, so a first
   *  attempt that actually landed (and only lost its response) is recognised by
   *  the daemon and not applied a second time. */
  const retryPending = useCallback(
    (entry: PendingSend) => {
      void deliver(entry.text, {
        interruptFirst: false,
        requestId: entry.requestId,
        key: entry.key,
        attachmentIds: entry.attachmentIds,
        attachments: entry.attachments,
        localAttachmentIds: entry.localAttachmentIds,
      });
    },
    [deliver],
  );

  /** A durable unconfirmed row is a DIFFERENT case from retrying a failed HTTP
   * call. Its old sendId remains an immutable audit record and may still land,
   * so LedgerMessage first exposes that duplicate risk; only the explicit
   * second activation reaches here. The replacement then mints a fresh identity
   * unconditionally — `identityFor` must never collapse it onto the old send. */
  const resendLedger = useCallback(
    async (record: SendRecord): Promise<boolean> => {
      const attachments: StoredTranscriptImage[] = record.attachmentIds.map(attachmentId => ({
        kind: 'attachment',
        sessionId,
        attachmentId,
        filename: attachmentId,
      }));
      const accepted = await deliver(record.message, {
        interruptFirst: false,
        requestId: requestIdForLedgerResend(record.sendId),
        attachmentIds: [...record.attachmentIds],
        attachments,
        localAttachmentIds: [],
      });
      if (accepted) {
        setActionNotice({
          kind: 'ok',
          text: 'A separate resend was accepted with a new ID and is awaiting its own confirmation. The original remains unconfirmed.',
        });
      }
      return accepted;
    },
    [deliver, sessionId],
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
  const attachmentSlot = pendingAttachments.length ? (
    <PendingAttachmentStrip
      entries={pendingAttachments}
      onRetry={entry => void uploadAttachment(entry.localId, entry.file)}
      onRemove={entry => removeAttachment(entry.localId)}
    />
  ) : undefined;

  const transcriptHeader = (
    <>
      {loadingOlder && <div className="py-1 text-center text-[11.5px] text-muted">loading older messages…</div>}
      {transcriptView.hidden > 0 && transcriptView.activeBoundary && (
        <div className="py-1 text-center text-[11.5px] text-muted">
          <button
            type="button"
            aria-expanded={false}
            className="rounded-control px-2 py-px hover:bg-surface-2 hover:text-fg"
            onClick={() => {
              revealTranscriptHistory(sessionId, transcriptView.activeBoundary!.id);
              setAnnouncement(
                `Showing ${transcriptView.hidden} earlier transcript ${transcriptView.hidden === 1 ? 'row' : 'rows'} from before context was cleared.`,
              );
            }}
          >
            {transcriptView.hidden} earlier transcript {transcriptView.hidden === 1 ? 'row' : 'rows'} hidden · context
            cleared {fmtAbsolute(transcriptView.activeBoundary.at)} · show
          </button>
        </div>
      )}
      {transcriptView.hidden === 0 && atStart && records.length > 0 && (
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
    ledgerRows.length || reconciled.unclaimedLocal.length || busy ? (
      <div className="space-y-1 px-1 py-1">
        {/* Only genuinely current durable accepts remain here. Unconfirmed and
            exceptional delivered rows are interleaved into displayedBlocks by
            acceptedAt, so old uncertainty can never bury the conversation. */}
        {ledgerRows.map(record => (
          <LedgerMessage
            key={record.sendId}
            record={record}
            sessionId={sessionId}
            asOf={ledgerNow}
            onResend={HAS_TOKEN ? resendLedger : undefined}
          />
        ))}
        {reconciled.unclaimedLocal.map(p => (
          <PendingMessage
            key={p.key}
            text={p.text}
            attachments={p.attachments}
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
  const chatPage = (
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
                // Files is no longer a third entry here — it opens in the side
                // pane (see SessionHeader's surface triggers), so the chat stays
                // on screen while the tree is read.
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
        <AttachmentImageProvider>
          {/* CHAT WIDTH SURFACE (item 5): `data-chat-width` drives the max-width.
              'full' (default) is full-bleed — no cap, today's behaviour. 'readable'
              caps the whole column so transcript and composer narrow together and
              stay centered. Below the cap this is inert (phones are unaffected). */}
          <div className="kt-chat-surface flex min-h-0 min-w-0 w-full flex-1 flex-col" data-chat-width={chatWidth}>
            {/* ONE pane scroller: the transcript. The details drawer is a fixed
              overlay with its own internal scroller, so this stays true.
              Below `sm` the card melts away — no border, no rounding, no
              surface fill distinct from the pane — so the conversation reads
              edge-to-edge on a phone where that frame is pure cost. The card
              (border + rounded-lg + bg-surface) is restored at `sm` and up. */}
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden sm:rounded-lg sm:border sm:border-border sm:bg-surface">
              {loadingInitial ? (
                <ThreadSkeleton />
              ) : (
                <Transcript
                  blocks={displayedBlocks}
                  live={busy}
                  hasOlder={transcriptView.hidden > 0 ? false : nextBefore != null}
                  loadingOlder={loadingOlder}
                  onLoadOlder={() => void loadOlder()}
                  pinSignal={pinSignal}
                  sessionId={sessionId}
                  onResendLedger={HAS_TOKEN ? resendLedger : undefined}
                  header={transcriptHeader}
                  footer={transcriptFooter}
                />
              )}
            </div>

            {!showQuestion && HAS_TOKEN && (
              <div className="mt-2">
                <Composer
                  sessionId={sessionId}
                  draft={draft}
                  onDraftChange={setDraft}
                  onSubmit={() => void send()}
                  onInterruptAndSend={() => void interruptAndSend()}
                  disabled={!view || loadingInitial}
                  busy={busy}
                  sending={sending}
                  context={composerContext}
                  compact={compact}
                  onFiles={addFiles}
                  attachmentSlot={attachmentSlot}
                  // Model + reasoning switch, ON the phone status line (item 2).
                  // Page-owned because it needs the live view and the Terminal
                  // tab; the composer just gives it a home. Desktop keeps its
                  // ContextStrip readout and switches from the details Runtime
                  // tab, so this is compact-only.
                  runtimeControl={
                    compact && view ? (
                      <ComposerRuntime
                        view={view}
                        canControl={HAS_TOKEN}
                        busy={busy}
                        onOpenTerminal={() => {
                          setTab('terminal');
                          return true;
                        }}
                      />
                    ) : undefined
                  }
                  hasAttachments={readyAttachments.length > 0}
                  attachmentsPending={hasUploadingAttachments}
                />
              </div>
            )}
            {showQuestion && questionSurface && (
              <div className="mt-2">
                <QuestionForm
                  // Remount on a NEW question set: `picks`/`others` are `useState`
                  // initializers, so without this a set arriving while the form is
                  // still mounted would carry the previous set's answers.
                  key={pendingQuestionKey}
                  sessionId={sessionId}
                  question={questionSurface}
                  onSubmit={() => void store.fetchSession(sessionId).catch(() => undefined)}
                  onDismissed={key => {
                    setDismissedQuestionKey(key);
                    setActionNotice({
                      kind: 'ok',
                      text: 'Question declined locally. Normal chat is restored while the daemon confirms the decline.',
                    });
                  }}
                  onDismissFailed={message =>
                    setActionNotice({
                      kind: 'err',
                      text: `The question is hidden locally, but the daemon did not confirm the decline: ${message}. Reload to show and dismiss it again.`,
                    })
                  }
                  active={active !== false}
                  // Phone: one question per screen. Paging is a LAYOUT decision, so
                  // it keys off `compact` (the same signal `Composer` gets), never
                  // off input modality — a narrow desktop window is not a phone.
                  compact={compact}
                />
              </div>
            )}
            {!HAS_TOKEN && (
              <div className="mt-2 rounded-md border border-warn-border bg-warn-bg px-2.5 py-1.5 text-[12.5px] text-warn">
                Read-only: this origin did not receive an embedding token from the daemon, so messages, answers, and
                control actions are disabled.
              </div>
            )}
          </div>
        </AttachmentImageProvider>
      )}
    </div>
  );
  // The unified side pane replaces the browser-only workspace: same non-modal
  // desktop pane / mobile sheet split, now hosting browser, files, tasks and
  // pins as session-scoped surfaces. `active` lets a retained background pane
  // drop an open (focus-trapped) sheet; the desktop pane is safe to retain.
  return (
    <SidePaneWorkspace
      sessionId={sessionId}
      compact={compact}
      active={active !== false}
      cwd={view?.config.cwd}
      onInsertSkill={invocation => setDraft(current => appendSkillInvocation(current, invocation))}
    >
      {chatPage}
    </SidePaneWorkspace>
  );
}

export function PendingAttachmentStrip({
  entries,
  onRetry,
  onRemove,
}: {
  entries: PendingAttachment[];
  onRetry(entry: PendingAttachment): void;
  onRemove(entry: PendingAttachment): void;
}) {
  // Alignment is the flex default `stretch`, deliberately NOT `items-start`: the
  // failed chip is the tallest and already sets the strip's height, so letting the
  // others match it costs no pixels and keeps the row from reading as ragged.
  return (
    <div
      className="flex min-w-0 gap-1.5 overflow-x-auto border-b border-border-soft pb-1 scroll-thin"
      aria-label="Attached images"
    >
      {entries.map(entry => (
        <div
          key={entry.localId}
          className={cn(
            'flex items-center gap-1.5 rounded-control border bg-surface-2 p-1',
            // Failure is the only state that needs a SECOND 44px control AND the
            // only one whose second row carries a sentence rather than a token,
            // so it gets the wider box: 88px of buttons plus a wrapping error out
            // of the same 230px would have forced the error to truncate, and that
            // is the one string here the reader cannot do without.
            entry.status === 'failed'
              ? 'min-w-[320px] max-w-[344px] border-err-border'
              : 'min-w-[230px] max-w-[320px] border-border-soft',
          )}
          role={entry.status === 'failed' ? 'alert' : 'status'}
        >
          {entry.objectUrl ? (
            <img
              src={entry.objectUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded-sm border border-border-soft object-cover"
            />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-border-soft bg-surface">
              <ImageOff size={16} className="text-muted" aria-hidden="true" />
            </span>
          )}
          {/* TWO ROWS, TIGHT LEADING. This was three rows at body leading — name,
              size, state — which put 60px of type beside a 44px button and made
              the chip 74px tall before a pixel of it said anything the reader did
              not already know. Size and state now share row two: both are one
              short token, they are read together ("472 KB · ready"), and the state
              keeps its own colour so the scan still works.

              FAILURE IS THE DELIBERATE EXCEPTION. An error is a sentence, not a
              token, so on `failed` the SIZE is dropped — a hard failure has
              already said whatever mattered about the bytes — and the error takes
              the whole second row so it can wrap instead of truncate. That is why
              a failed chip is a few px taller than a ready one; it is still less
              than half of what every chip used to cost. */}
          <span className="min-w-0 flex-1 text-meta leading-tight">
            <span className="block truncate text-fg" title={entry.file.name}>
              {entry.file.name}
            </span>
            {entry.status === 'failed' ? (
              <span className="block text-err">{entry.error}</span>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-faint">{formatAttachmentSize(entry.file.size)}</span>
                <span className="shrink-0 text-faint" aria-hidden="true">
                  ·
                </span>
                {entry.status === 'uploading' ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-muted">
                    <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{' '}
                    uploading
                  </span>
                ) : (
                  <span className="shrink-0 text-ok">ready</span>
                )}
              </span>
            )}
          </span>
          {entry.status === 'failed' && (
            <button
              type="button"
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg"
              onClick={() => onRetry(entry)}
              aria-label={`Retry ${entry.file.name}`}
              title="Retry upload"
            >
              <RotateCcw size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg"
            onClick={() => onRemove(entry)}
            aria-label={`Remove ${entry.file.name}`}
            title="Remove image"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
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
//
// `delivered` USED TO BE GREEN AND SAY "delivered". It no longer does, because at
// this point the only thing that has happened is that the daemon accepted the
// message and reported a disposition — kteam's own belief, not harness proof. That
// is exactly the class of claim this change exists to stop making: green
// "delivered" on an HTTP 200 is how a message that never reached the agent gets
// reported as read.
//
// The wording stays on the kteam side of the boundary for the same reason the
// ledger's ACCEPTED copy does (lib/sends.ts sendBadge): "sent" would assert that
// keystrokes reached the pane, which is unknown here. The optimistic row tops out
// at "accepted — awaiting confirmation" and the durable ledger chip takes over from
// there, so the reader still gets instant feedback without being told something
// kteam cannot see. `queued` keeps its wording because that disposition IS the
// harness's native input queue.
const PENDING_BADGE: Record<PendingStatus, { label: string; tone: string }> = {
  sending: { label: 'sending', tone: 'border-border bg-surface-2 text-muted' },
  queued: { label: 'queued for next turn', tone: 'border-warn-border bg-warn-bg text-warn' },
  delivered: { label: 'accepted — awaiting confirmation', tone: 'border-warn-border bg-warn-bg text-warn' },
  error: { label: 'failed to send', tone: 'border-err-border bg-err-bg text-err' },
};

function PendingMessage({
  text,
  attachments,
  status,
  onRetry,
  onDismiss,
}: {
  text: string;
  attachments: StoredTranscriptImage[];
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
        {text && (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-1.5 pt-0.5 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
            {text}
          </div>
        )}
        <TranscriptImageGallery images={attachments} className="px-panel pb-2 pt-1" />
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
function journalEventKey(event: KTeamEvent): string {
  if (event.sequence > 0) return `${event.sessionId}:${event.sequence}`;
  return `${event.sessionId}:${event.type}:${event.time}:${fieldHash(JSON.stringify(event.data ?? null))}`;
}

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
