// Render the on-disk artifacts kloge needs: the CLIProxyAPI config.yaml and the
// docker compose.yaml. Auth files are written by pull.ts (it owns the decoded
// credentials). Both config and compose use container-internal / relative paths
// so the whole ~/.kloge dir can be rsynced to a box and started identically.
import { mkdirSync, writeFileSync } from 'node:fs';
import { authDir, composeFile, configFile, containerName, dataDir, image, internalApiKey } from './paths';

// Inside the container the auth-dir is mounted at /root/.cli-proxy-api and the
// config at /CLIProxyAPI/config.yaml (upstream image defaults).
const CONTAINER_AUTH_DIR = '/root/.cli-proxy-api';

export function renderConfigYaml(port: number): string {
  return [
    '# Rendered by kloge — do not hand-edit; re-run `kloge render`/`kloge pull`.',
    '# CLIProxyAPI config for the loge credential pool, run locally in Docker.',
    'host: ""',
    `port: ${port}`,
    `auth-dir: "${CONTAINER_AUTH_DIR}"`,
    'api-keys:',
    `  - "${internalApiKey}"`,
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

export function renderComposeYaml(port: number): string {
  // Relative bind mounts resolve against the compose file's directory, so this
  // is identical on the Mac and on a pushed box. Port is bound to 127.0.0.1 so
  // the proxy is reachable only from the host it runs on.
  return [
    '# Rendered by kloge — CLIProxyAPI for the loge pool.',
    'services:',
    '  cli-proxy-api:',
    `    image: ${image}`,
    '    pull_policy: always',
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
  writeFileSync(configFile, renderConfigYaml(port), { mode: 0o600 });
  writeFileSync(composeFile, renderComposeYaml(port), { mode: 0o644 });
}

export { dataDir };
