// Grafana Alloy (observability collector) lifecycle.
// The user-editable config is a single plaintext file ~/.khost/alloy.alloy (the
// full Alloy config); `khost alloy up` copies it into the runtime state dir and
// runs docker compose. By default it scrapes the local kloop/kautopilot/kfleet
// exporters; edit the file (`khost alloy edit`) to add a remote_write target.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  alloyConfigFile,
  alloyContainer,
  alloyImage,
  alloyPort,
  alloyRemoteWritePassword,
  alloyRemoteWriteUrl,
  alloyRemoteWriteUsername,
  alloyRuntimeCompose,
  alloyRuntimeConfig,
  alloyState,
} from './deps';
import { die, dockerCompose, log, need, ok, run, warn } from './exec';

/** docker-compose.yml for Alloy, rendered with the runtime state dir. The
 *  `host.docker.internal` host-gateway mapping lets the container scrape the
 *  exporters running on the host (built-in on macOS; explicit on Linux). */
function composeYaml(): string {
  return `# khost-managed Grafana Alloy deployment (generated — do not edit).
services:
  alloy:
    image: ${alloyImage}
    container_name: ${alloyContainer}
    command:
      - run
      - --server.http.listen-addr=0.0.0.0:${alloyPort}
      - --storage.path=/var/lib/alloy/data
      - /etc/alloy/config.alloy
    ports:
      - '127.0.0.1:${alloyPort}:${alloyPort}'
    volumes:
      - '${alloyState}/config.alloy:/etc/alloy/config.alloy'
      - '${alloyState}/data:/var/lib/alloy/data'
    # Keys only (no values): the remote_write creds are inherited from the
    # 'docker compose up' process env (set by alloyUp from khost config/env), so
    # the token is never written into this generated file.
    environment:
      - ALLOY_REMOTE_WRITE_URL
      - ALLOY_REMOTE_WRITE_USERNAME
      - ALLOY_REMOTE_WRITE_PASSWORD
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    restart: unless-stopped
`;
}

/** Copy the plaintext Alloy config into the runtime state dir. */
async function renderConfig(): Promise<void> {
  if (!existsSync(alloyConfigFile)) die(`alloy config missing: ${alloyConfigFile} (run: khost init)`);
  await mkdir(`${alloyState}/data`, { recursive: true });
  await copyFile(alloyConfigFile, alloyRuntimeConfig);
}

async function renderCompose(): Promise<void> {
  await mkdir(alloyState, { recursive: true });
  await writeFile(alloyRuntimeCompose, composeYaml());
}

async function runningImage(): Promise<string> {
  const r = await run(['docker', 'inspect', alloyContainer, '--format', '{{.Image}}']);
  return r.code === 0 ? r.stdout.trim() : 'none';
}

/** Idempotent bring-up: re-renders config + compose and recreates the container
 *  only when the rendered config actually changed. Self-guards when no config
 *  file exists (so `khost up` can call it unconditionally). */
export async function alloyUp(): Promise<void> {
  if (!existsSync(alloyConfigFile)) {
    warn(`alloy config missing (${alloyConfigFile}) — skipping; run "khost init" then "khost alloy up"`);
    return;
  }
  await need('docker');
  const before = existsSync(alloyRuntimeConfig) ? await readFile(alloyRuntimeConfig, 'utf8') : '';
  await renderConfig();
  await renderCompose();
  const after = await readFile(alloyRuntimeConfig, 'utf8');
  const changed = before !== after;
  log(`Starting Grafana Alloy on :${alloyPort}${changed ? ' (config changed → recreate)' : ''}`);
  const args = changed ? ['up', '-d', '--force-recreate'] : ['up', '-d'];
  // Pass resolved remote_write creds through to the container env (not the file).
  const r = await dockerCompose(args, {
    cwd: alloyState,
    interactive: true,
    env: {
      ALLOY_REMOTE_WRITE_URL: alloyRemoteWriteUrl,
      ALLOY_REMOTE_WRITE_USERNAME: alloyRemoteWriteUsername,
      ALLOY_REMOTE_WRITE_PASSWORD: alloyRemoteWritePassword,
    },
  });
  if (r.code !== 0) die('docker compose up failed');
  ok(`alloy up — UI on http://127.0.0.1:${alloyPort}`);
}

export async function alloyDown(): Promise<void> {
  if (!existsSync(alloyRuntimeCompose)) {
    warn('no runtime compose; nothing to stop');
    return;
  }
  await dockerCompose(['down'], { cwd: alloyState, interactive: true });
  ok('alloy down');
}

export async function alloyRestart(): Promise<void> {
  await alloyDown();
  await alloyUp();
}

export async function alloyStatus(): Promise<void> {
  if (!existsSync(alloyRuntimeCompose)) {
    warn('alloy not initialised (no runtime compose); run: khost alloy up');
    return;
  }
  await dockerCompose(['ps'], { cwd: alloyState, interactive: true });
  const img = await runningImage();
  if (img !== 'none') console.log(`running image: ${img}`);
}

export async function alloyLogs(args: string[]): Promise<void> {
  await dockerCompose(['logs', ...args], { cwd: alloyState, interactive: true });
}

/** Open the plaintext Alloy config in $EDITOR. */
export async function alloyEdit(): Promise<void> {
  const editor = process.env.EDITOR ?? 'nano';
  if (!existsSync(alloyConfigFile)) die(`alloy config missing: ${alloyConfigFile} (run: khost init)`);
  await run([editor, alloyConfigFile], { interactive: true });
  log('edited — apply with: khost alloy restart');
}
