// SSH for khost. macOS Remote Login socket-activates sshd on ALL interfaces
// (launchd owns the socket → LAN-exposed, ListenAddress ignored). So instead khost
// runs its OWN sshd as a LaunchDaemon, bound to two PRIVATE paths: 127.0.0.1 (the
// Cloudflare tunnel + break-glass) and the WARP mesh endpoint 172.16.0.2 (so
// `ssh user@<mesh-ip>` works device-to-device). Neither is reachable from the LAN,
// which keeps password auth safe. Linux uses a config drop-in (sshd there isn't
// socket-activated, so ListenAddress works directly).
import { existsSync } from 'node:fs';
import { meshListenConfig, osKind, sshPort } from './deps';
import { die, log, ok, run, warn } from './exec';
import { resolveMeshListen } from './mesh';

const SSHD_CONFIG = '/etc/ssh/khost_sshd_config';
const PLIST = '/Library/LaunchDaemons/cloud.atomi.khost.sshd.plist';
const LABEL = 'cloud.atomi.khost.sshd';
const LINUX_DROPIN = '/etc/ssh/sshd_config.d/100-khost.conf';

// WARP-to-WARP mesh listener. Inbound mesh traffic (to this device's mesh IP) is
// delivered to the local WARP endpoint, 172.16.0.2 by default. Binding sshd there
// makes it reachable over the mesh (`ssh user@<mesh-ip> -p <sshPort>`) while the
// LAN still cannot reach it (172.16.0.2 is the point-to-point WARP address; no LAN
// route exists). The loopback listener (127.0.0.1) stays as the tunnel path AND a
// break-glass fallback. Set KHOST_MESH_LISTEN="" to disable the mesh listener.
// NOTE: if WARP isn't up when sshd starts (boot ordering), sshd binds 127.0.0.1
// and skips the mesh address — re-run `khost ssh setup` (or reload) once WARP is
// connected to pick it up. Boot-time WARP-up reload is a follow-up.
// Configured via ssh.mesh_listen in ~/.khost/config.yaml ('' disables it).

function currentUser(): string {
  return process.env.SUDO_USER ?? process.env.USER ?? '';
}

function sshdConfig(user: string, meshListen: string): string {
  const meshLine = meshListen ? `ListenAddress ${meshListen}\n` : '';
  return `# Managed by khost — private sshd reachable via two paths, both unreachable
# from the LAN: the Cloudflare tunnel (127.0.0.1, break-glass) and the WARP mesh
# (${meshListen || 'disabled'}). Password auth is ON for browser-rendered SSH; the
# mesh path uses native ssh. ListenAddress lines without a port use Port below.
Port ${sshPort}
ListenAddress 127.0.0.1
${meshLine}PasswordAuthentication yes
KbdInteractiveAuthentication yes
PermitRootLogin no
AllowUsers ${user}
UsePAM yes
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_rsa_key
PidFile /var/run/khost_sshd.pid
`;
}

// Linux boxes are NOT private (only the MacBook is): the SYSTEM sshd keeps its
// default listeners (port 22, all interfaces) so direct/public SSH keeps
// working. The drop-in must not contain Port/ListenAddress/AllowUsers — any of
// those REPLACE sshd's defaults and would cut off existing access paths (a
// remote box's only way in). It only enables password auth for TUNNEL-LOCAL
// (loopback) connections, which browser-rendered SSH needs; public port 22
// keeps the distro's key-only policy.
function linuxDropin(): string {
  return `# Managed by khost — system sshd untouched (default listeners stay).
# Password auth is enabled ONLY for loopback connections (the Cloudflare
# tunnel's browser-rendered SSH terminates locally); public SSH keeps the
# distro default (key-only).
Match Address 127.0.0.1,::1
  PasswordAuthentication yes
  KbdInteractiveAuthentication yes
`;
}

function plist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/sshd</string>
    <string>-D</string>
    <string>-f</string>
    <string>${SSHD_CONFIG}</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

/** Write a root-owned file via `sudo tee` (stdin → path). */
async function writeRoot(path: string, content: string): Promise<void> {
  if ((await run(['sudo', 'tee', path], { input: content })).code !== 0) die(`failed to write ${path}`);
}

async function setupDarwin(user: string, meshListen: string): Promise<void> {
  log(`Writing loopback sshd config (sudo): ${SSHD_CONFIG}`);
  await writeRoot(SSHD_CONFIG, sshdConfig(user, meshListen));
  if ((await run(['sudo', '/usr/sbin/sshd', '-t', '-f', SSHD_CONFIG])).code !== 0) {
    die(`sshd config invalid: ${SSHD_CONFIG}`);
  }
  log(`Installing LaunchDaemon (sudo): ${PLIST}`);
  await writeRoot(PLIST, plist());
  await run(['sudo', 'chown', 'root:wheel', PLIST]);
  await run(['sudo', 'chmod', '644', PLIST]);
  await run(['sudo', 'launchctl', 'bootout', `system/${LABEL}`]); // no-op if not loaded
  if ((await run(['sudo', 'launchctl', 'bootstrap', 'system', PLIST], { interactive: true })).code !== 0) {
    die('launchctl bootstrap failed');
  }
  const meshNote = meshListen ? ` + mesh ${meshListen}:${sshPort}` : '';
  ok(`khost sshd up on 127.0.0.1:${sshPort}${meshNote} (LaunchDaemon ${LABEL}) — LAN cannot reach it`);
  warn('If browser SSH fails to authenticate, grant Full Disk Access to /usr/sbin/sshd');
  warn('  in System Settings > Privacy & Security > Full Disk Access, then re-run.');
}

async function setupLinux(): Promise<void> {
  log(`Writing sshd drop-in (sudo): ${LINUX_DROPIN}`);
  await run(['sudo', 'mkdir', '-p', '/etc/ssh/sshd_config.d'], { interactive: true });
  await writeRoot(LINUX_DROPIN, linuxDropin());
  if ((await run(['sudo', 'sshd', '-t'])).code !== 0) {
    warn(`sshd -t failed; drop-in written but NOT reloaded — review ${LINUX_DROPIN}`);
    return;
  }
  const reload = await run(['sudo', 'systemctl', 'reload', 'ssh']);
  if (reload.code !== 0) await run(['sudo', 'systemctl', 'reload', 'sshd']);
  ok(`system sshd unchanged (port ${sshPort}, all interfaces); loopback password auth enabled for the tunnel`);
}

/** Install + start the sshd exposure (darwin: private loopback+mesh daemon;
 *  linux: system sshd untouched, loopback-only password-auth drop-in). */
export async function sshSetup(): Promise<void> {
  const user = currentUser();
  if (!user) die('could not determine current user for AllowUsers');
  if (osKind() === 'linux') return setupLinux();
  const meshListen = await resolveMeshListen(meshListenConfig);
  if (osKind() === 'darwin') return setupDarwin(user, meshListen);
  die('unsupported OS for ssh setup');
}

/** Remove khost's sshd footprint (darwin: the private daemon; linux: the drop-in). */
export async function sshDown(): Promise<void> {
  if (osKind() === 'darwin') {
    await run(['sudo', 'launchctl', 'bootout', `system/${LABEL}`]);
    await run(['sudo', 'rm', '-f', PLIST, SSHD_CONFIG]);
    ok('khost sshd removed');
    return;
  }
  await run(['sudo', 'rm', '-f', LINUX_DROPIN]);
  const r = await run(['sudo', 'systemctl', 'reload', 'ssh']);
  if (r.code !== 0) await run(['sudo', 'systemctl', 'reload', 'sshd']);
  ok('khost sshd drop-in removed (system sshd untouched)');
}

export async function sshStatus(): Promise<void> {
  console.log(`  os        : ${osKind()}`);
  if (osKind() === 'linux') {
    console.log(`  endpoint  : system sshd, port ${sshPort} (all interfaces — not privatized)`);
  } else {
    console.log(`  endpoint  : 127.0.0.1:${sshPort} (khost loopback sshd)`);
    const mesh = await resolveMeshListen(meshListenConfig);
    console.log(
      `  mesh      : ${mesh ? `${mesh}:${sshPort}` : 'disabled'}${meshListenConfig === 'auto' ? ' (auto)' : ''}`,
    );
  }
  const configPath = osKind() === 'darwin' ? PLIST : LINUX_DROPIN;
  console.log(
    existsSync(configPath) ? `  config    : present (${configPath})` : `  config    : absent — run "khost ssh setup"`,
  );
  const probe = await run(['sh', '-c', `nc -z -w2 127.0.0.1 ${sshPort} >/dev/null 2>&1 && echo up || echo down`]);
  console.log(`  listening : ${probe.stdout.trim() || '?'}`);
}
