// Resolve the sshd mesh ListenAddress — the WARP virtual IP other enrolled
// devices reach this host on (`ssh user@<mesh-ip>`). This IP is assigned by
// Cloudflare at ENROLLMENT and changes whenever the device re-enrolls, so a
// hardcoded value silently rots (sshd falls back to loopback-only and mesh SSH
// breaks). `mesh_listen: auto` detects the live value instead.
import { networkInterfaces } from 'node:os';
import { cfConfigured, findDeviceVirtualIp } from './cloudflare';
import { run, warn } from './exec';

/** This device's registration ID from `warp-cli registration show`. null if
 *  warp-cli is missing or the device isn't registered. */
async function warpDeviceId(): Promise<string | null> {
  const r = await run(['warp-cli', 'registration', 'show']);
  if (r.code !== 0) return null;
  return r.stdout.match(/^Device ID:\s*(\S+)/m)?.[1] ?? null;
}

/** True if `ip` is currently bound to a local interface — sshd cannot bind an
 *  address the host doesn't hold, so we never hand it one that isn't up. */
function isLocalAddress(ip: string): boolean {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.address === ip) return true;
  }
  return false;
}

/** Resolve `ssh.mesh_listen` to a concrete sshd ListenAddress (or '' = loopback
 *  only). Values: '' disables the mesh listener; 'auto' detects the current WARP
 *  virtual IP (warp-cli device id -> Cloudflare virtual_ipv4, validated against a
 *  live local interface); any other value is used verbatim (manual override).
 *  Every failure path degrades to '' with a warning — never a bind that fails. */
export async function resolveMeshListen(configured: string): Promise<string> {
  if (configured !== 'auto') return configured;

  const deviceId = await warpDeviceId();
  if (!deviceId) {
    warn('mesh_listen=auto: WARP not registered (warp-cli) — sshd on loopback only');
    return '';
  }
  if (!cfConfigured()) {
    warn('mesh_listen=auto: Cloudflare creds absent — cannot resolve mesh IP; loopback only');
    return '';
  }
  let ip: string | null;
  try {
    ip = await findDeviceVirtualIp(deviceId);
  } catch (e) {
    warn(`mesh_listen=auto: Cloudflare lookup failed (${(e as Error).message}) — loopback only`);
    return '';
  }
  if (!ip) {
    warn(`mesh_listen=auto: no virtual IP for device ${deviceId} — loopback only`);
    return '';
  }
  if (!isLocalAddress(ip)) {
    warn(`mesh_listen=auto: resolved ${ip} but it is not on a local interface (WARP down?) — loopback only`);
    return '';
  }
  return ip;
}
