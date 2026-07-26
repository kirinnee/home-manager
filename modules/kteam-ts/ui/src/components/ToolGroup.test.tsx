// A running tool must never hide inside the collapsed count. Even in a large
// merged run, the live tool keeps its own named status line (verb + headline),
// while the finished calls collapse into the "N tools" group above it. These
// tests render the component to static markup (this package has no DOM impl)
// and assert on that contract.

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolGroup } from './ToolGroup';
import type { ToolCall } from '../lib/transcript';

function call(key: string, name: string, input: unknown, done = true): ToolCall {
  return {
    key,
    use: { name, input } as ToolCall['use'],
    ts: '2026-07-25T12:00:00.000Z',
    ...(done ? { result: { text: 'ok' } as ToolCall['result'] } : {}),
  };
}

const render = (calls: ToolCall[], live: boolean, isLast: boolean) =>
  renderToStaticMarkup(createElement(ToolGroup, { calls, live, isLast }));

describe('ToolGroup running-tail split', () => {
  test('a running tool at the tail of a big group is named, not folded into the count', () => {
    const calls = [
      call('a', 'Read', { file_path: '/tmp/a.ts' }),
      call('b', 'Edit', { file_path: '/tmp/b.ts' }),
      call('c', 'Bash', { command: 'bun test' }, false),
    ];
    const markup = render(calls, true, true);
    // the two finished calls collapse into a count (not 3 — the running one is
    // pulled out onto its own line)
    expect(markup).toContain('2 tools');
    // the live tool is named
    expect(markup).toContain('bun test');
    // and it carries the running spinner (animate-spin only appears on the
    // running line)
    expect(markup).toContain('animate-spin');
  });

  test('a finished group shows the full count with no spinner', () => {
    const calls = [
      call('a', 'Read', { file_path: '/tmp/a.ts' }),
      call('b', 'Edit', { file_path: '/tmp/b.ts' }),
      call('c', 'Bash', { command: 'bun test' }),
    ];
    const markup = render(calls, true, true);
    expect(markup).toContain('3 tools');
    expect(markup).not.toContain('animate-spin');
  });

  test('a lone running tool renders only its named status line', () => {
    const markup = render([call('a', 'Bash', { command: 'bun run build' }, false)], true, true);
    expect(markup).toContain('bun run build');
    expect(markup).toContain('animate-spin');
    expect(markup).not.toContain('tools');
  });

  test('running state is ignored when this is not the last block', () => {
    const calls = [call('a', 'Read', { file_path: '/tmp/a.ts' }), call('b', 'Bash', { command: 'bun test' }, false)];
    // not last → the trailing unfinished call is history, not live
    const markup = render(calls, true, false);
    expect(markup).toContain('2 tools');
    expect(markup).not.toContain('animate-spin');
  });
});
