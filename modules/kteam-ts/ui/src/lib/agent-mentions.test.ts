import { describe, expect, test } from 'bun:test';
import type { SessionStatus, SessionView } from '../types';
import {
  agentMentionHref,
  agentMentionIdentityKey,
  agentMentionReference,
  agentSessionHref,
  createAgentMentionResolver,
  parseAgentMentionHref,
} from './agent-mentions';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function session(id: string, teammate: string, createdAt: string, status: SessionStatus = 'running'): SessionView {
  return {
    config: {
      id,
      name: `Work owned by ${teammate}`,
      teammate,
      binary: 'codex-auto-loge',
      harness: 'codex',
      modelHint: 'gpt-5.6-sol',
      mode: 'auto',
      cwd: '/repo',
      createdAt,
      updatedAt: createdAt,
    } as SessionView['config'],
    state: { id, status, turn: 1 },
    directory: `/fleet/${id}`,
  };
}

describe('agent mention references', () => {
  test('inserts canonical sigil text while retaining legacy href decoding', () => {
    expect(agentSessionHref('ms4v5fu2-f2a89500')).toBe('/session/ms4v5fu2-f2a89500');
    expect(agentMentionHref('ms4v5fu2-f2a89500')).toBe('/session/ms4v5fu2-f2a89500#kteam-agent-mention');
    expect(agentMentionReference('Ottis', 'ms4v5fu2-f2a89500')).toBe(':ottis');
    expect(parseAgentMentionHref('/session/ms4v5fu2-f2a89500#kteam-agent-mention')).toBe('ms4v5fu2-f2a89500');
    expect(parseAgentMentionHref('/session/ms4v5fu2-f2a89500')).toBeNull();
    expect(parseAgentMentionHref('/session/%2E%2E#kteam-agent-mention')).toBeNull();
    expect(() => agentMentionReference('not a callsign!', 'ms-safe')).toThrow(TypeError);
  });

  test('bare names mirror the five-day newest-holder rule while exact ids retain finished history', () => {
    const ancient = session('ms-ancient', 'mileena', '2026-07-01T00:00:00.000Z', 'completed');
    const older = session('ms-older', 'ottis', '2026-07-27T08:00:00.000Z', 'completed');
    const current = session('ms-current', 'ottis', '2026-07-28T11:00:00.000Z', 'tool_running');
    const resolve = createAgentMentionResolver([older, ancient, current], NOW);

    expect(resolve({ name: 'OTTIS' })).toEqual({ sessionId: 'ms-current', name: 'ottis' });
    expect(resolve({ name: 'mileena' })).toBeNull();
    expect(resolve({ sessionId: 'ms-ancient' })).toEqual({ sessionId: 'ms-ancient', name: 'mileena' });
    expect(resolve({ sessionId: 'missing' })).toBeNull();
  });

  test('identity snapshots ignore status churn but observe a callsign rename', () => {
    const before = session('ms-one', 'ottis', '2026-07-28T11:00:00.000Z', 'running');
    const statusOnly = session('ms-one', 'ottis', '2026-07-28T11:00:00.000Z', 'completed');
    const renamed = session('ms-one', 'mileena', '2026-07-28T11:00:00.000Z', 'completed');
    expect(agentMentionIdentityKey([before])).toBe(agentMentionIdentityKey([statusOnly]));
    expect(agentMentionIdentityKey([before])).not.toBe(agentMentionIdentityKey([renamed]));
  });
});
