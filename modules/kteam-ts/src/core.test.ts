import { describe, expect, test } from 'bun:test';
import { inferHarness, interactiveHarnessArgs, recommendAgents } from './core';
import type { SessionConfig } from './types';

const config = (harness: 'claude' | 'codex', turn = 1, model?: string): SessionConfig => ({
  id: 'abc',
  name: 'test',
  binary: `${harness}-auto-test`,
  harness,
  modelHint: 'test',
  model,
  cwd: '/tmp',
  mode: 'auto',
  createdAt: '',
  updatedAt: '',
  turn,
  harnessSessionId: '00000000-0000-4000-8000-000000000000',
  tmuxSession: 'kteam-abc-agent',
  watcherSession: 'kteam-abc-watch',
  intervalSeconds: 15,
  stallSeconds: 900,
  timeoutSeconds: 7200,
  maxSnapshots: 200,
  systemPromptFile: '/tmp/system.md',
  originalPromptFile: '/tmp/prompt.md',
});

describe('harness support', () => {
  test('infers supported wrappers', () => {
    expect(inferHarness('claude-auto-mm3')).toBe('claude');
    expect(inferHarness('/x/codex-auto-atomi')).toBe('codex');
  });

  test('uses interactive persistent resume modes without print or exec', () => {
    expect(interactiveHarnessArgs(config('claude', 2))).toContain('--resume');
    expect(interactiveHarnessArgs(config('claude', 2))).not.toContain('--print');
    expect(interactiveHarnessArgs(config('codex', 2))[0]).toBe('resume');
    expect(interactiveHarnessArgs(config('codex', 1))).not.toContain('exec');
  });

  test('omits --model when no model is set', () => {
    expect(interactiveHarnessArgs(config('claude', 1))).not.toContain('--model');
    expect(interactiveHarnessArgs(config('codex', 1))).not.toContain('--model');
    expect(interactiveHarnessArgs(config('codex', 2))).not.toContain('--model');
  });

  test('injects --model for both harnesses when set', () => {
    const claudeArgs = interactiveHarnessArgs(config('claude', 1, 'opus'));
    expect(claudeArgs).toContain('--model');
    expect(claudeArgs[claudeArgs.indexOf('--model') + 1]).toBe('opus');

    // codex fresh start: --model is a top-level option
    const codexNew = interactiveHarnessArgs(config('codex', 1, 'terra'));
    expect(codexNew[codexNew.indexOf('--model') + 1]).toBe('terra');

    // codex resume: `resume` subcommand stays first, then --model
    const codexResume = interactiveHarnessArgs(config('codex', 2, 'terra'));
    expect(codexResume[0]).toBe('resume');
    expect(codexResume[codexResume.indexOf('--model') + 1]).toBe('terra');
  });
});

test('recommends mm3 for frontend plus an independent reviewer', () => {
  const result = recommendAgents('Build a polished React frontend', [
    'claude-auto-mm3',
    'codex-auto-atomi',
    'claude-auto-glm52a',
  ]);
  expect(result[0]?.binary).toBe('claude-auto-mm3');
  expect(result.some(item => item.binary === 'codex-auto-atomi')).toBe(true);
});

test('fills a generic task to at least three distinct teammates', () => {
  const result = recommendAgents('Implement the new billing reconciliation service', [
    'claude-auto-kirin',
    'claude-auto-loge',
    'claude-auto-mm3',
    'codex-auto-atomi',
    'codex-auto-loge',
  ]);
  expect(result.length).toBeGreaterThanOrEqual(3);
  expect(new Set(result.map(item => item.binary)).size).toBe(result.length);
});

test('never recommends more teammates than there are wrappers', () => {
  const result = recommendAgents('fix a typo', ['claude-auto-loge']);
  expect(result).toHaveLength(1);
});
