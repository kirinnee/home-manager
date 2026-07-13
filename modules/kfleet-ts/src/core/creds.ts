// Low-level credential access shared by usage probing (core/usage.ts) and
// fleet login/sync (core/login.ts).
import { createHash } from 'node:crypto';

/** First 8 hex of sha256(absolute config-dir path) — the suffix Claude Code uses
 *  for its keychain item name `Claude Code-credentials-<suffix>`. */
export function keychainSuffix(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
}

/** Read a macOS Keychain generic-password secret by service name (-w = raw). Bounded
 *  by `timeoutMs` so a locked/stalled Keychain can't hang the whole probe cycle. */
export async function readKeychain(service: string, timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn({
      cmd: ['security', 'find-generic-password', '-s', service, '-w'],
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) return null;
      const trimmed = out.trim();
      return trimmed.length ? trimmed : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Read the Claude Code OAuth credential blob for a config dir, wherever this
 *  platform stores it: macOS keeps it in the Keychain (`Claude Code-credentials-
 *  <suffix>`), Linux in `<configDir>/.credentials.json`. */
export async function readClaudeCred(configDir: string, timeoutMs: number): Promise<string | null> {
  if (process.platform === 'darwin') {
    return readKeychain(`Claude Code-credentials-${keychainSuffix(configDir)}`, timeoutMs);
  }
  try {
    const file = Bun.file(`${configDir}/.credentials.json`);
    if (!(await file.exists())) return null;
    const text = (await file.text()).trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

/** Decode a JWT's `exp` (seconds → epoch ms) without verifying the signature. */
export function jwtExpMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
