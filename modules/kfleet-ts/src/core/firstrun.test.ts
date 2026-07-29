import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedFirstRunFlags } from './firstrun';

const tempDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'kfleet-firstrun-'));

describe('seedFirstRunFlags', () => {
  test('creates a fresh Claude config with every blocking first-run flag', () => {
    const dir = path.join(tempDir(), 'new-config');

    expect(seedFirstRunFlags('claude', dir, '/workspace', {})).toBe(true);

    const config = JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')) as Record<string, any>;
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.hasCompletedClaudeInChromeOnboarding).toBe(true);
    expect(config.claudeInChromeDefaultEnabled).toBe(false);
    expect(config.projects['/workspace'].hasTrustDialogAccepted).toBe(true);
  });

  test('is byte-idempotent after the flags are present', () => {
    const dir = tempDir();
    expect(seedFirstRunFlags('claude', dir, '/workspace', {})).toBe(true);
    const first = readFileSync(path.join(dir, '.claude.json'), 'utf8');

    expect(seedFirstRunFlags('claude', dir, '/workspace', {})).toBe(false);
    expect(readFileSync(path.join(dir, '.claude.json'), 'utf8')).toBe(first);
  });

  test('merges state without clobbering user choices and records the configured API key tail', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.claude.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        theme: 'dark',
        oauthAccount: { emailAddress: 'person@example.com' },
        claudeInChromeDefaultEnabled: true,
        projects: { '/workspace': { note: 'keep me' }, '/other': { untouched: true } },
        customApiKeyResponses: { approved: ['existing'] },
      }),
    );
    const apiKey = 'sk-ant-this-is-a-deliberately-long-test-key';

    expect(seedFirstRunFlags('claude', dir, '/workspace', { ANTHROPIC_API_KEY: apiKey })).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
    expect(config.theme).toBe('dark');
    expect(config.oauthAccount.emailAddress).toBe('person@example.com');
    expect(config.claudeInChromeDefaultEnabled).toBe(true);
    expect(config.projects['/workspace']).toEqual({ note: 'keep me', hasTrustDialogAccepted: true });
    expect(config.projects['/other']).toEqual({ untouched: true });
    expect(config.customApiKeyResponses.approved).toEqual(['existing', apiKey.slice(-20)]);
  });

  test('leaves malformed JSON untouched', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.claude.json');
    writeFileSync(configPath, '{{{');

    expect(seedFirstRunFlags('claude', dir, '/workspace', {})).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe('{{{');
  });

  test('honors CLAUDE_AUTOTRUST=0 and is a no-op for Codex', () => {
    const disabled = path.join(tempDir(), 'disabled');
    const codex = path.join(tempDir(), 'codex');

    expect(seedFirstRunFlags('claude', disabled, '/workspace', { CLAUDE_AUTOTRUST: '0' })).toBe(false);
    expect(seedFirstRunFlags('codex', codex, '/workspace', {})).toBe(false);
    expect(existsSync(disabled)).toBe(false);
    expect(existsSync(codex)).toBe(false);
  });
});
