// Convert the flat normalized chat-record stream into TRANSCRIPT BLOCKS —
// the top-to-bottom, role-marked model the redesign renders (no bubbles).
//
// Grouping rules:
//   - chat.user / interaction.answer      → one user block.
//   - chat.assistant.text                 → one assistant block; CONSECUTIVE
//     assistant text (no tool/thinking between) merges into a single block.
//   - thinking / reasoning                → one collapsed thinking block, with
//     an approximate duration (prev record → this record).
//   - a RUN of tool.use / tool.result     → ONE tools block (the whole run
//     collapses into a single slim group line; uses are paired to results by
//     toolUseId within the run).
//   - turn.*                              → NOT a row of its own. See below.
//   - anything else                       → a muted notice row.
//
// TURN MARKERS ARE A SEPARATOR, NOT AN EVENT LOG (round 4).
//
// Rendering one divider per turn event produced the reported "wall of empty
// rows": a session that has been resumed/nudged repeatedly emits a
// turn.started/turn.completed pair per nudge with NO conversation between them,
// and `/chat` history carries no turn records at all — so the websocket's
// journal backfill (`after=-200`) dumps the whole accumulated run of them at the
// END of the transcript. The user saw ~20 consecutive full-width dividers after
// the last assistant message, including two COMPLETED in a row.
//
// So turn events never become rows directly. They accumulate in a buffer that
// is FLUSHED — into at most ONE slim boundary — only when real content arrives
// after them. A boundary that separates nothing is dropped:
//   - a run with no content BEFORE it (transcript opens on turn markers) → gone
//   - a run with no content AFTER it (the backfilled tail) → gone
//   - N consecutive empty turns → one line, which says how many it swallowed
// The one exception is turn.aborted: "your turn was interrupted" is real
// information even with nothing after it, so an aborted run still flushes at the
// end. The boundary also carries the duration of the turn it closes, which is
// the fact a reader actually wants from a turn marker.
//
// Ids are content-derived and stable per record so React keys (and the
// MessageScroller's preserveScrollOnPrepend anchoring) survive older-page
// prepends without remounting the visible tail.

import type { ChatRecord, KTeamEvent } from '../types';
import { resultImages, type ToolResultData, type ToolUseData } from './tool-extract';
import {
  attachmentFromToolPath,
  sameAttachmentIds,
  type StoredTranscriptImage,
  type TranscriptImage,
} from './attachments';
import { classifySystemText, type SystemBlockInfo } from './system-blocks';
export type { SystemBlockInfo } from './system-blocks';

export interface ToolCall {
  key: string;
  use: ToolUseData;
  result?: ToolResultData;
  ts?: string;
  /** true when this call was a bare result with no matching use in the run. */
  orphanResult?: boolean;
  /** Bytes already present in a Claude result, or an authenticated store id
   * derived from a same-session Codex view_image path. */
  images?: TranscriptImage[];
}

/** A message that came from another SESSION rather than from the human.
 *
 *  The daemon prepends an attribution banner to peer messages (see
 *  session-manager.peerPreamble) because the harness only ever reads message
 *  TEXT. In the browser that banner is redundant chrome — the UI can render a
 *  proper sender chip instead — so it is parsed off here and the remaining
 *  prose is what gets shown. */
export interface PeerFrom {
  name: string;
  /** The sender is parked awaiting an answer to this message. */
  replyExpected: boolean;
}

/** Matches the banner emitted by session-manager.peerPreamble. Kept tolerant:
 *  an unrecognised banner is simply left in the body rather than half-stripped,
 *  so a daemon/UI version skew degrades to "shows extra text", never to
 *  "silently eats the first paragraph of a message". */
const PEER_BANNER = /^\[peer message from teammate ([^\s(]+)[^\]]*\]\n(.*?)\n\n/s;

export function peerFrom(text: string): { from: PeerFrom | null; body: string } {
  const match = PEER_BANNER.exec(text);
  if (!match) return { from: null, body: text };
  return {
    from: { name: match[1]!, replyExpected: /PARKED/.test(match[2] ?? '') },
    body: text.slice(match[0].length),
  };
}

export type TranscriptBlock =
  | {
      id: string;
      kind: 'user';
      text: string;
      ts?: string;
      source: string;
      /** Present when another session sent this, absent when a human did. */
      from?: PeerFrom;
      attachments?: StoredTranscriptImage[];
    }
  | { id: string; kind: 'assistant'; text: string; ts?: string; source: string }
  // A harness-INJECTED system text that arrived on the user channel (task
  // notifications, the turn prompt, environment_context, …) — classified at
  // render-model build time so the raw record stays untouched. See
  // lib/system-blocks.ts. Only ever produced for non-peer chat.user records.
  | { id: string; kind: 'system'; info: SystemBlockInfo; ts?: string; source: string }
  | { id: string; kind: 'thinking'; text: string; ts?: string; durationMs?: number; source: string }
  | { id: string; kind: 'tools'; calls: ToolCall[]; ts?: string }
  | {
      id: string;
      kind: 'turn';
      /** When the boundary sits — the newest marker in the collapsed run. */
      ts?: string;
      /** How long the turn that just CLOSED took, when both ends are known. */
      durationMs?: number;
      /** Turn boundaries swallowed beyond this one (empty resume/nudge turns). */
      skipped?: number;
      /** The run contained a turn.aborted — the turn did not finish normally. */
      aborted?: boolean;
    }
  | { id: string; kind: 'notice'; label: string; detail?: string };

/** A turn separator earns a transcript row only when it communicates a fact.
 * Keep this shared between the builder and renderer so a malformed or legacy
 * caller cannot reintroduce an empty flex item and its rhythm margin. */
export function isInformativeTurnBoundary(boundary: {
  aborted?: boolean;
  durationMs?: number;
  skipped?: number;
}): boolean {
  return boundary.aborted === true || boundary.durationMs !== undefined || boundary.skipped !== undefined;
}

function dataStr(rec: ChatRecord, key: string): string | undefined {
  const d = rec.data as Record<string, unknown> | undefined;
  const v = d?.[key];
  return typeof v === 'string' ? v : undefined;
}

function idOf(rec: ChatRecord): string | undefined {
  return dataStr(rec, 'toolUseId');
}

// Small stable hash for content-derived ids.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Identity of a record, for deriving a STABLE React key.
//
// The harness's own `recordUuid` is used when present, because it does not
// change as a streaming message grows. Content signatures do: a block whose id
// is derived from its text gets a NEW id on every delta, which React reads as
// "different element" — unmount, remount, lose scroll position and any open
// disclosure. That remount storm is what made a streaming session flicker.
//
// The content fallback hashes the FULL body (never a prefix) so two long
// messages that merely start alike cannot share an id.
function sig(rec: ChatRecord): string {
  const meta = rec as unknown as { recordUuid?: unknown; blockIndex?: unknown };
  if (typeof meta.recordUuid === 'string' && meta.recordUuid)
    return `${rec.source ?? ''}|${rec.type}|${meta.recordUuid}|${String(meta.blockIndex ?? '')}`;
  const t = rec.timestamp ?? '';
  let body = '';
  const d = rec.data as Record<string, unknown> | undefined;
  if (d) {
    for (const k of ['text', 'thinking', 'reasoning', 'toolUseId', 'name']) {
      const v = d[k];
      if (typeof v === 'string') body += `${k}=${hash(v)}:${v.length};`;
    }
  }
  return `${rec.source ?? ''}|${rec.type}|${t}|${body}`;
}

function tsMs(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

function extractAnswerText(r: ChatRecord): string {
  const d = r.data as { labels?: string[]; other?: string; responses?: string[] } | undefined;
  if (!d) return '(answer)';
  if (d.other) return d.other;
  if (d.labels?.length) return d.labels.join(', ');
  if (d.responses?.length) return d.responses.join(' / ');
  return '(answer)';
}

const TOOL_TYPES = new Set(['tool.use', 'tool.result']);

/** Record types that are DATA, not conversation: they are consumed elsewhere in
 *  the UI (header context %, RC badge) and must never render as a transcript
 *  row. Anything not listed here still falls through to a visible `notice` row —
 *  a new record type should be noticed, not silently swallowed. */
const SILENT_TYPES = new Set(['context.usage', 'session.remote_control']);

/** Does this record produce NO visible transcript block, so a tool run should
 *  bridge STRAIGHT ACROSS it rather than end at it?
 *
 *  Measured on a real busy session (mrwirdnf, 4022 records): a `context.usage`
 *  accounting record is emitted after almost every tool result, and it — along
 *  with empty thinking heartbeats and empty assistant text — used to TERMINATE
 *  the tool run despite rendering nothing. That shattered one turn's tools into
 *  ~1330 separate single-call lines instead of a handful of grouped ones, AND
 *  split a `tool.use` from its own `tool.result` (the result then rendered as a
 *  bare "result tool result" orphan line). 88.5% of all run breaks in that
 *  session were one of these invisible records.
 *
 *  Bridging them keeps a turn's tools in ONE group and lets groupToolRun pair
 *  use↔result again. Records that DO render — visible prose, real thinking, a
 *  user/system row, an informative turn boundary — still break the run, so the
 *  reader never sees two tool batches reordered across something they can read.
 *  Turn markers are deliberately NOT bridged here: their visibility is decided
 *  later by flushTurns, and a non-informative one that survives leaves two
 *  adjacent tools blocks that the final merge pass folds together anyway. */
function bridgesToolRun(rec: ChatRecord): boolean {
  const type = rec.type;
  if (SILENT_TYPES.has(type)) return true;
  if (type === 'chat.assistant.thinking' || type === 'chat.assistant.reasoning') {
    const t = dataStr(rec, type === 'chat.assistant.thinking' ? 'thinking' : 'reasoning');
    return !(t && t.trim());
  }
  if (type === 'chat.assistant.text') {
    const t = dataStr(rec, 'text');
    return !(t && t.trim());
  }
  return false;
}

const TRANSCRIPT_JOURNAL_TYPES = new Set([
  'control.send',
  'control.send_queued',
  'control.send_consumed',
  'attachment.created',
]);

export function isTranscriptJournalEvent(event: KTeamEvent): boolean {
  return TRANSCRIPT_JOURNAL_TYPES.has(event.type);
}

export interface SentMessage {
  kind: 'sent' | 'queued';
  sequence: number;
  time: string;
  turn?: number;
  queueId?: string;
  message: string;
  attachmentIds: string[];
  from?: string;
  fromName?: string;
  replyExpected?: boolean;
}

export interface SendIndex {
  byTurn: ReadonlyMap<number, SentMessage>;
  byQueueId: ReadonlyMap<string, SentMessage>;
  attachments: ReadonlyMap<string, StoredTranscriptImage>;
  /** Inline (NON file-backed) native-queue sends. These are the only send class
   *  the harness delivers WITHOUT leaving a chat.user transcript record: a short
   *  message typed into a busy session's composer is folded into a turn and no
   *  `chat.user` / `control.send_consumed` is ever emitted for it (verified on
   *  ms1lhymf-c4051f31, turns 36→37). buildTranscript SYNTHESIZES a user block
   *  for each once its turn has demonstrably closed, so the message is visible
   *  after reload AND the optimistic "queued" chip has a block to reap against.
   *  File-backed queued sends are excluded — those DO leave a "Read the queued
   *  message file …" chat.user row that byQueueId replaces in place. */
  queued: readonly SentMessage[];
}

function validAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && /^att_[a-f0-9]{64}$/i.test(id));
}

/** Build the send indexes. `byTurn`/`byQueueId` are REPLACEMENT indexes: the
 * direct turn-file and file-backed-queue paths both leave a real chat.user row
 * (a turn prompt / a "Read the queued message file …" instruction) that
 * buildTranscript rewrites in place. `queued` is a SYNTHESIS list: inline native
 * queue sends leave no chat.user row at all, so buildTranscript builds one for
 * them (see the SendIndex.queued note). */
export function buildSendIndex(events: KTeamEvent[], sessionId: string): SendIndex {
  const byTurn = new Map<number, SentMessage>();
  const byQueueId = new Map<string, SentMessage>();
  const queued: SentMessage[] = [];
  const queuedSeen = new Set<string>();
  const attachments = new Map<string, StoredTranscriptImage>();
  const seen = new Set<number>();

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sessionId !== sessionId || (event.sequence > 0 && seen.has(event.sequence))) continue;
    if (event.sequence > 0) seen.add(event.sequence);
    if (!event.data || typeof event.data !== 'object') continue;
    const data = event.data as Record<string, unknown>;

    if (event.type === 'attachment.created') {
      const id = typeof data['id'] === 'string' ? data['id'] : '';
      if (!/^att_[a-f0-9]{64}$/i.test(id)) continue;
      attachments.set(id, {
        kind: 'attachment',
        sessionId,
        attachmentId: id,
        filename: typeof data['filename'] === 'string' && data['filename'] ? data['filename'] : id,
        ...(typeof data['mime'] === 'string' ? { mime: data['mime'] } : {}),
        ...(typeof data['size'] === 'number' ? { size: data['size'] } : {}),
      });
      continue;
    }

    if (event.type === 'control.send' && data['direct'] !== true && typeof event.turn === 'number') {
      if (!byTurn.has(event.turn)) {
        byTurn.set(event.turn, {
          kind: 'sent',
          sequence: event.sequence,
          time: event.time,
          turn: event.turn,
          message: typeof data['message'] === 'string' ? data['message'].trim() : '',
          attachmentIds: validAttachmentIds(data['attachmentIds']),
          ...(typeof data['from'] === 'string' ? { from: data['from'] } : {}),
          ...(typeof data['fromName'] === 'string' ? { fromName: data['fromName'] } : {}),
          ...(data['replyExpected'] === true ? { replyExpected: true } : {}),
        });
      }
      continue;
    }

    if (event.type === 'control.send_queued' && typeof data['queueId'] === 'string' && data['queueId']) {
      const queueId = data['queueId'];
      const message: SentMessage = {
        kind: 'queued',
        sequence: event.sequence,
        time: event.time,
        queueId,
        ...(typeof event.turn === 'number' ? { turn: event.turn } : {}),
        message: typeof data['message'] === 'string' ? data['message'].trim() : '',
        attachmentIds: validAttachmentIds(data['attachmentIds']),
        ...(typeof data['from'] === 'string' ? { from: data['from'] } : {}),
        ...(typeof data['fromName'] === 'string' ? { fromName: data['fromName'] } : {}),
        ...(data['replyExpected'] === true ? { replyExpected: true } : {}),
      };
      // File-backed queue sends leave a chat.user instruction row that
      // byQueueId rewrites; inline ones leave nothing, so they go on the
      // synthesis list instead. The two paths are mutually exclusive.
      if (data['fileBacked'] === true) {
        if (!byQueueId.has(queueId)) byQueueId.set(queueId, message);
      } else if (!queuedSeen.has(queueId)) {
        queuedSeen.add(queueId);
        queued.push(message);
      }
    }
  }
  return { byTurn, byQueueId, attachments, queued };
}

function queuedFileId(text: string): string | undefined {
  const normalized = text.replaceAll('\\', '/');
  const match =
    /^Read the queued message file at .*\/\.kteam\/[\w.-]+\/channel\/queued-([0-9a-f-]{36})\.md completely now, then follow every instruction inside it\./i.exec(
      normalized,
    );
  return match?.[1];
}

/** Conservatively strip only the daemon's complete, trailing reference block.
 * Any malformed line leaves the prose untouched. */
export function stripAttachmentReferenceBlock(text: string): { text: string; attachmentIds: string[] } | null {
  const heading = /(?:^|\n\n)(Attached images? \(inspect th(?:is|ese) files? directly before responding\):\n)/g;
  let match: RegExpExecArray | null = null;
  for (const candidate of text.matchAll(heading)) match = candidate;
  if (!match || match.index === undefined) return null;
  const blockStart = match.index + (match[0].startsWith('\n\n') ? 2 : 0);
  const lines = text.slice(blockStart).split('\n');
  if (
    lines.length < 2 ||
    !/^Attached images? \(inspect th(?:is|ese) files? directly before responding\):$/.test(lines[0]!)
  )
    return null;
  const attachmentIds: string[] = [];
  for (const line of lines.slice(1)) {
    const item = /^- .+ \(image\/(?:png|jpeg|gif|webp), \d+ bytes, id (att_[a-f0-9]{64})\)$/.exec(line);
    if (!item) return null;
    attachmentIds.push(item[1]!);
  }
  if (!attachmentIds.length) return null;
  return { text: text.slice(0, match.index).trim(), attachmentIds };
}

function imagesForIds(
  ids: string[],
  sends: SendIndex | undefined,
  sessionId: string | undefined,
): StoredTranscriptImage[] {
  if (!sessionId) return [];
  return ids.map(
    id =>
      sends?.attachments.get(id) ?? {
        kind: 'attachment' as const,
        sessionId,
        attachmentId: id,
        filename: id,
      },
  );
}

function senderFor(message: SentMessage, parsed: PeerFrom | null): PeerFrom | undefined {
  if (!message.from && !parsed) return undefined;
  return {
    name: message.fromName ?? parsed?.name ?? message.from!,
    replyExpected: message.replyExpected ?? parsed?.replyExpected ?? false,
  };
}

interface PendingTurns {
  /** Every marker in the current run, newest last. */
  markers: { variant: 'started' | 'completed' | 'aborted'; ts?: string }[];
  /** Duration of the most recent turn to close inside this run. */
  durationMs?: number;
  aborted: boolean;
  /** sig() of the first marker — the run's stable React key. */
  key: string;
}

export function buildTranscript(
  records: ChatRecord[],
  sends?: SendIndex,
  sessionId?: string,
  /** The session's live turn. Inline native-queue sends are synthesized into
   *  user blocks only once this has advanced PAST the turn they were queued in
   *  — the proof they left the composer (a turn cannot advance while its queued
   *  text sits unsubmitted; a lost send dies at its turn and never advances it).
   *  Undefined ⇒ turn unknown ⇒ synthesize nothing, so a queued chip is never
   *  cleared on an assumption. */
  currentTurn?: number,
): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  const seen = new Map<string, number>();
  const mkId = (raw: string): string => {
    const n = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, n);
    return n === 1 ? raw : `${raw}#${n}`;
  };

  // ---- turn-boundary buffering (see the header comment) --------------------
  let pending: PendingTurns | null = null;
  /** Timestamp of the last turn.started, so a turn.completed can be given the
   *  duration of the turn it closes. */
  let openTurnAt: string | undefined;

  /** Emit the buffered run as ONE boundary — but only if it actually separates
   *  something. `final` is the end-of-stream flush, where there is by
   *  definition no content after the run. */
  const flushTurns = (final: boolean) => {
    const p = pending;
    pending = null;
    if (!p || p.markers.length === 0) return;
    // Nothing above it: the transcript would open on a divider.
    if (out.length === 0) return;
    // Nothing below it: this is the backfilled tail — the wall. An abort is the
    // one boundary worth showing with nothing after it.
    if (final && !p.aborted) return;
    const last = p.markers[p.markers.length - 1]!;
    const boundary: Extract<TranscriptBlock, { kind: 'turn' }> = {
      id: mkId(`n-${hash(p.key)}`),
      kind: 'turn',
      ...(last.ts === undefined ? {} : { ts: last.ts }),
      ...(p.durationMs === undefined ? {} : { durationMs: p.durationMs }),
      // One boundary is expected (the previous turn ending / the next starting);
      // anything beyond that is an empty turn this line stands in for.
      ...(p.markers.length > 2 ? { skipped: p.markers.length - 2 } : {}),
      ...(p.aborted ? { aborted: true } : {}),
    };
    if (isInformativeTurnBoundary(boundary)) out.push(boundary);
  };

  const n = records.length;
  let i = 0;
  let prevTs: string | undefined;

  while (i < n) {
    const r = records[i]!;
    const type = r.type;

    if (type === 'chat.user') {
      flushTurns(false);
      // Peer messages carry their attribution INSIDE the text (that is the only
      // channel the harness reads). Lift it out into structured form so the UI
      // can show a sender chip and the reader sees prose, not a banner.
      const { from, body } = peerFrom(dataStr(r, 'text') ?? '');
      // A genuine human/peer message renders as a user block; a harness-injected
      // system text (classified ONLY when there is no peer attribution, so peer
      // semantics are untouched by construction) collapses to a slim system row.
      const info = from ? null : classifySystemText(body);
      const turnNumber = info?.label === 'turn prompt' ? Number(/turn-(\d+)\.md/.exec(info.summary ?? '')?.[1]) : NaN;
      const queueId = from ? undefined : queuedFileId(body);
      const merged = Number.isFinite(turnNumber)
        ? sends?.byTurn.get(turnNumber)
        : queueId
          ? sends?.byQueueId.get(queueId)
          : undefined;

      if (merged) {
        const parsed = peerFrom(merged.message);
        const mergedFrom = senderFor(merged, parsed.from);
        const attachments = imagesForIds(merged.attachmentIds, sends, sessionId);
        out.push({
          // The record, not the late-arriving event, owns row identity. `p-` is
          // also used by the fallback below so a replay race cannot remount it.
          id: mkId(`p-${hash(sig(r))}`),
          kind: 'user',
          text: parsed.body,
          ts: r.timestamp,
          source: r.source ?? 'user',
          ...(mergedFrom ? { from: mergedFrom } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      } else if (info || queueId) {
        const fallbackInfo: SystemBlockInfo = info ?? {
          label: 'queued message',
          summary: queueId ? `queued-${queueId.slice(0, 8)}….md` : undefined,
          raw: body,
        };
        out.push({
          id: mkId(`${info?.label === 'turn prompt' || queueId ? 'p' : 's'}-${hash(sig(r))}`),
          kind: 'system',
          info: fallbackInfo,
          ts: r.timestamp,
          source: r.source ?? 'user',
        });
      } else {
        const referenced = stripAttachmentReferenceBlock(body);
        const attachments = imagesForIds(referenced?.attachmentIds ?? [], sends, sessionId);
        out.push({
          id: mkId(`u-${hash(sig(r))}`),
          kind: 'user',
          text: referenced?.text ?? body,
          ts: r.timestamp,
          source: r.source ?? 'user',
          ...(from ? { from } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      }
      prevTs = r.timestamp;
      i++;
      continue;
    }

    if (type === 'interaction.answer') {
      flushTurns(false);
      out.push({
        id: mkId(`a-${hash(sig(r))}`),
        kind: 'user',
        text: extractAnswerText(r),
        ts: r.timestamp,
        source: r.source ?? 'user',
      });
      prevTs = r.timestamp;
      i++;
      continue;
    }

    if (type === 'interaction.question') {
      i++; // rendered as the inline question form, not a transcript block
      continue;
    }

    // Not conversation. `context.usage` is context ACCOUNTING that rides the
    // same harness-derived channel (it is a chat pointer, so /chat returns it),
    // and it landed in the catch-all `notice` branch below — printing a literal
    // "context.usage" line after almost every assistant message and tool call.
    // Its content already has a home: the header's context %.
    if (SILENT_TYPES.has(type)) {
      i++;
      continue;
    }

    if (type === 'chat.assistant.text') {
      const parts: string[] = [];
      const first = r;
      while (i < n && records[i]!.type === 'chat.assistant.text') {
        const t = dataStr(records[i]!, 'text') ?? '';
        if (t) parts.push(t);
        i++;
      }
      flushTurns(false);
      out.push({
        id: mkId(`t-${hash(sig(first))}`),
        kind: 'assistant',
        text: parts.join('\n\n'),
        ts: first.timestamp,
        source: first.source ?? 'claude',
      });
      prevTs = first.timestamp;
      continue;
    }

    if (type === 'chat.assistant.thinking' || type === 'chat.assistant.reasoning') {
      const text = (type === 'chat.assistant.thinking' ? dataStr(r, 'thinking') : dataStr(r, 'reasoning')) ?? '';
      const start = tsMs(prevTs);
      const end = tsMs(r.timestamp);
      const durationMs =
        start != null && end != null && end >= start && end - start < 3 * 3600_000 ? end - start : undefined;
      // Empty thinking heartbeats are dropped entirely.
      if (text.trim()) {
        flushTurns(false);
        out.push({
          id: mkId(`k-${hash(sig(r))}`),
          kind: 'thinking',
          text,
          ts: r.timestamp,
          durationMs,
          source: r.source ?? 'claude',
        });
      }
      prevTs = r.timestamp;
      i++;
      continue;
    }

    if (TOOL_TYPES.has(type)) {
      // Consume the whole run of tool activity — bridging STRAIGHT ACROSS any
      // record that renders nothing (see bridgesToolRun). Those invisible
      // records used to end the run despite emitting no block, which both
      // fragmented one turn's tools into dozens of group lines and split a
      // tool.use from its own tool.result. Bridging keeps the run intact.
      const runStart = i;
      let lastTool = i;
      while (i < n && (TOOL_TYPES.has(records[i]!.type) || bridgesToolRun(records[i]!))) {
        if (TOOL_TYPES.has(records[i]!.type)) lastTool = i;
        i++;
      }
      // Group only the tool records; the bridged records are transparent (they
      // emit nothing, so consuming them here just stops them re-breaking the run
      // or reaching a branch that would build an empty message block).
      const run = records.slice(runStart, lastTool + 1).filter(rc => TOOL_TYPES.has(rc.type));
      const calls = groupToolRun(run, sessionId, sends?.attachments);
      const firstTs = run[0]?.timestamp;
      // Keyed on the run's FIRST record only. Hashing the whole run gave the
      // group a new id every time a tool.use/tool.result was appended to it —
      // i.e. on every event of an active tool run — remounting the group (and
      // collapsing whatever the reader had expanded) mid-stream.
      flushTurns(false);
      out.push({ id: mkId(`g-${hash(sig(run[0]!))}`), kind: 'tools', calls, ts: firstTs });
      prevTs = records[i - 1]?.timestamp;
      continue;
    }

    if (type === 'turn.started' || type === 'turn.completed' || type === 'turn.aborted') {
      const variant = type.slice('turn.'.length) as 'started' | 'completed' | 'aborted';
      if (variant === 'started') openTurnAt = r.timestamp;
      // The duration of the turn this marker CLOSES — the one useful fact a
      // turn boundary carries. Bounded, so a stale openTurnAt from before a
      // resume cannot print "thought for 9 hours".
      let closedMs: number | undefined;
      if (variant !== 'started') {
        const start = tsMs(openTurnAt);
        const end = tsMs(r.timestamp);
        if (start != null && end != null && end >= start && end - start < 3 * 3600_000) closedMs = end - start;
        openTurnAt = undefined;
      }
      pending ??= { markers: [], aborted: false, key: sig(r) };
      pending.markers.push({ variant, ...(r.timestamp === undefined ? {} : { ts: r.timestamp }) });
      if (closedMs !== undefined) pending.durationMs = closedMs;
      if (variant === 'aborted') pending.aborted = true;
      prevTs = r.timestamp;
      i++;
      continue;
    }

    // Unknown / system record.
    flushTurns(false);
    out.push({ id: mkId(`x-${hash(sig(r))}`), kind: 'notice', label: type });
    i++;
  }

  flushTurns(true);
  return synthesizeDeliveredQueued(mergeAdjacentToolBlocks(out), sends, sessionId, currentTurn);
}

/** Weave in a user block for each inline native-queue send whose turn has
 *  closed (see SendIndex.queued). Runs on the finished block list so it never
 *  perturbs turn grouping or tool-run merging: each block is inserted at its
 *  chronological position by send time, and a send already visible as a real
 *  chat.user row (or an earlier synthesis) is skipped so nothing double-renders.
 *  Placement by time mirrors where the reader typed it — a human interjection
 *  during the agent's work — and gives the optimistic reaper a block whose ts is
 *  in-window with the pending send it must clear. */
function synthesizeDeliveredQueued(
  blocks: TranscriptBlock[],
  sends: SendIndex | undefined,
  sessionId: string | undefined,
  currentTurn: number | undefined,
): TranscriptBlock[] {
  const queued = sends?.queued;
  if (!queued?.length || currentTurn == null) return blocks;
  const out = [...blocks];
  for (const q of queued) {
    // Not yet delivered: the turn it was queued in is still open (or its turn
    // is unknown). Leave it to the sender's optimistic chip; do not fabricate a
    // delivered row for a message that may still be sitting in the composer.
    if (q.turn == null || currentTurn <= q.turn) continue;
    const parsed = peerFrom(q.message);
    const from = senderFor(q, parsed.from);
    const text = parsed.body.trim();
    const attachments = imagesForIds(q.attachmentIds, sends, sessionId);
    if (!text && attachments.length === 0) continue;
    // Already on screen (a real chat.user landed, or a duplicate queueId): the
    // existing row and the reaper own it, so never add a second bubble.
    const duplicate = out.some(
      b =>
        b.kind === 'user' &&
        b.text.trim() === text &&
        (b.from?.name ?? undefined) === (from?.name ?? undefined) &&
        sameAttachmentIds(
          (b.attachments ?? []).map(image => image.attachmentId),
          q.attachmentIds,
        ),
    );
    if (duplicate) continue;
    const block: Extract<TranscriptBlock, { kind: 'user' }> = {
      id: `q-${hash(q.queueId ?? String(q.sequence))}`,
      kind: 'user',
      text,
      ts: q.time,
      source: q.from ?? 'user',
      ...(from ? { from } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    const at = tsMs(q.time);
    let idx = out.length;
    if (at != null) {
      const found = out.findIndex(b => {
        const bt = 'ts' in b ? tsMs(b.ts) : undefined;
        return bt != null && bt > at;
      });
      if (found !== -1) idx = found;
    }
    out.splice(idx, 0, block);
  }
  return out;
}

/** Fold any two `tools` blocks that ended up ADJACENT in the output into one.
 *
 *  Adjacency here is a proof, not a heuristic: if nothing sits between two tools
 *  blocks in the built list, then every source record between their runs emitted
 *  no block — so concatenating their calls in order reorders nothing the reader
 *  can see. The record-level bridge (bridgesToolRun) already merges the common
 *  case; this pass is the catch-all for anything that slips through without a
 *  visible block, most notably a turn boundary that flushTurns judged
 *  uninformative and dropped. It keeps the FIRST block's id and ts, so the id is
 *  stable across rebuilds and the group never remounts (nor loses an expansion)
 *  as later runs merge into it while streaming. */
function mergeAdjacentToolBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const merged: TranscriptBlock[] = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (b.kind === 'tools' && prev && prev.kind === 'tools') {
      merged[merged.length - 1] = { ...prev, calls: prev.calls.concat(b.calls) };
      continue;
    }
    merged.push(b);
  }
  return merged;
}

// Pair uses to results within a run by toolUseId; keep use order, append any
// orphan results at the end so nothing is silently dropped.
function toolInputPath(input: unknown): string | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath']) if (typeof obj[key] === 'string') return obj[key] as string;
  }
  if (typeof input === 'string') {
    const match = /(?:path|file_path|filePath)\s*[:=]\s*["'`]([^"'`]+)["'`]/.exec(input);
    return match?.[1];
  }
  return undefined;
}

function imagesForCall(
  call: ToolCall,
  sessionId: string | undefined,
  knownAttachments: ReadonlyMap<string, StoredTranscriptImage>,
): TranscriptImage[] {
  const images: TranscriptImage[] = [];
  if (call.result) {
    for (const [index, image] of resultImages(call.result).entries()) {
      images.push({
        kind: 'inline',
        src: `data:${image.mediaType};base64,${image.data}`,
        alt: `Tool result image ${index + 1}`,
      });
    }
  }
  if (sessionId && /(?:^|\.)view_image$/i.test(call.use.name ?? '')) {
    const path = toolInputPath(call.use.input);
    if (path) {
      const attachment = attachmentFromToolPath(sessionId, path, knownAttachments);
      if (attachment) images.push(attachment);
    }
  }
  return images;
}

function groupToolRun(
  run: ChatRecord[],
  sessionId?: string,
  knownAttachments: ReadonlyMap<string, StoredTranscriptImage> = new Map(),
): ToolCall[] {
  const uses: { rec: ChatRecord; call: ToolCall }[] = [];
  const results: ChatRecord[] = [];
  for (const rec of run) {
    if (rec.type === 'tool.use') {
      uses.push({
        rec,
        call: { key: `${idOf(rec) ?? hash(sig(rec))}`, use: rec.data as ToolUseData, ts: rec.timestamp },
      });
    } else {
      results.push(rec);
    }
  }
  const byId = new Map<string, ToolCall>();
  for (const u of uses) {
    const id = idOf(u.rec);
    if (id) byId.set(id, u.call);
  }
  const usedResultIdx = new Set<number>();
  results.forEach((res, idx) => {
    const id = idOf(res);
    if (id && byId.has(id)) {
      byId.get(id)!.result = res.data as ToolResultData;
      usedResultIdx.add(idx);
    }
  });
  // Adjacency fallback: a use immediately followed by a result with no id on
  // either — pair positionally when counts line up 1:1 and none matched.
  const calls = uses.map(u => u.call);
  const orphanResults = results.filter((_, idx) => !usedResultIdx.has(idx));
  if (orphanResults.length && calls.some(c => !c.result)) {
    let ri = 0;
    for (const c of calls) {
      if (c.result) continue;
      if (ri >= orphanResults.length) break;
      c.result = orphanResults[ri]!.data as ToolResultData;
      ri++;
    }
    orphanResults.splice(0, ri);
  }
  for (const res of orphanResults) {
    const d = res.data as ToolResultData;
    calls.push({
      key: `orphan-${hash(sig(res))}`,
      use: { name: 'result', input: undefined },
      result: d,
      ts: res.timestamp,
      orphanResult: true,
    });
  }
  for (const call of calls) {
    const images = imagesForCall(call, sessionId, knownAttachments);
    if (images.length) call.images = images;
  }
  return calls;
}

export function latestPendingQuestion(records: ChatRecord[]): ChatRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.type === 'interaction.question') return records[i]!;
  }
  return null;
}
