// kloge layout + constants. Everything lives under ~/.kloge/ (override with
// KLOGE_DIR): the CLIProxyAPI auth files, the rendered config.yaml, and the
// docker compose file. The same directory is what `kloge push` mirrors to a
// remote box, so local and remote are byte-identical.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dataDir = process.env.KLOGE_DIR ?? join(homedir(), '.kloge');
export const authDir = join(dataDir, 'auth');
export const configFile = join(dataDir, 'config.yaml');
export const composeFile = join(dataDir, 'compose.yaml');

// CLIProxyAPI docker image. Upstream project: github.com/router-for-me/CLIProxyAPI.
// Pin via KLOGE_IMAGE for reproducibility; :latest matches the upstream compose.
export const image = process.env.KLOGE_IMAGE ?? 'eceasy/cli-proxy-api:latest';
export const containerName = 'kloge-cliproxy';

// Placeholder API key clients present to the proxy — same convention as loge.
// It is NOT a provider secret; the real credentials are the auth files.
export const internalApiKey = process.env.KLOGE_API_KEY ?? 'loge-internal';

export const DEFAULT_PORT = 8317;

// loge pool credential keys in the Secret. The count grows over time (there is
// no fixed 1..3), so pull.ts discovers every matching key rather than assuming a
// range. The captured group is the index used for the auth filename; CLIProxyAPI
// itself only cares about the `type` field inside each file.
export const CODEX_KEY_RE = /^CODEX_OAUTH_TOKEN_PE_LLM_(\d+)$/;
export const CLAUDE_KEY_RE = /^CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_(\d+)$/;

/**
 * Resolve the listen port. Single source of truth is the rendered config.yaml
 * (so `kloge up`/`status`/`push` agree with whatever `pull`/`render` wrote);
 * falls back to KLOGE_PORT then the default.
 */
export function resolvePort(): number {
  if (existsSync(configFile)) {
    const m = readFileSync(configFile, 'utf8').match(/^port:\s*(\d+)/m);
    if (m) return Number.parseInt(m[1], 10);
  }
  const env = process.env.KLOGE_PORT;
  if (env && /^\d+$/.test(env)) return Number.parseInt(env, 10);
  return DEFAULT_PORT;
}

export function localUrl(port = resolvePort()): string {
  return `http://127.0.0.1:${port}`;
}
