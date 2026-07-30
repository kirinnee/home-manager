import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeAgent } from '../core/health';
import type { Identity, MemberStatus } from '../core/login';
import { nonLoginStatus, runLogin } from './login';

const missingIdentity = (): Identity => ({
  kind: 'claude',
  base: 'kirin',
  oauth: true,
  members: [
    { name: 'auto-kirin', variant: 'auto', dir: '/tmp/auto-kirin', state: 'missing' },
    { name: 'kirin', variant: 'default', dir: '/tmp/kirin', state: 'missing' },
  ],
});

const externalIdentity = (): Identity => ({
  kind: 'claude',
  base: 'loge1',
  oauth: false,
  credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' },
  members: [
    { name: 'loge1', variant: 'default', dir: '/tmp/loge1', state: 'missing' },
    { name: 'auto-loge1', variant: 'auto', dir: '/tmp/auto-loge1', state: 'missing' },
  ],
});

const logger = () => {
  const messages = { dim: [] as string[], info: [] as string[], ok: [] as string[], warn: [] as string[] };
  return {
    messages,
    log: {
      dim: (message: string) => messages.dim.push(message),
      info: (message: string) => messages.info.push(message),
      ok: (message: string) => messages.ok.push(message),
      warn: (message: string) => messages.warn.push(message),
    },
  };
};

describe('runLogin probe gate', () => {
  test('external-token identities are named clearly and never probed, synced, or logged in', async () => {
    const identity = externalIdentity();
    expect(nonLoginStatus(identity)).toBe(
      'claude-loge1: external-token account (~/.secrets key LOGE_CLAUDE_1_TOKEN) — no login needed',
    );

    const output = logger();
    let probeCalls = 0;
    let syncCalls = 0;
    let interactiveCalls = 0;
    const summary = await runLogin(
      [identity],
      [],
      { probe: true, syncOnly: false },
      {
        log: output.log,
        probe: async () => {
          probeCalls += 1;
          return { up: false };
        },
        syncIdentity: async () => {
          syncCalls += 1;
          return [];
        },
        interactiveLogin: async item => {
          interactiveCalls += 1;
          return item.members[0]!;
        },
      },
    );

    expect({ probeCalls, syncCalls, interactiveCalls }).toEqual({ probeCalls: 0, syncCalls: 0, interactiveCalls: 0 });
    expect(summary.loginNeeded).toBe(0);
    expect(summary.unresolved).toBe(0);
  });

  test('an unreadable credential with a passing probe skips interactive login', async () => {
    const output = logger();
    let interactiveCalls = 0;

    const summary = await runLogin(
      [missingIdentity()],
      [],
      { probe: true, syncOnly: false },
      {
        log: output.log,
        probe: async () => ({ up: true }),
        interactiveLogin: async identity => {
          interactiveCalls += 1;
          return identity.members[0]!;
        },
      },
    );

    expect(interactiveCalls).toBe(0);
    expect(summary.skippedWorking).toBe(1);
    expect(summary.loginNeeded).toBe(0);
    expect(output.messages.ok.some(message => message.includes('CLI works — skipping login'))).toBe(true);
    expect(output.messages.ok.some(message => message.includes('sibling variants were not verified or synced'))).toBe(
      true,
    );
  });

  test('a real sentinel wrapper proves an unreadable identity works without an LLM call', async () => {
    const output = logger();
    const bin = mkdtempSync(path.join(os.tmpdir(), 'kfleet-login-probe-bin-'));
    const name = `synthetic-${process.pid}-${Date.now()}`;
    const wrapper = path.join(bin, `codex-${name}`);
    writeFileSync(wrapper, '#!/bin/sh\nprintf "KFLEET_HEALTH_OK\\n"\n');
    chmodSync(wrapper, 0o755);
    let interactiveCalls = 0;

    const summary = await runLogin(
      [
        {
          kind: 'codex',
          base: name,
          oauth: true,
          members: [{ name, variant: 'default', dir: path.join(bin, 'missing-credential-dir'), state: 'missing' }],
        },
      ],
      [],
      { probe: true, syncOnly: false },
      {
        log: output.log,
        probe: member =>
          probeAgent(member, 1_000, {
            resolveWrapper: target => ({
              binary: `${target.kind}-${target.name}`,
              resolved: wrapper,
            }),
          }),
        interactiveLogin: async identity => {
          interactiveCalls += 1;
          return identity.members[0]!;
        },
      },
    );

    expect(summary.skippedWorking).toBe(1);
    expect(interactiveCalls).toBe(0);
  });

  test('a failed probe surfaces its error and falls through to interactive login', async () => {
    const output = logger();
    let interactiveCalls = 0;

    const summary = await runLogin(
      [missingIdentity()],
      [],
      { probe: true, syncOnly: false },
      {
        log: output.log,
        probe: async () => ({ up: false, error: 'token rejected by provider' }),
        interactiveLogin: async () => {
          interactiveCalls += 1;
          throw new Error('browser login cancelled');
        },
      },
    );

    expect(interactiveCalls).toBe(1);
    expect(summary.loginNeeded).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(output.messages.warn.some(message => message.includes('token rejected by provider'))).toBe(true);
    expect(output.messages.info).toEqual(['claude-kirin: opening Claude Code to log in']);
    expect(output.messages.dim.some(message => message.includes('type `/exit`'))).toBe(true);
  });

  test('--sync-only probes nothing and leaves the candidate explicitly untested', async () => {
    const output = logger();
    let probeCalls = 0;
    let interactiveCalls = 0;

    const summary = await runLogin(
      [missingIdentity()],
      [],
      { probe: true, syncOnly: true },
      {
        log: output.log,
        probe: async () => {
          probeCalls += 1;
          return { up: true };
        },
        interactiveLogin: async identity => {
          interactiveCalls += 1;
          return identity.members[0]!;
        },
      },
    );

    expect(probeCalls).toBe(0);
    expect(interactiveCalls).toBe(0);
    expect(summary.notChecked).toBe(1);
  });

  test('--no-probe forces the previous interactive-login path', async () => {
    const output = logger();
    let probeCalls = 0;
    let interactiveCalls = 0;
    const loggedIn: MemberStatus = {
      name: 'kirin',
      variant: 'default',
      dir: '/tmp/kirin',
      state: 'valid',
    };

    const summary = await runLogin(
      [missingIdentity()],
      [{ name: 'kirin', kind: 'claude' }],
      { probe: false, syncOnly: false },
      {
        log: output.log,
        probe: async () => {
          probeCalls += 1;
          return { up: true };
        },
        interactiveLogin: async () => {
          interactiveCalls += 1;
          return loggedIn;
        },
        scanIdentities: async () => [
          {
            ...missingIdentity(),
            members: [loggedIn, { name: 'auto-kirin', variant: 'auto', dir: '/tmp/auto-kirin', state: 'missing' }],
          },
        ],
        syncIdentity: async () => ['auto-kirin'],
      },
    );

    expect(probeCalls).toBe(0);
    expect(interactiveCalls).toBe(1);
    expect(summary.loginNeeded).toBe(1);
    expect(summary.loggedIn).toBe(1);
    expect(summary.synced).toBe(1);
  });
});
