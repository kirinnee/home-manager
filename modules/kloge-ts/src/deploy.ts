// Local docker lifecycle + remote push. Both ends run the SAME compose file
// (CLIProxyAPI in Docker, mounting ~/.kloge/auth + config.yaml). Each binds the
// proxy to 127.0.0.1 on its own host, so you "access it locally" on whichever
// machine it runs on.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import {
  authDir,
  composeFile,
  containerName,
  dataDir,
  internalApiKey,
  localUrl,
  PATCHED_IMAGE,
  resolvePort,
} from './paths';
import { die, dockerCompose, log, need, ok, run, warn, type RunOpts, type RunResult } from './exec';

function requireRendered(): void {
  if (!existsSync(composeFile)) die(`no compose file at ${composeFile} — run \`kloge pull\` first`);
  if (!existsSync(authDir) || readdirSync(authDir).length === 0) {
    die(`no credentials in ${authDir} — run \`kloge pull\` first`);
  }
}

/** Bring up the local CLIProxyAPI container. */
export async function up(): Promise<void> {
  await need('docker');
  requireRendered();
  log('starting CLIProxyAPI (docker compose up -d)…');
  const r = await dockerCompose(['-f', composeFile, 'up', '-d'], { cwd: dataDir });
  if (r.code !== 0) die(`docker compose up failed:\n${r.stderr.trim()}`);
  ok(`up — ${localUrl()}`);
  await probe();
}

interface RestartDeps {
  runCommand: (cmd: string[], opts?: RunOpts) => Promise<RunResult>;
  compose: (args: string[], opts?: RunOpts) => Promise<RunResult>;
  sleep: (ms: number) => Promise<unknown>;
}

/** Refresh a running proxy after pull replaced its mounted auth directory. */
export async function restartIfRunning(overrides: Partial<RestartDeps> = {}): Promise<void> {
  const deps: RestartDeps = { runCommand: run, compose: dockerCompose, sleep: Bun.sleep, ...overrides };
  let inspected: RunResult;
  try {
    inspected = await deps.runCommand(['docker', 'inspect', '--format', '{{.State.Running}}', containerName]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // pull also works without Docker installed
    throw error;
  }
  if (inspected.code !== 0) {
    if (/No such (object|container)/i.test(inspected.stderr)) return;
    throw new Error(`could not inspect local proxy: ${inspected.stderr.trim() || inspected.stdout.trim()}`);
  }
  if (inspected.stdout.trim() !== 'true') return;

  log('recreating running CLIProxyAPI to load the pulled credentials…');
  const recreated = await deps.compose(['-f', composeFile, 'up', '-d', '--force-recreate'], { cwd: dataDir });
  if (recreated.code !== 0) throw new Error(`docker compose recreate failed:\n${recreated.stderr.trim()}`);

  const url = `${localUrl()}/v1/models`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await deps.runCommand([
      'curl',
      '-fsS',
      '-m',
      '5',
      '-H',
      `Authorization: Bearer ${internalApiKey}`,
      url,
    ]);
    if (response.code === 0) {
      const models = extractModelIds(response.stdout);
      if (models.length > 0) {
        ok(`serving ${models.length} model(s): ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}`);
        return;
      }
    }
    if (attempt < 29) await deps.sleep(1000);
  }
  throw new Error(`proxy was recreated, but ${url} did not serve any models within 30 seconds`);
}

export async function down(): Promise<void> {
  await need('docker');
  if (!existsSync(composeFile)) die(`no compose file at ${composeFile}`);
  const r = await dockerCompose(['-f', composeFile, 'down'], { cwd: dataDir });
  if (r.code !== 0) die(`docker compose down failed:\n${r.stderr.trim()}`);
  ok('down');
}

export async function logs(follow: boolean): Promise<void> {
  await need('docker');
  if (!existsSync(composeFile)) die(`no compose file at ${composeFile}`);
  const args = ['-f', composeFile, 'logs'];
  if (follow) args.push('-f');
  await dockerCompose(args, { cwd: dataDir, interactive: true });
}

/** Curl the proxy's model list to confirm it is actually serving. */
async function probe(): Promise<void> {
  const url = `${localUrl()}/v1/models`;
  const r = await run(['curl', '-fsS', '-m', '10', '-H', `Authorization: Bearer ${internalApiKey}`, url]);
  if (r.code !== 0) {
    warn(`could not reach ${url} yet (container may still be starting): ${r.stderr.trim()}`);
    return;
  }
  const models = extractModelIds(r.stdout);
  ok(`serving ${models.length} model(s): ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}`);
}

function extractModelIds(body: string): string[] {
  try {
    const j = JSON.parse(body) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
    const arr = j.data ?? j.models ?? [];
    return arr.map(m => m.id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export async function status(): Promise<void> {
  const port = resolvePort();
  console.log(`kloge — local CLIProxyAPI for the loge pool`);
  console.log(`  data dir : ${dataDir}`);
  console.log(`  url      : ${localUrl(port)}  (api key: ${internalApiKey})`);
  const creds = existsSync(authDir) ? readdirSync(authDir).filter(f => f.endsWith('.json')) : [];
  console.log(`  creds    : ${creds.length ? creds.join(', ') : '(none — run `kloge pull`)'}`);
  if (existsSync(composeFile)) {
    const r = await dockerCompose(['-f', composeFile, 'ps'], { cwd: dataDir });
    console.log(`  container:\n${(r.stdout || r.stderr).trimEnd()}`);
  } else {
    console.log('  container: (not rendered — run `kloge pull`)');
  }
  await probe();
}

export interface PushOpts {
  host: string; // user@host (an ssh target)
  remoteDir: string; // remote path for the ~/.kloge mirror
  start: boolean; // run `docker compose up -d` on the box after copying
  yes?: boolean; // allow rsync to delete remote-only credential files
}

/** Inspect remote auth before rsync --delete can remove credentials. */
export async function remoteCredentialLoss(
  opts: Pick<PushOpts, 'host' | 'remoteDir'>,
  localFiles: readonly string[],
  runCommand: (cmd: string[]) => Promise<RunResult> = run,
): Promise<string[]> {
  const remoteAuth = posix.join(opts.remoteDir, 'auth');
  const command = `if test -d ${shq(remoteAuth)}; then LC_ALL=C ls -1A ${shq(remoteAuth)}; fi`;
  const result = await runCommand(['ssh', '-o', 'ClearAllForwardings=yes', opts.host, command]);
  if (result.code !== 0) throw new Error(`could not list remote credentials on ${opts.host}: ${result.stderr.trim()}`);
  const local = new Set(localFiles.filter(file => file.endsWith('.json')));
  return result.stdout.split('\n').filter(file => file.endsWith('.json') && !local.has(file));
}

export function requirePushConfirmation(losses: readonly string[], yes: boolean): void {
  if (losses.length > 0 && !yes) {
    throw new Error(
      `push would delete ${losses.length} remote-only credential file(s): ${losses.join(', ')}. ` +
        'Pass --yes to confirm, or add those credentials locally before pushing.',
    );
  }
}

export function composeUsesPatchedImage(contents: string): boolean {
  return contents.split('\n').some(line => line.trim() === `image: ${PATCHED_IMAGE}`);
}

/** Build the remote command used to start the mirrored compose deployment. */
export function buildRemoteStartCommand(opts: Pick<PushOpts, 'host' | 'remoteDir'>): string {
  // Non-interactive SSH has a minimal PATH. Put Nix profiles first so their
  // Docker (and its Compose v2 plugin) wins over an older system Docker, while
  // still retaining system Docker and docker-compose v1 as fallbacks.
  return (
    `export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"; ` +
    `cd ${shq(opts.remoteDir)} && ` +
    `if docker compose version >/dev/null 2>&1; then docker compose up -d; ` +
    `elif command -v docker-compose >/dev/null 2>&1; then docker-compose up -d; ` +
    `elif command -v docker >/dev/null 2>&1; then ` +
    `echo "Docker Compose unavailable on ${opts.host} (need docker compose v2 or docker-compose v1)" >&2; exit 127; ` +
    `else echo "docker not found on ${opts.host} (need docker + compose)" >&2; exit 127; fi`
  );
}

/** rsync ~/.kloge to a box and (optionally) start CLIProxyAPI there. */
export async function push(opts: PushOpts): Promise<void> {
  requireRendered();
  const patched = composeUsesPatchedImage(readFileSync(composeFile, 'utf8'));
  if (patched && opts.start) {
    die(
      `rendered compose uses local-only ${PATCHED_IMAGE}, but kloge push cannot transfer Docker images — ` +
        'build/load that tag on the remote host, then use `kloge push <host> --no-up` and start it there manually',
    );
  }
  if (patched) warn(`pushing compose for local-only ${PATCHED_IMAGE}; confirm that tag already exists on ${opts.host}`);

  await need('rsync');
  await need('ssh');

  // ClearAllForwardings stops the user's ssh-config LocalForwards (e.g. a
  // :1455 that's often already bound) from failing/polluting our commands.
  const SSH = ['ssh', '-o', 'ClearAllForwardings=yes'];

  // Ensure the remote dir exists, and best-effort fix ownership: the container
  // runs as root, so any files it wrote into the mounted auth dir (rotated
  // token files, logs/) become root-owned and would block rsync's update/delete
  // as the login user. `sudo -n` never prompts, and `|| true` keeps this a
  // no-op on boxes without passwordless sudo.
  const prep =
    `mkdir -p ${shq(opts.remoteDir)}/auth; ` +
    `sudo -n chown -R "$(id -un)":"$(id -gn)" ${shq(opts.remoteDir)} 2>/dev/null || true`;
  const mk = await run([...SSH, opts.host, prep]);
  if (mk.code !== 0) die(`ssh prep failed on ${opts.host}:\n${mk.stderr.trim()}`);

  const losses = await remoteCredentialLoss(opts, readdirSync(authDir));
  requirePushConfirmation(losses, Boolean(opts.yes));
  if (losses.length > 0) {
    warn(`--yes confirmed deletion of ${losses.length} remote-only credential file(s): ${losses.join(', ')}`);
  }

  log(`syncing ${dataDir}/ -> ${opts.host}:${opts.remoteDir}/`);
  // Trailing slash on source copies contents. --delete keeps the box a mirror
  // (removed creds vanish there too), but EXCLUDE logs/ — those are per-host
  // container runtime, not credentials, and are what --delete chokes on.
  const sync = await run([
    'rsync',
    '-az',
    '--delete',
    '--exclude=logs/',
    '--chmod=D700,F600',
    '-e',
    'ssh -o ClearAllForwardings=yes',
    `${dataDir}/`,
    `${opts.host}:${opts.remoteDir}/`,
  ]);
  if (sync.code !== 0) die(`rsync failed:\n${sync.stderr.trim()}`);
  ok(`pushed auth + config + compose to ${opts.host}:${opts.remoteDir}`);

  if (!opts.start) {
    log(`to start it there: ssh ${opts.host} 'cd ${opts.remoteDir} && docker compose up -d'`);
    return;
  }

  log(`starting CLIProxyAPI on ${opts.host}…`);
  const remoteCmd = buildRemoteStartCommand(opts);
  const startr = await run([...SSH, opts.host, remoteCmd]);
  if (startr.code !== 0) die(`remote start failed:\n${startr.stderr.trim() || startr.stdout.trim()}`);
  ok(`started on ${opts.host} — reachable there at ${localUrl()} (bound to the box's 127.0.0.1)`);
  log(`from here you could tunnel it: ssh -N -L ${resolvePort()}:127.0.0.1:${resolvePort()} ${opts.host}`);
}

/** Single-arg shell quote for remote command interpolation. */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
