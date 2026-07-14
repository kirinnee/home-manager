#!/usr/bin/env bun
// kloge — pull the loge credential pool out of the LLM cluster and run a local
// (or pushed-to-a-box) CLIProxyAPI in Docker that serves it, so you can point
// Claude Code / Codex / anything at http://127.0.0.1:8317 without the loge
// gateway or the tailnet.
//
// WARNING: `kloge pull` copies SHARED PRODUCTION credentials onto this machine.
// Running the same OAuth sessions from extra locations can get the accounts
// flagged and take loge down for everyone. See README.md.
import { Command } from 'commander';
import { DEFAULT_PORT, resolvePort } from './paths';
import { pull, renderOnly } from './pull';
import { down, logs, push, status, up } from './deploy';

const program = new Command();
program.name('kloge').description('Local/box CLIProxyAPI for the loge credential pool (Docker)').showHelpAfterError();

program
  .command('pull')
  .description('pull loge creds from the k8s Secret and render auth + config + compose')
  .option('-c, --context <ctx>', 'kube context', 'eks-llm-us-east-1')
  .option('-n, --namespace <ns>', 'secret namespace', 'loge')
  .option('-s, --secret <name>', 'secret name', 'loge-credentials')
  .option('-p, --port <port>', 'listen port', String(DEFAULT_PORT))
  .action(async o => {
    await pull({
      context: o.context,
      namespace: o.namespace,
      secret: o.secret,
      port: Number.parseInt(o.port, 10),
    });
  });

program
  .command('render')
  .description('re-render config.yaml + compose.yaml (e.g. to change the port) without pulling')
  .option('-p, --port <port>', 'listen port', String(resolvePort()))
  .action(async o => {
    await renderOnly(Number.parseInt(o.port, 10));
  });

program
  .command('up')
  .description('start the local CLIProxyAPI container (docker)')
  .action(async () => {
    await up();
  });

program
  .command('down')
  .description('stop the local CLIProxyAPI container')
  .action(async () => {
    await down();
  });

program
  .command('status')
  .description('show data dir, creds, container state, and served models')
  .action(async () => {
    await status();
  });

program
  .command('logs')
  .description('show CLIProxyAPI container logs')
  .option('-f, --follow', 'follow log output', false)
  .action(async o => {
    await logs(Boolean(o.follow));
  });

program
  .command('push')
  .argument('<host>', 'ssh target, e.g. user@box')
  .description('rsync ~/.kloge to a box and start CLIProxyAPI there (docker)')
  .option('-d, --dir <path>', 'remote dir (relative to remote home)', '.kloge')
  .option('--no-up', 'copy only; do not start the container on the box')
  .action(async (host, o) => {
    await push({ host, remoteDir: o.dir, start: o.up });
  });

program.parseAsync().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
