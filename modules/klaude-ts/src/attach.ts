// `klaude at` — pick a running zellij session and attach to it.
import pc from 'picocolors';
import { die, which } from './exec';
import { attachSession, listSessions } from './zellij';

export async function attach(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    die('no running zellij sessions to attach to. Start one with: klaude [-n <name>]');
  }
  if (sessions.length === 1) {
    process.exit(await attachSession(sessions[0]!));
  }

  const chosen = (await which('fzf')) ? await pickFzf(sessions) : pickNumbered(sessions);
  if (!chosen) process.exit(0); // cancelled
  process.exit(await attachSession(chosen));
}

/** Fuzzy-pick with fzf: feed the list on stdin, fzf draws on /dev/tty. */
async function pickFzf(sessions: string[]): Promise<string | null> {
  const proc = Bun.spawn(['fzf', '--prompt', 'attach> ', '--height', '40%', '--reverse'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  proc.stdin.write(sessions.join('\n'));
  await proc.stdin.end();
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out || null;
}

/** Plain numbered menu read from stdin (fallback when fzf is absent). */
function pickNumbered(sessions: string[]): string | null {
  console.error(pc.bold('zellij sessions:'));
  sessions.forEach((s, i) => console.error(`  ${pc.cyan(String(i + 1))}) ${s}`));
  const answer = prompt('attach to # (blank to cancel):');
  if (answer === null || answer.trim() === '') return null;
  const idx = Number.parseInt(answer.trim(), 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= sessions.length) {
    die(`invalid selection: ${answer.trim()}`);
  }
  return sessions[idx]!;
}
