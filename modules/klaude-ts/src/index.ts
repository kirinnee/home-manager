#!/usr/bin/env bun
// klaude — run a crc-kirin (Claude Code remote-control) session inside a
// persistent zellij session, and re-attach to running ones. `printHelp` below is
// the authoritative usage description; keep it as the single source of truth.
import { die } from './exec';
import { attach } from './attach';
import { start } from './start';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'at') return attach();
  if (argv[0] === '-h' || argv[0] === '--help') return printHelp();

  // `-n`/`--name` is klaude's own flag (it names the zellij session and is
  // re-passed to claude as --name). Everything else is forwarded to claude
  // untouched, so any claude flag — --resume, --model, -- <prompt>, … — works.
  const { name, rest } = extractName(argv);
  return start(name, rest);
}

/** Pluck `-n`/`--name <value>` (and the `--name=v` / `-nv` spellings) out of
 *  argv; return it plus the remaining args to forward to claude. The separate
 *  `-n <value>` form requires a real value: a missing or flag-looking next token
 *  (e.g. `klaude -n --resume`) is a user mistake, so we die rather than silently
 *  eat the flag as the session name. */
function extractName(argv: string[]): { name?: string; rest: string[] } {
  const rest: string[] = [];
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-n' || a === '--name') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) die(`flag ${a} requires a session name`);
      name = v;
    } else if (a.startsWith('--name=')) name = a.slice('--name='.length);
    else if (a.startsWith('-n') && a.length > 2) name = a.slice(2);
    else rest.push(a);
  }
  return { name, rest };
}

function printHelp(): never {
  console.error(`klaude — crc-kirin (Claude remote-control) sessions wrapped in zellij

Usage:
  klaude [-n <name>] [claude flags...]   start (or re-attach to) a session
  klaude at                              pick a running session and attach

  -n, --name <name>   session name (zellij session + claude --name).
                      Defaults to the current directory's basename.

Any other flag is forwarded verbatim to claude when a NEW session is created,
e.g.:
  klaude --resume            klaude -r <session-id>
  klaude --model opus        klaude -n work --resume

If a session with that name already exists, klaude just attaches to it and the
extra flags are ignored (the running claude can't be reconfigured).`);
  process.exit(0);
}

main();
