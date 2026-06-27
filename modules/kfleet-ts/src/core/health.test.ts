import { describe, expect, test } from 'bun:test';
import { autoAgents } from './health';
import { configSchema } from './types';

describe('autoAgents', () => {
  test('returns the resolved auto-* variant wrappers, not the raw (un-prefixed) config names', () => {
    const config = configSchema.parse({
      variants: { default: {}, auto: { memory: './CLAUDE.auto.md' } },
      agents: [
        { name: 'kirin', kind: 'claude' },
        { name: 'gpt55', kind: 'codex' },
      ],
    });
    const auto = autoAgents(config)
      .map(a => `${a.kind}-${a.name}`)
      .sort();
    expect(auto).toEqual(['claude-auto-kirin', 'codex-auto-gpt55']);
  });

  test('with no auto variant declared there are no auto-* agents', () => {
    const config = configSchema.parse({ agents: [{ name: 'kirin', kind: 'claude' }] });
    expect(autoAgents(config)).toEqual([]);
  });
});
