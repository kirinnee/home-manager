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
import { jwtExpMs, keychainSuffix, readClaudeCred } from './creds';
import { seedFirstRunFlags } from './firstrun';
import { type AgentProbeTarget, prepareAgentEnv, resolveAgentWrapper } from './health';
import type { Kind, ResolvedAgent } from './types';

const KEYCHAIN_TIMEOUT_MS = 5_000;
const EXPIRY_SKEW_MS = 60_000; // a token this close to expiry counts as expired

type CredState = 'valid' | 'refreshable' | 'missing';

export interface MemberStatus {
  /** resolved (variant-infixed) agent name, e.g. "auto-kirin" */
  name: string;
  variant: string;
  dir: string;
  state: CredState;
  /** Resolved wrapper env, used only to distinguish intentional auth/model
   * variables from contamination inherited from the calling agent session. */
  env?: Record<string, string>;
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

export type LivenessProbe = (member: AgentProbeTarget) => Promise<{ up: boolean; error?: string }>;

export interface IdentityProbeResult {
  identity: Identity;
  member: MemberStatus;
  error?: string;
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
    const blob = await readClaudeCred(dir, KEYCHAIN_TIMEOUT_MS);
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
    id.members.push({
      name: a.name,
      variant: a.variant ?? 'default',
      dir,
      ...(a.env ? { env: a.env } : {}),
      ...status,
    });
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

/** The member whose wrapper represents an identity for both probing and login. */
export function loginMember(identity: Identity): MemberStatus {
  const member = identity.members.find(m => m.variant === 'default') ?? identity.members[0];
  if (!member) throw new Error(`identity "${identity.base}": no members`);
  return member;
}

/** Probe would-be interactive identities concurrently, preserving input order
 * in each partition. Probe failures are data: they must lead to login, not crash
 * the entire fleet command. */
export async function filterLiveIdentities(
  identities: Identity[],
  probe: LivenessProbe,
  concurrency = 4,
): Promise<{ live: IdentityProbeResult[]; dead: IdentityProbeResult[] }> {
  const results: Array<IdentityProbeResult & { up: boolean }> = new Array(identities.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < identities.length) {
      const index = next++;
      const identity = identities[index]!;
      const member = loginMember(identity);
      try {
        const result = await probe({
          name: member.name,
          kind: identity.kind,
          ...(member.env ? { env: member.env } : {}),
        });
        results[index] = { identity, member, up: result.up, error: result.error };
      } catch (error) {
        results[index] = {
          identity,
          member,
          up: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  const workerCount = Math.min(identities.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    live: results.filter(result => result.up).map(({ up: _up, ...result }) => result),
    dead: results.filter(result => !result.up).map(({ up: _up, ...result }) => result),
  };
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
    const blob = await readClaudeCred(donor.dir, KEYCHAIN_TIMEOUT_MS);
    if (!blob) return [];
    if (process.platform === 'darwin') {
      const account = await keychainAccount(claudeService(donor.dir));
      for (const t of targets) {
        if (await writeKeychain(claudeService(t.dir), account, blob)) {
          syncOauthAccount(donor.dir, t.dir);
          synced.push(t.name);
        }
      }
    } else {
      // Linux: Claude Code keeps the blob as a plain file in the config dir.
      for (const t of targets) {
        writeFileSync(path.join(t.dir, '.credentials.json'), blob, { mode: 0o600 });
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

export interface LoginTarget {
  member: MemberStatus;
  cmd: string[];
  via: 'wrapper' | 'raw';
}

interface LoginTargetDeps {
  resolveWrapper?: typeof resolveAgentWrapper;
  which?: (binary: string) => string | null;
}

interface InteractiveLoginDeps extends LoginTargetDeps {
  cwd?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  seed?: typeof seedFirstRunFlags;
  spawn?: (options: {
    cmd: string[];
    env: NodeJS.ProcessEnv;
    stdin: 'inherit';
    stdout: 'inherit';
    stderr: 'inherit';
  }) => { exited: Promise<number> };
}

/** Resolve the generated wrapper used by normal sessions, with a raw CLI
 * fallback for fresh machines where `kfleet apply` has not run yet. */
export function resolveLoginTarget(identity: Identity, deps: LoginTargetDeps = {}): LoginTarget {
  const member = loginMember(identity);
  const spec = KIND_SPECS[identity.kind];
  const wrapper = (deps.resolveWrapper ?? resolveAgentWrapper)({ name: member.name, kind: identity.kind }).resolved;
  if (wrapper) {
    return {
      member,
      cmd: identity.kind === 'claude' ? [wrapper, '/login'] : [wrapper, 'login'],
      via: 'wrapper',
    };
  }

  const bin = (deps.which ?? (binary => Bun.which(binary)))(spec.bin);
  if (!bin) {
    throw new Error(
      `the "${spec.bin}" CLI is not installed on this machine — install it (or log this account in on a machine that has it and re-run \`kfleet login\` to sync)`,
    );
  }
  return { member, cmd: identity.kind === 'claude' ? [bin, '/login'] : [bin, 'login'], via: 'raw' };
}

/** Run one interactive OAuth login for an identity. The generated wrapper is
 * preferred so login gets the same env, flags, and prompt suppression as normal
 * sessions. The TypeScript seeder makes the raw fallback safe on a fresh box. */
export async function interactiveLogin(identity: Identity, deps: InteractiveLoginDeps = {}): Promise<MemberStatus> {
  const target = resolveLoginTarget(identity, deps);
  const spec = KIND_SPECS[identity.kind];
  const sourceEnv = deps.env ?? process.env;
  const baseEnv = prepareAgentEnv(target.member.env, sourceEnv);
  (deps.seed ?? seedFirstRunFlags)(identity.kind, target.member.dir, deps.cwd ?? process.cwd(), baseEnv);
  const spawn = deps.spawn ?? (options => Bun.spawn(options));
  const proc = spawn({
    cmd: target.cmd,
    env: { ...baseEnv, ...spec.wrapperEnv(target.member.name, target.member.dir) },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await proc.exited;
  return target.member;
}
