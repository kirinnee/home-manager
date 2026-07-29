import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import type { SessionGroup } from '../lib/grouping';
import {
  DENSITY_COLUMN_LABELS,
  LeanDensityGroups,
  LeanSessionCard,
  LeanSessionRow,
  groupHueVar,
  groupHueVars,
  hoistedStatus,
  statusWord,
} from './SessionsListPage';

const view = {
  config: {
    id: 'secret-session-id',
    teammate: 'Ada',
    name: 'Fix parser',
    label: 'private-label',
    model: 'private-model',
    mode: 'auto',
    harness: 'codex',
  },
  state: {
    status: 'running',
    waiting: { condition: 'external condition' },
    needsHuman: 'needs a decision',
  },
} as unknown as SessionView;

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('dashboard density rendering', () => {
  test('uses exactly 6 / 3 / 2 table columns', () => {
    expect(DENSITY_COLUMN_LABELS).toEqual({
      full: ['Teammate', 'Task', 'Status', 'Runtime', 'Activity', 'Signals'],
      compact: ['Teammate', 'Task', 'Status'],
      minimal: ['Teammate', 'Task'],
    });
  });

  test('Minimal cards visibly contain name + task and nothing else', () => {
    const text = visibleText(renderToStaticMarkup(<LeanSessionCard view={view} density="minimal" />));
    expect(text).toContain('Ada');
    expect(text).toContain('Fix parser');
    for (const hidden of ['running', 'parked', 'needs human', 'private-model', 'private-label']) {
      expect(text).not.toContain(hidden);
    }
  });

  test('Compact cards contain identity, task, and exception flags; a declared park collapses the status pill', () => {
    // `view` has state.waiting set: 'parked' and the status pill would say the
    // same thing twice, so only the flag renders (two chips for one condition
    // was eating the title width on a 390px row).
    const text = visibleText(renderToStaticMarkup(<LeanSessionCard view={view} density="compact" />));
    for (const visible of ['Ada', 'Fix parser', 'parked', 'needs human']) {
      expect(text).toContain(visible);
    }
    for (const hidden of ['running', 'run', 'private-model', 'private-label', 'external condition']) {
      expect(text).not.toContain(hidden);
    }
  });

  test('an unparked compact card shows the short status word, raw enum on hover only', () => {
    const unparked = {
      config: { id: 'busy-session', teammate: 'Cy', name: 'Ship the thing' },
      state: { status: 'tool_running' },
    } as unknown as SessionView;
    const html = renderToStaticMarkup(<LeanSessionCard view={unparked} density="compact" />);
    const text = visibleText(html);
    expect(text).toContain('tool');
    expect(text).not.toContain('tool_running');
    expect(html).toContain('title="tool_running"');
  });

  test('statusWord maps every enum to a short human word and never leaks underscores', () => {
    expect(statusWord('tool_running')).toBe('tool');
    expect(statusWord('awaiting_user')).toBe('you');
    expect(statusWord('rate_limited')).toBe('limited');
    expect(statusWord('running')).toBe('run');
    expect(statusWord('completed')).toBe('done');
    // Unknown statuses degrade to readable words, never to raw identifiers.
    expect(statusWord('some_future_state')).toBe('some future state');
  });

  test('Minimal table rows omit the status cell entirely', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <LeanSessionRow view={view} density="minimal" />
        </tbody>
      </table>,
    );
    expect(html.match(/<td/g)).toHaveLength(2);
    expect(visibleText(html)).not.toContain('running');
  });

  // The point of the redesign: a lean list must still VARY row to row, so both
  // reduced densities carry the status SHAPE as a greyscale-safe anchor (a
  // re-added visual, never a re-added fact) and let a finished row's name
  // recede. Asserted in markup so the anchor cannot silently regress back to a
  // uniform wall of bold names.
  const running = view;
  const finished = {
    config: { id: 'done-session', teammate: 'Bo', name: 'Ship it' },
    state: { status: 'completed' },
  } as unknown as SessionView;

  function tableRow(v: SessionView, density: 'compact' | 'minimal'): string {
    return renderToStaticMarkup(
      <table>
        <tbody>
          <LeanSessionRow view={v} density={density} />
        </tbody>
      </table>,
    );
  }

  test('both lean densities anchor every row with a status shape mark', () => {
    for (const density of ['compact', 'minimal'] as const) {
      expect(tableRow(running, density)).toContain('role="img"');
      expect(renderToStaticMarkup(<LeanSessionCard view={running} density={density} />)).toContain('role="img"');
    }
  });

  test('a finished row recedes to muted while a live row stays at full strength', () => {
    // Live name is --fg and NOT dimmed; the plain name carries no chip, so
    // `text-muted` would only appear if the name itself were dimmed.
    expect(tableRow(running, 'minimal')).toContain('text-fg');
    expect(tableRow(running, 'minimal')).not.toContain('text-muted');
    // Finished name recedes.
    expect(tableRow(finished, 'minimal')).toContain('text-muted');
  });

  // ---- B42: status hoisting + group panels --------------------------------
  // The pill was identical on every card of a same-status repo group. It is
  // hoisted to the group header when one status holds a strict majority, and
  // only exceptions keep theirs. These assert the VISIBLE facts, not classes —
  // class-token tests passed both rejected versions of this page.

  test('a hoisted compact row drops the status word but keeps exception flags', () => {
    const text = visibleText(renderToStaticMarkup(<LeanSessionCard view={view} density="compact" statusHoisted />));
    expect(text).not.toContain('running');
    expect(text).not.toContain('run');
    for (const kept of ['Ada', 'Fix parser', 'parked', 'needs human']) {
      expect(text).toContain(kept);
    }
  });

  function fakeView(id: string, status: string): SessionView {
    return {
      config: { id, teammate: id, name: `Task ${id}`, mode: 'auto', harness: 'claude' },
      state: { status },
    } as unknown as SessionView;
  }

  test('hoistedStatus: strict majority only, with at least two agreeing rows', () => {
    const rows = (...statuses: string[]) => statuses.map((s, i) => fakeView(`s${i}`, s));
    expect(hoistedStatus(rows('running', 'running', 'running'))).toEqual({
      status: 'running',
      count: 3,
      uniform: true,
    });
    expect(hoistedStatus(rows('running', 'running', 'failed'))).toEqual({
      status: 'running',
      count: 2,
      uniform: false,
    });
    // Ties, one-of-each pairs and single rows hoist nothing.
    expect(hoistedStatus(rows('running', 'failed'))).toBeNull();
    expect(hoistedStatus(rows('running', 'running', 'failed', 'failed'))).toBeNull();
    expect(hoistedStatus(rows('running'))).toBeNull();
    expect(hoistedStatus([])).toBeNull();
  });

  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  function renderGroups(group: SessionGroup, density: 'compact' | 'minimal', scoped = false): string {
    return visibleText(
      renderToStaticMarkup(
        <LeanDensityGroups groups={[group]} mode="cards" density={density} scoped={scoped} onFocus={() => {}} />,
      ),
    );
  }

  test('a uniform compact group names its status exactly once, in the header, as a word', () => {
    const group: SessionGroup = {
      name: 'repo',
      path: '/tmp/repo',
      rows: [fakeView('a', 'running'), fakeView('b', 'running'), fakeView('c', 'running')],
    };
    const text = renderGroups(group, 'compact');
    expect(occurrences(text, 'run')).toBe(1);
    expect(text).not.toContain('running');
  });

  test('a majority group hoists the majority and pills only the exceptions', () => {
    const group: SessionGroup = {
      name: 'repo',
      path: '/tmp/repo',
      rows: [fakeView('a', 'running'), fakeView('b', 'running'), fakeView('c', 'failed')],
    };
    const text = renderGroups(group, 'compact');
    expect(text).toContain('2× run');
    expect(occurrences(text, 'run')).toBe(1);
    expect(occurrences(text, 'failed')).toBe(1);
  });

  test('scoped groups keep per-row pills (the header that would carry the hoist is suppressed)', () => {
    const group: SessionGroup = {
      name: 'repo',
      path: '/tmp/repo',
      rows: [fakeView('a', 'running'), fakeView('b', 'running')],
    };
    const text = renderGroups(group, 'compact', true);
    expect(occurrences(text, 'run')).toBe(2);
  });

  test('minimal groups never show a status word, hoisted or otherwise', () => {
    const group: SessionGroup = {
      name: 'repo',
      path: '/tmp/repo',
      rows: [fakeView('a', 'running'), fakeView('b', 'running')],
    };
    expect(renderGroups(group, 'minimal')).not.toContain('running');
  });

  test('groupHueVar is stable per key and always a tool-token var', () => {
    expect(groupHueVar('/tmp/repo')).toBe(groupHueVar('/tmp/repo'));
    expect(groupHueVar('/tmp/repo')).toMatch(/^var\(--tool-[a-z]+\)$/);
  });

  test('adjacent groups never share a hue, even on hash collision', () => {
    // Brute-force two keys that hash to the same hue, then place them side by
    // side: the second must be bumped off the first.
    const base = groupHueVar('/tmp/a');
    let clash = '';
    for (let i = 0; i < 200 && !clash; i++) {
      const candidate = `/tmp/clash-${i}`;
      if (groupHueVar(candidate) === base) clash = candidate;
    }
    expect(clash).not.toBe('');
    const mkGroup = (path: string): SessionGroup => ({ name: path, path, rows: [] });
    const hues = groupHueVars([mkGroup('/tmp/a'), mkGroup(clash)]);
    expect(hues[0]).toBe(base);
    expect(hues[1]).not.toBe(base);
  });

  test('reduced densities never mount the usage hook branch', async () => {
    const source = await Bun.file(new URL('./SessionsListPage.tsx', import.meta.url).pathname).text();
    const full = source.slice(
      source.indexOf('function FullDensityGroups'),
      source.indexOf('function LeanDensityGroups'),
    );
    const lean = source.slice(
      source.indexOf('function LeanDensityGroups'),
      source.indexOf('function TranscriptResults'),
    );
    expect(full).toContain('useUsage()');
    expect(lean).not.toContain('useUsage()');
  });
});
