import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { ComposerRuntime } from './ComposerRuntime';

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

function trigger(html: string): string {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const button = buttons.find(candidate => candidate.includes('aria-haspopup="dialog"'));
  if (!button) throw new Error(`no runtime trigger button\n${html}`);
  return button;
}

describe('ComposerRuntime bar trigger', () => {
  test('reads the observed model and offers a dialog trigger when idle', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl busy={false} />);
    const button = trigger(html);
    expect(button).toContain('claude-opus-5');
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).not.toContain('disabled=""');
    expect(button).toContain('aria-label="Switch model — currently claude-opus-5"');
  });

  test('read-only origin disables the trigger with a non-visual reason', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl={false} busy={false} />);
    const button = trigger(html);
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-disabled="true"');
    const reasonId = button.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(reasonId).toBeDefined();
    expect(html).toContain(`id="${reasonId}"`);
    expect(html).toContain('Read-only origin');
  });

  test('a busy session disables the switch (a switch needs an idle prompt)', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view()} canControl busy />);
    const button = trigger(html);
    expect(button).toContain('disabled=""');
    expect(html).toContain('Busy: wait for an idle prompt');
  });

  test('a terminal session disables the switch', () => {
    const html = renderToStaticMarkup(<ComposerRuntime view={view({ status: 'completed' })} canControl busy={false} />);
    const button = trigger(html);
    expect(button).toContain('disabled=""');
    expect(html).toContain('Session finished');
  });

  test('falls back to the launch model only when nothing is observed yet', () => {
    const html = renderToStaticMarkup(
      <ComposerRuntime view={view({ observedModel: undefined })} canControl busy={false} />,
    );
    expect(trigger(html)).toContain('launch-model');
  });
});
