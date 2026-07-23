// Pure transcript grep — shared by GET /v1/search. Case-insensitive substring
// match over the text-bearing fields of normalized chat records
// (text / thinking / reasoning), returning a short single-line snippet with a
// little context around the first match, plus a best-effort turn number
// (counted from turn.started records). I/O (reading chat.jsonl, ordering
// sessions, caps) lives in the service.

export interface TranscriptMatch {
  turn?: number;
  snippet: string;
  at?: string;
}

interface RecordLike {
  type?: string;
  timestamp?: string;
  turn?: number;
  data?: unknown;
}

const SNIPPET_BEFORE = 48;
const SNIPPET_AFTER = 96;

function textOf(rec: RecordLike): string | undefined {
  const d = rec.data as Record<string, unknown> | undefined;
  if (!d) return undefined;
  for (const k of ['text', 'thinking', 'reasoning']) {
    const v = d[k];
    if (typeof v === 'string' && v.length) return v;
  }
  return undefined;
}

function snippetAround(text: string, at: number, q: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + q + SNIPPET_AFTER);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '… ' + s;
  if (end < text.length) s = s + ' …';
  return s;
}

/** Find matches for `q` (case-insensitive) in a session's records. Returns at
 *  most `perSession` matches, each with a context snippet and the turn it fell
 *  in. Returns [] for an empty query. */
export function searchRecords(records: RecordLike[], q: string, perSession = 3): TranscriptMatch[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: TranscriptMatch[] = [];
  let turn = 1;
  for (const rec of records) {
    if (rec.type === 'turn.started') {
      turn = typeof rec.turn === 'number' ? rec.turn : turn + 1;
      continue;
    }
    if (typeof rec.turn === 'number') turn = rec.turn;
    const text = textOf(rec);
    if (!text) continue;
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    out.push({ turn, snippet: snippetAround(text, idx, needle.length), at: rec.timestamp });
    if (out.length >= perSession) break;
  }
  return out;
}
