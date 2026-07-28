import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyticsCompletions, type AnalyticsCompletion } from '../lib/analytics-query-complete';
import {
  AnalyticsCompletionList,
  AnalyticsQueryAutocomplete,
  analyticsAutocompleteKeyAction,
  applyAnalyticsCompletion,
  createLabelValueCache,
  groupAnalyticsCompletions,
  nextAnalyticsCompletionIndex,
  type ValueCacheEntry,
} from './AnalyticsQueryAutocomplete';

const candidate = (label: string, group = 'Aggregations'): AnalyticsCompletion => ({
  id: `aggregation:${label}`,
  kind: 'aggregation',
  label,
  detail: `${label} detail`,
  replacement: `${label} `,
  group,
  rankPriority: 100,
});

const candidates = [candidate('sum'), candidate('avg'), candidate('model', 'Labels')];

function list(patch: Partial<Parameters<typeof AnalyticsCompletionList>[0]> = {}) {
  return renderToStaticMarkup(
    <AnalyticsCompletionList
      open
      status="ready"
      candidates={candidates}
      activeIndex={0}
      listboxId="analytics-list"
      contextLabel="Aggregation"
      onAccept={() => undefined}
      {...patch}
    />,
  );
}

/** The component's own view of the cache: only a READY entry is a value list;
 *  loading and error both mean "not fetched", never "no values exist". */
function valuesFrom(cache: { entry(label: string): ValueCacheEntry | undefined }, label: string) {
  const entry = cache.entry(label);
  return entry?.status === 'ready' ? entry.values : undefined;
}

/** Strip comments so a source assertion tests CODE, not the prose explaining
 *  which call was deliberately avoided. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('analytics autocomplete keyboard contract', () => {
  test('Enter accepts only while an open list has a selection, and otherwise runs', () => {
    expect(analyticsAutocompleteKeyAction('Enter', { open: true, count: 3, activeIndex: 1 })).toEqual({
      type: 'accept',
      index: 1,
    });
    expect(analyticsAutocompleteKeyAction('Enter', { open: false, count: 3, activeIndex: 1 })).toEqual({ type: 'run' });
    expect(analyticsAutocompleteKeyAction('Enter', { open: true, count: 0, activeIndex: -1 })).toEqual({ type: 'run' });
  });

  test('arrows navigate and wrap, Escape closes, and an IME owns its own keys', () => {
    expect(analyticsAutocompleteKeyAction('ArrowDown', { open: true, count: 3, activeIndex: 2 })).toEqual({
      type: 'navigate',
      index: 0,
    });
    expect(analyticsAutocompleteKeyAction('ArrowUp', { open: true, count: 3, activeIndex: -1 })).toEqual({
      type: 'navigate',
      index: 2,
    });
    expect(analyticsAutocompleteKeyAction('ArrowDown', { open: false, count: 3, activeIndex: 0 })).toEqual({
      type: 'ignore',
    });
    expect(analyticsAutocompleteKeyAction('Escape', { open: true, count: 3, activeIndex: 0 })).toEqual({
      type: 'close',
    });
    expect(analyticsAutocompleteKeyAction('Escape', { open: false, count: 0, activeIndex: -1 })).toEqual({
      type: 'ignore',
    });
    expect(analyticsAutocompleteKeyAction('Enter', { open: true, count: 3, activeIndex: 0, composing: true })).toEqual({
      type: 'ignore',
    });
    expect(analyticsAutocompleteKeyAction('a', { open: true, count: 3, activeIndex: 0 })).toEqual({ type: 'ignore' });
    expect(nextAnalyticsCompletionIndex(0, -1, 1)).toBe(-1);
  });

  test('accepting replaces exactly the completion range and leaves the caret after it', () => {
    expect(applyAnalyticsCompletion('sum by (mod)', { start: 8, end: 11 }, 'model')).toEqual({
      value: 'sum by (model)',
      selection: { start: 13, end: 13 },
    });
    // Ranges from a stale render can never write outside the current value.
    expect(applyAnalyticsCompletion('su', { start: 40, end: 90 }, 'sum ')).toEqual({
      value: 'susum ',
      selection: { start: 6, end: 6 },
    });
  });
});

describe('AnalyticsCompletionList', () => {
  test('is an active-descendant listbox whose rows never take focus', () => {
    const html = list();
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="analytics-list"');
    expect(html).toContain('role="option"');
    expect(html).toContain('id="analytics-list-option-0"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="analytics-list-group-0"');
    expect(html).toContain('min-h-[44px]');
    // Options are not focusable at all — the input keeps DOM focus, so a phone
    // keyboard stays open while the reader arrows through suggestions.
    expect(html).not.toContain('tabindex=');
    expect(groupAnalyticsCompletions(candidates).map(group => group.label)).toEqual(['Aggregations', 'Labels']);
  });

  test('states loading, emptiness and failure instead of rendering a blank list', () => {
    expect(list({ status: 'loading', candidates: [] })).toContain('Loading values');
    expect(list({ status: 'error', candidates: [], error: 'daemon offline' })).toContain('daemon offline');
    expect(list({ status: 'error', candidates: [], error: 'daemon offline' })).toContain('role="alert"');
    const empty = list({ candidates: [], notice: 'cwd values are unbounded; type an exact value or a glob.' });
    expect(empty).toContain('unbounded');
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain('role="listbox"');
    expect(list({ open: false })).toBe('');
  });
});

describe('label value cache', () => {
  test('a pending label fetches once and resolves into real value candidates', async () => {
    const asked: string[] = [];
    const snapshots: Array<ReadonlyMap<string, ValueCacheEntry>> = [];
    const cache = createLabelValueCache(
      async label => {
        asked.push(label);
        return ['completed', 'failed'];
      },
      snapshot => snapshots.push(snapshot),
    );

    const pending = analyticsCompletions('{status=', 8, { valuesFor: label => valuesFrom(cache, label) });
    expect(pending.pendingValueLabel).toBe('status');
    expect(pending.candidates).toEqual([]);

    // Two requests for the same label — the second must not refetch, and the
    // first must still be able to publish its result.
    await Promise.all([cache.request('status'), cache.request('status')]);
    expect(asked).toEqual(['status']);
    expect(cache.entry('status')).toEqual({ status: 'ready', values: ['completed', 'failed'] });
    expect(snapshots.map(snapshot => snapshot.get('status')?.status)).toEqual(['loading', 'ready']);

    const ready = analyticsCompletions('{status=', 8, { valuesFor: label => valuesFrom(cache, label) });
    expect(ready.pendingValueLabel).toBeUndefined();
    expect(ready.candidates.map(candidate => candidate.label)).toEqual(['completed', 'failed']);
  });

  test('a failed fetch is remembered as an error rather than retried forever', async () => {
    let calls = 0;
    const cache = createLabelValueCache(
      async () => {
        calls += 1;
        throw new Error('daemon offline');
      },
      () => undefined,
    );
    await cache.request('model');
    await cache.request('model');
    expect(calls).toBe(1);
    expect(cache.entry('model')).toEqual({ status: 'error', error: 'daemon offline' });
    // An errored label offers nothing rather than an empty "no values" claim.
    expect(analyticsCompletions('{model=', 7, { valuesFor: label => valuesFrom(cache, label) }).candidates).toEqual([]);
  });
});

describe('AnalyticsQueryAutocomplete', () => {
  test('renders a closed combobox until the reader is actually in the field', () => {
    const html = renderToStaticMarkup(
      <AnalyticsQueryAutocomplete
        value="sum by (model)"
        onValueChange={() => undefined}
        onRun={() => undefined}
        inputId="analytics-query"
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('id="analytics-query"');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('role="listbox"');
  });

  test('never moves DOM focus and never opens a second accept path', async () => {
    const source = codeOnly(await Bun.file(new URL('./AnalyticsQueryAutocomplete.tsx', import.meta.url)).text());
    expect(source).not.toContain('.focus(');
    expect(source).not.toContain('autoFocus');
    expect(source).not.toContain('onClick');
    expect(source).not.toContain('setTimeout');
    // Caret restoration is the ONLY selection side effect, and it happens after
    // the controlled value commits.
    expect(source).toContain('setSelectionRange');
  });
});
