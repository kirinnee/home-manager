import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { ComposerRuntime, codexReasoningObservationChanged } from './ComposerRuntime';

function view(
  overrides: Partial<SessionView['state']> = {},
  harness: SessionView['config']['harness'] = 'claude',
): SessionView {
  return {
    config: {
      id: 'bar-probe',
      name: 'Bar Probe',
      binary: `${harness}-auto`,
      harness,
      modelHint: 'launch-model',
      model: 'launch-model',
      mode: 'auto',
      cwd: '/tmp/probe',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      turn: 1,
      harnessSessionId: 'harness',
      tmuxSession: 'kteam-bar-probe',
      watcherSession: 'watcher',
      intervalSeconds: 2,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 8,
      systemPromptFile: '/tmp/system.md',
      originalPromptFile: '/tmp/prompt.md',
    },
    state: {
      id: 'bar-probe',
      status: 'awaiting_user',
      turn: 1,
      observedModel: 'claude-opus-5',
      promptReady: true,
      ...overrides,
    },
    directory: '/tmp/session',
  };
}

function buttons(html: string): string[] {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

/** The chips are told apart by the verb their aria-label opens with — "Switch
 *  model …" vs "Set reasoning …" — so a test can target one without depending
 *  on DOM order. */
function chip(html: string, kind: 'model' | 'effort'): string {
  const needle = kind === 'model' ? 'aria-label="Switch model' : 'aria-label="Set reasoning';
  const found = buttons(html).find(candidate => candidate.includes(needle));
  if (!found) throw new Error(`no ${kind} chip\n${html}`);
  return found;
}

describe('ComposerRuntime bar chips', () => {
  test('offers a model chip AND a reasoning chip, both idle dialog triggers', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl busy={false} />);
    const triggers = buttons(html).filter(b => b.includes('aria-haspopup="dialog"'));
    expect(triggers.length).toBe(2);

    const model = chip(html, 'model');
    expect(model).toContain('claude-opus-5');
    expect(model).toContain('aria-label="Switch model — currently claude-opus-5"');
    expect(model).not.toContain('disabled=""');

    const effort = chip(html, 'effort');
    expect(effort).toContain('aria-haspopup="dialog"');
    expect(effort).not.toContain('disabled=""');
    expect(model).toContain('min-w-[44px]');
    expect(effort).toContain('min-w-[44px]');
  });

  test('the chip row is rest-only chrome that collapses with the keyboard', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl busy={false} />);
    expect(html).toContain('kt-composer__runtime-row');
    // data-kb-hide lives on the ROW so both chips hide together when typing.
    expect(html).toMatch(/kt-composer__runtime-row[^>]*data-kb-hide/);
  });

  test('a Claude reasoning chip is a neutral effort verb, not a claimed level', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl busy={false} />);
    const effort = chip(html, 'effort');
    expect(effort).toContain('aria-label="Set reasoning effort"');
    expect(effort).toContain('effort');
  });

  test('a Codex reasoning chip reads the observed reasoning level as truth', () => {
    const html = renderToStaticMarkup(
      <ComposerRuntime view={view({ observedReasoningEffort: 'high' }, 'codex')} canControl busy={false} />,
    );
    const effort = chip(html, 'effort');
    expect(effort).toContain('aria-label="Set reasoning level — currently high"');
    expect(effort).toContain('high');
  });

  test('a fresh Codex settings timestamp confirms re-selecting the same reasoning level', () => {
    const before = { effort: 'high', observedAt: '2026-07-27T00:37:00.000Z' };
    expect(codexReasoningObservationChanged(before, before)).toBe(false);
    expect(
      codexReasoningObservationChanged(before, {
        effort: 'high',
        observedAt: '2026-07-27T00:38:00.000Z',
      }),
    ).toBe(true);
    expect(codexReasoningObservationChanged(before, { ...before, effort: 'ultra' })).toBe(true);
  });

  test('read-only origin disables BOTH chips with a shared non-visual reason', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl={false} busy={false} />);
    const model = chip(html, 'model');
    const effort = chip(html, 'effort');
    expect(model).toContain('disabled=""');
    expect(effort).toContain('disabled=""');
    const reasonId = model.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(reasonId).toBeDefined();
    expect(effort).toContain(`aria-describedby="${reasonId}"`);
    expect(html).toContain(`id="${reasonId}"`);
    expect(html).toContain('Read-only origin');
  });

  test('a busy session disables both chips (a switch needs an idle prompt)', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl busy />);
    expect(chip(html, 'model')).toContain('disabled=""');
    expect(chip(html, 'effort')).toContain('disabled=""');
    expect(html).toContain('Busy: wait for an idle prompt');
  });

  test('a terminal session disables both chips', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view({ status: 'completed' })} canControl busy={false} />);
    expect(chip(html, 'model')).toContain('disabled=""');
    expect(chip(html, 'effort')).toContain('disabled=""');
    expect(html).toContain('Session finished');
  });

  test('the model chip falls back to the launch model only when nothing is observed', () => {
    const html = renderToStaticMarkup(
      <ComposerRuntime view={view({ observedModel: undefined })} canControl busy={false} />,
    );
    expect(chip(html, 'model')).toContain('launch-model');
  });
});
