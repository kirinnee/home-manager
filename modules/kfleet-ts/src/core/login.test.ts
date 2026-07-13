import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credStatus, isOAuth, pickDonor, syncIdentity } from './login';
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

  test('codex: OPENAI_API_KEY/BASE_URL env ⇒ api-key; plain ⇒ OAuth', () => {
    expect(isOAuth({ name: 'personal', kind: 'codex' })).toBe(true);
    expect(isOAuth({ name: 'loge', kind: 'codex', env: { OPENAI_API_KEY: 'loge-internal' } })).toBe(false);
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
