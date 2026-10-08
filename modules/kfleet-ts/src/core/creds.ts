// Low-level credential access shared by usage probing (core/usage.ts) and
// fleet login/sync (core/login.ts), and the apply-time secrets-file check.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

/** First 8 hex of sha256(absolute config-dir path) — the suffix Claude Code uses
 *  for its keychain item name `Claude Code-credentials-<suffix>`. */
export function keychainSuffix(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
}

/** Read a macOS Keychain generic-password secret by service name (-w = raw). Bounded
 *  by `timeoutMs` so a locked/stalled Keychain can't hang the whole probe cycle. */
async function readKeychain(service: string, timeoutMs: number): Promise<string | null> {
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

const READ_SECRETS_FILE_KEYS = `
set -a
. "$1" >/dev/null 2>&1 || exit 1
shift
exec "$1" -e 'const out = {}; for (const k of process.argv.slice(1)) if (process.env[k]) out[k] = true; process.stdout.write(JSON.stringify(out))' "$@"
`;

/** Which of `keys` hold a non-empty value in the generated `~/.secrets` shell
 *  file. Only the FILE counts (not the caller's ambient env): it is what
 *  load-secrets just projected from upstream, so a key a stale shell still
 *  exports is still treated as gone. Values never leave the child process.
 *  A missing file means no keys; null means the file could not be read, so the
 *  caller must not conclude anything is absent. */
export function secretsFileKeysPresent(keys: string[], file: string): Set<string> | null {
  if (!keys.length || !existsSync(file)) return new Set();
  const child = Bun.spawnSync({
    cmd: ['/bin/sh', '-c', READ_SECRETS_FILE_KEYS, 'kfleet-read-secrets', file, process.execPath, ...keys],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5_000,
  });
  if (!child.success) return null;
  try {
    return new Set(Object.keys(JSON.parse(child.stdout.toString()) as Record<string, true>));
  } catch {
    return null;
  }
}
