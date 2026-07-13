// Fleet login: sync credentials across each identity's variant dirs, and walk
// through one interactive OAuth login per identity that has none.
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../core/config';
import { type Identity, interactiveLogin, pickDonor, scanIdentities, syncIdentity } from '../core/login';
import { resolveAll } from '../core/merge';
import { logDim, logInfo, logOk, logWarn } from '../util/format';
import { loadOrDie } from './shared';

const stateIcon = (s: string): string =>
  s === 'valid' ? pc.green('✓') : s === 'refreshable' ? pc.yellow('~') : pc.red('✗');

function printStatus(identities: Identity[]): void {
  for (const id of identities) {
    if (!id.oauth) {
      logDim(`  ${id.kind}-${id.base}: api-key account — no login needed`);
      continue;
    }
    const parts = id.members.map(m => `${stateIcon(m.state)} ${m.name}`).join('  ');
    console.log(`  ${pc.bold(`${id.kind}-${id.base}`)}: ${parts}`);
  }
  logDim(`  (${pc.green('✓')} valid  ${pc.yellow('~')} expired-but-refreshable  ${pc.red('✗')} missing/dead)`);
}

export function createLoginCommand(): Command {
  return new Command('login')
    .description('sync OAuth credentials across all variants of each account; interactive login for the rest')
    .argument('[names...]', 'only these base agents (default: all)')
    .option('--status', 'report credential state only, change nothing')
    .option('--sync-only', 'clone credentials but skip interactive logins')
    .action(async (names: string[], opts: { status?: boolean; syncOnly?: boolean }) => {
      const config = loadOrDie(() => loadConfig());
      const agents = loadOrDie(() => resolveAll(config));
      let identities = await scanIdentities(agents);
      if (names.length) identities = identities.filter(id => names.includes(id.base));
      if (!identities.length) return logWarn('no matching agents');

      if (opts.status) return printStatus(identities);

      const needInteractive: Identity[] = [];
      for (const id of identities.filter(i => i.oauth)) {
        const donor = pickDonor(id.members);
        if (!donor) {
          needInteractive.push(id);
          continue;
        }
        const synced = await syncIdentity(id, donor);
        if (synced.length) logOk(`${id.kind}-${id.base}: synced ${donor.name} → ${synced.join(', ')}`);
        else logDim(`  ${id.kind}-${id.base}: all ${id.members.length} dirs already logged in`);
      }

      if (!needInteractive.length) return logOk('fleet is fully logged in');
      if (opts.syncOnly) {
        for (const id of needInteractive)
          logWarn(`${id.kind}-${id.base}: no credential anywhere — run \`kfleet login ${id.base}\` to log in`);
        return;
      }

      for (const id of needInteractive) {
        logInfo(
          `${id.kind}-${id.base}: interactive login — approve in the browser, then quit the CLI to continue` +
            (id.kind === 'claude' ? ' (Ctrl+C twice after "/login" finishes)' : ''),
        );
        await interactiveLogin(id);
        // Re-scan just this identity and fan the fresh credential out.
        const [rescanned] = await scanIdentities(
          agents.filter(a => a.kind === id.kind && (a.identity ?? a.base ?? a.name) === id.base),
        );
        const donor = rescanned && pickDonor(rescanned.members);
        if (!rescanned || !donor) {
          logWarn(`${id.kind}-${id.base}: still no usable credential — skipped`);
          continue;
        }
        const synced = await syncIdentity(rescanned, donor);
        logOk(`${id.kind}-${id.base}: logged in${synced.length ? ` + synced → ${synced.join(', ')}` : ''}`);
      }
    });
}
