import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { SessionCommandControls } from './SessionCommandControls';

function view(
  overrides: Partial<SessionView['state']> = {},
  harness: SessionView['config']['harness'] = 'claude',
): SessionView {
  return {
    config: {
      id: 'cmd-probe',
      name: 'Cmd Probe',
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
      tmuxSession: 'kteam-cmd-probe',
      watcherSession: 'watcher',
      intervalSeconds: 2,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 8,
      systemPromptFile: '/tmp/system.md',
      originalPromptFile: '/tmp/prompt.md',
    },
    state: {
      id: 'cmd-probe',
      status: 'awaiting_user',
      turn: 1,
      observedModel: 'claude-opus-5',
      promptReady: true,
      ...overrides,
    },
    directory: '/tmp/session',
  };
}

describe('SessionCommandControls', () => {
  test('an idle, controllable session offers Compact and a confirm-gated Clear', () => {
    const html = renderToStaticMarkup(<SessionCommandControls view={view()} open canControl />);
    expect(html).toContain('Session context');
    expect(html).toContain('Compact context');
    expect(html).toContain('Clear context…');
    expect(html).not.toContain('Yes, clear context');
    expect(html).not.toContain('disabled=""');
  });

  test('a busy pane keeps the controls but disables them and warns to wait', () => {
    const html = renderToStaticMarkup(<SessionCommandControls view={view({ promptReady: false })} open canControl />);
    expect(html).toContain('Wait for an idle prompt');
    expect(html).toContain('disabled=""');
  });

  test('a terminal session explains it needs a running session and shows no controls', () => {
    const html = renderToStaticMarkup(<SessionCommandControls view={view({ status: 'completed' })} open canControl />);
    expect(html).toContain('need a running session');
    expect(html).not.toContain('Compact context');
    expect(html).not.toContain('Clear context…');
  });

  test('a read-only origin cannot clear or compact', () => {
    const html = renderToStaticMarkup(<SessionCommandControls view={view()} open canControl={false} />);
    expect(html).toContain('read-only');
    expect(html).not.toContain('Compact context');
  });

  test('the same controls are offered for a Codex session', () => {
    const html = renderToStaticMarkup(<SessionCommandControls view={view({}, 'codex')} open canControl />);
    expect(html).toContain('Compact context');
    expect(html).toContain('Clear context…');
  });
});
