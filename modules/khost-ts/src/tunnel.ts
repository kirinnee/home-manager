// Cloudflare Tunnel lifecycle — runs cloudflared as a persistent service that
// survives reboot. On macOS we hand-roll a launchd daemon so we can pass
// --protocol (QUIC/UDP to the edge is unreliable here — e.g. WARP interference —
// so we default to http2). On Linux we use cloudflared's own service manager.
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { osKind, tunnelName, tunnelPidfile, tunnelProtocol } from './deps';
import { die, log, need, ok, run, warn } from './exec';
import { cfConfigured, createTunnel, findTunnel, tunnelToken, verifyAccount, verifyToken } from './cloudflare';

const CFD_PLIST = '/Library/LaunchDaemons/cloud.atomi.khost.cloudflared.plist';
const CFD_LABEL = 'cloud.atomi.khost.cloudflared';
const CFD_LOG = '/Library/Logs/cloud.atomi.khost.cloudflared.log';
// cloudflared's own `service install` writes this; we replace it with our plist.
const LEGACY_PLIST = '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist';

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

/** Prefer the stable nix-profile symlink (updates on hms) over a pinned store path. */
async function cloudflaredBin(): Promise<string> {
  const profile = `${homedir()}/.nix-profile/bin/cloudflared`;
  if (existsSync(profile)) return profile;
  return (await run(['sh', '-c', 'command -v cloudflared'])).stdout.trim();
}

function cfdPlist(bin: string, token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CFD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>tunnel</string><string>run</string>
    <string>--protocol</string><string>${tunnelProtocol}</string>
    <string>--token</string><string>${token}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${CFD_LOG}</string>
  <key>StandardErrorPath</key><string>${CFD_LOG}</string>
</dict>
</plist>
`;
}

async function writeRoot(path: string, content: string): Promise<void> {
  if ((await run(['sudo', 'tee', path], { input: content })).code !== 0) die(`failed to write ${path}`);
}

export async function tunnelUp(): Promise<void> {
  if (!requireCf()) return; // graceful no-op; suite up still succeeds
  await need('cloudflared');

  const tok = await verifyToken();
  if (!tok.ok) die(`Cloudflare token check failed: ${tok.detail}\n  run 'khost doctor' for details`);
  const acct = await verifyAccount();
  if (!acct.ok) die(`Cloudflare account check failed: ${acct.detail}\n  run 'khost doctor' for details`);
  ok('Cloudflare credentials verified');

  const found = await findTunnel(tunnelName);
  const tun = found ?? (log(`Creating remotely-managed tunnel ${tunnelName}`), await createTunnel(tunnelName));
  log(`Tunnel ${tunnelName} = ${tun.id}`);
  const token = await tunnelToken(tun.id);
  await killOldDetached();

  if (osKind() === 'linux') {
    await run(['sudo', 'cloudflared', 'service', 'uninstall']); // ignore if none
    if ((await run(['sudo', 'cloudflared', 'service', 'install', token], { interactive: true })).code !== 0) {
      die('cloudflared service install failed');
    }
    ok('tunnel up — systemd service (survives reboot)');
    return;
  }

  // darwin: replace any cloudflared-managed service, then install our launchd
  // daemon with the chosen --protocol.
  if (existsSync(LEGACY_PLIST)) {
    log('Removing cloudflared-managed service (sudo)');
    await run(['sudo', 'cloudflared', 'service', 'uninstall']);
  }
  const bin = await cloudflaredBin();
  log(`Installing cloudflared launchd daemon (sudo): ${CFD_PLIST} [protocol=${tunnelProtocol}]`);
  await writeRoot(CFD_PLIST, cfdPlist(bin, token));
  await run(['sudo', 'chown', 'root:wheel', CFD_PLIST]);
  await run(['sudo', 'chmod', '644', CFD_PLIST]);
  await run(['sudo', 'launchctl', 'bootout', `system/${CFD_LABEL}`]); // no-op if not loaded
  if ((await run(['sudo', 'launchctl', 'bootstrap', 'system', CFD_PLIST], { interactive: true })).code !== 0) {
    die('launchctl bootstrap failed');
  }
  ok(`tunnel up — persistent service (protocol=${tunnelProtocol}, survives reboot) — logs: ${CFD_LOG}`);
}

export async function tunnelDown(): Promise<void> {
  await killOldDetached();
  if (osKind() === 'darwin') {
    await run(['sudo', 'launchctl', 'bootout', `system/${CFD_LABEL}`]);
    await run(['sudo', 'rm', '-f', CFD_PLIST]);
    await run(['sudo', 'cloudflared', 'service', 'uninstall']); // clean any legacy install too
  } else {
    await run(['sudo', 'cloudflared', 'service', 'uninstall']);
  }
  ok('tunnel service removed');
}

export async function tunnelStatus(): Promise<void> {
  if (osKind() === 'darwin') {
    console.log(existsSync(CFD_PLIST) ? `  service : installed (${CFD_PLIST})` : '  service : not installed');
  } else {
    const a = await run(['systemctl', 'is-active', 'cloudflared']);
    console.log(`  service : ${a.stdout.trim() || 'unknown'}`);
  }
  if (cfConfigured()) {
    const found = await findTunnel(tunnelName).catch(() => null);
    console.log(`  cloudflare tunnel: ${tunnelName} (${found?.id ?? 'none'})`);
  }
}
