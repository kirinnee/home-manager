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
//   - turn.*                              → a slim turn marker.
//   - anything else                       → a muted notice row.
//
// Ids are content-derived and stable per record so React keys (and the
// MessageScroller's preserveScrollOnPrepend anchoring) survive older-page
// prepends without remounting the visible tail.

import type { ChatRecord } from '../types';
import type { ToolResultData, ToolUseData } from './tool-extract';

export interface ToolCall {
  key: string;
  use: ToolUseData;
  result?: ToolResultData;
  ts?: string;
  /** true when this call was a bare result with no matching use in the run. */
  orphanResult?: boolean;
}

export type TranscriptBlock =
  | { id: string; kind: 'user'; text: string; ts?: string; source: string }
  | { id: string; kind: 'assistant'; text: string; ts?: string; source: string }
  | { id: string; kind: 'thinking'; text: string; ts?: string; durationMs?: number; source: string }
  | { id: string; kind: 'tools'; calls: ToolCall[]; ts?: string }
  | { id: string; kind: 'turn'; variant: 'started' | 'completed' | 'aborted'; ts?: string }
  | { id: string; kind: 'notice'; label: string; detail?: string };

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

export function buildTranscript(records: ChatRecord[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  const seen = new Map<string, number>();
  const mkId = (raw: string): string => {
    const n = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, n);
    return n === 1 ? raw : `${raw}#${n}`;
  };

  const n = records.length;
  let i = 0;
  let prevTs: string | undefined;

  while (i < n) {
    const r = records[i]!;
    const type = r.type;

    if (type === 'chat.user') {
      out.push({
        id: mkId(`u-${hash(sig(r))}`),
        kind: 'user',
        text: dataStr(r, 'text') ?? '',
        ts: r.timestamp,
        source: r.source ?? 'user',
      });
      prevTs = r.timestamp;
      i++;
      continue;
    }

    if (type === 'interaction.answer') {
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
      out.push({ id: mkId(`g-${hash(sig(run[0]!))}`), kind: 'tools', calls, ts: firstTs });
      prevTs = run[run.length - 1]?.timestamp;
      continue;
    }

    if (type === 'turn.started' || type === 'turn.completed' || type === 'turn.aborted') {
      out.push({
        id: mkId(`n-${hash(sig(r))}`),
        kind: 'turn',
        variant: type.replace('turn.', '') as 'started' | 'completed' | 'aborted',
        ts: r.timestamp,
      });
      prevTs = r.timestamp;
      i++;
      continue;
    }

    // Unknown / system record.
    out.push({ id: mkId(`x-${hash(sig(r))}`), kind: 'notice', label: type });
    i++;
  }

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
