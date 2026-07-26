import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { RenameSheet } from './RenameSheet';

function session(parent?: string): SessionView {
  return {
    config: {
      id: 'ms-rename-1234',
      name: 'Original Task',
      teammate: 'original',
      ...(parent ? { parent } : {}),
      binary: 'claude-auto-loge',
      harness: 'claude',
      modelHint: 'claude-fable-5',
      model: 'claude-fable-5',
      mode: 'auto',
      cwd: '/tmp/session',
      createdAt: '2026-07-26T12:00:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
      turn: 1,
      harnessSessionId: 'harness',
      tmuxSession: 'tmux',
      watcherSession: 'watcher',
      intervalSeconds: 2,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 8,
      systemPromptFile: '/tmp/system.md',
      originalPromptFile: '/tmp/prompt.md',
    },
    state: { id: 'ms-rename-1234', status: 'awaiting_user', turn: 1 },
    directory: '/tmp/session',
  };
}

describe('RenameSheet', () => {
  test('renders daemon-aligned fields, advisory copy, and touch-safe controls', () => {
    const html = renderToStaticMarkup(<RenameSheet view={session('parent-id')} open onClose={() => undefined} />);
    expect(html).toContain('Rename session');
    expect(html).toContain('value="Original Task"');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('pattern="[a-z][a-z0-9-]*"');
    expect(html).toContain('Convention: plain Title Case, up to 5 words');
    expect(html).toContain('Detach from parent');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('autofocus');
  });

  test('does not offer detaching when the session has no parent', () => {
    const html = renderToStaticMarkup(<RenameSheet view={session()} open onClose={() => undefined} />);
    expect(html).not.toContain('Detach from parent');
  });
});
