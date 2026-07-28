import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsAggregateResponse, AnalyticsMeasure } from '../../../src/analytics-types';
import { EQUIVALENT_API_COST_CAVEAT, PRICING_REGISTRY_VERIFIED_AT } from '../lib/model-cost';
import {
  ANALYTICS_TABLE_COLUMNS,
  AnalyticsResultTable,
  analyticsColumnsFor,
  analyticsTableRows,
  defaultAnalyticsSort,
  resolveAnalyticsSort,
  analyticsTotalRow,
  coverageNote,
  equivalentCostFootnote,
  formatEquivalentCost,
  formatUsdMicros,
  pricingVerifiedAt,
  sortAnalyticsRows,
} from './AnalyticsResultTable';

const measure = (value: number | null, known = 1, total = 1): AnalyticsMeasure => ({ value, known, total });

function group(name: string, tokens: number, cost: number | null, sessions = 1) {
  return {
    labels: { model: name },
    sessions,
    rates: { stall: 0, failure: 0, completion: 1 },
    tokens: measure(tokens, sessions, sessions),
    inputTokens: measure(tokens * 0.6, sessions, sessions),
    outputTokens: measure(tokens * 0.4, sessions, sessions),
    cachedInputTokens: measure(tokens * 0.3, sessions, sessions),
    cacheWriteInputTokens: measure(tokens * 0.1, sessions, sessions),
    ...(cost === null ? {} : { equivalentApiCostUsdMicros: measure(cost, sessions, sessions) }),
  };
}

function response(results: unknown[], aggregation = 'sum'): AnalyticsAggregateResponse {
  return {
    kind: 'aggregate',
    aggregation,
    query: 'sum by (model)',
    results,
  } as unknown as AnalyticsAggregateResponse;
}

const mixed = response([
  group('claude-sonnet-5', 1_000, 2_000_000),
  group('some-unpriced-model', 5_000_000, null),
  group('claude-opus-5', 2_000, 9_000_000),
]);

describe('AnalyticsResultTable', () => {
  test('sorts by equivalent cost descending by default and keeps unknown rows last', () => {
    const rows = analyticsTableRows(mixed);
    expect(sortAnalyticsRows(rows, 'cost', 'desc').map(row => row.group)).toEqual([
      'model=claude-opus-5',
      'model=claude-sonnet-5',
      'model=some-unpriced-model',
    ]);
    // Ascending puts the cheapest KNOWN row first; an unknown price is not a
    // small number, so it never leads either order.
    expect(sortAnalyticsRows(rows, 'cost', 'asc').map(row => row.group)).toEqual([
      'model=claude-sonnet-5',
      'model=claude-opus-5',
      'model=some-unpriced-model',
    ]);
    const html = renderToStaticMarkup(<AnalyticsResultTable response={mixed} />);
    expect(html.indexOf('claude-opus-5')).toBeLessThan(html.indexOf('claude-sonnet-5'));
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('Equivalent API cost: sort ascending');
  });

  test('an unpriced model keeps every token value and says the cost is unknown', () => {
    const unpriced = analyticsTableRows(mixed).find(row => row.group === 'model=some-unpriced-model')!;
    expect(unpriced.total.value).toBe(5_000_000);
    expect(unpriced.cost).toEqual({ value: null, known: 0, total: 1 });
    expect(formatEquivalentCost(unpriced.cost)).toBe('Cost unknown');

    const html = renderToStaticMarkup(<AnalyticsResultTable response={mixed} />);
    expect(html).toContain('Cost unknown');
    expect(html).toContain('5,000,000');
    // The row is present, not dropped, and no rate was substituted.
    expect(html).toContain('some-unpriced-model');
    expect(html).not.toContain('$0.00');
  });

  test('a partially known measure renders as unknown with its known/total coverage', () => {
    expect(coverageNote(measure(null, 2, 5))).toBe('2/5');
    expect(coverageNote(measure(7, 5, 5))).toBeUndefined();
    const partial = response([
      group('claude-opus-5', 10, 5),
      { ...group('mixed', 10, null), tokens: measure(null, 2, 5) },
    ]);
    expect(renderToStaticMarkup(<AnalyticsResultTable response={partial} />)).toContain('[2/5]');
  });

  test('confines horizontal overflow to its own container', () => {
    const html = renderToStaticMarkup(<AnalyticsResultTable response={mixed} />);
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('overscroll-x-contain');
    expect(html).toContain('max-w-full');
    // BOTH the component root and its scroller: the root is a grid item in the
    // cost panel, and min-width:auto there would propagate the table's
    // min-content width straight past the scroller.
    expect(html.startsWith('<div class="grid min-w-0 gap-2">')).toBe(true);
    expect(html.match(/min-w-0/g)?.length).toBeGreaterThanOrEqual(2);
    // A table narrower than its columns would wrap into unreadable mush, so the
    // min-width lives on the TABLE and the scroller is its parent.
    expect(html).toContain('min-w-[44rem]');
    expect(html).toContain('min-h-[44px]');
  });

  test('rolls a sum up strictly: one unknown group makes the total unknown', () => {
    const known = analyticsTotalRow(analyticsTableRows(response([group('a', 10, 5), group('b', 20, 7)])));
    expect(known.total.value).toBe(30);
    expect(known.cost.value).toBe(12);
    expect(known.sessions).toBe(2);

    const strict = analyticsTotalRow(analyticsTableRows(mixed));
    expect(strict.cost).toEqual({ value: null, known: 2, total: 3 });
    expect(strict.total.value).toBe(5_003_000);

    const html = renderToStaticMarkup(<AnalyticsResultTable response={mixed} />);
    expect(html).toContain('<tfoot>');
    expect(html).toContain('Total');
    // An average of averages is not a total, so avg results get no roll-up row.
    expect(renderToStaticMarkup(<AnalyticsResultTable response={response(mixed.results, 'avg')} />)).not.toContain(
      '<tfoot>',
    );
  });

  test('keeps a count result readable: the two columns it actually answers', () => {
    expect(analyticsColumnsFor('count').map(column => column.key)).toEqual(['group', 'sessions']);
    expect(analyticsColumnsFor('sum')).toEqual(ANALYTICS_TABLE_COLUMNS);
    expect(defaultAnalyticsSort('count')).toEqual({ key: 'sessions', direction: 'desc' });
    expect(defaultAnalyticsSort('sum')).toEqual({ key: 'cost', direction: 'desc' });

    // count asks the server for no measures at all, so six columns of em dashes
    // and a cost nobody computed would be noise, not honesty.
    const counted = response(
      [
        { ...group('claude-opus-5', 0, null), sessions: 4 },
        { ...group('claude-fable-5', 0, null), sessions: 9 },
      ],
      'count',
    );
    const html = renderToStaticMarkup(<AnalyticsResultTable response={counted} />);
    expect(html).not.toContain('Equivalent API cost');
    expect(html).not.toContain('Cost unknown');
    expect(html).toContain('Sessions');
    expect(html.indexOf('claude-fable-5')).toBeLessThan(html.indexOf('claude-opus-5'));
  });

  test('a sort chosen on one response can never name a column the next one lacks', () => {
    const sumColumns = analyticsColumnsFor('sum');
    const countColumns = analyticsColumnsFor('count');
    const chosen = { key: 'cost', direction: 'asc' } as const;
    // Kept while its column is on screen…
    expect(resolveAnalyticsSort(chosen, sumColumns, 'sum')).toEqual(chosen);
    // …and dropped for the current aggregation's default the moment it is not,
    // so no invisible column can sort the rows or caption the table.
    expect(resolveAnalyticsSort(chosen, countColumns, 'count')).toEqual({ key: 'sessions', direction: 'desc' });
    expect(resolveAnalyticsSort(null, sumColumns, 'sum')).toEqual({ key: 'cost', direction: 'desc' });

    // The same mounted table, re-rendered with a count response: the caption
    // names a real header and exactly one header carries aria-sort.
    const counted = response([{ ...group('claude-opus-5', 0, null), sessions: 4 }], 'count');
    const html = renderToStaticMarkup(<AnalyticsResultTable response={counted} />);
    expect(html).toContain('Sorted by Sessions descending');
    expect(html).not.toContain('Sorted by  ');
    expect(html.match(/aria-sort="(descending|ascending)"/g)).toHaveLength(1);
  });

  test('names the money honestly and dates the rates it used', () => {
    // The date comes from the SHARED registry constant, not a private copy.
    expect(pricingVerifiedAt()).toBe(PRICING_REGISTRY_VERIFIED_AT);
    expect(pricingVerifiedAt()).toBe('2026-07-28');
    const footnote = equivalentCostFootnote();
    expect(footnote).toContain(EQUIVALENT_API_COST_CAVEAT);
    expect(footnote).toContain('Equivalent API cost is what this usage would cost at public API rates');
    expect(footnote).toContain('a comparison, not a bill');
    expect(footnote).toContain('not a claim about how any session was billed');
    // Gross input is a reading trap if it is only a tooltip on the header.
    expect(footnote).toContain('Input is gross: it includes cache reads and cache writes');
    expect(footnote).toContain('Rates verified 2026-07-28');
    expect(renderToStaticMarkup(<AnalyticsResultTable response={mixed} />)).toContain(
      'includes cache reads and cache writes',
    );
    const html = renderToStaticMarkup(<AnalyticsResultTable response={mixed} />);
    expect(html).toContain('Equivalent API cost');
    expect(html.toLowerCase()).not.toContain('spend');
    expect(html.toLowerCase()).not.toContain('you paid');
  });

  test('formats money exactly and never renders an empty result as zero', () => {
    expect(formatUsdMicros(9_007_199_254_740_993n)).toBe('$9,007,199,254.740993');
    expect(formatEquivalentCost(measure(2_000_000))).toBe('$2.00');
    expect(renderToStaticMarkup(<AnalyticsResultTable response={response([])} />)).toContain('No groups matched');
  });
});
