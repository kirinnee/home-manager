import { describe, expect, test } from 'bun:test';
import { MAX_ANALYTICS_GROUP_LABELS } from '../../../src/analytics-query';
import { ANALYTICS_AGGREGATIONS } from '../../../src/analytics-types';
import {
  analyticsCompletions,
  quoteAnalyticsValue,
  rankAnalyticsCompletions,
  type AnalyticsCompletion,
} from './analytics-query-complete';

const labels = (result: { candidates: AnalyticsCompletion[] }) => result.candidates.map(candidate => candidate.label);

describe('analyticsCompletions', () => {
  test('offers every aggregation first, before keywords, labels and values', () => {
    const empty = analyticsCompletions('', 0);
    expect(empty.context).toBe('aggregation');
    expect(labels(empty).slice(0, ANALYTICS_AGGREGATIONS.length)).toEqual([...ANALYTICS_AGGREGATIONS]);
    // Kind priority is coarse and absolute: a label that fuzzy-matches better
    // than an aggregation still ranks below it.
    const typed = analyticsCompletions('m', 1);
    expect(typed.candidates[0]?.kind).toBe('aggregation');
    expect(labels(typed).slice(0, 2)).toEqual(['min', 'max']);
    expect(labels(typed)).toContain('model');
    expect(typed.candidates.find(candidate => candidate.label === 'model')?.replacement).toBe('{model=');
  });

  test('completes a partial aggregation over exactly its own token', () => {
    const result = analyticsCompletions('su', 2);
    expect(result.candidates[0]).toMatchObject({ label: 'sum', replacement: 'sum ' });
    expect(result.replaceRange).toEqual({ start: 0, end: 2 });
    // The caret inside a complete word still replaces the whole word.
    expect(analyticsCompletions('summary', 3).replaceRange).toEqual({ start: 0, end: 7 });
  });

  test('offers by and a filter once an aggregation exists, and drops by afterwards', () => {
    const clause = analyticsCompletions('sum ', 4);
    expect(clause.context).toBe('clause');
    expect(labels(clause).slice(0, 2)).toEqual(['by', '{']);
    expect(clause.candidates[0]?.replacement).toBe('by (');
    expect(labels(analyticsCompletions('sum by (model) ', 15))).not.toContain('by');
  });

  test('groups by real labels, excludes duplicates, and stops at the parser cap', () => {
    const open = analyticsCompletions('sum by (', 8);
    expect(open.context).toBe('grouping-label');
    expect(labels(open)).toContain('model');
    expect(open.candidates[0]?.replacement).toBe('id');

    const second = analyticsCompletions('sum by (model, ', 15);
    expect(labels(second)).not.toContain('model');
    expect(labels(second)).toContain('wrapper');

    const full = 'sum by (model, wrapper, status, mode, ';
    const capped = analyticsCompletions(full, full.length);
    expect(capped.candidates).toEqual([]);
    expect(capped.notice).toBe(`at most ${MAX_ANALYTICS_GROUP_LABELS} grouping labels are allowed`);
  });

  test('completes filter labels and attaches both operators to a complete one', () => {
    const partial = analyticsCompletions('sum by (model) {wr', 18);
    expect(partial.context).toBe('matcher-label');
    expect(partial.candidates[0]).toMatchObject({ label: 'wrapper', replacement: 'wrapper=' });
    expect(partial.replaceRange).toEqual({ start: 16, end: 18 });

    const complete = analyticsCompletions('{wrapper', 8);
    const operators = complete.candidates.filter(candidate => candidate.kind === 'operator');
    expect(operators.map(candidate => candidate.replacement)).toEqual(['wrapper=', 'wrapper=~']);
    // Labels still outrank the operators, so the list never reorders itself
    // under the caret when a longer label is what the reader meant.
    expect(complete.candidates[0]?.kind).toBe('label');
  });

  test('serves cached low-cardinality values and reports an unfetched label as pending', () => {
    const cached = analyticsCompletions('sum by (model) {status=', 23, {
      valuesFor: label => (label === 'status' ? ['completed', 'failed'] : undefined),
    });
    expect(cached.context).toBe('matcher-value');
    expect(labels(cached)).toEqual(['completed', 'failed']);
    expect(cached.pendingValueLabel).toBeUndefined();

    const pending = analyticsCompletions('{status=', 8);
    expect(pending.candidates).toEqual([]);
    expect(pending.pendingValueLabel).toBe('status');

    const filtered = analyticsCompletions('{status=fai', 11, { valuesFor: () => ['completed', 'failed'] });
    expect(labels(filtered)).toEqual(['failed']);
    expect(filtered.replaceRange).toEqual({ start: 8, end: 11 });
  });

  test('never fetches an unbounded label and never guesses inside a quote', () => {
    const unbounded = analyticsCompletions('{cwd=', 5);
    expect(unbounded.candidates).toEqual([]);
    expect(unbounded.pendingValueLabel).toBeUndefined();
    expect(unbounded.notice).toContain('unbounded');

    const quoted = analyticsCompletions('{label="ui build', 16);
    expect(quoted.candidates).toEqual([]);
    expect(quoted.notice).toBe('Close the quote to continue.');
    // A comma inside a closed quote is not a matcher separator.
    const afterQuoted = analyticsCompletions('{label="a,b", wr', 16);
    expect(afterQuoted.context).toBe('matcher-label');
    expect(afterQuoted.candidates[0]?.label).toBe('wrapper');
  });

  test('offers client-side ids for tree, and quotes values the parser would reject bare', () => {
    const tree = analyticsCompletions('sum {tree=', 10, {
      treeIds: [{ id: 'ms52w0d0-7a627875', detail: 'resolved lineage root' }],
    });
    expect(tree.candidates).toHaveLength(1);
    expect(tree.candidates[0]).toMatchObject({ label: 'ms52w0d0-7a627875', replacement: 'ms52w0d0-7a627875' });
    expect(analyticsCompletions('sum {tree=', 10).notice).toContain('one exact session id');

    // `tree` is exact-only on the server. Neither the operator list nor the
    // value list may lead the reader into a matcher the parser rejects.
    const treeLabel = analyticsCompletions('{tree', 5);
    expect(treeLabel.candidates.filter(candidate => candidate.kind === 'operator').map(c => c.replacement)).toEqual([
      'tree=',
    ]);
    const glob = analyticsCompletions('sum {tree=~ms52', 15, { treeIds: [{ id: 'ms52w0d0-7a627875' }] });
    expect(glob.candidates).toEqual([]);
    expect(glob.notice).toBe('tree filters take one exact session id — use tree= instead of tree=~.');
    expect(analyticsCompletions('{wrapper', 8).candidates.filter(c => c.kind === 'operator')).toHaveLength(2);
    expect(quoteAnalyticsValue('ui build')).toBe('"ui build"');
    expect(quoteAnalyticsValue('claude-auto-*')).toBe('claude-auto-*');
  });

  test('ranks by kind before fuzzy score and caps the popover', () => {
    const candidates: AnalyticsCompletion[] = [
      { id: 'v', kind: 'value', label: 'model', replacement: 'model', group: 'Values', rankPriority: 20 },
      { id: 'a', kind: 'aggregation', label: 'max', replacement: 'max ', group: 'Aggregations', rankPriority: 100 },
    ];
    expect(rankAnalyticsCompletions(candidates, 'm').map(candidate => candidate.id)).toEqual(['a', 'v']);
    expect(rankAnalyticsCompletions(candidates, 'zzz')).toEqual([]);
    expect(rankAnalyticsCompletions(candidates, '', 1)).toHaveLength(1);
  });
});
