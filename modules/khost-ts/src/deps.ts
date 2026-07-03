// Shared constants + OS detection. Everything configurable is sourced from
// ~/.khost/config.yaml (see config.ts); this module just derives named exports.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { alloyConfigFile, config, configDir, configFile, machineId } from './config';

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

export { configDir, configFile, alloyConfigFile, machineId };

// Runtime (host-local) state — regenerable, separate from config.
export const stateDir = process.env.KHOST_STATE_DIR ?? join(home, '.local/state/khost');
const tunnelState = join(stateDir, 'tunnel');
// Legacy: path of the old detached-cloudflared pidfile; tunnelUp cleans it up.
export const tunnelPidfile = join(tunnelState, 'cloudflared.pid');

// Grafana Alloy (observability collector) — an editable config copied into
// runtime state, then `docker compose up`.
export const alloyState = join(stateDir, 'alloy');
export const alloyRuntimeConfig = join(alloyState, 'config.alloy');
export const alloyRuntimeCompose = join(alloyState, 'docker-compose.yml');
export const alloyPort = config.alloy.port;
export const alloyContainer = config.alloy.container;
export const alloyImage = config.alloy.image;

// khost self-metrics exporter port (`khost metrics serve`).
export const metricsPort = config.metrics.port;

// Alloy remote_write creds: env wins (keep the token out of plaintext
// config.yaml), fall back to config.alloy.remote_write. khost injects these into
// the Alloy container as ALLOY_REMOTE_WRITE_* so the config reads them via
// sys.env(...) — no secret is written into the generated compose file.
export const alloyRemoteWriteUrl = process.env.ALLOY_REMOTE_WRITE_URL || config.alloy.remote_write.url;
export const alloyRemoteWriteUsername = process.env.ALLOY_REMOTE_WRITE_USERNAME || config.alloy.remote_write.username;
export const alloyRemoteWritePassword = process.env.ALLOY_REMOTE_WRITE_PASSWORD || config.alloy.remote_write.password;

// khost runs its own sshd bound to 127.0.0.1:<sshPort> (not macOS Remote Login),
// so the tunnel reaches it via loopback and the LAN cannot.
export const sshPort = config.ssh.port;
// Configured mesh bind: 'auto' (detect live WARP IP), a literal IP, or '' (loopback
// only). Resolve to a concrete address with mesh.ts:resolveMeshListen — never bind
// this raw value, since 'auto' is a sentinel, not an address.
export const meshListenConfig = config.ssh.mesh_listen ?? '';

// cloudflared edge protocol. http2 by default; QUIC (UDP/7844) can be unreliable.
export const tunnelProtocol = config.tunnel.protocol;

// Tunnel name is derived from the machine identity (one tunnel per machine).
export const tunnelName = `khost-${machineId}`;

// Cloudflare credentials. Prefer the environment (e.g. home-manager's ~/.secrets)
// so secrets need not sit in plaintext; fall back to config.yaml for standalone
// boxes. Zones are auto-discovered from the account.
export const cfApiToken = process.env.CLOUDFLARE_API_TOKEN || config.cloudflare.api_token;
export const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || config.cloudflare.account_id;
export const cfApiBase = config.cloudflare.api_base;

// Externally-managed reusable Access policy. khost only looks this up by name
// and attaches it to owned apps; it never creates/updates/deletes this policy.
export const accessPolicyName = config.access.policy;

// Ownership markers: khost only ever modifies/deletes resources carrying these.
// DNS records get the comment; Access apps get the tag (+ a "khost: " name).
export const ownerTag = 'khost';
export const ownerComment = 'khost:managed';
