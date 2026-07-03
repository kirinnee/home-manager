#!/usr/bin/env bun
// klaude/kodex — run Claude RC or Codex inside persistent zellij sessions.
// `printHelp` below is the authoritative usage description; keep it as the
// single source of truth.
import { die } from './exec';
import { attach } from './attach';
import { start } from './start';
import { parseArgs, targetFromRuntime, TARGETS } from './cli';

async function main(): Promise<void> {
  const target = targetFromRuntime();
  const spec = TARGETS[target];
  const argv = process.argv.slice(2);

  if (argv[0] === 'at') return attach();
  if (argv[0] === '-h' || argv[0] === '--help') return printHelp(spec.command);

  try {
    const handoff = argv[0] === 'handoff';
    const { name, detach, rest } = parseArgs(handoff ? argv.slice(1) : argv);
    if (handoff) {
      process.exit(await start({ target, name, detach: true, args: rest, mode: 'handoff' }));
    }
    process.exit(await start({ target, name, detach, args: rest }));
  } catch (e) {
    die((e as Error).message);
  }
}

function printHelp(command: 'klaude' | 'kodex'): never {
  const isCodex = command === 'kodex';
  console.error(`${command} — ${isCodex ? 'Codex' : 'crc-kirin (Claude remote-control)'} sessions wrapped in zellij

Usage:
  ${command} [-n <name>] [${isCodex ? 'codex' : 'claude'} flags...]   start (or re-attach to) a session
  ${command} --detach -n <name> [...]     start a detached session
  ${command} handoff [-n <name>] [...]     prepare a session for mobile/CLI handoff
  ${command} at                           pick a running session and attach

  -n, --name <name>   session name${isCodex ? '' : ' (zellij session + claude --name)'}.
                      Defaults to the current directory's basename.
      --detach        start in the background and print the attach command.

Any other flag is forwarded verbatim to ${isCodex ? 'codex' : 'claude'} when a NEW session is created,
e.g.:
  ${command} --resume
  ${command} --model ${isCodex ? 'gpt-5.3-codex' : 'opus'}
  ${command} -n work --resume
  ${command} handoff -n work

If a session with that name already exists, attached mode attaches to it; detached
mode prints the attach command. Extra flags are ignored for an existing session.`);
  process.exit(0);
}

main();
