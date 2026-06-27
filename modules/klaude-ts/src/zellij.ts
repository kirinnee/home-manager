// Thin wrappers around the zellij CLI: list/inspect sessions, start a new
// session running a command, and attach to an existing one.
import { run, runInteractive } from './exec';

/**
 * Active zellij session names. `list-sessions --short` prints one bare name per
 * line with no ANSI codes, so exact line matching is reliable. Exited sessions
 * are filtered out by zellij itself with `--short`.
 */
export async function listSessions(): Promise<string[]> {
  const r = await run(['zellij', 'list-sessions', '--short']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

export async function sessionExists(name: string): Promise<boolean> {
  return (await listSessions()).includes(name);
}

/**
 * Start a fresh zellij session named `name`, running `cmd` (already an absolute
 * path) with `args` in `cwd`, and attach this terminal to it. The command is
 * written into a generated KDL layout — printing the args as quoted strings so
 * spaces/apostrophes (e.g. a ticket-title display name) can't break the layout.
 * All args go on a SINGLE `args` node: zellij honors only one `args` node per
 * pane, so splitting them across lines silently drops every arg but the first
 * (which left `-n` with no value, swallowing the next flag as the name).
 * Blocks until the session is detached or exits; returns zellij's exit code.
 */
export async function startSession(name: string, cwd: string, cmd: string, args: string[]): Promise<number> {
  const argLine = args.length ? `        args ${args.map(quoteKdl).join(' ')}\n` : '';
  const layout = `layout {
    pane command=${quoteKdl(cmd)} cwd=${quoteKdl(cwd)} {
${argLine}        close_on_exit true
    }
}
`;
  const file = `${process.env.TMPDIR ?? '/tmp'}/klaude-${name}-${process.pid}.kdl`;
  await Bun.write(file, layout);
  try {
    return await runInteractive(['zellij', '--session', name, '--new-session-with-layout', file]);
  } finally {
    await Bun.file(file)
      .unlink()
      .catch(() => {});
  }
}

/** Attach this terminal to an existing session; returns zellij's exit code. */
export async function attachSession(name: string): Promise<number> {
  return runInteractive(['zellij', 'attach', name]);
}

/** Quote a value as a KDL string literal (the args/command can contain spaces). */
function quoteKdl(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
