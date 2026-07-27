import { describe, expect, test } from 'bun:test';
import type { SessionView } from '../types';
import { sessionActionSpecs, type SessionAction } from './session-actions';

function view(status: string): SessionView {
  return {
    config: {
      id: 's1',
      name: 'task',
      binary: 'claude-x',
      harness: 'claude',
      mode: 'auto',
      cwd: '/tmp',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      turn: 1,
    },
    state: { status } as SessionView['state'],
  } as SessionView;
}

function actions(status: string, hasToken = true): SessionAction[] {
  return sessionActionSpecs(view(status), hasToken).map(s => s.action);
}

describe('sessionActionSpecs', () => {
  test('a read-only origin (no token) offers nothing', () => {
    expect(sessionActionSpecs(view('running'), false)).toEqual([]);
  });

  test('a running session: interrupt, stop, rename, migrate — no resume', () => {
    expect(actions('running')).toEqual(['interrupt', 'stop', 'rename', 'migrate']);
  });

  test('a completed session: resume, rename, migrate — no interrupt or stop', () => {
    expect(actions('completed')).toEqual(['resume', 'rename', 'migrate']);
  });

  test('kill_failed still offers Stop and never Resume', () => {
    const a = actions('kill_failed');
    expect(a).toContain('stop');
    expect(a).not.toContain('resume');
    expect(a).not.toContain('interrupt');
    expect(a).toEqual(['stop', 'rename', 'migrate']);
  });

  test('Stop and Migrate are the destructive-toned entries', () => {
    const specs = sessionActionSpecs(view('running'), true);
    const danger = specs.filter(s => s.danger).map(s => s.action);
    expect(danger).toEqual(['stop', 'migrate']);
  });

  test('rename and migrate are always present with a token, any status', () => {
    for (const status of ['running', 'completed', 'stopped', 'failed', 'stalled', 'kill_failed', 'waiting']) {
      const a = actions(status);
      expect(a).toContain('rename');
      expect(a).toContain('migrate');
    }
  });
});
