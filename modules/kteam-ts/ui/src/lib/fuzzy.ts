// THE PALETTE'S RANKER — dependency-free, pure, and the only place that decides
// what "best match" means.
//
// It exists as its own module for two reasons. The first is testability: ranking
// is the part of a command palette that quietly rots (a weight nudged to fix one
// query breaks three others), so it is a table-tested pure function rather than
// a `.filter()` buried in a component. The second is the CASING CONTRACT
// (lib/callsign.ts): the fleet's search haystack is RAW LOWERCASE while the UI
// renders `displayCallsign()` Title Case. Matching therefore has to happen over
// values this module lowercases itself, never over the rendered strings — a
// palette that scored `Meghan` would stop answering to `meghan` the day someone
// changed the display casing.
//
// The scoring model, in one paragraph. A query scores against each of a
// session's five fields independently; every field score is one of three kinds,
// strictly ordered, so a weaker kind can never outrank a stronger one within a
// field: a WORD-START substring (100), a substring anywhere (70), or an in-order
// SUBSEQUENCE scored by how tightly it packs (40 × density, so always < 70).
// Field scores are multiplied by that field's weight — who the teammate is
// beats what the task says beats which folder it ran in — and the composite is
// the BEST weighted score plus a small residual from the others, so matching in
// two fields beats matching in one without ever letting a pile of weak matches
// out-rank a strong one.

/** One searchable value plus how much it counts. */
export interface FuzzyField {
  value: string;
  weight: number;
  /** Ids only answer to an anchored query — a prefix of the id, or of one of
   *  its `-`-separated segments. Ids are high-entropy hex-ish noise; letting
   *  them match loosely means every id matches every query by subsequence. */
  anchored?: boolean;
}

/** A word-start substring: the query begins a value or one of its segments. */
export const WORD_START_SCORE = 100;
/** A substring anywhere inside the value. */
export const SUBSTRING_SCORE = 70;
/** Ceiling for an in-order subsequence; the actual score scales with density,
 *  so it is strictly below SUBSTRING_SCORE for anything that is not already a
 *  substring (which the branch above would have caught). */
export const SUBSEQUENCE_SCORE = 40;

/** Field weights, per the reviewed plan. Exported so the tests assert the same
 *  numbers the palette ranks with rather than a copy of them. */
export const FIELD_WEIGHTS = {
  teammate: 3,
  task: 2,
  label: 1.5,
  folder: 1.2,
  id: 1,
} as const;

/** How much the non-winning fields contribute. Small on purpose: it breaks ties
 *  between sessions that match equally well in their strongest field, and is
 *  too small to reorder two different match KINDS in the strongest field. */
const CROSS_FIELD_RESIDUAL = 0.05;

/** A session doing live work now is the one you are most likely hunting for. */
export const ACTIVE_BONUS = 10;

/** Recency ladder: [window in ms, bonus]. Ordered narrowest-first. */
const RECENCY_LADDER: ReadonlyArray<readonly [number, number]> = [
  [5 * 60_000, 25],
  [60 * 60_000, 15],
  [24 * 60 * 60_000, 5],
];

/** Visible session results are capped: a palette that can show 40 rows is a
 *  list view with a text box on top. */
export const MAX_SESSION_RESULTS = 8;
/** Empty query — the "where was I" default. */
export const RECENT_SESSION_COUNT = 6;

/** Anything that is not a letter or a digit starts a new word. Unicode-aware so
 *  a non-ASCII task name still has word starts. */
const SEPARATOR = /[^\p{L}\p{N}]/u;

function isWordStart(haystack: string, at: number): boolean {
  if (at === 0) return true;
  return SEPARATOR.test(haystack[at - 1]!);
}

/** WORD_START if any occurrence begins a word, SUBSTRING if it occurs at all,
 *  0 if it does not. Every occurrence is checked, not just the first: `nitroso`
 *  inside `/home/k/Workspace/atomi/nitroso` is a word start even though the
 *  first `n` in the path is not. */
function substringScore(haystack: string, needle: string): number {
  let at = haystack.indexOf(needle);
  if (at === -1) return 0;
  while (at !== -1) {
    if (isWordStart(haystack, at)) return WORD_START_SCORE;
    at = haystack.indexOf(needle, at + 1);
  }
  return SUBSTRING_SCORE;
}

/** Length of the TIGHTEST window of `haystack` that contains `needle` as an
 *  in-order subsequence, or null when it does not contain one at all.
 *
 *  Tightest, not first: `tsx` against `transcript-search.tsx` should be scored
 *  on the 3-character tail it really abbreviates, not on the 21-character span
 *  a greedy left-to-right scan finds first. */
function subsequenceSpan(haystack: string, needle: string): number | null {
  let best: number | null = null;
  for (let start = 0; start < haystack.length; start++) {
    if (haystack[start] !== needle[0]) continue;
    let matched = 1;
    let cursor = start + 1;
    while (cursor < haystack.length && matched < needle.length) {
      if (haystack[cursor] === needle[matched]) matched++;
      cursor++;
    }
    // A later start can only match a suffix of what this one did, so once one
    // start runs out of haystack every later start does too.
    if (matched < needle.length) break;
    const span = cursor - start;
    if (best === null || span < best) best = span;
  }
  return best;
}

/** Score ONE value against ONE query term, before field weighting. 0 means
 *  "this field does not match" — never a floor, so callers can treat 0 as a
 *  rejection. */
export function fieldScore(value: string, term: string, options: { anchored?: boolean } = {}): number {
  const haystack = value.trim().toLowerCase();
  const needle = term.trim().toLowerCase();
  if (!haystack || !needle) return 0;

  const substring = substringScore(haystack, needle);
  // An anchored field is all-or-nothing: word start or no match. It never falls
  // through to the subsequence branch.
  if (options.anchored) return substring === WORD_START_SCORE ? WORD_START_SCORE : 0;
  if (substring) return substring;

  const span = subsequenceSpan(haystack, needle);
  if (span === null) return 0;
  return SUBSEQUENCE_SCORE * (needle.length / span);
}

/** Split a query into terms. Whitespace is AND: `jessica palette` must match
 *  something in both, which is what a reader typing two words means. */
function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The weighted composite for one item. 0 when any term matches no field —
 *  every term has to earn its place, or typing more would widen the result set.
 *
 *  Multi-term queries AVERAGE their per-term composites rather than summing, so
 *  a two-word query's scores stay on the same scale as a one-word query's and
 *  the caps and bonuses below mean the same thing either way. */
export function scoreFields(fields: readonly FuzzyField[], query: string): number {
  const parts = terms(query);
  if (parts.length === 0) return 0;

  let total = 0;
  for (const term of parts) {
    let best = 0;
    let rest = 0;
    for (const field of fields) {
      const score = field.weight * fieldScore(field.value, term, { anchored: field.anchored });
      if (score > best) {
        rest += best;
        best = score;
      } else {
        rest += score;
      }
    }
    if (best === 0) return 0;
    total += best + rest * CROSS_FIELD_RESIDUAL;
  }
  return total / parts.length;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A session flattened to exactly what ranking needs.
 *
 *  Deliberately plain strings, not a `SessionView`: this keeps the ranker free
 *  of the fleet's shape, and it makes the caller responsible for the casing
 *  contract — it passes RAW `config.teammate`, and renders `displayCallsign()`
 *  itself. */
export interface SessionEntry {
  /** Raw session id. */
  id: string;
  /** Raw lowercase callsign — NOT `displayCallsign()`. */
  teammate: string;
  /** The task, already stripped of its `[Bracket]` prefix. */
  task: string;
  label: string;
  /** Project group name plus the working directory. */
  folder: string;
  /** Epoch ms of the last life sign; 0 when unknown (sorts last). */
  activityAt: number;
  /** Doing live work right now (status shape `active`). */
  active: boolean;
  /** Terminal — completed/failed/stalled/stopped. Still searchable; just not
   *  what the empty-query default offers first. */
  finished: boolean;
}

function entryFields(entry: SessionEntry): FuzzyField[] {
  return [
    { value: entry.teammate, weight: FIELD_WEIGHTS.teammate },
    { value: entry.task, weight: FIELD_WEIGHTS.task },
    { value: entry.label, weight: FIELD_WEIGHTS.label },
    { value: entry.folder, weight: FIELD_WEIGHTS.folder },
    { value: entry.id, weight: FIELD_WEIGHTS.id, anchored: true },
  ];
}

/** Status + recency bonus. Added only to entries that already matched, so it
 *  can reorder results but can never admit one. */
export function sessionBonus(entry: SessionEntry, now: number): number {
  let bonus = entry.active ? ACTIVE_BONUS : 0;
  const age = now - entry.activityAt;
  if (entry.activityAt > 0 && age >= 0) {
    for (const [window, points] of RECENCY_LADDER) {
      if (age < window) {
        bonus += points;
        break;
      }
    }
  }
  return bonus;
}

/** Score, rank and cap. Generic over the entry so callers can carry their own
 *  payload (the `SessionView`, the rendered folder name) through untouched.
 *
 *  Ordering is total and stable: score, then recency, then the caller's input
 *  order — so two sessions the query cannot tell apart never swap places
 *  between renders. */
export function rankSessions<E extends SessionEntry>(
  entries: readonly E[],
  query: string,
  options: { limit?: number; now?: number } = {},
): E[] {
  const limit = options.limit ?? MAX_SESSION_RESULTS;
  const now = options.now ?? Date.now();

  const scored: Array<{ entry: E; index: number; score: number }> = [];
  entries.forEach((entry, index) => {
    const base = scoreFields(entryFields(entry), query);
    if (base <= 0) return;
    scored.push({ entry, index, score: base + sessionBonus(entry, now) });
  });

  scored.sort((a, b) => b.score - a.score || b.entry.activityAt - a.entry.activityAt || a.index - b.index);
  return scored.slice(0, limit).map(s => s.entry);
}

/** The empty-query default: the sessions you are most plausibly coming back to.
 *
 *  Live work first, newest life-sign first within that, then finished sessions
 *  to top the list up — a fleet where everything has completed should still
 *  offer somewhere to go rather than an empty panel. */
export function recentSessions<E extends SessionEntry>(
  entries: readonly E[],
  limit: number = RECENT_SESSION_COUNT,
): E[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.activityAt - a.entry.activityAt || a.index - b.index);
  return [...ordered.filter(o => !o.entry.finished), ...ordered.filter(o => o.entry.finished)]
    .slice(0, limit)
    .map(o => o.entry);
}
