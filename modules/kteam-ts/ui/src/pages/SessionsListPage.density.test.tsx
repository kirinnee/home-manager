import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { DENSITY_COLUMN_LABELS, LeanSessionCard, LeanSessionRow } from './SessionsListPage';

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

  test('Compact cards contain only identity, task, status, and exception flags', () => {
    const text = visibleText(renderToStaticMarkup(<LeanSessionCard view={view} density="compact" />));
    for (const visible of ['Ada', 'Fix parser', 'running', 'parked', 'needs human']) {
      expect(text).toContain(visible);
    }
    for (const hidden of ['private-model', 'private-label', 'external condition']) {
      expect(text).not.toContain(hidden);
    }
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
