// Small helpers around shelling out (Bun.spawn) and colored logging.
import pc from 'picocolors';

export const log = (m: string) => console.error(`${pc.blue('==>')} ${m}`);
export function die(m: string): never {
  console.error(`${pc.red('✗')} ${m}`);
  process.exit(1);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing stdout/stderr. Does not throw on non-zero. */
export async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/**
 * Run an interactive command attached to this terminal (inherited stdio) and
 * return its exit code. Used to hand the TTY to zellij.
 */
export async function runInteractive(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return proc.exited;
}

/** Absolute path to a binary on PATH, or null if not resolvable. */
export async function which(bin: string): Promise<string | null> {
  const r = await run(['sh', '-c', `command -v ${bin}`]);
  const p = r.stdout.trim();
  return r.code === 0 && p ? p : null;
}

/** Resolve a required binary to its absolute path, or die with a hint. */
export async function need(bin: string, hint = ''): Promise<string> {
  const p = await which(bin);
  if (!p) die(`required tool not found on PATH: ${bin}${hint ? ` — ${hint}` : ''}`);
  return p;
}
