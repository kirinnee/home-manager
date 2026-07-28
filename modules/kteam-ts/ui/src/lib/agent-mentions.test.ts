import { describe, expect, test } from 'bun:test';
import type { SessionStatus, SessionView } from '../types';
import {
  agentMentionHref,
  agentMentionIdentityKey,
  agentMentionReference,
  agentSessionHref,
  createAgentMentionResolver,
  parseAgentMentionHref,
  remarkAgentMentions,
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

interface TestNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  data?: { hProperties?: Record<string, string> };
  children?: TestNode[];
}

describe('agent mention references', () => {
  test('uses a readable Markdown label with an immutable session-id destination', () => {
    expect(agentSessionHref('ms4v5fu2-f2a89500')).toBe('/session/ms4v5fu2-f2a89500');
    expect(agentMentionHref('ms4v5fu2-f2a89500')).toBe('/session/ms4v5fu2-f2a89500#kteam-agent-mention');
    expect(agentMentionReference('Ottis', 'ms4v5fu2-f2a89500')).toBe(
      '[@ottis](/session/ms4v5fu2-f2a89500#kteam-agent-mention)',
    );
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

  test('linkifies only proven bare callsigns, never email or path prefixes', () => {
    const tree: TestNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: 'Ping @ottis; not @missing, someone@example.com, @src/, @src/app.ts, or @app.ts:12.',
            },
            { type: 'inlineCode', value: '@ottis' },
            {
              type: 'link',
              url: 'https://example.com/@ottis',
              children: [{ type: 'text', value: '@ottis' }],
            },
          ],
        },
      ],
    };
    remarkAgentMentions({
      resolveMention: lookup =>
        lookup.name?.toLowerCase() === 'ottis' ? { sessionId: 'ms-ottis', name: 'ottis' } : null,
    })(tree);

    const children = tree.children?.[0]?.children ?? [];
    expect(children[0]).toEqual({ type: 'text', value: 'Ping ' });
    expect(children[1]).toEqual({
      type: 'link',
      url: '/session/ms-ottis#kteam-agent-mention',
      title: "Open @ottis's session",
      data: { hProperties: { 'data-agent-mention': 'ms-ottis' } },
      children: [{ type: 'text', value: '@ottis' }],
    });
    expect(children[2]?.value).toContain('someone@example.com');
    expect(children[2]?.value).toContain('@src/');
    expect(children[2]?.value).toContain('@src/app.ts');
    expect(children[2]?.value).toContain('@app.ts:12');
    expect(children[3]).toEqual({ type: 'inlineCode', value: '@ottis' });
    expect(children[4]?.type).toBe('link');
    expect(children[4]?.url).toBe('https://example.com/@ottis');
  });

  test.each([
    ['@ottis.', true],
    ['@ottis: ready', true],
    ['@ottis.ts', false],
    ['@ottis:12', false],
    ['@ottis#L12', false],
  ] as const)('treats sentence punctuation but not file syntax as a boundary in %p', (value, expected) => {
    const tree: TestNode = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
    };
    remarkAgentMentions({
      resolveMention: lookup => (lookup.name === 'ottis' ? { sessionId: 'ms-ottis', name: 'ottis' } : null),
    })(tree);
    expect(tree.children?.[0]?.children?.some(child => child.type === 'link')).toBe(expected);
  });

  test('without proof, the AST remains plain text', () => {
    const tree: TestNode = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '@nobody' }] }],
    };
    remarkAgentMentions({ resolveMention: () => null })(tree);
    expect(tree.children?.[0]?.children).toEqual([{ type: 'text', value: '@nobody' }]);
  });
});
