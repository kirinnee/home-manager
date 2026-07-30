import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';

function withTempConfig(yaml: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-'));
  try {
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, yaml);
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadConfig', () => {
  test('missing file throws with an init hint', () => {
    expect(() => loadConfig('/no/such/kfleet/config.yaml')).toThrow(/run "kfleet init"/);
  });

  test('parses a valid config and defaults profiles to {}', () => {
    withTempConfig('agents:\n  - { name: x, kind: claude }\n', file => {
      const c = loadConfig(file);
      expect(c.agents[0]?.name).toBe('x');
      expect(c.profiles).toEqual({});
    });
  });

  test('rejects an invalid kind', () => {
    withTempConfig('agents:\n  - { name: x, kind: bogus }\n', file => {
      expect(() => loadConfig(file)).toThrow(/invalid config/);
    });
  });

  test('rejects unknown top-level keys (strict schema)', () => {
    withTempConfig('bogusKey: 1\nagents: []\n', file => {
      expect(() => loadConfig(file)).toThrow(/invalid config/);
    });
  });

  test('parses a typed external secrets-file credential source', () => {
    withTempConfig(
      'agents:\n  - name: loge1\n    kind: claude\n    credential: { source: secrets-file, key: LOGE_CLAUDE_1_TOKEN }\n',
      file => {
        expect(loadConfig(file).agents[0]?.credential).toEqual({
          source: 'secrets-file',
          key: 'LOGE_CLAUDE_1_TOKEN',
        });
      },
    );
  });

  test('rejects unknown credential sources, invalid env names, and extra fields', () => {
    for (const credential of [
      '{ source: env, key: LOGE_CLAUDE_1_TOKEN }',
      '{ source: secrets-file, key: $LOGE_CLAUDE_1_TOKEN }',
      '{ source: secrets-file, key: LOGE_CLAUDE_1_TOKEN, file: /tmp/secrets }',
      '{ source: secrets-file, key: LOGE_CLAUDE_1_TOKEN, token: secret }',
    ]) {
      withTempConfig(`agents:\n  - name: loge1\n    kind: claude\n    credential: ${credential}\n`, file => {
        expect(() => loadConfig(file)).toThrow(/invalid config/);
      });
    }
  });

  test('rejects a secrets-file declaration on an unsupported agent kind', () => {
    withTempConfig(
      'agents:\n  - name: external-codex\n    kind: codex\n    credential: { source: secrets-file, key: CODEX_TOKEN }\n',
      file => expect(() => loadConfig(file)).toThrow(/supported only for Claude agents/),
    );
  });

  test('parses strict CLIProxyAPI availability sources', () => {
    withTempConfig(
      [
        'usage:',
        '  cliProxy:',
        '    - url: http://127.0.0.1:8317',
        '      managementKeyFile: ~/.kloge/management-key',
        '      baseAgents: [claude-loge, codex-loge]',
      ].join('\n'),
      file => {
        const c = loadConfig(file);
        expect(c.usage.cliProxy).toEqual([
          {
            url: 'http://127.0.0.1:8317',
            managementKeyFile: '~/.kloge/management-key',
            baseAgents: ['claude-loge', 'codex-loge'],
          },
        ]);
      },
    );
  });

  test('rejects malformed CLIProxyAPI availability sources', () => {
    withTempConfig(
      'usage:\n  cliProxy:\n    - url: not-a-url\n      managementKey: key\n      baseAgents: [loge]\n',
      file => {
        expect(() => loadConfig(file)).toThrow(/invalid config/);
      },
    );
  });

  test('requires exactly one CLIProxyAPI management credential source', () => {
    withTempConfig('usage:\n  cliProxy:\n    - url: http://127.0.0.1:8317\n      baseAgents: [claude-loge]\n', file => {
      expect(() => loadConfig(file)).toThrow(/invalid config/);
    });
    withTempConfig(
      'usage:\n  cliProxy:\n    - url: http://127.0.0.1:8317\n      managementKey: key\n      managementKeyFile: /tmp/key\n      baseAgents: [claude-loge]\n',
      file => {
        expect(() => loadConfig(file)).toThrow(/invalid config/);
      },
    );
  });
});
