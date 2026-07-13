import { describe, expect, test } from 'bun:test';
import { inferHarness, interactiveHarnessArgs, recommendAgents } from './core';
import type { SessionConfig } from './types';

const config = (harness: 'claude' | 'codex', turn = 1): SessionConfig => ({
  id: 'abc',
  name: 'test',
  binary: `${harness}-auto-test`,
  harness,
  modelHint: 'test',
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
