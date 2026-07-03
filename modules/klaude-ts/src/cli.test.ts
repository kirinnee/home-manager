import { describe, expect, test } from 'bun:test';
import { parseArgs, targetFromRuntime, TARGETS } from './cli';
import { sanitize } from './start';
import { sessionLayout } from './zellij';

describe('targetFromRuntime', () => {
  test('uses KLAUDE_TARGET when present', () => {
    expect(targetFromRuntime('/bin/klaude', { KLAUDE_TARGET: 'codex' })).toBe('codex');
    expect(targetFromRuntime('/bin/kodex', { KLAUDE_TARGET: 'claude' })).toBe('claude');
  });

  test('falls back to executable basename', () => {
    expect(targetFromRuntime('/nix/store/x/bin/klaude', {})).toBe('claude');
    expect(targetFromRuntime('/nix/store/x/bin/kodex', {})).toBe('codex');
  });
});

describe('parseArgs', () => {
  test('parses klaude name and forwarded args', () => {
    expect(parseArgs(['-n', 'foo', '--model', 'opus'])).toEqual({
      name: 'foo',
      detach: false,
      rest: ['--model', 'opus'],
    });
  });

  test('parses kodex detach and does not forward it', () => {
    expect(parseArgs(['--detach', '--name=foo', '--model', 'gpt-5.3-codex'])).toEqual({
      name: 'foo',
      detach: true,
      rest: ['--model', 'gpt-5.3-codex'],
    });
  });

  test('errors when -n has no value', () => {
    expect(() => parseArgs(['-n', '--resume'])).toThrow('flag -n requires a session name');
  });
});

describe('target agent args', () => {
  test('claude receives session name as -n', () => {
    expect(TARGETS.claude.agentArgs('foo', ['--resume'])).toEqual(['-n', 'foo', '--resume']);
  });

  test('codex receives forwarded args unchanged', () => {
    expect(TARGETS.codex.agentArgs('foo', ['--model', 'gpt-5.3-codex'])).toEqual(['--model', 'gpt-5.3-codex']);
  });

  test('codex starts with hello by default', () => {
    expect(TARGETS.codex.agentArgs('foo', [])).toEqual(['hello']);
  });
});

describe('zellij session layout', () => {
  test('uses one args node', () => {
    const layout = sessionLayout('/tmp/work tree', '/bin/codex', ['--model', 'gpt-5.3-codex']);
    expect(layout.match(/^\s*args /gm)).toHaveLength(1);
    expect(layout).toContain('pane command="/bin/codex" cwd="/tmp/work tree"');
  });

  test('sanitizes session names', () => {
    expect(sanitize(' hello/world now ')).toBe('hello-world-now');
  });
});
