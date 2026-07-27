import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LearningPage, LearningHeader, ProposalCard } from './LearningPage';
import type { LearningStatusView, ProposalView } from '../lib/learning-types';

const proposal: ProposalView = {
  id: 'p1',
  category: 'global',
  state: 'pending',
  title: 'Run project commands through direnv exec',
  ruleText: 'Run project commands through `direnv exec`.',
  target: { kind: 'kfleet-claude-md', path: 'kfleet/CLAUDE.md', anchor: '## Agent rules' },
  observationIds: ['o1', 'o2'],
  occurrences: 7,
  crossRepoCount: 2,
  firstSeen: '2026-07-01T00:00:00Z',
  lastSeen: '2026-07-26T00:00:00Z',
  identity: 'direnv-exec-required',
  evidence: [
    {
      observationId: 'o1',
      sessionId: 'ms2-abc',
      teammate: 'lacey',
      repo: '/home/kirin/Workspace/atomi/nitroso',
      at: '2026-07-26T10:11:12Z',
      quote: 'no — run it through direnv exec like I said last time',
      source: 'human',
      kind: 'correction',
    },
    {
      observationId: 'o2',
      sessionId: 'ms2-def',
      teammate: 'zelda',
      repo: '/home/kirin/.config/home-manager',
      at: '2026-07-25T08:00:00Z',
      quote: 'use direnv exec before bun',
      source: 'teammate',
      kind: 'preference',
    },
  ],
};

const noop = () => undefined;

function actionButtons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>/g)].map(m => m[0]);
}

describe('ProposalCard', () => {
  const html = renderToStaticMarkup(<ProposalCard proposal={proposal} act={noop} busy={false} />);

  test('shows the computed occurrence badge and cross-repo count', () => {
    expect(html).toContain('7×');
    expect(html).toContain('2 repos');
  });

  test('shows the rule title, text, and target file', () => {
    expect(html).toContain('Run project commands through direnv exec');
    expect(html).toContain('kfleet/CLAUDE.md');
  });

  test('renders verified evidence with verbatim quote and attribution, deep-linked', () => {
    expect(html).toContain('no — run it through direnv exec like I said last time');
    expect(html).toContain('teammate steer');
    expect(html).toContain('/home/kirin/Workspace/atomi/nitroso');
    expect(html).toContain('href="/session/ms2-abc"');
  });

  test('evidence is collapsed by default (a details element, no open attr)', () => {
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });

  test('every action is labelled and meets the 44px touch floor', () => {
    for (const label of [
      'aria-label="Accept Run project commands through direnv exec"',
      'aria-label="Edit Run project commands through direnv exec"',
      'aria-label="Reject Run project commands through direnv exec permanently"',
      'aria-label="Copy rule text for Run project commands through direnv exec"',
      'aria-label="Save a patch file for Run project commands through direnv exec"',
    ]) {
      expect(html).toContain(label);
    }
    for (const button of actionButtons(html)) {
      // Buttons that are true controls carry the floor; the <summary> rows carry
      // it separately. Every <button> here is an action → must be ≥44px.
      expect(button.includes('min-h-[44px]')).toBe(true);
    }
  });

  test('no keyboard-summoning autofocus in the default (touch-conservative) render', () => {
    expect(html.toLowerCase()).not.toContain('autofocus');
  });

  test('accepted variant drops accept/reject, keeps copy + patch', () => {
    const acc = renderToStaticMarkup(
      <ProposalCard proposal={{ ...proposal, state: 'accepted' }} act={noop} busy={false} accepted />,
    );
    expect(acc).not.toContain('aria-label="Accept Run project commands through direnv exec"');
    expect(acc).toContain('aria-label="Copy rule text for Run project commands through direnv exec"');
    expect(acc).toContain('aria-label="Save a patch file for Run project commands through direnv exec"');
  });
});

describe('LearningHeader', () => {
  const status: LearningStatusView = {
    enabled: true,
    intervalMinutes: 720,
    lastRunAt: '2026-07-27T00:00:00Z',
    watermarkAt: '2026-07-27T00:00:00Z',
    pending: { total: 4, strong: 1, weak: 2 },
    totals: { observations: 12, proposals: 4, tombstones: 1 },
    running: false,
  };

  test('states enabled, pending count, and a labelled 44px run-now control', () => {
    const html = renderToStaticMarkup(<LearningHeader status={status} failed={false} busy={false} onRunNow={noop} />);
    expect(html).toContain('enabled');
    expect(html).toContain('4 pending');
    expect(html).toContain('1 strong');
    const run = actionButtons(html).find(b => b.includes('Run a learning scan now'));
    expect(run).toBeDefined();
    expect(run!.includes('min-h-[44px]')).toBe(true);
  });
});

describe('LearningPage', () => {
  test('is a labelled full-width destination without duplicate route chrome', () => {
    const html = renderToStaticMarkup(<LearningPage />);
    expect(html).toContain('>Learning</h1>');
    expect(html).toContain('machine-verified against the transcript');
    // The header crumb "/" link lives in AppBar, never on the page itself.
    expect(html).not.toContain('href="/"');
  });

  test('surfaces the read-only banner when the page has no token', () => {
    // In the bun/SSR test env window.__KTEAM_TOKEN__ is unset → HAS_TOKEN false.
    const html = renderToStaticMarkup(<LearningPage />);
    expect(html).toContain('read-only: no local token');
  });
});
