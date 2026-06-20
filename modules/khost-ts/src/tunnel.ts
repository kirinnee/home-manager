// Cloudflare Tunnel lifecycle — Level 2 self-provision (config_src: cloudflare).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { tunnelLog, tunnelName, tunnelPidfile, tunnelState } from './deps';
import { die, log, need, ok, warn } from './exec';
import { cfConfigured, createTunnel, findTunnel, tunnelToken, verifyAccount, verifyToken } from './cloudflare';

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

async function pidRunning(): Promise<number | null> {
  if (!existsSync(tunnelPidfile)) return null;
  const pid = Number.parseInt((await readFile(tunnelPidfile, 'utf8')).trim(), 10);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe
    return pid;
  } catch {
    return null;
  }
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

  await mkdir(tunnelState, { recursive: true });

  const existing = await pidRunning();
  if (existing) {
    ok(`tunnel already running (pid ${existing})`);
    return;
  }

  const found = await findTunnel(tunnelName);
  const tun = found ?? (log(`Creating remotely-managed tunnel ${tunnelName}`), await createTunnel(tunnelName));
  log(`Tunnel ${tunnelName} = ${tun.id}`);

  const token = await tunnelToken(tun.id);
  log('Starting cloudflared (background)');
  const fd = openSync(tunnelLog, 'a');
  const proc = Bun.spawn(['cloudflared', 'tunnel', 'run', '--token', token], {
    stdin: 'ignore',
    stdout: fd,
    stderr: fd,
  });
  proc.unref();
  await writeFile(tunnelPidfile, String(proc.pid));
  ok(`tunnel up (pid ${proc.pid}) — logs: ${tunnelLog}`);
}

export async function tunnelDown(): Promise<void> {
  const pid = await pidRunning();
  if (pid) {
    process.kill(pid);
    await rm(tunnelPidfile, { force: true });
    ok('tunnel stopped');
  } else {
    warn('tunnel not running');
    await rm(tunnelPidfile, { force: true });
  }
}

export async function tunnelStatus(): Promise<void> {
  const pid = await pidRunning();
  if (pid) ok(`tunnel running (pid ${pid})`);
  else warn('tunnel not running');
  if (cfConfigured()) {
    const found = await findTunnel(tunnelName).catch(() => null);
    console.log(`  cloudflare tunnel: ${tunnelName} (${found?.id ?? 'none'})`);
  }
}
