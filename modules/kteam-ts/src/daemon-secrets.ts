import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type DaemonSecretsLoadStatus = 'loaded' | 'missing' | 'failed';

type MutableEnvironment = Record<string, string | undefined>;

export interface DaemonSecretsLoadOptions {
  secretsFile?: string;
  target?: MutableEnvironment;
  timeoutMs?: number;
}

const PROTECTED_DAEMON_ENV = new Set([
  'HOME',
  'LOGNAME',
  'NODE_ENV',
  'OLDPWD',
  'PATH',
  'PWD',
  'SHELL',
  'SHLVL',
  'TMPDIR',
  'TMUX',
  'TMUX_PANE',
  'USER',
  '_',
]);
const sourcedEnvironmentKeys = new Set<string>();
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)(?:_|$)/i;
const ASSIGNED_ENV_NAME = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm;

/** True when a daemon env key must never be materialized into a durable pane
 * launcher. Exact sourced names cover arbitrary provider naming; the name
 * pattern also protects credentials inherited before this loader ran. */
export function isDaemonSecretEnvironmentKey(key: string): boolean {
  return sourcedEnvironmentKeys.has(key) || SENSITIVE_ENV_NAME.test(key);
}

// ~/.secrets is deliberately shell syntax (`export KEY=VALUE`), not dotenv.
// Let a real shell interpret it, then use a short-lived Bun child to serialize
// the resulting environment without ever putting secret values in argv or a
// log line. Both source output and stderr stay suppressed: even a malformed
// generated file must not echo a credential into the daemon journal.
const SOURCE_AND_SERIALIZE = `
set -a
. "$1" >/dev/null 2>&1 || exit 1
exec "$2" -e 'process.stdout.write(JSON.stringify(process.env))'
`;

/** Load the generated shell environment into this process once at daemon boot.
 *
 * Missing is an intentional no-op. Every other failure is reported only as a
 * status so the daemon can stay available and surface unavailable provider
 * credentials through warden health, without logging secret values.
 */
export function loadDaemonSecretsEnvironment(options: DaemonSecretsLoadOptions = {}): DaemonSecretsLoadStatus {
  const secretsFile = options.secretsFile ?? path.join(homedir(), '.secrets');
  const target = options.target ?? process.env;
  sourcedEnvironmentKeys.clear();
  if (!existsSync(secretsFile)) return 'missing';

  let source: string;
  try {
    source = readFileSync(secretsFile, 'utf8');
  } catch {
    return 'failed';
  }
  const declaredKeys = new Set([...source.matchAll(ASSIGNED_ENV_NAME)].map(match => match[1]!));
  // Register names before evaluation so even a malformed file fails safe: a
  // daemon that inherited one of these values must not persist it in a pane
  // launcher just because sourcing the current file failed.
  for (const key of declaredKeys) {
    if (!key.startsWith('KTEAM_') && !PROTECTED_DAEMON_ENV.has(key)) sourcedEnvironmentKeys.add(key);
  }

  const baseline = { ...target };

  const child = Bun.spawnSync({
    cmd: ['/bin/sh', '-c', SOURCE_AND_SERIALIZE, 'kteam-load-secrets', secretsFile, process.execPath],
    env: target,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (!child.success) return 'failed';

  let loaded: unknown;
  try {
    loaded = JSON.parse(child.stdout.toString());
  } catch {
    return 'failed';
  }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return 'failed';
  const entries = Object.entries(loaded).filter(
    ([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('KTEAM_') && !PROTECTED_DAEMON_ENV.has(key),
  );
  if (entries.some(([, value]) => typeof value !== 'string')) return 'failed';

  // Validate the whole payload before mutating the daemon environment, so a
  // failed load can never leave it with a partially imported secret set.
  for (const [key, value] of entries) {
    // Dynamically assigned keys might not appear as a literal assignment in
    // the generated file, but a changed value proves the source introduced it.
    if (baseline[key] !== value) sourcedEnvironmentKeys.add(key);
    if (baseline[key] === value) continue;
    target[key] = value as string;
  }
  return 'loaded';
}
