// Shared paths, constants, and OS detection for khost.
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OsKind = 'darwin' | 'linux' | 'unknown';

export function osKind(): OsKind {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

const home = homedir();

// Repo location of the editable config (skeleton + sops fragment + compose
// template). KHOST_REPO_DIR overrides if the repo lives elsewhere.
const repoDir = process.env.KHOST_REPO_DIR ?? join(home, '.config/home-manager');
export const repoProxyDir = join(repoDir, 'modules/khost-ts/proxy');
export const skeletonPath = join(repoProxyDir, 'config.skeleton.yaml');
export const fragmentPath = join(repoProxyDir, 'config.secrets.enc.yaml');
export const composeTemplatePath = join(repoProxyDir, 'docker-compose.yml');

// Runtime (host-local, gitignored) state.
export const stateDir = process.env.KHOST_STATE_DIR ?? join(home, '.local/state/khost');
export const proxyState = join(stateDir, 'proxy');
const tunnelState = join(stateDir, 'tunnel');
export const proxyRuntimeConfig = join(proxyState, 'config.yaml');
export const proxyRuntimeCompose = join(proxyState, 'docker-compose.yml');
// Legacy: path of the old detached-cloudflared pidfile; tunnelUp cleans it up.
export const tunnelPidfile = join(tunnelState, 'cloudflared.pid');

export const proxyPort = 8317;
export const proxyContainer = 'khost-cli-proxy-api';

// khost runs its own sshd bound to 127.0.0.1:<sshPort> (not macOS Remote Login),
// so the tunnel reaches it via loopback and the LAN cannot. Default 2222.
export const sshPort = Number(process.env.KHOST_SSH_PORT ?? 2222);

// cloudflared edge protocol. Default http2 because QUIC (UDP/7844) to the edge
// is unreliable here (e.g. WARP interference / UDP blocks). Override via env.
export const tunnelProtocol = process.env.KHOST_TUNNEL_PROTOCOL ?? 'http2';

// Tunnel name is derived from the current user (one tunnel per host identity).
export const tunnelName = `khost-${process.env.USER ?? 'host'}`;

// Cloudflare credentials come from the shell env (populated by ~/.secrets via sops).
export const cfApiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';
export const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
export const cfApiBase = 'https://api.cloudflare.com/client/v4';

// The secret subtrees split out into the sops fragment; everything else is the
// non-secret skeleton. Keep in sync with proxy `import` / `capture`.
// Every top-level section that can carry a credential lives here so that
// `khost proxy capture` never writes a secret into the committed plaintext
// skeleton. Sections that mix secret + non-secret fields (kiro, ampcode) are
// captured wholesale into the encrypted fragment — over-encrypting is safe.
export const secretPaths = [
  'api-keys',
  'claude-api-key',
  'openai-compatibility',
  'gemini-api-key',
  'codex-api-key',
  'vertex-api-key',
  'kiro',
  'ampcode',
] as const;

// --- route-manager config -------------------------------------------------
// Declarative list of public hostnames that route to this host through the
// tunnel. KHOST_ROUTES_FILE overrides the committed default.
export const routesFile = process.env.KHOST_ROUTES_FILE ?? join(repoProxyDir, 'routes.yaml');

// Allow-list for the reusable "only-me" Access policy. Comma-separated, from
// the env (sops), defaulting to the owner.
export const accessEmails = (process.env.KHOST_ACCESS_EMAILS ?? 'ernest@atomi.cloud')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
export const accessPolicyName = 'only-ernest';

// Require the WARP device posture (device enrolled in the AtomiCloud org) on the
// only-me policy. Cloudflare's built-in gateway/warp policy rules 500 in this
// account, so we gate via a device-posture integration. The "Gateway" posture
// (proxy-mode) blocks browser/mobile sessions, so we use the "Warp" (enrolled)
// posture by default — that's "WARP + signed into the org" without proxy-mode.
// Override/disable via env. (Gateway posture uid: 4f62bf6f-35b9-4537-83e0-e820b0eaa869.)
export const requireWarp = (process.env.KHOST_REQUIRE_WARP ?? 'true') === 'true';
export const warpPostureUid = process.env.KHOST_WARP_POSTURE_UID ?? '55971cbe-2ddf-4c30-b504-abbb901a0600';

// Ownership markers: khost only ever modifies/deletes resources carrying these.
// DNS records get the comment; Access apps get the tag (+ a "khost: " name).
export const ownerTag = 'khost';
export const ownerComment = 'khost:managed';
