import { describe, expect, test } from 'bun:test';
import type { CodexPrewarmResult } from '../core/codex-prewarm';
import { configSchema } from '../core/types';
import { createPrewarmCommand, parsePrewarmTimeoutSeconds, runCodexPrewarm } from './prewarm';

const result: CodexPrewarmResult = {
  sqliteDir: '/tmp/shared/codex/sqlite',
  elapsedMs: 42,
  activeThreadsReturned: 1,
  archivedThreadsReturned: 0,
};

describe('runCodexPrewarm', () => {
  test('refuses disabled sharing before spawning and gives the apply sequence', async () => {
    const config = configSchema.parse({});
    let called = false;
    await expect(
      runCodexPrewarm(config, 120, async () => {
        called = true;
        return result;
      }),
    ).rejects.toThrow(/sharedHistory\.codex is disabled.*kfleet apply.*kfleet prewarm codex/);
    expect(called).toBe(false);
  });

  test('converts seconds to milliseconds and delegates when sharing is enabled', async () => {
    const config = configSchema.parse({ sharedHistory: { codex: true } });
    let timeoutMs = 0;
    await expect(
      runCodexPrewarm(config, 12.5, async options => {
        timeoutMs = options.timeoutMs;
        return result;
      }),
    ).resolves.toEqual(result);
    expect(timeoutMs).toBe(12_500);
  });
});

describe('prewarm CLI', () => {
  test('validates positive finite timeout seconds', () => {
    expect(parsePrewarmTimeoutSeconds('2.5')).toBe(2.5);
    for (const value of ['0', '-1', 'nope', 'Infinity']) {
      expect(() => parsePrewarmTimeoutSeconds(value)).toThrow(/greater than zero/);
    }
  });

  test('prints the non-LLM intent and active + archived success result', async () => {
    const messages: string[] = [];
    let timeoutMs = 0;
    const command = createPrewarmCommand({
      load: () => configSchema.parse({ sharedHistory: { codex: true } }),
      prewarm: async options => {
        timeoutMs = options.timeoutMs;
        return result;
      },
      info: message => messages.push(message),
      ok: message => messages.push(message),
      fail: message => {
        throw new Error(message);
      },
    });

    await command.parseAsync(['node', 'prewarm', 'codex', '--timeout', '3']);

    expect(timeoutMs).toBe(3_000);
    expect(messages[0]).toContain('non-LLM: initialize + thread/list only');
    expect(messages[1]).toContain('active + archived');
    expect(messages[1]).toContain(result.sqliteDir);
  });
});
