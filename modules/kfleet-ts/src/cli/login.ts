// Fleet login: sync credentials across each identity's variant dirs, prove
// credential-less CLIs are actually broken, and only then ask for OAuth.
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../core/config';
import { probeAgent } from '../core/health';
import {
  type Identity,
  type LivenessProbe,
  filterLiveIdentities,
  interactiveLogin,
  loginMember,
  pickDonor,
  scanIdentities,
  syncIdentity,
} from '../core/login';
import { resolveAll } from '../core/merge';
import type { ResolvedAgent } from '../core/types';
import { logDim, logInfo, logOk, logWarn } from '../util/format';
import { loadOrDie } from './shared';

const LOGIN_PROBE_TIMEOUT_MS = 25_000;

const stateIcon = (s: string): string =>
  s === 'valid' ? pc.green('✓') : s === 'refreshable' ? pc.yellow('~') : pc.red('✗');

/** Human-readable reason an identity is outside the interactive login workflow. */
export function nonLoginStatus(identity: Identity): string | undefined {
  if (identity.oauth) return undefined;
  if (identity.credential?.source === 'secrets-file') {
    return `${identity.kind}-${identity.base}: external-token account (~/.secrets key ${identity.credential.key}) — no login needed`;
  }
  return `${identity.kind}-${identity.base}: api-key account — no login needed`;
}

function printStatus(identities: Identity[]): void {
  let showedOAuth = false;
  for (const id of identities) {
    const skipped = nonLoginStatus(id);
    if (skipped) {
      logDim(`  ${skipped}`);
      continue;
    }
    showedOAuth = true;
    const parts = id.members.map(m => `${stateIcon(m.state)} ${m.name}`).join('  ');
    console.log(`  ${pc.bold(`${id.kind}-${id.base}`)}: ${parts}`);
  }
  if (showedOAuth)
    logDim(`  (${pc.green('✓')} valid  ${pc.yellow('~')} expired-but-refreshable  ${pc.red('✗')} missing/dead)`);
}

interface LoginLogger {
  dim: (message: string) => void;
  info: (message: string) => void;
  ok: (message: string) => void;
  warn: (message: string) => void;
}

interface LoginRunDeps {
  interactiveLogin: typeof interactiveLogin;
  log: LoginLogger;
  probe: LivenessProbe;
  scanIdentities: typeof scanIdentities;
  syncIdentity: typeof syncIdentity;
}

export interface LoginSummary {
  synced: number;
  skippedWorking: number;
  loginNeeded: number;
  loggedIn: number;
  unresolved: number;
  notChecked: number;
}

const defaultRunDeps: LoginRunDeps = {
  interactiveLogin,
  log: { dim: logDim, info: logInfo, ok: logOk, warn: logWarn },
  probe: member => probeAgent(member, LOGIN_PROBE_TIMEOUT_MS),
  scanIdentities,
  syncIdentity,
};

const count = (n: number, singular: string, plural = `${singular}s`): string => `${n} ${n === 1 ? singular : plural}`;

function printSummary(summary: LoginSummary, log: LoginLogger): void {
  const parts = [
    `${count(summary.synced, 'variant')} synced`,
    `${count(summary.skippedWorking, 'default wrapper')} already working (login skipped; siblings unchanged)`,
    `${count(summary.loginNeeded, 'identity', 'identities')} needed login (${summary.loggedIn} completed)`,
  ];
  if (summary.notChecked)
    parts.push(`${count(summary.notChecked, 'identity', 'identities')} not checked (--sync-only)`);
  parts.push(`${count(summary.unresolved, 'identity', 'identities')} unresolved`);
  log.ok(`done — ${parts.join('; ')}`);
}

function interactiveInstructions(identity: Identity, log: LoginLogger): void {
  const label = `${identity.kind}-${loginMember(identity).name}`;
  if (identity.kind === 'claude') {
    log.info(`${label}: opening Claude Code to log in`);
    log.dim('  Complete browser approval, wait for Claude to confirm login, then type `/exit` to return to kfleet.');
  } else {
    log.info(`${label}: opening Codex to log in`);
    log.dim('  Open the URL if prompted and approve it; Codex exits automatically when login completes.');
  }
}

/** Execute the mutable login workflow behind an injectable probe/login seam.
 * Unit tests use this directly, so no test ever launches a real LLM or browser. */
export async function runLogin(
  identities: Identity[],
  agents: ResolvedAgent[],
  options: { probe: boolean; syncOnly: boolean },
  overrides: Partial<LoginRunDeps> = {},
): Promise<LoginSummary> {
  const deps: LoginRunDeps = { ...defaultRunDeps, ...overrides };
  const summary: LoginSummary = {
    synced: 0,
    skippedWorking: 0,
    loginNeeded: 0,
    loggedIn: 0,
    unresolved: 0,
    notChecked: 0,
  };
  const candidates: Identity[] = [];

  for (const identity of identities.filter(item => item.oauth)) {
    const donor = pickDonor(identity.members);
    if (!donor) {
      candidates.push(identity);
      continue;
    }
    const synced = await deps.syncIdentity(identity, donor);
    summary.synced += synced.length;
    if (synced.length) deps.log.ok(`${identity.kind}-${identity.base}: synced ${donor.name} → ${synced.join(', ')}`);
    else deps.log.dim(`  ${identity.kind}-${identity.base}: all ${identity.members.length} dirs already logged in`);
  }

  if (!candidates.length) {
    deps.log.ok('fleet is fully logged in');
    printSummary(summary, deps.log);
    return summary;
  }

  if (options.syncOnly) {
    summary.notChecked = candidates.length;
    for (const identity of candidates) {
      deps.log.warn(
        `${identity.kind}-${identity.base}: no readable credential — run \`kfleet login ${identity.base}\` to check the CLI or log in`,
      );
    }
    printSummary(summary, deps.log);
    return summary;
  }

  let needInteractive = candidates;
  if (options.probe) {
    deps.log.dim(
      `  checking ${count(candidates.length, 'CLI')} with one cheap call each (${LOGIN_PROBE_TIMEOUT_MS / 1000}s max)…`,
    );
    const result = await filterLiveIdentities(candidates, deps.probe);
    summary.skippedWorking = result.live.length;
    for (const { identity, member } of result.live) {
      deps.log.ok(
        `${identity.kind}-${member.name}: no readable credential, but this CLI works — skipping login; sibling variants were not verified or synced`,
      );
    }
    for (const { identity, member, error } of result.dead) {
      deps.log.warn(
        `${identity.kind}-${member.name}: CLI check failed (${error ?? 'no successful response'}) — interactive login required`,
      );
    }
    needInteractive = result.dead.map(result => result.identity);
  }

  summary.loginNeeded = needInteractive.length;
  for (const identity of needInteractive) {
    interactiveInstructions(identity, deps.log);
    try {
      await deps.interactiveLogin(identity);
    } catch (error) {
      deps.log.warn(
        `${identity.kind}-${identity.base}: ${error instanceof Error ? error.message : String(error)} — skipped`,
      );
      summary.unresolved += 1;
      continue;
    }

    // Re-scan just this identity and fan the fresh credential out.
    const [rescanned] = await deps.scanIdentities(
      agents.filter(
        agent => agent.kind === identity.kind && (agent.identity ?? agent.base ?? agent.name) === identity.base,
      ),
    );
    const donor = rescanned && pickDonor(rescanned.members);
    if (!rescanned || !donor) {
      deps.log.warn(`${identity.kind}-${identity.base}: still no usable credential — skipped`);
      summary.unresolved += 1;
      continue;
    }
    const synced = await deps.syncIdentity(rescanned, donor);
    summary.synced += synced.length;
    summary.loggedIn += 1;
    deps.log.ok(
      `${identity.kind}-${identity.base}: logged in${synced.length ? ` + synced → ${synced.join(', ')}` : ''}`,
    );
  }

  printSummary(summary, deps.log);
  return summary;
}

export function createLoginCommand(): Command {
  return new Command('login')
    .description('sync OAuth credentials and prove a CLI is broken before asking for interactive login')
    .argument('[names...]', 'only these base agents (default: all)')
    .option('--status', 'report credential state only, change nothing')
    .option('--sync-only', 'clone credentials but skip probes and interactive logins')
    .option('--no-probe', 'skip liveness checks and force the previous interactive-login behavior')
    .action(async (names: string[], opts: { status?: boolean; syncOnly?: boolean; probe?: boolean }) => {
      const config = loadOrDie(() => loadConfig());
      const agents = loadOrDie(() => resolveAll(config));
      let identities = await scanIdentities(agents);
      if (names.length) identities = identities.filter(identity => names.includes(identity.base));
      if (!identities.length) return logWarn('no matching agents');

      if (opts.status) return printStatus(identities);
      await runLogin(identities, agents, {
        probe: opts.probe !== false,
        syncOnly: opts.syncOnly === true,
      });
    });
}
