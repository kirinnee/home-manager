import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credStatus,
  filterLiveIdentities,
  interactiveLogin,
  isOAuth,
  loginMember,
  pickDonor,
  resolveLoginTarget,
  scanIdentities,
  syncIdentity,
} from './login';
import type { Identity, MemberStatus } from './login';

// A JWT whose exp is far in the future / past (payload only — exp in seconds).
const jwt = (expSec: number): string => `x.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.y`;

describe('isOAuth', () => {
  test('claude: no base-url override ⇒ OAuth; third-party base url ⇒ api-key', () => {
    expect(isOAuth({ name: 'kirin', kind: 'claude' })).toBe(true);
    expect(
      isOAuth({ name: 'glm52a', kind: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }),
    ).toBe(false);
    expect(
      isOAuth({ name: 'dsv4f', kind: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }),
    ).toBe(false);
  });

  test('a declared external credential wins over OAuth URL/env heuristics', () => {
    expect(
      isOAuth({
        name: 'loge1',
        kind: 'claude',
        credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' },
        env: { CLAUDE_CODE_OAUTH_TOKEN: '$LOGE_CLAUDE_1_TOKEN' },
      }),
    ).toBe(false);
  });

  test('codex: OPENAI_API_KEY/BASE_URL env ⇒ api-key; plain ⇒ OAuth', () => {
    expect(isOAuth({ name: 'personal', kind: 'codex' })).toBe(true);
    expect(isOAuth({ name: 'loge', kind: 'codex', env: { OPENAI_API_KEY: 'loge-internal' } })).toBe(false);
  });
});

describe('scanIdentities: declared external credentials', () => {
  test('preserves the source and never scans it as a missing OAuth credential', async () => {
    const [identity] = await scanIdentities([
      {
        name: 'loge1',
        kind: 'claude',
        base: 'loge1',
        variant: 'default',
        credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' },
      },
      {
        name: 'auto-loge1',
        kind: 'claude',
        base: 'loge1',
        variant: 'auto',
        credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' },
      },
    ]);

    expect(identity).toMatchObject({
      kind: 'claude',
      base: 'loge1',
      oauth: false,
      credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' },
    });
    expect(identity?.members.map(member => member.state)).toEqual(['missing', 'missing']);
  });

  test('rejects a mixed external/OAuth identity independent of member order', async () => {
    const external = {
      name: 'loge1',
      kind: 'claude' as const,
      identity: 'shared',
      credential: { source: 'secrets-file' as const, key: 'LOGE_CLAUDE_1_TOKEN' },
    };
    const oauth = { name: 'kirin-alias', kind: 'claude' as const, identity: 'shared' };

    await expect(scanIdentities([external, oauth])).rejects.toThrow(/mixes credential sources/);
    await expect(scanIdentities([oauth, external])).rejects.toThrow(/mixes credential sources/);
  });
});

describe('pickDonor', () => {
  const m = (name: string, state: MemberStatus['state'], expiresAt?: number): MemberStatus => ({
    name,
    variant: 'default',
    dir: `/tmp/${name}`,
    state,
    expiresAt,
  });

  test('valid beats refreshable; later expiry wins among valid', () => {
    expect(pickDonor([m('a', 'refreshable', 9), m('b', 'valid', 1), m('c', 'valid', 5)])?.name).toBe('c');
  });

  test('refreshable is donor when nothing valid; none when all missing', () => {
    expect(pickDonor([m('a', 'missing'), m('b', 'refreshable', 2)])?.name).toBe('b');
    expect(pickDonor([m('a', 'missing'), m('b', 'missing')])).toBeUndefined();
  });
});

describe('loginMember', () => {
  test('prefers the default variant, falls back to the first member, and rejects an empty identity', () => {
    const auto: MemberStatus = { name: 'auto-kirin', variant: 'auto', dir: '/tmp/auto', state: 'missing' };
    const normal: MemberStatus = { name: 'kirin', variant: 'default', dir: '/tmp/default', state: 'missing' };
    const identity: Identity = { kind: 'claude', base: 'kirin', oauth: true, members: [auto, normal] };

    expect(loginMember(identity)).toBe(normal);
    expect(loginMember({ ...identity, members: [auto] })).toBe(auto);
    expect(() => loginMember({ ...identity, members: [] })).toThrow(/no members/);
  });
});

describe('filterLiveIdentities', () => {
  const identity = (base: string): Identity => ({
    kind: 'claude',
    base,
    oauth: true,
    members: [
      { name: `auto-${base}`, variant: 'auto', dir: `/tmp/auto-${base}`, state: 'missing' },
      { name: base, variant: 'default', dir: `/tmp/${base}`, state: 'missing' },
    ],
  });

  test('probes default members concurrently and partitions working from failed identities', async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const result = await filterLiveIdentities(
      [identity('works'), identity('broken')],
      async member => {
        calls.push(`${member.kind}-${member.name}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        active -= 1;
        return member.name === 'works' ? { up: true } : { up: false, error: 'token rejected' };
      },
      2,
    );

    expect(calls.sort()).toEqual(['claude-broken', 'claude-works']);
    expect(maxActive).toBe(2);
    expect(result.live.map(item => item.identity.base)).toEqual(['works']);
    expect(result.dead.map(item => [item.identity.base, item.error])).toEqual([['broken', 'token rejected']]);
  });

  test('turns a thrown probe error into an interactive-login candidate', async () => {
    const result = await filterLiveIdentities([identity('kirin')], async () => {
      throw new Error('probe crashed');
    });

    expect(result.live).toEqual([]);
    expect(result.dead[0]?.error).toBe('probe crashed');
  });

  test('carries the selected wrapper env into the probe target', async () => {
    const target = identity('kirin');
    target.members[1]!.env = { CLAUDE_CODE_OAUTH_TOKEN: '$CLAUDE_CODE_OAUTH_TOKEN' };
    let seen: Record<string, string> | undefined;

    await filterLiveIdentities([target], async member => {
      seen = member.env;
      return { up: true };
    });

    expect(seen).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '$CLAUDE_CODE_OAUTH_TOKEN' });
  });
});

describe('resolveLoginTarget', () => {
  const identity: Identity = {
    kind: 'claude',
    base: 'kirin',
    oauth: true,
    members: [{ name: 'kirin', variant: 'default', dir: '/tmp/kirin', state: 'missing' }],
  };

  test('uses the generated member wrapper when available', () => {
    const target = resolveLoginTarget(identity, {
      resolveWrapper: () => ({ binary: 'claude-kirin', resolved: '/managed/claude-kirin' }),
      which: () => {
        throw new Error('raw lookup must not run');
      },
    });

    expect(target.via).toBe('wrapper');
    expect(target.cmd).toEqual(['/managed/claude-kirin', '/login']);
  });

  test('falls back to the raw binary and keeps the existing missing-CLI error', () => {
    const resolveWrapper = () => ({ binary: 'claude-kirin' });
    expect(resolveLoginTarget(identity, { resolveWrapper, which: () => '/usr/bin/claude' })).toMatchObject({
      via: 'raw',
      cmd: ['/usr/bin/claude', '/login'],
    });
    expect(() => resolveLoginTarget(identity, { resolveWrapper, which: () => null })).toThrow(/CLI is not installed/);
  });

  test('seeds first-run flags before spawning the raw fallback', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kfleet-login-raw-'));
    const targetApiKey = 'sk-ant-raw-target-key-that-is-longer-than-twenty';
    const rawIdentity: Identity = {
      ...identity,
      members: [{ ...identity.members[0]!, dir, env: { ANTHROPIC_API_KEY: targetApiKey } }],
    };
    let spawned = false;

    await interactiveLogin(rawIdentity, {
      resolveWrapper: () => ({ binary: 'claude-kirin' }),
      which: () => '/usr/bin/claude',
      cwd: '/workspace',
      env: { PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'wrong-inherited-key' },
      spawn: options => {
        const config = JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')) as Record<string, any>;
        expect(config.hasCompletedOnboarding).toBe(true);
        expect(config.projects['/workspace'].hasTrustDialogAccepted).toBe(true);
        expect(config.customApiKeyResponses.approved).toEqual([targetApiKey.slice(-20)]);
        expect(options.cmd).toEqual(['/usr/bin/claude', '/login']);
        expect(options.env.CLAUDE_CONFIG_DIR).toBe(dir);
        expect(options.env.ANTHROPIC_API_KEY).toBe(targetApiKey);
        expect(options.env.CLAUDECODE).toBeUndefined();
        spawned = true;
        return { exited: Promise.resolve(0) };
      },
    });

    expect(spawned).toBe(true);
  });
});

describe('credStatus (codex)', () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), 'kfleet-login-'));

  test('valid / refreshable / missing from auth.json', async () => {
    const now = 1_000_000_000_000;
    const valid = dir();
    writeFileSync(
      path.join(valid, 'auth.json'),
      JSON.stringify({ tokens: { access_token: jwt(now / 1000 + 3600), refresh_token: 'r' } }),
    );
    expect((await credStatus('codex', valid, now)).state).toBe('valid');

    const expired = dir();
    writeFileSync(
      path.join(expired, 'auth.json'),
      JSON.stringify({ tokens: { access_token: jwt(now / 1000 - 60), refresh_token: 'r' } }),
    );
    expect((await credStatus('codex', expired, now)).state).toBe('refreshable');

    expect((await credStatus('codex', dir(), now)).state).toBe('missing');
  });
});

describe('syncIdentity (codex)', () => {
  test('clones the donor auth.json onto non-valid siblings only', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kfleet-login-sync-'));
    const mk = (name: string): string => {
      const d = path.join(root, name);
      mkdirSync(d);
      return d;
    };
    const donorDir = mk('donor');
    writeFileSync(path.join(donorDir, 'auth.json'), '{"tokens":{"access_token":"fresh"}}');
    const staleDir = mk('stale');
    writeFileSync(path.join(staleDir, 'auth.json'), '{"tokens":{"access_token":"old"}}');
    const okDir = mk('ok');
    writeFileSync(path.join(okDir, 'auth.json'), '{"tokens":{"access_token":"already-good"}}');

    const donor: MemberStatus = { name: 'personal', variant: 'default', dir: donorDir, state: 'valid' };
    const identity: Identity = {
      kind: 'codex',
      base: 'personal',
      oauth: true,
      members: [
        donor,
        { name: 'auto-personal', variant: 'auto', dir: staleDir, state: 'refreshable' },
        { name: 'f5-personal', variant: 'f5', dir: okDir, state: 'valid' },
      ],
    };

    const synced = await syncIdentity(identity, donor);

    expect(synced).toEqual(['auto-personal']);
    expect(readFileSync(path.join(staleDir, 'auth.json'), 'utf8')).toContain('fresh');
    expect(readFileSync(path.join(okDir, 'auth.json'), 'utf8')).toContain('already-good'); // untouched
  });
});
