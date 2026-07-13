// `kfleet login` core: log the whole fleet in with the minimum of clicking.
//
// Every variant of one base agent (kirin, auto-kirin, f5-kirin, …) is the SAME
// provider account, but each config dir keeps its own credential copy (claude:
// a per-dir macOS Keychain item; codex: a per-dir auth.json). So most "logins"
// are really just copies: we group dirs into IDENTITIES (kind × base agent),
// pick the freshest credential in each as donor, and clone it to the sibling
// dirs. Only an identity with no usable credential anywhere needs a real
// interactive OAuth round-trip (one browser approval), after which its variants
// are synced from the fresh credential.
//
// API-key accounts (z.ai / minimax / deepseek / loge proxies) have no login —
// they're classified out up front.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KIND_SPECS } from './kinds';
import { jwtExpMs, keychainSuffix, readKeychain } from './creds';
import type { Kind, ResolvedAgent } from './types';

const KEYCHAIN_TIMEOUT_MS = 5_000;
const EXPIRY_SKEW_MS = 60_000; // a token this close to expiry counts as expired

export type CredState = 'valid' | 'refreshable' | 'missing';

export interface MemberStatus {
  /** resolved (variant-infixed) agent name, e.g. "auto-kirin" */
  name: string;
  variant: string;
  dir: string;
  state: CredState;
  /** epoch ms the access token expires (valid/refreshable only, when known) */
  expiresAt?: number;
}

export interface Identity {
  kind: Kind;
  base: string;
  /** true = provider OAuth account (loginable); false = static API key (skipped) */
  oauth: boolean;
  members: MemberStatus[];
}

/** Whether this agent authenticates via provider OAuth (vs a static API key). */
export function isOAuth(agent: ResolvedAgent): boolean {
  if (agent.kind === 'claude') {
    const baseUrl = agent.env?.ANTHROPIC_BASE_URL ?? '';
    return !baseUrl || baseUrl.includes('anthropic.com');
  }
  return !agent.env?.OPENAI_API_KEY && !agent.env?.OPENAI_BASE_URL;
}

const claudeService = (dir: string): string => `Claude Code-credentials-${keychainSuffix(dir)}`;

/** Read one dir's credential state. claude: keychain blob; codex: auth.json. */
export async function credStatus(
  kind: Kind,
  dir: string,
  now = Date.now(),
): Promise<Omit<MemberStatus, 'name' | 'variant' | 'dir'>> {
  if (kind === 'claude') {
    const blob = await readKeychain(claudeService(dir), KEYCHAIN_TIMEOUT_MS);
    if (!blob) return { state: 'missing' };
    try {
      const parsed = JSON.parse(blob) as Record<string, unknown>;
      const creds = (parsed.claudeAiOauth as Record<string, unknown>) ?? parsed;
      const expiresAt = typeof creds.expiresAt === 'number' ? creds.expiresAt : undefined;
      if (creds.accessToken && expiresAt && expiresAt > now + EXPIRY_SKEW_MS) return { state: 'valid', expiresAt };
      return { state: creds.refreshToken ? 'refreshable' : 'missing', expiresAt };
    } catch {
      return { state: 'missing' };
    }
  }
  const authPath = path.join(dir, 'auth.json');
  if (!existsSync(authPath)) return { state: 'missing' };
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as {
      tokens?: { access_token?: string; refresh_token?: string };
    };
    if (!auth.tokens?.access_token) return { state: 'missing' };
    const expiresAt = jwtExpMs(auth.tokens.access_token);
    if (expiresAt && expiresAt > now + EXPIRY_SKEW_MS) return { state: 'valid', expiresAt };
    return { state: auth.tokens.refresh_token ? 'refreshable' : 'missing', expiresAt };
  } catch {
    return { state: 'missing' };
  }
}

/** Group resolved agents into login identities (kind × base agent) with the
 *  per-dir credential state filled in. */
export async function scanIdentities(agents: ResolvedAgent[], now = Date.now()): Promise<Identity[]> {
  const byKey = new Map<string, Identity>();
  for (const a of agents) {
    const base = a.identity ?? a.base ?? a.name;
    const key = `${a.kind}:${base}`;
    let id = byKey.get(key);
    if (!id) {
      id = { kind: a.kind, base, oauth: isOAuth(a), members: [] };
      byKey.set(key, id);
    }
    const dir = KIND_SPECS[a.kind].configDir(a.name);
    const status = id.oauth ? await credStatus(a.kind, dir, now) : { state: 'missing' as const };
    id.members.push({ name: a.name, variant: a.variant ?? 'default', dir, ...status });
  }
  return [...byKey.values()];
}

/** Best credential to clone: a valid one with the latest expiry, else the most
 *  recently expiring refreshable one. */
export function pickDonor(members: MemberStatus[]): MemberStatus | undefined {
  const rank = (m: MemberStatus): number => (m.state === 'valid' ? 2 : m.state === 'refreshable' ? 1 : 0);
  const best = [...members].sort((a, b) => rank(b) - rank(a) || (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
  return best && best.state !== 'missing' ? best : undefined;
}

/** The keychain "acct" attribute of a service item (needed to re-add it). */
async function keychainAccount(service: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['security', 'find-generic-password', '-s', service],
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return /"acct"<blob>="([^"]*)"/.exec(out)?.[1] ?? process.env.USER ?? '';
}

async function writeKeychain(service: string, account: string, blob: string): Promise<boolean> {
  // -U updates in place if the item exists.
  const proc = Bun.spawn({
    cmd: ['security', 'add-generic-password', '-U', '-a', account, '-s', service, '-w', blob],
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  return (await proc.exited) === 0;
}

/** Copy the donor's `oauthAccount` (display identity: email, org) into a target
 *  dir's .claude.json so /status and usage attribution match the credential. */
function syncOauthAccount(donorDir: string, targetDir: string): void {
  try {
    const donorCfg = JSON.parse(readFileSync(path.join(donorDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    if (!donorCfg.oauthAccount) return;
    const targetPath = path.join(targetDir, '.claude.json');
    const targetCfg = existsSync(targetPath)
      ? (JSON.parse(readFileSync(targetPath, 'utf8')) as Record<string, unknown>)
      : {};
    targetCfg.oauthAccount = donorCfg.oauthAccount;
    writeFileSync(targetPath, JSON.stringify(targetCfg, null, 2));
  } catch {
    /* display-only metadata — never fail a sync over it */
  }
}

/** Clone the donor credential onto every non-valid sibling dir. Returns the
 *  member names that were synced. */
export async function syncIdentity(identity: Identity, donor: MemberStatus): Promise<string[]> {
  const targets = identity.members.filter(m => m !== donor && m.state !== 'valid');
  if (!targets.length) return [];
  const synced: string[] = [];
  if (identity.kind === 'claude') {
    const blob = await readKeychain(claudeService(donor.dir), KEYCHAIN_TIMEOUT_MS);
    if (!blob) return [];
    const account = await keychainAccount(claudeService(donor.dir));
    for (const t of targets) {
      if (await writeKeychain(claudeService(t.dir), account, blob)) {
        syncOauthAccount(donor.dir, t.dir);
        synced.push(t.name);
      }
    }
  } else {
    // codex: auth.json is the whole credential. NOTE: codex refresh tokens
    // rotate, so clones can drift apart over time — re-running `kfleet login`
    // re-syncs from whichever copy is healthiest.
    const authPath = path.join(donor.dir, 'auth.json');
    if (!existsSync(authPath)) return [];
    const blob = readFileSync(authPath);
    for (const t of targets) {
      writeFileSync(path.join(t.dir, 'auth.json'), blob, { mode: 0o600 });
      synced.push(t.name);
    }
  }
  return synced;
}

/** Run one interactive OAuth login for an identity, in its default-variant dir
 *  (falling back to the first member). Hands the terminal to the real CLI:
 *  claude opens its TUI on /login; codex runs its localhost-callback flow.
 *  Resolves once the CLI exits; the caller re-scans and syncs. */
export async function interactiveLogin(identity: Identity): Promise<MemberStatus> {
  const member = identity.members.find(m => m.variant === 'default') ?? identity.members[0];
  if (!member) throw new Error(`identity "${identity.base}": no members`);
  const spec = KIND_SPECS[identity.kind];
  const bin = Bun.which(spec.bin) ?? spec.bin;
  const cmd = identity.kind === 'claude' ? [bin, '/login'] : [bin, 'login'];
  const proc = Bun.spawn({
    cmd,
    env: { ...process.env, ...spec.wrapperEnv(member.name, member.dir) },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await proc.exited;
  return member;
}
