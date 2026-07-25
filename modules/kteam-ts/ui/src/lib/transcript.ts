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

import type { ChatRecord } from '../types';
import type { ToolResultData, ToolUseData } from './tool-extract';
import { classifySystemText, type SystemBlockInfo } from './system-blocks';
export type { SystemBlockInfo } from './system-blocks';

export interface ToolCall {
  key: string;
  use: ToolUseData;
  result?: ToolResultData;
  ts?: string;
  /** true when this call was a bare result with no matching use in the run. */
  orphanResult?: boolean;
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

interface PendingTurns {
  /** Every marker in the current run, newest last. */
  markers: { variant: 'started' | 'completed' | 'aborted'; ts?: string }[];
  /** Duration of the most recent turn to close inside this run. */
  durationMs?: number;
  aborted: boolean;
  /** sig() of the first marker — the run's stable React key. */
  key: string;
}

export function buildTranscript(records: ChatRecord[]): TranscriptBlock[] {
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
      if (info) {
        out.push({
          id: mkId(`s-${hash(sig(r))}`),
          kind: 'system',
          info,
          ts: r.timestamp,
          source: r.source ?? 'user',
        });
      } else {
        out.push({
          id: mkId(`u-${hash(sig(r))}`),
          kind: 'user',
          text: body,
          ts: r.timestamp,
          source: r.source ?? 'user',
          ...(from ? { from } : {}),
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
      // Consume the whole consecutive run of tool activity.
      const runStart = i;
      while (i < n && TOOL_TYPES.has(records[i]!.type)) i++;
      const run = records.slice(runStart, i);
      const calls = groupToolRun(run);
      const firstTs = run[0]?.timestamp;
      // Keyed on the run's FIRST record only. Hashing the whole run gave the
      // group a new id every time a tool.use/tool.result was appended to it —
      // i.e. on every event of an active tool run — remounting the group (and
      // collapsing whatever the reader had expanded) mid-stream.
      flushTurns(false);
      out.push({ id: mkId(`g-${hash(sig(run[0]!))}`), kind: 'tools', calls, ts: firstTs });
      prevTs = run[run.length - 1]?.timestamp;
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
  return out;
}

// Pair uses to results within a run by toolUseId; keep use order, append any
// orphan results at the end so nothing is silently dropped.
function groupToolRun(run: ChatRecord[]): ToolCall[] {
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
  return calls;
}

export function latestPendingQuestion(records: ChatRecord[]): ChatRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.type === 'interaction.question') return records[i]!;
  }
  return null;
}
