// Small helpers around shelling out (Bun.spawn) and colored logging.
import pc from 'picocolors';

export const log = (m: string) => console.log(`${pc.blue('==>')} ${m}`);
export const ok = (m: string) => console.log(`${pc.green('✓')} ${m}`);
export const warn = (m: string) => console.error(`${pc.yellow('!')} ${m}`);
export function die(m: string): never {
  console.error(`${pc.red('✗')} ${m}`);
  process.exit(1);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  cwd?: string;
  /** Feed this to the process stdin. */
  input?: string;
  /** Inherit stdio (interactive: login flows, sops $EDITOR, docker logs -f). */
  interactive?: boolean;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
}

/** Run a command, capturing output. Does not throw on non-zero. */
export async function run(cmd: string[], opts: RunOpts = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.interactive ? 'inherit' : opts.input !== undefined ? 'pipe' : 'ignore',
    stdout: opts.interactive ? 'inherit' : 'pipe',
    stderr: opts.interactive ? 'inherit' : 'pipe',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  const stdout = opts.interactive ? '' : await new Response(proc.stdout).text();
  const stderr = opts.interactive ? '' : await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** True if a binary is resolvable on PATH. */
async function have(bin: string): Promise<boolean> {
  return (await run(['sh', '-c', `command -v ${bin}`])).code === 0;
}

export async function need(bin: string): Promise<void> {
  if (!(await have(bin))) die(`required tool not found on PATH: ${bin}`);
}

/** `docker compose <args>` (v2) with fallback to `docker-compose` (v1). */
export async function dockerCompose(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  if ((await run(['docker', 'compose', 'version'])).code === 0) {
    return run(['docker', 'compose', ...args], opts);
  }
  if (await have('docker-compose')) return run(['docker-compose', ...args], opts);
  die("neither 'docker compose' nor 'docker-compose' found (is OrbStack running?)");
}
