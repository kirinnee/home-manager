#!/usr/bin/env bun
// klaude — run a crc-kirin (Claude Code remote-control) session inside a
// persistent zellij session, and re-attach to running ones.
//
//   klaude            start crc-kirin in a zellij session named after the cwd
//   klaude -n <name>  ...named <name> (sets both the zellij + crc-kirin name)
//   klaude at         pick a running zellij session and attach to it
import { Command } from 'commander';
import { attach } from './attach';
import { start } from './start';

const program = new Command();
program.name('klaude').description('crc-kirin (Claude remote-control) sessions wrapped in zellij');

program
  .command('start', { isDefault: true })
  .description('start (or re-attach to) a crc-kirin session inside zellij')
  .option('-n, --name <name>', 'session name (zellij session + crc-kirin --name)')
  .action((opts: { name?: string }) => start(opts.name));

program.command('at').description('pick a running zellij session and attach to it').action(attach);

program.parseAsync(process.argv);
