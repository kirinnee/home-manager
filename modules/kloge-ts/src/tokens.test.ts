import { describe, expect, test } from 'bun:test';
import { decryptSecretsScript, encryptSecretsScript } from './paths';
import {
  claudeCredentialDestinations,
  claudeSopsEnvTokens,
  hasDirectClaudeCredential,
  normalizeClaudeOAuthAccessToken,
} from './tokens';

const configYaml = `
agents:
  - name: loge1
    kind: claude
    credential: { source: secrets-file, key: LOGE_CLAUDE_1_TOKEN }
  - name: loge2
    kind: claude
    credential: { source: secrets-file, key: LOGE_CLAUDE_2_TOKEN }
  - name: loge6
    kind: claude
    credential: { source: secrets-file, key: LOGE_CLAUDE_6_TOKEN }
`;

describe('claudeCredentialDestinations', () => {
  test('reads the destinations from kfleet credential declarations', () => {
    expect([...claudeCredentialDestinations(configYaml)]).toEqual([
      ['loge1', 'LOGE_CLAUDE_1_TOKEN'],
      ['loge2', 'LOGE_CLAUDE_2_TOKEN'],
      ['loge6', 'LOGE_CLAUDE_6_TOKEN'],
    ]);
  });

  test('rejects a direct agent without the required external source', () => {
    expect(() => claudeCredentialDestinations('agents: [{ name: loge1, kind: claude }]')).toThrow(
      /must declare a secrets-file credential key/,
    );
  });

  test('rejects an invalid declared destination key', () => {
    expect(() =>
      claudeCredentialDestinations(
        'agents: [{ name: loge1, kind: claude, credential: { source: secrets-file, key: bad-key } }]',
      ),
    ).toThrow(/must declare a secrets-file credential key/);
  });
});

describe('hasDirectClaudeCredential', () => {
  test('matches only direct slots 1 through 6', () => {
    expect(hasDirectClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_1: 'one' })).toBe(true);
    expect(hasDirectClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_0: 'zero' })).toBe(false);
    expect(hasDirectClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_7: 'seven' })).toBe(false);
    expect(hasDirectClaudeCredential({ CODEX_OAUTH_TOKEN_PE_LLM_1: 'codex' })).toBe(false);
  });
});

describe('claudeSopsEnvTokens', () => {
  test('maps only the six direct Claude slots to their declared SOPS env names', () => {
    const tokens = claudeSopsEnvTokens(
      {
        CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_6: ' sk-ant-oat-sixth-token\n',
        CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_2: JSON.stringify({
          accessToken: 'sk-ant-oat-second-token',
          refreshToken: 'refresh-token',
        }),
        CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_0: 'sk-ant-oat-slot-zero',
        CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_7: 'proxy-only-token',
        CODEX_OAUTH_TOKEN_PE_LLM_1: 'codex-token',
        OTHER_SECRET: 'ignored',
      },
      claudeCredentialDestinations(configYaml),
    );

    expect(tokens).toEqual([
      {
        source: 'CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_2',
        destination: 'LOGE_CLAUDE_2_TOKEN',
        value: 'sk-ant-oat-second-token',
      },
      {
        source: 'CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_6',
        destination: 'LOGE_CLAUDE_6_TOKEN',
        value: 'sk-ant-oat-sixth-token',
      },
    ]);
  });
});

describe('normalizeClaudeOAuthAccessToken', () => {
  test('accepts raw and snake/camel-case OAuth JSON without storing the JSON blob', () => {
    expect(normalizeClaudeOAuthAccessToken('raw', ' sk-ant-oat-raw-token\n')).toBe('sk-ant-oat-raw-token');
    expect(
      normalizeClaudeOAuthAccessToken(
        'snake',
        JSON.stringify({ access_token: 'sk-ant-oat-snake', refresh_token: 'refresh-snake' }),
      ),
    ).toBe('sk-ant-oat-snake');
    expect(
      normalizeClaudeOAuthAccessToken(
        'camel',
        JSON.stringify({ accessToken: 'sk-ant-oat-camel', refreshToken: 'refresh-camel' }),
      ),
    ).toBe('sk-ant-oat-camel');
  });

  test('rejects API-key JSON for an OAuth-token destination', () => {
    expect(() => normalizeClaudeOAuthAccessToken('api-key', JSON.stringify({ api_key: 'sk-ant-api-key' }))).toThrow(
      /does not contain a Claude OAuth access token/,
    );
  });
});
