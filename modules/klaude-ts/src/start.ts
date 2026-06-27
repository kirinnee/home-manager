// `klaude [-n <name>]` — start (or re-attach to) a crc-kirin remote-control
// session living inside a persistent zellij session.
import { basename } from 'node:path';
import { die, log, need } from './exec';
import { attachSession, sessionExists, startSession } from './zellij';

/**
 * `-n` names BOTH the zellij session and the crc-kirin display name. Omitted, it
 * defaults to the current directory's basename. If a zellij session with that
 * name already exists, we attach to it instead of spawning a second crc-kirin —
 * so `klaude` is idempotent per name. `claudeArgs` are any extra flags the user
 * passed (e.g. --resume, --model); they're forwarded verbatim to crc-kirin when
 * a NEW session is created. When an existing session is re-attached they can't
 * take effect (the claude process is already running), so we warn rather than
 * silently drop them.
 */
export async function start(name?: string, claudeArgs: string[] = []): Promise<void> {
  await need('zellij');
  const crc = await need('crc-kirin', 'is the claude-multi `crc` alias installed? run hms');

  const session = sanitize(name ?? basename(process.cwd()));
  if (!session) die('could not derive a session name — pass one with -n <name>');

  if (await sessionExists(session)) {
    if (claudeArgs.length) {
      log(`ignoring flags (${claudeArgs.join(' ')}) — attaching to the running "${session}" session`);
    }
    log(`session "${session}" already exists — attaching`);
    process.exit(await attachSession(session));
  }

  log(`starting crc-kirin in zellij session "${session}"`);
  process.exit(await startSession(session, process.cwd(), crc, ['-n', session, ...claudeArgs]));
}

/** zellij session names must be free of whitespace and path separators. */
function sanitize(s: string): string {
  return s
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
