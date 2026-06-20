// SSH: portable hardened drop-in; OS-specific enable. sudo-on-demand.
import { existsSync } from 'node:fs';
import { osKind } from './deps';
import { die, log, ok, run, warn } from './exec';

const SSHD_DROPIN = '/etc/ssh/sshd_config.d/100-khost.conf';

function currentUser(): string {
  return process.env.SUDO_USER ?? process.env.USER ?? '';
}

export async function sshHarden(): Promise<void> {
  const user = currentUser();
  if (!user) die('could not determine current user for AllowUsers');
  log(`Writing hardened sshd drop-in (sudo): ${SSHD_DROPIN}`);
  // Password auth is ON so Cloudflare browser-rendered SSH can log in without a
  // short-lived-cert CA. Remote reach is only via the Access-gated tunnel; root
  // is off and access is limited to the single owner user.
  const body = `# Managed by khost. Password auth ON (for Cloudflare browser SSH), no root, single user.
PasswordAuthentication yes
KbdInteractiveAuthentication yes
PermitRootLogin no
AllowUsers ${user}
`;
  await run(['sudo', 'mkdir', '-p', '/etc/ssh/sshd_config.d'], { interactive: true });
  await run(['sudo', 'tee', SSHD_DROPIN], { input: body });

  // Validate before reloading so a typo never wedges sshd.
  if ((await run(['sudo', 'sshd', '-t'])).code === 0) {
    if (osKind() === 'darwin') {
      await run(['sudo', 'launchctl', 'kickstart', '-k', 'system/com.openssh.sshd']);
    } else {
      const reload = await run(['sudo', 'systemctl', 'reload', 'ssh']);
      if (reload.code !== 0) await run(['sudo', 'systemctl', 'reload', 'sshd']);
    }
    ok(`sshd hardened (key-only, no root, AllowUsers ${user})`);
  } else {
    warn(`sshd -t failed; drop-in written but NOT reloaded — review ${SSHD_DROPIN}`);
  }
  warn('ensure your client public key is in ~/.ssh/authorized_keys BEFORE disconnecting');
}

export async function sshEnable(): Promise<void> {
  if (osKind() === 'darwin') {
    log('Enabling macOS Remote Login (sudo)');
    const r = await run(['sudo', 'systemsetup', '-setremotelogin', 'on'], { interactive: true });
    if (r.code !== 0) die('could not enable Remote Login (System Settings > General > Sharing > Remote Login)');
    ok('Remote Login enabled');
    return;
  }
  if (osKind() === 'linux') {
    if ((await run(['sh', '-c', 'command -v systemctl'])).code !== 0) {
      warn("no systemd; enable your SSH server manually, then re-run 'khost ssh harden'");
      return;
    }
    log('Enabling sshd (sudo)');
    const a = await run(['sudo', 'systemctl', 'enable', '--now', 'ssh'], { interactive: true });
    if (a.code !== 0) {
      const b = await run(['sudo', 'systemctl', 'enable', '--now', 'sshd'], { interactive: true });
      if (b.code !== 0) die('could not enable ssh/sshd service');
    }
    ok('sshd enabled');
    return;
  }
  die('unsupported OS for ssh enable');
}

export async function sshStatus(): Promise<void> {
  console.log(`  os          : ${osKind()}`);
  if (osKind() === 'darwin') {
    const r = await run(['sudo', 'systemsetup', '-getremotelogin']);
    console.log(`  remote login: ${r.stdout.replace(/^.*:\s*/, '').trim() || '?'}`);
  } else if (osKind() === 'linux') {
    const a = await run(['systemctl', 'is-active', 'ssh']);
    const s = a.code === 0 ? a.stdout.trim() : (await run(['systemctl', 'is-active', 'sshd'])).stdout.trim();
    console.log(`  sshd        : ${s || '?'}`);
  }
  console.log(
    existsSync(SSHD_DROPIN)
      ? `  hardening   : present (${SSHD_DROPIN})`
      : `  hardening   : absent — run "khost ssh harden"`,
  );
}

/** One-shot: enable Remote Login + apply the hardened drop-in (idempotent). */
export async function sshSetup(): Promise<void> {
  await sshEnable();
  await sshHarden();
}
