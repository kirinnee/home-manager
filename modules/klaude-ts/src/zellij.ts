// Thin wrappers around the zellij CLI: list/inspect sessions, start a new
// session running a command, start one detached, and attach to an existing one.
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

export function sessionLayout(cwd: string, cmd: string, args: string[]): string {
  const argLine = args.length ? `        args ${args.map(quoteKdl).join(' ')}\n` : '';
  return `layout {
    pane command=${quoteKdl(cmd)} cwd=${quoteKdl(cwd)} {
${argLine}        close_on_exit true
    }
}
`;
}

/**
 * Start a fresh zellij session named `name`, running `cmd` (already an absolute
 * path) with `args` in `cwd`, and attach this terminal to it. The command is
 * written into a generated KDL layout. All args go on a SINGLE `args` node:
 * zellij honors only one `args` node per pane.
 */
export async function startSession(name: string, cwd: string, cmd: string, args: string[]): Promise<number> {
  const file = await writeLayout(name, cwd, cmd, args);
  try {
    return await runInteractive(['zellij', '--session', name, '--new-session-with-layout', file]);
  } finally {
    await unlink(file);
  }
}

/**
 * Start a zellij session in the background. zellij needs a PTY for startup, so
 * use a short-lived detached tmux session as the bootstrap client, wait for the
 * zellij session to appear, then remove the bootstrap client.
 */
export async function startDetachedSession(name: string, cwd: string, cmd: string, args: string[]): Promise<void> {
  const file = await writeLayout(name, cwd, cmd, args);
  const boot = `klaude-boot-${name}`;
  try {
    await run(['tmux', 'kill-session', '-t', boot]);
    const start = await run([
      'tmux',
      'new-session',
      '-d',
      '-s',
      boot,
      `zellij --session ${quoteShell(name)} --new-session-with-layout ${quoteShell(file)}`,
    ]);
    if (start.code !== 0) throw new Error(start.stderr.trim() || `tmux failed to start bootstrap session "${boot}"`);

    for (let i = 0; i < 30; i++) {
      if (await sessionExists(name)) return;
      await Bun.sleep(500);
    }
    throw new Error(`zellij session "${name}" did not come up in time`);
  } finally {
    await run(['tmux', 'kill-session', '-t', boot]);
    await unlink(file);
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

function quoteShell(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function writeLayout(name: string, cwd: string, cmd: string, args: string[]): Promise<string> {
  const file = `${process.env.TMPDIR ?? '/tmp'}/klaude-${name}-${process.pid}.kdl`;
  await Bun.write(file, sessionLayout(cwd, cmd, args));
  return file;
}

async function unlink(file: string): Promise<void> {
  await Bun.file(file)
    .unlink()
    .catch(() => {});
}
