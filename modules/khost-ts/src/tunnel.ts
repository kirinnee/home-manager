// Cloudflare Tunnel lifecycle — Level 2 self-provision (config_src: cloudflare).
// The tunnel runs as a persistent OS service (`cloudflared service install`) so
// it survives reboot — launchd on macOS, systemd on Linux. (Earlier khost ran
// cloudflared as a detached process; tunnelUp migrates off that.)
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { osKind, tunnelName, tunnelPidfile } from './deps';
import { die, log, need, ok, run, warn } from './exec';
import { cfConfigured, createTunnel, findTunnel, tunnelToken, verifyAccount, verifyToken } from './cloudflare';

// `cloudflared service install` writes this on macOS; presence = installed.
const SERVICE_PLIST = '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist';

function requireCf(): boolean {
  if (cfConfigured()) return true;
  warn('Cloudflare not configured — tunnel skipped.');
  console.log(`  To enable the tunnel, add these to your sops secrets (env: map) and rebuild:
    CLOUDFLARE_API_TOKEN   (perms: Cloudflare Tunnel:Edit, Cloudflare One Networks:Edit)
    CLOUDFLARE_ACCOUNT_ID
  Create the token at: https://dash.cloudflare.com/profile/api-tokens
  Then: hms  (to reload ~/.secrets) and re-run: khost tunnel up`);
  return false;
}

/** Migrate off the old model: kill a detached cloudflared from a stale pidfile. */
async function killOldDetached(): Promise<void> {
  if (!existsSync(tunnelPidfile)) return;
  const pid = Number.parseInt((await readFile(tunnelPidfile, 'utf8')).trim(), 10);
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid);
      log(`Stopped old detached cloudflared (pid ${pid})`);
    } catch {
      /* already gone */
    }
  }
  await rm(tunnelPidfile, { force: true });
}

export async function tunnelUp(): Promise<void> {
  if (!requireCf()) return; // graceful no-op; suite up still succeeds
  await need('cloudflared');

  // Preflight: fail clearly on a bad token/account before any provisioning.
  const tok = await verifyToken();
  if (!tok.ok) die(`Cloudflare token check failed: ${tok.detail}\n  run 'khost doctor' for details`);
  const acct = await verifyAccount();
  if (!acct.ok) die(`Cloudflare account check failed: ${acct.detail}\n  run 'khost doctor' for details`);
  ok('Cloudflare credentials verified');

  const found = await findTunnel(tunnelName);
  const tun = found ?? (log(`Creating remotely-managed tunnel ${tunnelName}`), await createTunnel(tunnelName));
  log(`Tunnel ${tunnelName} = ${tun.id}`);

  await killOldDetached();

  // Idempotent + self-healing: clear any existing (possibly stale/not-running)
  // service, then install fresh with the current token. `cloudflared service
  // install` also boots the service, so it's running on success.
  if (osKind() === 'darwin' ? existsSync(SERVICE_PLIST) : true) {
    log('Clearing any existing cloudflared service (sudo)');
    await run(['sudo', 'cloudflared', 'service', 'uninstall'], { interactive: true }); // ignore if none
  }

  const token = await tunnelToken(tun.id);
  log('Installing cloudflared as a persistent service (sudo)');
  const r = await run(['sudo', 'cloudflared', 'service', 'install', token], { interactive: true });
  if (r.code !== 0) die('cloudflared service install failed');
  ok('tunnel up — persistent service installed + started (survives reboot)');
}

export async function tunnelDown(): Promise<void> {
  await killOldDetached();
  const r = await run(['sudo', 'cloudflared', 'service', 'uninstall'], { interactive: true });
  if (r.code === 0) ok('tunnel service removed');
  else warn('no tunnel service to remove (or uninstall failed)');
}

export async function tunnelStatus(): Promise<void> {
  if (osKind() === 'darwin') {
    console.log(existsSync(SERVICE_PLIST) ? `  service : installed (${SERVICE_PLIST})` : '  service : not installed');
  } else {
    const a = await run(['systemctl', 'is-active', 'cloudflared']);
    console.log(`  service : ${a.stdout.trim() || 'unknown'}`);
  }
  if (cfConfigured()) {
    const found = await findTunnel(tunnelName).catch(() => null);
    console.log(`  cloudflare tunnel: ${tunnelName} (${found?.id ?? 'none'})`);
  }
}
