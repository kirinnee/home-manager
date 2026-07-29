// Render the on-disk artifacts kloge needs: the CLIProxyAPI config.yaml and the
// docker compose.yaml. Auth files are written by pull.ts (it owns the decoded
// credentials). Both config and compose use container-internal / relative paths
// so the whole ~/.kloge dir can be rsynced to a box and started identically.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  authDir,
  composeFile,
  configFile,
  containerName,
  dataDir,
  internalApiKey,
  isPatchedImage,
  managementKeyFile,
  resolveImage,
} from './paths';

// Inside the container the auth-dir is mounted at /root/.cli-proxy-api and the
// config at /CLIProxyAPI/config.yaml (upstream image defaults).
const CONTAINER_AUTH_DIR = '/root/.cli-proxy-api';

export function renderConfigYaml(port: number, managementKey: string): string {
  return [
    '# Rendered by kloge — do not hand-edit; re-run `kloge render`/`kloge pull`.',
    '# CLIProxyAPI config for the loge credential pool, run locally in Docker.',
    'host: ""',
    `port: ${port}`,
    `auth-dir: "${CONTAINER_AUTH_DIR}"`,
    'api-keys:',
    `  - "${internalApiKey}"`,
    'remote-management:',
    // Docker DNAT makes the host appear as a bridge peer inside the container.
    // The compose port is still published on 127.0.0.1 only; upstream must
    // accept that bridge peer for host-local kfleet probes to reach management.
    '  allow-remote: true',
    `  secret-key: ${JSON.stringify(managementKey)}`,
    '  disable-control-panel: true',
    'debug: false',
    'request-retry: 3',
    'max-retry-credentials: 0',
    '# Keep loge parity: cloak non-Claude-Code clients automatically.',
    'disable-claude-cloak-mode: false',
    'routing:',
    '  strategy: "round-robin"',
    '',
  ].join('\n');
}

function readManagementKey(file: string): string {
  const key = readFileSync(file, 'utf8').trim();
  if (!key) throw new Error(`empty CLIProxyAPI management key: ${file}`);
  chmodSync(file, 0o600);
  return key;
}

/** Return the durable management key, creating it with owner-only permissions.
 * KLOGE_MANAGEMENT_KEY is an explicit rotation/import mechanism: when present,
 * render persists that value so kloge and the file-based kfleet probe agree. */
export function ensureManagementKey(
  file = managementKeyFile,
  environment: Record<string, string | undefined> = process.env,
): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const configured = environment.KLOGE_MANAGEMENT_KEY?.trim();
  if (configured) {
    writeFileSync(file, `${configured}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return configured;
  }

  try {
    return readManagementKey(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${generated}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(file, 0o600);
    return generated;
  } catch (error) {
    // Another render may have won the create race; use its complete key.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readManagementKey(file);
    throw error;
  }
}

export function renderComposeYaml(port: number, selectedImage = resolveImage()): string {
  // Relative bind mounts resolve against the compose file's directory, so this
  // is identical on the Mac and on a pushed box. Port is bound to 127.0.0.1 so
  // the proxy is reachable only from the host it runs on.
  const patched = isPatchedImage(selectedImage);
  return [
    '# Rendered by kloge — CLIProxyAPI for the loge pool.',
    'services:',
    '  cli-proxy-api:',
    `    image: ${selectedImage}`,
    `    pull_policy: ${patched ? 'never' : 'always'}`,
    ...(patched ? ['    command:', '      - ./CLIProxyAPI', '      - --local-model'] : []),
    `    container_name: ${containerName}`,
    '    ports:',
    `      - "127.0.0.1:${port}:${port}"`,
    '    volumes:',
    '      - ./config.yaml:/CLIProxyAPI/config.yaml:ro',
    '      - ./auth:/root/.cli-proxy-api',
    '    restart: unless-stopped',
    '',
  ].join('\n');
}

/** Write config.yaml + compose.yaml (and ensure the dir + auth dir exist). */
export function renderArtifacts(port: number): void {
  mkdirSync(authDir, { recursive: true });
  const managementKey = ensureManagementKey();
  writeFileSync(configFile, renderConfigYaml(port, managementKey), { mode: 0o600 });
  chmodSync(configFile, 0o600);
  writeFileSync(composeFile, renderComposeYaml(port), { mode: 0o644 });
}

export { dataDir };
