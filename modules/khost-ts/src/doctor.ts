// Preflight checks: tooling, secrets, Cloudflare credentials, and Alloy. Run on
// demand (`khost doctor`) and reused by `tunnel up` to fail clearly before
// provisioning.
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import {
  alloyConfigFile,
  alloyRemoteWritePassword,
  alloyRemoteWriteUrl,
  alloyRemoteWriteUsername,
  cfAccountId,
  cfApiToken,
  configFile,
  machineId,
  osKind,
  tunnelName,
} from './deps';
import { run } from './exec';
import { cfConfigured, verifyAccount, verifyToken } from './cloudflare';

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  /** false = informational only, doesn't fail an overall gate */
  required: boolean;
}

async function onPath(bin: string): Promise<boolean> {
  return (await run(['sh', '-c', `command -v ${bin}`])).code === 0;
}

// sshd usually lives in /usr/sbin (not on a non-root PATH), so check the common
// absolute locations too before declaring it missing.
async function sshdPresent(): Promise<boolean> {
  if (await onPath('sshd')) return true;
  return ['/usr/sbin/sshd', '/usr/bin/sshd', '/sbin/sshd'].some(p => existsSync(p));
}

/** Run the Cloudflare credential checks (token verify + account access). */
async function cloudflareChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  if (!cfConfigured()) {
    checks.push({
      label: 'cloudflare creds',
      ok: false,
      required: false,
      detail: 'cloudflare.account_id / api_token not set in config.yaml (tunnel disabled)',
    });
    return checks;
  }
  const tok = await verifyToken();
  checks.push({ label: 'cloudflare token', ok: tok.ok, required: true, detail: tok.detail });
  if (tok.ok) {
    const acct = await verifyAccount();
    checks.push({ label: 'cloudflare account', ok: acct.ok, required: true, detail: acct.detail });
  }
  return checks;
}

/** Full preflight. Returns true if all *required* checks passed. */
export async function doctor(): Promise<boolean> {
  const checks: Check[] = [];

  // Machine identity (informational): the tunnel/route namespace for this box.
  checks.push({
    label: 'machine id',
    ok: true,
    required: false,
    detail: `${machineId} (tunnel: ${tunnelName})`,
  });

  // Tooling. docker runs the alloy container; sshd backs the loopback SSH
  // listener; cloudflared is only for the tunnel.
  const tools: { bin: string; required: boolean; note: string }[] = [
    { bin: 'bun', required: true, note: 'runtime' },
    { bin: 'docker', required: true, note: 'alloy container' },
    { bin: 'cloudflared', required: false, note: 'only for the tunnel' },
  ];
  for (const t of tools) {
    const present = await onPath(t.bin);
    checks.push({
      label: `tool: ${t.bin}`,
      ok: present,
      required: t.required,
      detail: present ? 'on PATH' : `missing — ${t.note}`,
    });
  }
  const sshd = await sshdPresent();
  checks.push({
    label: 'tool: sshd',
    ok: sshd,
    required: true,
    detail: sshd ? 'present' : 'missing — install openssh-server (loopback SSH listener)',
  });

  // Config files (~/.khost).
  checks.push({
    label: 'config.yaml',
    ok: existsSync(configFile),
    required: false,
    detail: existsSync(configFile) ? configFile : `missing — run 'khost init' (using defaults)`,
  });
  checks.push({
    label: 'alloy.alloy',
    ok: existsSync(alloyConfigFile),
    required: false,
    detail: existsSync(alloyConfigFile) ? alloyConfigFile : `missing — run 'khost init' (Alloy metrics disabled)`,
  });

  // Alloy remote_write (optional): if a url is configured, the token must be too,
  // else metrics scrape locally but never ship.
  if (alloyRemoteWriteUrl) {
    // The token (password) is the gate. Username is only needed for basic_auth
    // (e.g. Grafana Cloud); bearer/no-auth setups leave it blank — so note a
    // missing username rather than failing on it.
    const hasToken = Boolean(alloyRemoteWritePassword);
    const noUser = hasToken && !alloyRemoteWriteUsername ? ' (no username — ok for bearer/no-auth)' : '';
    checks.push({
      label: 'alloy remote_write',
      ok: hasToken,
      required: false,
      detail: hasToken
        ? `configured → ${alloyRemoteWriteUrl}${noUser}`
        : `url set but token missing — set ALLOY_REMOTE_WRITE_PASSWORD (or alloy.remote_write.password)`,
    });
  } else {
    checks.push({
      label: 'alloy remote_write',
      ok: true,
      required: false,
      detail: 'not set — Alloy scrapes locally only (no remote_write)',
    });
  }

  // Cloudflare.
  checks.push(...(await cloudflareChecks()));

  // Render.
  console.log(`${pc.bold('khost doctor')} (${osKind()})\n`);
  let allRequiredOk = true;
  for (const c of checks) {
    const mark = c.ok ? pc.green('✓') : c.required ? pc.red('✗') : pc.yellow('!');
    console.log(`  ${mark} ${c.label.padEnd(20)} ${c.detail}`);
    if (!c.ok && c.required) allRequiredOk = false;
  }
  console.log();
  if (allRequiredOk) {
    console.log(pc.green('All required checks passed.'));
  } else {
    console.log(pc.red('Some required checks failed — see above.'));
  }
  // Hint for the common missing-token case.
  if (cfApiToken && !cfAccountId) console.log(pc.yellow('note: token set but account id missing.'));
  return allRequiredOk;
}
