#!/usr/bin/env bun
// khost — control the host-exposure suite (CLIProxyAPI :8317 + SSH over a
// self-provisioned Cloudflare Tunnel, reachable only by verified WARP devices).
// Config lives in this repo; running this binary IS the manual enable/disable.
import { Command } from 'commander';
import pc from 'picocolors';
import { cfAccountId, cfApiToken, fragmentPath, proxyPort, stateDir, tunnelName } from './deps';
import { existsSync } from 'node:fs';
import { ok } from './exec';
import {
  proxyAuth,
  proxyDown,
  proxyEdit,
  proxyImport,
  proxyLogs,
  proxyPin,
  proxyRestart,
  proxyStatus,
  proxyUp,
  proxyUpdate,
} from './proxy';
import { tunnelDown, tunnelStatus, tunnelUp } from './tunnel';
import { sshDown, sshSetup, sshStatus } from './ssh';
import { routeLs, routeSync } from './routes';
import { doctor } from './doctor';

function suiteStatus(): void {
  console.log(`${pc.bold('khost')} — host-exposure suite\n`);
  console.log(`  tunnel name : ${tunnelName}`);
  console.log(`  proxy       : 127.0.0.1:${proxyPort}`);
  console.log(`  state dir   : ${stateDir}`);
  console.log(
    existsSync(fragmentPath)
      ? `  secrets     : ${pc.green('present')} (${fragmentPath})`
      : `  secrets     : ${pc.yellow('missing')} — run "khost proxy import"`,
  );
  console.log(
    cfApiToken && cfAccountId
      ? `  cloudflare  : ${pc.green('configured')}`
      : `  cloudflare  : ${pc.yellow('not set')} — CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID absent`,
  );
  console.log(
    `\n  lifecycle   : manual + idempotent. Run "khost up" to heal/bring up the` +
      `\n                whole suite (ssh, proxy, tunnel); re-run anytime` +
      `\n                to reconcile drift. Nothing auto-starts at boot.`,
  );
}

const program = new Command();
program.name('khost').description('Host-exposure suite: CLIProxyAPI :8317 + SSH over Cloudflare Tunnel');

program
  .command('up')
  .description('heal + bring up the whole suite (ssh + proxy + tunnel)')
  .action(async () => {
    await sshSetup(); // enable + harden sshd
    await proxyUp(); // render config + (re)create container if changed
    await tunnelUp(); // self-guards: no-op if Cloudflare creds absent
    await routeSync(); // self-guards: no-op if no routes / no creds
    ok('suite up — run "khost status" / "khost route ls" for details');
  });

program
  .command('down')
  .description('tear down the whole suite')
  .action(async () => {
    await tunnelDown().catch(() => {});
    await proxyDown().catch(() => {});
    ok('suite down');
  });

program.command('status').description('show suite configuration & state').action(suiteStatus);

program
  .command('doctor')
  .description('preflight: tooling, secrets, and Cloudflare credentials')
  .action(async () => {
    const okAll = await doctor();
    process.exit(okAll ? 0 : 1);
  });

const proxy = program.command('proxy').description('manage the CLIProxyAPI container');
proxy.command('up').action(proxyUp);
proxy.command('down').action(proxyDown);
proxy.command('restart').action(proxyRestart);
proxy.command('status').action(proxyStatus);
proxy
  .command('logs')
  .allowUnknownOption(true)
  .argument('[args...]')
  .action((args: string[]) => proxyLogs(args ?? []));
proxy.command('update').description('pull newest image + recreate').action(proxyUpdate);
proxy.command('pin').argument('<digest>').action(proxyPin);
proxy.command('auth').argument('<provider>').action(proxyAuth);
proxy
  .command('import')
  .argument('[config.yaml]')
  .description('split a live config.yaml into skeleton + sops fragment')
  .action((src?: string) => proxyImport(src));
proxy.command('edit').description('sops-edit the secret fragment').action(proxyEdit);

const tunnel = program.command('tunnel').description('manage the Cloudflare Tunnel');
tunnel.command('up').action(tunnelUp);
tunnel.command('down').action(tunnelDown);
tunnel.command('status').action(tunnelStatus);

const route = program.command('route').description('manage public hostname routes (ingress + DNS + Access)');
route.command('ls').description('show desired (routes.yaml) vs live ingress').action(routeLs);
route
  .command('sync')
  .description('reconcile Cloudflare to routes.yaml')
  .option('--prune', 'delete khost-owned routes/DNS/apps not in routes.yaml')
  .option('--dry-run', 'print the plan, change nothing')
  .action((opts: { prune?: boolean; dryRun?: boolean }) => routeSync({ prune: opts.prune, dryRun: opts.dryRun }));

const ssh = program.command('ssh').description('manage the loopback sshd for the tunnel');
ssh.command('setup').description('install + start loopback sshd on 127.0.0.1').action(sshSetup);
ssh.command('down').description('stop + remove the loopback sshd').action(sshDown);
ssh.command('status').action(sshStatus);

program.parseAsync(process.argv);
