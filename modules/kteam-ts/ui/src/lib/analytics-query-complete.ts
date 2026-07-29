// GRAMMAR-AWARE COMPLETION for the analytics query box.
//
// The query language is small and regular — `agg by (labels) {matchers}` — so
// the caret's meaning can be decided by scanning the text before it rather than
// by parsing a half-typed query the parser would reject anyway.
//
// The constants are IMPORTED, never copied: `ANALYTICS_AGGREGATIONS`,
// `ANALYTICS_LABELS` and `MAX_ANALYTICS_GROUP_LABELS` come from the same modules
// the server parses with, so a label added on the backend appears here and a
// suggestion can never drift into something the parser rejects.
//
// Ranking is `fieldScore` from lib/fuzzy — the app's one definition of "best
// match" — with a coarse kind priority in front of it: an aggregation is the
// first thing a query needs, `by` is the second, labels name the dimensions,
// operators are punctuation, and values are the long tail.

import { MAX_ANALYTICS_GROUP_LABELS } from '../../../src/analytics-query';
import { ANALYTICS_AGGREGATIONS, ANALYTICS_LABELS } from '../../../src/analytics-types';
import { fieldScore } from './fuzzy';

export type AnalyticsCompletionKind = 'aggregation' | 'keyword' | 'label' | 'operator' | 'value';

/** What the caret is sitting in. `clause` is the gap after an aggregation,
 *  where the query can only continue with `by (…)` or a `{…}` filter. */
export type AnalyticsCompletionContext =
  | 'aggregation'
  | 'clause'
  | 'grouping-label'
  | 'matcher-label'
  | 'matcher-value';

export interface AnalyticsCompletion {
  id: string;
  kind: AnalyticsCompletionKind;
  label: string;
  detail?: string;
  /** Complete replacement for `replaceRange`, including any punctuation. */
  replacement: string;
  /** Visual section inside the listbox. */
  group: string;
  /** Coarse source priority, applied before the fuzzy score. */
  rankPriority: number;
}

/** Kind priority. Aggregations first, then `by`, then real labels, then
 *  operators, then values — the order in which a query is actually written. */
export const ANALYTICS_COMPLETION_PRIORITY: Record<AnalyticsCompletionKind, number> = {
  aggregation: 100,
  keyword: 80,
  label: 60,
  operator: 40,
  value: 20,
};

/** A popover, not a directory listing. Twelve rows is ~530px of content. */
export const MAX_ANALYTICS_COMPLETIONS = 12;

/** Labels whose value set is small enough to enumerate from one cached
 *  `count by (<label>)` call. `id`, `cwd`, `repo` and `parent` are unbounded and
 *  are deliberately never fetched. */
export const ANALYTICS_VALUE_LABELS = [
  'wrapper',
  'binary',
  'model',
  'context_window',
  'harness',
  'mode',
  'status',
  'label',
  'token_data',
  'day',
  'week',
] as const;

export interface AnalyticsTreeSuggestion {
  id: string;
  detail?: string;
}

export interface AnalyticsCompletionSources {
  /** Cached low-cardinality values. `undefined` means "not fetched yet" and is
   *  reported back as `pendingValueLabel` rather than rendered as "none". */
  valuesFor?(label: string): readonly string[] | undefined;
  /** Client-side ids worth offering to `tree=` — the focused session and its
   *  resolved lineage root. Never fetched. */
  treeIds?: readonly AnalyticsTreeSuggestion[];
}

export interface AnalyticsCompletionResult {
  context: AnalyticsCompletionContext;
  /** The text being replaced, as typed. */
  token: string;
  replaceRange: { start: number; end: number };
  candidates: AnalyticsCompletion[];
  /** Set when the caret wants values for a label nothing has fetched yet. */
  pendingValueLabel?: string;
  /** Honest explanation when the context legitimately offers nothing. */
  notice?: string;
}

const labelSet = new Set<string>(ANALYTICS_LABELS);
const valueLabelSet = new Set<string>(ANALYTICS_VALUE_LABELS);

/** Everything a bare (unquoted) analytics token may contain. Deliberately wider
 *  than a label name so a half-typed value like `claude-auto-*` is one token. */
const TOKEN_CHAR = /[A-Za-z0-9_.:@+*?/-]/;

const LABEL_DETAIL: Partial<Record<string, string>> = {
  id: 'exact session id',
  wrapper: 'CLI account (alias: binary)',
  binary: 'CLI account (alias of wrapper)',
  model: 'model reported by the harness',
  context_window: 'selected/reported context window in tokens',
  harness: 'claude or codex',
  mode: 'auto, interactive, …',
  status: 'completed, failed, running, …',
  label: 'batch label',
  cwd: 'working directory',
  repo: 'working directory (alias of cwd)',
  parent: 'immediate parent session',
  tree: 'whole lineage subtree',
  day: 'UTC day bucket',
  week: 'UTC week bucket',
  token_data: 'whether token counters are complete',
};

const AGGREGATION_DETAIL: Record<string, string> = {
  sum: 'total across the group',
  avg: 'mean per session',
  min: 'smallest in the group',
  max: 'largest in the group',
  count: 'sessions only, no measures',
};

/** The parser's own quoting rule, so an accepted value re-parses unchanged. */
export function quoteAnalyticsValue(value: string): string {
  return /^[A-Za-z0-9_./:@+*?-]+$/.test(value) ? value : JSON.stringify(value);
}

interface Scan {
  /** Index of the innermost unclosed `{`, or -1. */
  braceOpen: number;
  /** Index of the innermost unclosed `(`, or -1. */
  parenOpen: number;
  /** Index of the last separator (`,`) that starts the current segment, or -1. */
  lastComma: number;
  /** An open quote makes the caret part of a literal value. */
  quoted: boolean;
}

/** Single left-to-right pass. Quotes are honoured so a comma inside a quoted
 *  value never looks like a matcher separator. */
function scanBefore(before: string): Scan {
  let braceOpen = -1;
  let parenOpen = -1;
  let lastComma = -1;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < before.length; index += 1) {
    const char = before[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== undefined) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') {
      braceOpen = index;
      lastComma = -1;
    } else if (char === '}') braceOpen = -1;
    else if (char === '(') {
      parenOpen = index;
      lastComma = -1;
    } else if (char === ')') parenOpen = -1;
    else if (char === ',') lastComma = index;
  }
  return { braceOpen, parenOpen, lastComma, quoted: quote !== undefined };
}

function tokenRange(text: string, caret: number, floor: number): { start: number; end: number } {
  let start = caret;
  while (start > floor && TOKEN_CHAR.test(text[start - 1]!)) start -= 1;
  let end = caret;
  while (end < text.length && TOKEN_CHAR.test(text[end]!)) end += 1;
  return { start, end };
}

function completion(
  kind: AnalyticsCompletionKind,
  label: string,
  replacement: string,
  group: string,
  detail?: string,
): AnalyticsCompletion {
  return {
    id: `${kind}:${label}`,
    kind,
    label,
    detail,
    replacement,
    group,
    rankPriority: ANALYTICS_COMPLETION_PRIORITY[kind],
  };
}

function score(candidate: AnalyticsCompletion, query: string): number {
  if (!query) return 1;
  const name = fieldScore(candidate.label, query);
  const supporting = fieldScore(candidate.detail ?? '', query);
  if (!name && !supporting) return 0;
  // The name of the thing dominates the sentence describing it.
  return name * 3 + supporting;
}

/** Filter, rank and cap. Kind priority is coarse and always wins, so no amount
 *  of fuzzy score can push a value above the aggregation the query still needs. */
export function rankAnalyticsCompletions(
  candidates: readonly AnalyticsCompletion[],
  query: string,
  limit = MAX_ANALYTICS_COMPLETIONS,
): AnalyticsCompletion[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, value: score(candidate, query) }))
    .filter(item => item.value > 0)
    .sort((a, b) => b.candidate.rankPriority - a.candidate.rankPriority || b.value - a.value || a.index - b.index)
    .slice(0, limit)
    .map(item => item.candidate);
}

function aggregationCandidates(): AnalyticsCompletion[] {
  return ANALYTICS_AGGREGATIONS.map(name =>
    completion('aggregation', name, `${name} `, 'Aggregations', AGGREGATION_DETAIL[name]),
  );
}

function labelCandidates(
  group: string,
  suffix: (label: string) => string,
  exclude: ReadonlySet<string> = new Set(),
): AnalyticsCompletion[] {
  return ANALYTICS_LABELS.filter(label => !exclude.has(label)).map(label =>
    completion('label', label, suffix(label), group, LABEL_DETAIL[label]),
  );
}

/** Values for a label, or the pending marker when nothing has fetched them. */
function valueCandidates(
  label: string,
  sources: AnalyticsCompletionSources,
): { candidates: AnalyticsCompletion[]; pending?: string; notice?: string } {
  if (label === 'tree') {
    const ids = sources.treeIds ?? [];
    if (!ids.length) return { candidates: [], notice: 'tree filters take one exact session id.' };
    return {
      candidates: ids.map(entry =>
        completion('value', entry.id, quoteAnalyticsValue(entry.id), 'Sessions', entry.detail),
      ),
    };
  }
  if (!valueLabelSet.has(label))
    return { candidates: [], notice: `${label} values are unbounded; type an exact value or a glob.` };
  const values = sources.valuesFor?.(label);
  if (values === undefined) return { candidates: [], pending: label };
  return {
    candidates: values.map(value => completion('value', value, quoteAnalyticsValue(value), 'Values')),
  };
}

/** Classify the caret and return the ranked suggestions for it.
 *
 *  Pure: every fact about the fleet arrives through `sources`, so this is table
 *  testable and the component owns caching and fetching. */
export function analyticsCompletions(
  text: string,
  caret: number,
  sources: AnalyticsCompletionSources = {},
): AnalyticsCompletionResult {
  const position = Math.max(0, Math.min(text.length, Math.trunc(caret)));
  const before = text.slice(0, position);
  const scan = scanBefore(before);

  // Inside a quoted literal the caret is in free text the grammar does not
  // constrain. Offering identifiers there would insert a nested quote.
  if (scan.quoted) {
    return {
      context: 'matcher-value',
      token: '',
      replaceRange: { start: position, end: position },
      candidates: [],
      notice: 'Close the quote to continue.',
    };
  }

  if (scan.braceOpen >= 0) {
    const segmentStart = Math.max(scan.braceOpen, scan.lastComma) + 1;
    const segment = before.slice(segmentStart);
    const operator = segment.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)(=~|=)(\s*)/);
    if (operator) {
      const label = operator[2]!;
      const range = tokenRange(text, position, segmentStart + operator[0].length);
      // `tree` takes ONE exact id: a subtree-of-every-match is expensive and
      // ambiguous, so the server rejects `tree=~`. Suggesting ids into a matcher
      // the parser will refuse would send the reader to a red error instead of a
      // result, so this context says what is wrong instead.
      if (label === 'tree' && operator[4] === '=~') {
        return {
          context: 'matcher-value',
          token: text.slice(range.start, position),
          replaceRange: range,
          candidates: [],
          notice: 'tree filters take one exact session id — use tree= instead of tree=~.',
        };
      }
      const { candidates, pending, notice } = valueCandidates(label, sources);
      return {
        context: 'matcher-value',
        token: text.slice(range.start, position),
        replaceRange: range,
        candidates: rankAnalyticsCompletions(candidates, text.slice(range.start, position)),
        pendingValueLabel: pending,
        notice,
      };
    }
    const range = tokenRange(text, position, segmentStart);
    const token = text.slice(range.start, position);
    // A complete label is offered with its operators attached, so the reader
    // never has to know that `=~` exists to use it — except on `tree`, which
    // only ever accepts one exact id.
    const operators = labelSet.has(token)
      ? [
          completion('operator', `${token}=`, `${token}=`, 'Operators', 'exact match'),
          ...(token === 'tree'
            ? []
            : [completion('operator', `${token}=~`, `${token}=~`, 'Operators', 'case-insensitive glob')]),
        ]
      : [];
    return {
      context: 'matcher-label',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions([...labelCandidates('Labels', label => `${label}=`), ...operators], token),
    };
  }

  if (scan.parenOpen >= 0 && /\bby\s*$/i.test(before.slice(0, scan.parenOpen))) {
    const segmentStart = Math.max(scan.parenOpen, scan.lastComma) + 1;
    const range = tokenRange(text, position, segmentStart);
    const token = text.slice(range.start, position);
    const listed = before
      .slice(scan.parenOpen + 1)
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    // The label under the caret is not yet "used"; everything else in the
    // parentheses is, and the parser rejects both duplicates and a fifth label.
    const used = new Set(token ? listed.slice(0, -1) : listed);
    if (used.size >= MAX_ANALYTICS_GROUP_LABELS) {
      return {
        context: 'grouping-label',
        token,
        replaceRange: range,
        candidates: [],
        notice: `at most ${MAX_ANALYTICS_GROUP_LABELS} grouping labels are allowed`,
      };
    }
    return {
      context: 'grouping-label',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions(
        labelCandidates('Group by', label => label, used),
        token,
      ),
    };
  }

  const range = tokenRange(text, position, 0);
  const token = text.slice(range.start, position);
  const head = before.slice(0, range.start).match(/^\s*([A-Za-z]+)\b/);
  const aggregation = head && (ANALYTICS_AGGREGATIONS as readonly string[]).includes(head[1]!.toLowerCase());
  if (!aggregation) {
    return {
      context: 'aggregation',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions(
        [
          ...aggregationCandidates(),
          completion('keyword', '{', '{', 'Filters', 'raw rows for a filter'),
          ...labelCandidates('Filters', label => `{${label}=`),
        ],
        token,
      ),
    };
  }
  const grouped = /\bby\s*\(/i.test(before);
  return {
    context: 'clause',
    token,
    replaceRange: range,
    candidates: rankAnalyticsCompletions(
      [
        ...(grouped ? [] : [completion('keyword', 'by', 'by (', 'Grouping', 'group the result by labels')]),
        completion('keyword', '{', '{', 'Filters', 'restrict the matched sessions'),
        ...labelCandidates('Filters', label => `{${label}=`),
      ],
      token,
    ),
  };
}
