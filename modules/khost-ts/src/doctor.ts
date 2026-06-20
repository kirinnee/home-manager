// Preflight checks: tooling, secrets, and Cloudflare credentials. Run on demand
// (`khost doctor`) and reused by `tunnel up` to fail clearly before provisioning.
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import { cfAccountId, cfApiToken, fragmentPath, osKind, skeletonPath } from './deps';
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

/** Run the Cloudflare credential checks (token verify + account access). */
async function cloudflareChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  if (!cfConfigured()) {
    checks.push({
      label: 'cloudflare creds',
      ok: false,
      required: false,
      detail: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set (tunnel disabled)',
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

  // Tooling.
  for (const bin of ['docker', 'sops', 'cloudflared']) {
    const present = await onPath(bin);
    checks.push({
      label: `tool: ${bin}`,
      ok: present,
      required: bin !== 'cloudflared', // cloudflared only needed for the tunnel
      detail: present ? 'on PATH' : 'missing',
    });
  }

  // Config / secrets.
  checks.push({
    label: 'proxy skeleton',
    ok: existsSync(skeletonPath),
    required: true,
    detail: existsSync(skeletonPath) ? skeletonPath : "missing — run 'khost proxy import'",
  });
  checks.push({
    label: 'secret fragment',
    ok: existsSync(fragmentPath),
    required: true,
    detail: existsSync(fragmentPath) ? fragmentPath : "missing — run 'khost proxy import'",
  });

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
