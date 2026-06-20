// SSH over the khost tunnel. macOS Remote Login socket-activates sshd on ALL
// interfaces (launchd owns the socket → LAN-exposed, ListenAddress ignored). So
// instead khost runs its OWN sshd bound to 127.0.0.1:<sshPort> as a LaunchDaemon.
// The tunnel reaches it via loopback; the LAN cannot — which makes password auth
// safe (only the Access-gated tunnel can connect). Linux uses a config drop-in
// (sshd there isn't socket-activated, so ListenAddress works directly).
import { existsSync } from 'node:fs';
import { osKind, sshPort } from './deps';
import { die, log, ok, run, warn } from './exec';

const SSHD_CONFIG = '/etc/ssh/khost_sshd_config';
const PLIST = '/Library/LaunchDaemons/cloud.atomi.khost.sshd.plist';
const LABEL = 'cloud.atomi.khost.sshd';
const LINUX_DROPIN = '/etc/ssh/sshd_config.d/100-khost.conf';

function currentUser(): string {
  return process.env.SUDO_USER ?? process.env.USER ?? '';
}

function sshdConfig(user: string): string {
  return `# Managed by khost — loopback-only sshd for the Cloudflare tunnel.
# Bound to 127.0.0.1 so only the tunnel (and local user) can reach it; the LAN
# cannot. Password auth is ON for Cloudflare browser-rendered SSH.
Port ${sshPort}
ListenAddress 127.0.0.1
PasswordAuthentication yes
KbdInteractiveAuthentication yes
PermitRootLogin no
AllowUsers ${user}
UsePAM yes
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_rsa_key
PidFile /var/run/khost_sshd.pid
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

async function setupDarwin(user: string): Promise<void> {
  log(`Writing loopback sshd config (sudo): ${SSHD_CONFIG}`);
  await writeRoot(SSHD_CONFIG, sshdConfig(user));
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
  ok(`khost sshd up on 127.0.0.1:${sshPort} (LaunchDaemon ${LABEL}) — LAN cannot reach it`);
  warn('If browser SSH fails to authenticate, grant Full Disk Access to /usr/sbin/sshd');
  warn('  in System Settings > Privacy & Security > Full Disk Access, then re-run.');
}

async function setupLinux(user: string): Promise<void> {
  log(`Writing sshd drop-in (sudo): ${LINUX_DROPIN}`);
  await run(['sudo', 'mkdir', '-p', '/etc/ssh/sshd_config.d'], { interactive: true });
  await writeRoot(LINUX_DROPIN, sshdConfig(user));
  if ((await run(['sudo', 'sshd', '-t'])).code !== 0) {
    warn(`sshd -t failed; drop-in written but NOT reloaded — review ${LINUX_DROPIN}`);
    return;
  }
  const reload = await run(['sudo', 'systemctl', 'restart', 'ssh']);
  if (reload.code !== 0) await run(['sudo', 'systemctl', 'restart', 'sshd']);
  ok(`khost sshd on 127.0.0.1:${sshPort} (drop-in) — LAN cannot reach it`);
}

/** Install + start a loopback-only sshd for the tunnel (idempotent). */
export async function sshSetup(): Promise<void> {
  const user = currentUser();
  if (!user) die('could not determine current user for AllowUsers');
  if (osKind() === 'darwin') return setupDarwin(user);
  if (osKind() === 'linux') return setupLinux(user);
  die('unsupported OS for ssh setup');
}

/** Stop + remove the loopback sshd. */
export async function sshDown(): Promise<void> {
  if (osKind() === 'darwin') {
    await run(['sudo', 'launchctl', 'bootout', `system/${LABEL}`]);
    await run(['sudo', 'rm', '-f', PLIST, SSHD_CONFIG]);
  } else {
    await run(['sudo', 'rm', '-f', LINUX_DROPIN]);
    const r = await run(['sudo', 'systemctl', 'restart', 'ssh']);
    if (r.code !== 0) await run(['sudo', 'systemctl', 'restart', 'sshd']);
  }
  ok('khost sshd removed');
}

export async function sshStatus(): Promise<void> {
  console.log(`  os        : ${osKind()}`);
  console.log(`  endpoint  : 127.0.0.1:${sshPort} (khost loopback sshd)`);
  const configPath = osKind() === 'darwin' ? PLIST : LINUX_DROPIN;
  console.log(
    existsSync(configPath) ? `  config    : present (${configPath})` : `  config    : absent — run "khost ssh setup"`,
  );
  const probe = await run(['sh', '-c', `nc -z -w2 127.0.0.1 ${sshPort} >/dev/null 2>&1 && echo up || echo down`]);
  console.log(`  listening : ${probe.stdout.trim() || '?'}`);
}
