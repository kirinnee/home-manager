import { describe, expect, test } from 'bun:test';
import type { SessionStatus, SessionView } from '../types';
import { selectLiveDescendants, selectStopTargets } from './stop-actions';

function session(id: string, parent?: string, label?: string, status: SessionStatus = 'running'): SessionView {
  return {
    config: {
      id,
      name: `task ${id}`,
      parent,
      label,
      binary: 'codex',
      harness: 'codex',
      modelHint: 'gpt-5.6',
      mode: 'auto',
      cwd: '/tmp',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      turn: 1,
      harnessSessionId: id,
      tmuxSession: id,
      watcherSession: id,
      intervalSeconds: 60,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 3,
      systemPromptFile: '',
      originalPromptFile: '',
    },
    state: { id, status, turn: 1 },
    directory: '/tmp',
  };
}

describe('selectStopTargets', () => {
  test('keeps descendants running for orphan, cascades shallow parents first, and leaves the selected session running for children', () => {
    const sessions = [session('root'), session('child', 'root'), session('grandchild', 'child'), session('other')];
    expect(selectStopTargets(sessions, 'root', 'orphan').map(view => view.config.id)).toEqual(['root']);
    expect(selectStopTargets(sessions, 'root', 'cascade').map(view => view.config.id)).toEqual([
      'root',
      'child',
      'grandchild',
    ]);
    expect(selectStopTargets(sessions, 'root', 'children').map(view => view.config.id)).toEqual([
      'child',
      'grandchild',
    ]);
    expect(selectLiveDescendants(sessions, 'root').map(view => view.config.id)).toEqual(['child', 'grandchild']);
  });

  test('is cycle-safe and retains only stoppable sessions', () => {
    const sessions = [
      session('root', 'child'),
      session('child', 'root'),
      session('retry', 'child', undefined, 'kill_failed'),
      session('done', 'child', undefined, 'completed'),
    ];
    expect(selectStopTargets(sessions, 'root', 'cascade').map(view => view.config.id)).toEqual([
      'root',
      'child',
      'retry',
    ]);
    expect(selectStopTargets(sessions, 'root', 'children').map(view => view.config.id)).toEqual(['child', 'retry']);
  });

  test('children mode excludes the selected session even when a parent cycle reaches it', () => {
    const sessions = [session('root', 'child'), session('child', 'root'), session('grandchild', 'child')];
    expect(selectStopTargets(sessions, 'root', 'children').map(view => view.config.id)).toEqual([
      'child',
      'grandchild',
    ]);
    expect(selectLiveDescendants(sessions, 'root').map(view => view.config.id)).toEqual(['child', 'grandchild']);
  });

  test('orphan disclosure keeps retryable kill_failed descendants visible under the same stop semantics', () => {
    const sessions = [
      session('root'),
      session('retry', 'root', undefined, 'kill_failed'),
      session('done', 'root', undefined, 'completed'),
    ];
    expect(selectLiveDescendants(sessions, 'root').map(view => view.config.id)).toEqual(['retry']);
  });

  test('keeps a label group distinct from lineage and requires a non-empty selected label', () => {
    const sessions = [
      session('root', undefined, 'release'),
      session('child', 'root', 'release'),
      session('peer', undefined, 'release'),
      session('blank', undefined, '   '),
      session('blank-peer', undefined, '   '),
    ];
    expect(selectStopTargets(sessions, 'root', 'label').map(view => view.config.id)).toEqual(['root', 'peer', 'child']);
    expect(selectStopTargets(sessions, 'root', 'cascade').map(view => view.config.id)).toEqual(['root', 'child']);
    expect(selectStopTargets(sessions, 'blank', 'label')).toEqual([]);
  });

  test('a re-scan identifies a matching target that appeared after the confirmed list', () => {
    const first = [session('root'), session('child', 'root')];
    const confirmed = new Set(selectStopTargets(first, 'root', 'cascade').map(view => view.config.id));
    const after = [...first, session('late-child', 'root')];
    expect(
      selectStopTargets(after, 'root', 'cascade')
        .filter(view => !confirmed.has(view.config.id))
        .map(view => view.config.id),
    ).toEqual(['late-child']);
  });
});
