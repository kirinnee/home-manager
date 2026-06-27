#!/usr/bin/env bun
// khost — control the host-exposure suite (SSH over a self-provisioned
// Cloudflare Tunnel + Grafana Alloy metrics). Config lives in ~/.khost/; running
// this binary IS the manual enable/disable.
import { Command } from 'commander';
import pc from 'picocolors';
import {
  alloyConfigFile,
  alloyPort,
  cfAccountId,
  cfApiToken,
  configFile,
  machineId,
  metricsPort,
  stateDir,
  tunnelName,
} from './deps';
import { existsSync } from 'node:fs';
import { ok } from './exec';
import { init } from './init';
import { tunnelDown, tunnelStatus, tunnelUp } from './tunnel';
import { alloyDown, alloyEdit, alloyLogs, alloyRestart, alloyStatus, alloyUp } from './alloy';
import { createMetricsCommand } from './metrics';
import { sshDown, sshSetup, sshStatus } from './ssh';
import { routeLs, routeSync } from './routes';
import { doctor } from './doctor';

function suiteStatus(): void {
  console.log(`${pc.bold('khost')} — host-exposure suite\n`);
  console.log(`  machine     : ${machineId}`);
  console.log(`  tunnel name : ${tunnelName}`);
  console.log(`  alloy       : 127.0.0.1:${alloyPort}`);
  console.log(`  metrics     : 127.0.0.1:${metricsPort}`);
  console.log(`  config      : ${configFile}`);
  console.log(`  state dir   : ${stateDir}`);
  console.log(
    existsSync(alloyConfigFile)
      ? `  alloy cfg   : ${pc.green('present')} (${alloyConfigFile})`
      : `  alloy cfg   : ${pc.yellow('missing')} — run "khost init"`,
  );
  console.log(
    cfApiToken && cfAccountId
      ? `  cloudflare  : ${pc.green('configured')}`
      : `  cloudflare  : ${pc.yellow('not set')} — set cloudflare.* in config.yaml`,
  );
  console.log(
    `\n  lifecycle   : manual + idempotent. Run "khost up" to heal/bring up the` +
      `\n                whole suite (ssh, alloy, tunnel); re-run anytime` +
      `\n                to reconcile drift. Nothing auto-starts at boot.`,
  );
}

const program = new Command();
program.name('khost').description('Host-exposure suite: SSH over Cloudflare Tunnel + Grafana Alloy');

program
  .command('up')
  .description('heal + bring up the whole suite (ssh + alloy + tunnel)')
  .action(async () => {
    await sshSetup(); // enable + harden sshd
    await alloyUp(); // self-guards: no-op if no alloy config
    await tunnelUp(); // self-guards: no-op if Cloudflare creds absent
    await routeSync(); // self-guards: no-op if no routes / no creds
    ok('suite up — run "khost status" / "khost route ls" for details');
  });

program
  .command('down')
  .description('tear down the whole suite')
  .action(async () => {
    await tunnelDown().catch(() => {});
    await alloyDown().catch(() => {});
    ok('suite down');
  });

program.command('status').description('show suite configuration & state').action(suiteStatus);

program
  .command('init')
  .description('scaffold ~/.khost/config.yaml + alloy.alloy')
  .option('--force', 'overwrite existing files')
  .action((opts: { force?: boolean }) => init(opts));

program
  .command('doctor')
  .description('preflight: tooling, secrets, Cloudflare credentials, and Alloy')
  .action(async () => {
    const okAll = await doctor();
    process.exit(okAll ? 0 : 1);
  });

const alloy = program.command('alloy').description('manage the Grafana Alloy metrics collector');
alloy.command('up').action(alloyUp);
alloy.command('down').action(alloyDown);
alloy.command('restart').action(alloyRestart);
alloy.command('status').action(alloyStatus);
alloy
  .command('logs')
  .allowUnknownOption(true)
  .argument('[args...]')
  .action((args: string[]) => alloyLogs(args ?? []));
alloy.command('edit').description('edit ~/.khost/alloy.alloy in $EDITOR').action(alloyEdit);

program.addCommand(createMetricsCommand());

const tunnel = program.command('tunnel').description('manage the Cloudflare Tunnel');
tunnel.command('up').action(tunnelUp);
tunnel.command('down').action(tunnelDown);
tunnel.command('status').action(tunnelStatus);

const route = program.command('route').description('manage public hostname routes (ingress + DNS + Access)');
route.command('ls').description('show desired (config.yaml) vs live ingress').action(routeLs);
route
  .command('sync')
  .description('reconcile Cloudflare to config.yaml routes')
  .option('--prune', 'delete khost-owned routes/DNS/apps not in config.yaml')
  .option('--dry-run', 'print the plan, change nothing')
  .action((opts: { prune?: boolean; dryRun?: boolean }) => routeSync({ prune: opts.prune, dryRun: opts.dryRun }));

const ssh = program.command('ssh').description('manage the loopback sshd for the tunnel');
ssh.command('setup').description('install + start loopback sshd on 127.0.0.1').action(sshSetup);
ssh.command('down').description('stop + remove the loopback sshd').action(sshDown);
ssh.command('status').action(sshStatus);

program.parseAsync(process.argv);
