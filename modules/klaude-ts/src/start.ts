// Start (or re-attach to) a Claude RC / Codex session living inside zellij.
import { basename } from 'node:path';
import { die, log, need } from './exec';
import { TARGETS, type TargetKind } from './cli';
import { attachSession, sessionExists, startDetachedSession, startSession } from './zellij';

export interface StartOptions {
  target: TargetKind;
  name?: string;
  detach?: boolean;
  args?: string[];
  mode?: 'normal' | 'handoff';
}

/**
 * `-n` names the zellij session. For Claude, the same value is also passed to
 * crc-kirin as `-n`. Omitted, it defaults to the current directory's basename.
 * If a zellij session with that name already exists, attached mode attaches to
 * it, while detached mode reports the attach command and exits successfully.
 */
export async function start(options: StartOptions): Promise<number> {
  const spec = TARGETS[options.target];
  const agentArgs = options.args ?? [];
  await need('zellij');
  if (options.detach) await need('tmux');
  const bin = await need(spec.binary, spec.missingHint);

  const session = sanitize(options.name ?? basename(process.cwd()));
  if (!session) die('could not derive a session name — pass one with -n <name>');

  if (await sessionExists(session)) {
    if (agentArgs.length) {
      log(`ignoring flags (${agentArgs.join(' ')}) — session "${session}" already exists`);
    }
    if (options.detach) {
      reportDetachedSession(spec.command, session, 'already exists');
      return 0;
    }
    log(`session "${session}" already exists — attaching`);
    return attachSession(session);
  }

  const args = spec.agentArgs(session, agentArgs);
  if (options.detach) {
    log(`starting ${spec.binary} in detached zellij session "${session}"`);
    await startDetachedSession(session, process.cwd(), bin, args);
    reportDetachedSession(spec.command, session, options.mode === 'handoff' ? 'ready for handoff' : 'started');
    return 0;
  }

  log(`starting ${spec.binary} in zellij session "${session}"`);
  return startSession(session, process.cwd(), bin, args);
}

/** zellij session names must be free of whitespace and path separators. */
export function sanitize(s: string): string {
  return s
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function reportDetachedSession(command: 'klaude' | 'kodex', session: string, status: string): void {
  console.error(`session "${session}" ${status}`);
  console.error(`attach with: ${command} -n "${session}"`);
  console.error(`raw zellij: zellij attach "${session}"`);
}
