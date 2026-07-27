import {
  ANALYTICS_AGGREGATIONS,
  ANALYTICS_LABELS,
  type AnalyticsAggregation,
  type AnalyticsLabel,
  type AnalyticsMatcher,
  type ParsedAnalyticsQuery,
} from './analytics-types';

export const DEFAULT_ANALYTICS_QUERY = 'count by (status)';
export const MAX_ANALYTICS_QUERY_CHARS = 2_048;
export const MAX_ANALYTICS_GROUP_LABELS = 4;

const aggregations = new Set<string>(ANALYTICS_AGGREGATIONS);
const labels = new Set<string>(ANALYTICS_LABELS);

export class AnalyticsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsQueryError';
  }
}

function splitMatchers(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== undefined) {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote === char) quote = undefined;
      else if (quote === undefined && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*(?:=~|=)\s*$/.test(source.slice(start, index)))
        quote = char;
      continue;
    }
    if (char === ',' && quote === undefined) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (quote !== undefined) throw new AnalyticsQueryError('unterminated quoted filter value');
  parts.push(source.slice(start));
  return parts;
}

function parseValue(source: string): string {
  const value = source.trim();
  if (!value) throw new AnalyticsQueryError('filter values may not be empty');
  const first = value[0];
  if (first !== '"' && first !== "'") return value;
  if (value.at(-1) !== first) throw new AnalyticsQueryError('unterminated quoted filter value');
  let result = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char !== '\\') {
      result += char;
      continue;
    }
    index += 1;
    if (index >= value.length - 1) throw new AnalyticsQueryError('unterminated escape in filter value');
    const escaped = value[index]!;
    result += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
  }
  return result;
}

function parseMatchers(source: string): AnalyticsMatcher[] {
  if (!source.trim()) return [];
  return splitMatchers(source).flatMap(raw => {
    const part = raw.trim();
    if (!part) return [];
    const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(=~|=)\s*(.+)$/s);
    if (!match) throw new AnalyticsQueryError(`could not parse filter matcher ${JSON.stringify(part)}`);
    const label = match[1]!;
    if (!labels.has(label))
      throw new AnalyticsQueryError(
        `unknown analytics label ${JSON.stringify(label)} (choose ${ANALYTICS_LABELS.join(', ')})`,
      );
    const op = match[2] as '=' | '=~';
    const value = parseValue(match[3]!);
    return [{ label: label as AnalyticsLabel, op, value, wildcard: op === '=~' || /[*?]/.test(value) }];
  });
}

function quoteValue(value: string): string {
  return /^[A-Za-z0-9_./:@+*?-]+$/.test(value) ? value : JSON.stringify(value);
}

function canonical(parsed: Omit<ParsedAnalyticsQuery, 'source' | 'canonical'>): string {
  const aggregation = parsed.aggregation ?? '';
  const grouping = parsed.groupBy.length ? ` by (${parsed.groupBy.join(', ')})` : '';
  const filters = parsed.matchers.length
    ? ` {${parsed.matchers.map(matcher => `${matcher.label}${matcher.op}${quoteValue(matcher.value)}`).join(', ')}}`
    : '';
  return `${aggregation}${grouping}${filters}`.trim();
}

/**
 * Parse the deliberately small kloop-compatible surface:
 *
 *   count by (status)
 *   avg by (model, harness) {label=ui-*, status=completed}
 *   {wrapper=~claude-auto-*}          # bounded raw rows
 */
export function parseAnalyticsQuery(input?: string): ParsedAnalyticsQuery {
  const source = (input ?? '').trim() || DEFAULT_ANALYTICS_QUERY;
  if (source.length > MAX_ANALYTICS_QUERY_CHARS)
    throw new AnalyticsQueryError(`analytics query exceeds ${MAX_ANALYTICS_QUERY_CHARS} characters`);

  let rest = source;
  let aggregation: AnalyticsAggregation | undefined;
  const operation = rest.match(/^([A-Za-z]+)\b/);
  if (operation && aggregations.has(operation[1]!.toLowerCase())) {
    aggregation = operation[1]!.toLowerCase() as AnalyticsAggregation;
    rest = rest.slice(operation[0].length).trim();
  }

  const groupBy: AnalyticsLabel[] = [];
  if (/^by\b/i.test(rest)) {
    if (!aggregation) throw new AnalyticsQueryError('by (...) requires an aggregation');
    const grouping = rest.match(/^by\s*\(\s*([^)]*)\s*\)\s*/i);
    if (!grouping) throw new AnalyticsQueryError('grouping must look like by (model, status)');
    for (const raw of grouping[1]!.split(',')) {
      const label = raw.trim();
      if (!label) continue;
      if (!labels.has(label))
        throw new AnalyticsQueryError(
          `unknown analytics label ${JSON.stringify(label)} (choose ${ANALYTICS_LABELS.join(', ')})`,
        );
      if (groupBy.includes(label as AnalyticsLabel))
        throw new AnalyticsQueryError(`duplicate grouping label ${JSON.stringify(label)}`);
      groupBy.push(label as AnalyticsLabel);
    }
    if (!groupBy.length) throw new AnalyticsQueryError('by (...) needs at least one label');
    if (groupBy.length > MAX_ANALYTICS_GROUP_LABELS)
      throw new AnalyticsQueryError(`at most ${MAX_ANALYTICS_GROUP_LABELS} grouping labels are allowed`);
    rest = rest.slice(grouping[0].length).trim();
  }

  let matchers: AnalyticsMatcher[] = [];
  if (rest) {
    if (!(rest.startsWith('{') && rest.endsWith('}')))
      throw new AnalyticsQueryError(`unexpected analytics query suffix ${JSON.stringify(rest)}`);
    matchers = parseMatchers(rest.slice(1, -1));
  }

  const partial = { aggregation, groupBy, matchers };
  return { source, canonical: canonical(partial), ...partial };
}

/** SQL LIKE pattern for kloop's case-insensitive glob semantics. */
export function matcherLikePattern(value: string): string {
  let result = '';
  for (const char of value) {
    if (char === '*') result += '%';
    else if (char === '?') result += '_';
    else if (char === '%' || char === '_' || char === '\\') result += `\\${char}`;
    else result += char;
  }
  return result;
}
