import { describe, expect, test } from 'bun:test';
import { resolveAll } from './merge';
import { configSchema } from './types';

const cfg = (raw: unknown) => configSchema.parse(raw);

describe('resolveAll', () => {
  test('base merges into every agent', () => {
    const [r] = resolveAll(
      cfg({ profiles: { base: { env: { A: '1' }, settings: './s' } }, agents: [{ name: 'x', kind: 'claude' }] }),
    );
    expect(r.env).toEqual({ A: '1' });
    expect(r.settings).toBe('./s');
  });

  test('profiles apply left-to-right; env merges, flags concatenate, later wins', () => {
    const [r] = resolveAll(
      cfg({
        profiles: {
          base: { env: { A: '1' }, flags: ['--base'] },
          p1: { env: { B: '2' }, flags: ['--p1'] },
          p2: { env: { A: '9' }, flags: ['--p2'] },
        },
        agents: [{ name: 'x', kind: 'claude', profiles: ['p1', 'p2'], flags: ['--inline'], env: { C: '3' } }],
      }),
    );
    expect(r.env).toEqual({ A: '9', B: '2', C: '3' });
    expect(r.flags).toEqual(['--base', '--p1', '--p2', '--inline']);
  });

  test('inline scalar overrides profile scalar', () => {
    const [r] = resolveAll(
      cfg({ profiles: { base: { memory: './base.md' } }, agents: [{ name: 'x', kind: 'codex', memory: './own.md' }] }),
    );
    expect(r.memory).toBe('./own.md');
  });

  test('unknown profile throws', () => {
    expect(() => resolveAll(cfg({ agents: [{ name: 'x', kind: 'claude', profiles: ['nope'] }] }))).toThrow(
      /unknown profile "nope"/,
    );
  });

  test('base profile is optional', () => {
    const [r] = resolveAll(cfg({ agents: [{ name: 'x', kind: 'claude' }] }));
    expect(r.name).toBe('x');
  });

  test('with no variants declared, the implicit default yields one wrapper per agent (no infix)', () => {
    const r = resolveAll(cfg({ agents: [{ name: 'kirin', kind: 'claude' }] }));
    expect(r.map(a => a.name)).toEqual(['kirin']);
  });
});

describe('variants', () => {
  const base = {
    profiles: { autonomous: { memory: './CLAUDE.auto.md' }, hello: { settings: './s' } },
    variants: { default: { memory: './CLAUDE.md' }, auto: { profiles: ['autonomous'] } },
    agents: [{ name: 'kirin', kind: 'claude', profiles: ['hello'] }],
  };

  test('every agent is cloned across every variant; default has no infix, others infix V-', () => {
    const r = resolveAll(cfg(base));
    expect(r.map(a => a.name).sort()).toEqual(['auto-kirin', 'kirin']);
  });

  test('merge order base → agent.profiles → variant.profiles → variant.inline → agent.inline', () => {
    const r = resolveAll(cfg(base));
    const def = r.find(a => a.name === 'kirin');
    const auto = r.find(a => a.name === 'auto-kirin');
    expect(def?.settings).toBe('./s'); // from agent profile `hello`
    expect(def?.memory).toBe('./CLAUDE.md'); // default variant inline
    expect(auto?.memory).toBe('./CLAUDE.auto.md'); // auto variant's `autonomous` profile
    expect(auto?.settings).toBe('./s'); // still from `hello`
  });

  test("agent inline overrides the variant's inline", () => {
    const r = resolveAll(
      cfg({
        variants: { default: {}, auto: { memory: './CLAUDE.auto.md' } },
        agents: [{ name: 'x', kind: 'claude', memory: './own.md' }],
      }),
    );
    expect(r.find(a => a.name === 'auto-x')?.memory).toBe('./own.md');
  });
});
