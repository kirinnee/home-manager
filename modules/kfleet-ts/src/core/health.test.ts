import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoAgents, prepareAgentEnv, probeAgent, sanitizeAgentEnv } from './health';
import { configSchema } from './types';

describe('autoAgents', () => {
  test('returns the resolved auto-* variant wrappers, not the raw (un-prefixed) config names', () => {
    const config = configSchema.parse({
      variants: { default: {}, auto: { memory: './CLAUDE.auto.md' } },
      agents: [
        { name: 'kirin', kind: 'claude', env: { CLAUDE_CODE_OAUTH_TOKEN: '$CLAUDE_CODE_OAUTH_TOKEN' } },
        { name: 'gpt55', kind: 'codex' },
      ],
    });
    const agents = autoAgents(config);
    const auto = agents.map(a => `${a.kind}-${a.name}`).sort();
    expect(auto).toEqual(['claude-auto-kirin', 'codex-auto-gpt55']);
    expect(agents.find(agent => agent.name === 'auto-kirin')?.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: '$CLAUDE_CODE_OAUTH_TOKEN',
    });
  });

  test('with no auto variant declared there are no auto-* agents', () => {
    const config = configSchema.parse({ agents: [{ name: 'kirin', kind: 'claude' }] });
    expect(autoAgents(config)).toEqual([]);
  });
});

describe('sanitizeAgentEnv', () => {
  test('drops inherited provider/session identity while preserving ordinary and source-secret vars', () => {
    const clean = sanitizeAgentEnv({
      PATH: '/bin',
      DEEPSEEK_API_KEY: 'source-secret-used-by-a-wrapper',
      ANTHROPIC_API_KEY: 'wrong-account',
      ANTHROPIC_BASE_URL: 'https://wrong.example',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'wrong-model',
      CLAUDE_CONFIG_DIR: '/wrong-home',
      CLAUDECODE: '1',
      CODEX_HOME: '/wrong-codex-home',
      OPENAI_API_KEY: 'wrong-openai-account',
    });

    expect(clean.PATH).toBe('/bin');
    expect(clean.DEEPSEEK_API_KEY).toBe('source-secret-used-by-a-wrapper');
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(clean.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(clean.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(clean.CLAUDECODE).toBeUndefined();
    expect(clean.CODEX_HOME).toBeUndefined();
    expect(clean.OPENAI_API_KEY).toBeUndefined();
  });

  test('keeps provider variables that the target wrapper explicitly configures', () => {
    const clean = sanitizeAgentEnv(
      {
        OPENAI_API_KEY: 'intentional-parent-value-for-a-self-reference',
        OPENAI_BASE_URL: 'https://leaked.example',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'configured-model',
      },
      ['OPENAI_API_KEY', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
    );

    expect(clean.OPENAI_API_KEY).toBe('intentional-parent-value-for-a-self-reference');
    expect(clean.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('configured-model');
    expect(clean.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe('prepareAgentEnv', () => {
  test('configured literals and source refs replace unrelated inherited provider state', () => {
    const prepared = prepareAgentEnv(
      {
        ANTHROPIC_API_KEY: 'literal-target-key',
        ANTHROPIC_AUTH_TOKEN: '${SOURCE_AUTH_TOKEN}',
        OPENAI_API_KEY: '$OPENAI_API_KEY',
      },
      {
        ANTHROPIC_API_KEY: 'wrong-inherited-key',
        ANTHROPIC_BASE_URL: 'https://wrong.example',
        OPENAI_API_KEY: 'intentional-self-reference',
        SOURCE_AUTH_TOKEN: 'resolved-source-token',
      },
    );

    expect(prepared.ANTHROPIC_API_KEY).toBe('literal-target-key');
    expect(prepared.ANTHROPIC_AUTH_TOKEN).toBe('resolved-source-token');
    expect(prepared.OPENAI_API_KEY).toBe('intentional-self-reference');
    expect(prepared.SOURCE_AUTH_TOKEN).toBe('resolved-source-token');
    expect(prepared.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe('probeAgent', () => {
  test('reports a missing generated wrapper as a failure without spawning', async () => {
    const name = `definitely-missing-${process.pid}-${Date.now()}`;

    const result = await probeAgent({ name, kind: 'claude' }, 10);

    expect(result.up).toBe(false);
    expect(result.error).toBe('wrapper not found — run `kfleet apply`');
  });

  test('approves the target literal API key before launching a jq-less wrapper', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kfleet-health-key-'));
    const wrapper = path.join(root, 'claude-literal-key');
    const configDir = path.join(root, 'config');
    const apiKey = 'sk-ant-literal-target-key-that-is-longer-than-twenty';
    writeFileSync(wrapper, '#!/bin/sh\nprintf "KFLEET_HEALTH_OK\\n"\n');
    chmodSync(wrapper, 0o755);

    const result = await probeAgent(
      { name: 'literal-key', kind: 'claude', env: { ANTHROPIC_API_KEY: apiKey } },
      1_000,
      {
        configDir: () => configDir,
        resolveWrapper: () => ({ binary: 'claude-literal-key', resolved: wrapper }),
      },
    );
    const config = JSON.parse(readFileSync(path.join(configDir, '.claude.json'), 'utf8')) as Record<string, any>;

    expect(result.up).toBe(true);
    expect(config.customApiKeyResponses.approved).toEqual([apiKey.slice(-20)]);
  });
});
