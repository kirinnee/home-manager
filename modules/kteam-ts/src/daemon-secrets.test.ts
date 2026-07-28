import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDaemonSecretEnvironmentKey, loadDaemonSecretsEnvironment } from './daemon-secrets';

describe('loadDaemonSecretsEnvironment', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-daemon-secrets-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a missing secrets file is a no-op', () => {
    const environment = { EXISTING: 'kept' };
    expect(loadDaemonSecretsEnvironment({ secretsFile: path.join(root, 'absent'), target: environment })).toBe(
      'missing',
    );
    expect(environment).toEqual({ EXISTING: 'kept' });
  });

  test('uses shell semantics and imports exported and assigned values', async () => {
    const secrets = path.join(root, 'secrets file');
    await writeFile(
      secrets,
      [
        "export DAEMON_SECRET_LITERAL='spaces = $literal'",
        'DAEMON_SECRET_EXPANDED="${DAEMON_SECRET_BASE}-suffix"',
        "printf 'source output must be discarded'",
        '',
      ].join('\n'),
    );
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      DAEMON_SECRET_BASE: 'base',
    };

    expect(loadDaemonSecretsEnvironment({ secretsFile: secrets, target: environment })).toBe('loaded');
    expect(environment.DAEMON_SECRET_LITERAL).toBe('spaces = $literal');
    expect(environment.DAEMON_SECRET_EXPANDED).toBe('base-suffix');
    expect(isDaemonSecretEnvironmentKey('DAEMON_SECRET_EXPANDED')).toBe(true);
  });

  test('a source error neither throws nor partially mutates the target', async () => {
    const secrets = path.join(root, '.secrets');
    await writeFile(
      secrets,
      [
        "export HF_ACCESS_KEY_ID='already-inherited'",
        "export IMPORTED_BEFORE_ERROR='must not escape'",
        "export BROKEN='unterminated",
        '',
      ].join('\n'),
    );
    const environment = { EXISTING: 'kept', HF_ACCESS_KEY_ID: 'already-inherited' };

    expect(loadDaemonSecretsEnvironment({ secretsFile: secrets, target: environment })).toBe('failed');
    expect(environment).toEqual({ EXISTING: 'kept', HF_ACCESS_KEY_ID: 'already-inherited' });
    expect(isDaemonSecretEnvironmentKey('HF_ACCESS_KEY_ID')).toBe(true);
  });

  test('does not let the secrets file steer daemon control variables', async () => {
    const secrets = path.join(root, '.secrets');
    await writeFile(
      secrets,
      [
        "export KTEAM_HOME='/tmp/wrong-home'",
        "export PATH='/tmp/wrong-path'",
        "export HOME='/tmp/wrong-user'",
        "export CUSTOM_WARDEN_CREDENTIAL='available'",
        '',
      ].join('\n'),
    );
    const environment: Record<string, string | undefined> = {
      KTEAM_HOME: '/real/home',
      PATH: '/real/path',
      HOME: '/real/user',
    };

    expect(loadDaemonSecretsEnvironment({ secretsFile: secrets, target: environment })).toBe('loaded');
    expect(environment).toEqual({
      KTEAM_HOME: '/real/home',
      PATH: '/real/path',
      HOME: '/real/user',
      CUSTOM_WARDEN_CREDENTIAL: 'available',
    });
    expect(isDaemonSecretEnvironmentKey('CUSTOM_WARDEN_CREDENTIAL')).toBe(true);
  });

  test('bounds shell evaluation that does not finish', async () => {
    const secrets = path.join(root, '.secrets');
    await writeFile(secrets, 'sleep 5\n');
    const startedAt = Date.now();

    expect(
      loadDaemonSecretsEnvironment({ secretsFile: secrets, target: { PATH: process.env.PATH }, timeoutMs: 100 }),
    ).toBe('failed');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test('recognizes provider-style credentials inherited before daemon boot', () => {
    expect(isDaemonSecretEnvironmentKey('ZAI_API_KEY_A')).toBe(true);
    expect(isDaemonSecretEnvironmentKey('GITHUB_TOKEN')).toBe(true);
    expect(isDaemonSecretEnvironmentKey('PATH')).toBe(false);
  });

  test('registers sourced credential names already present with the same value', async () => {
    const secrets = path.join(root, '.secrets');
    await writeFile(secrets, "export HF_ACCESS_KEY_ID='already-inherited'\n");
    const environment = { HF_ACCESS_KEY_ID: 'already-inherited', DISPLAY: ':1' };

    expect(loadDaemonSecretsEnvironment({ secretsFile: secrets, target: environment })).toBe('loaded');
    expect(environment).toEqual({ HF_ACCESS_KEY_ID: 'already-inherited', DISPLAY: ':1' });
    expect(isDaemonSecretEnvironmentKey('HF_ACCESS_KEY_ID')).toBe(true);
    expect(isDaemonSecretEnvironmentKey('DISPLAY')).toBe(false);
  });
});
