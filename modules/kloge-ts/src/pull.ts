// `kloge pull` — read the loge credential Secret out of the LLM cluster and
// render it into local CLIProxyAPI auth files + config + compose.
//
// GitHub org secrets are write-only, so the only readable source is the
// Kubernetes Secret loge/loge-credentials. Access goes through plain kubectl
// against the configured context (kubeconfig + AWS auth must already be valid;
// the LLM cluster only authorizes the DevOps role). This copies SHARED
// PRODUCTION credentials onto this machine — see README for the risk note.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authDir,
  CLAUDE_KEY_RE,
  CODEX_KEY_RE,
  dataDir,
  decryptedSecretsFile,
  decryptSecretsScript,
  encryptSecretsScript,
  kfleetConfigFile,
  resolvePort,
} from './paths';
import { renderArtifacts } from './render';
import {
  claudeCredentialDestinations,
  claudeSopsEnvTokens,
  hasDirectClaudeCredential,
  normalizeClaudeTokenJson,
  normalizeCodexTokenJson,
  type ClaudeSopsEnvToken,
} from './tokens';
import { die, log, must, need, ok, run, type RunOpts, warn } from './exec';

export interface PullOpts {
  context: string; // kube context
  namespace: string;
  secret: string;
  port?: number;
}

interface K8sSecret {
  data?: Record<string, string>;
}

type CommandRunner = (cmd: string[], opts?: RunOpts) => Promise<unknown>;

function secretsYamlSetCommand(): string[] {
  // The key and value travel in the short-lived yq environment, never argv.
  return ['yq', '--inplace', '.env[strenv(KLOGE_SECRET_KEY)] = strenv(KLOGE_SECRET_VALUE)', decryptedSecretsFile];
}

/** Edit the decrypted source of truth without exposing token values in argv. */
export async function materializeClaudeSopsEnv(
  tokens: readonly ClaudeSopsEnvToken[],
  runCommand: CommandRunner,
): Promise<void> {
  for (const token of tokens) {
    await runCommand(secretsYamlSetCommand(), {
      env: {
        KLOGE_SECRET_KEY: token.destination,
        KLOGE_SECRET_VALUE: token.value,
      },
    });
  }
}

interface SecretSyncDeps {
  fileExists: (file: string) => boolean;
  requireTool: (tool: string) => Promise<void>;
  runCommand: CommandRunner;
}

/** Follow the repository's required secrets workflow exactly: ensure a
 *  decrypted working copy, edit it, then invoke the canonical encrypt script. */
export async function syncClaudeSopsEnv(
  tokens: readonly ClaudeSopsEnvToken[],
  overrides: Partial<SecretSyncDeps> = {},
): Promise<void> {
  if (tokens.length === 0) return;
  const deps: SecretSyncDeps = {
    fileExists: existsSync,
    requireTool: need,
    runCommand: (cmd, opts) => must(cmd, opts),
    ...overrides,
  };
  await deps.requireTool('sops');
  await deps.requireTool('yq');
  if (!deps.fileExists(decryptedSecretsFile)) await deps.runCommand([decryptSecretsScript]);
  if (!deps.fileExists(decryptedSecretsFile)) {
    throw new Error(`decrypted secrets file was not created at ${decryptedSecretsFile}`);
  }
  await materializeClaudeSopsEnv(tokens, deps.runCommand);
  await deps.runCommand([encryptSecretsScript]);
}

export async function pull(opts: PullOpts): Promise<void> {
  await need('kubectl');

  const cmd = ['kubectl', '--context', opts.context, '-n', opts.namespace, 'get', 'secret', opts.secret, '-o', 'json'];
  log(`pulling ${opts.namespace}/${opts.secret} via: ${cmd.join(' ')}`);
  const raw = await must(cmd);

  let secret: K8sSecret;
  try {
    secret = JSON.parse(raw) as K8sSecret;
  } catch (err) {
    die(`could not parse kubectl JSON output: ${(err as Error).message}`);
  }
  const data = secret.data ?? {};
  if (Object.keys(data).length === 0) die('secret has no data keys');

  const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
  const decoded = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, decode(value)]));
  // Codex-only and proxy-only pulls retain their old behavior and do not need a
  // home-manager checkout. Read kfleet config only when slots 1..6 are present.
  const claudeSopsTokens = hasDirectClaudeCredential(decoded)
    ? claudeSopsEnvTokens(decoded, claudeCredentialDestinations(readFileSync(kfleetConfigFile, 'utf8')))
    : [];

  // Start from a clean auth dir so removed credentials don't linger.
  if (existsSync(authDir)) rmSync(authDir, { recursive: true, force: true });
  mkdirSync(authDir, { recursive: true, mode: 0o700 });

  // Discover every codex/claude token key present (count is not fixed at 1..3).
  // Other keys in the secret (CODEX_BASE_URL, API keys, …) are ignored here.
  let codex = 0;
  let claude = 0;
  for (const [key, token] of Object.entries(decoded)) {
    let m: RegExpMatchArray | null;
    if ((m = key.match(CODEX_KEY_RE))) {
      const json = normalizeCodexTokenJson(key, token);
      writeFileSync(join(authDir, `codex-${m[1]}.json`), json, { mode: 0o600 });
      codex += 1;
    } else if ((m = key.match(CLAUDE_KEY_RE))) {
      const json = normalizeClaudeTokenJson(key, token);
      writeFileSync(join(authDir, `claude-${m[1]}.json`), json, { mode: 0o600 });
      claude += 1;
    }
  }
  const written = codex + claude;

  if (written === 0) die('no CODEX_/CLAUDE_ token keys found in the secret');

  const port = opts.port ?? resolvePort();
  renderArtifacts(port);
  await syncClaudeSopsEnv(claudeSopsTokens);
  // Lock down the dir — it holds live provider credentials.
  chmodSync(dataDir, 0o700);

  ok(`wrote ${written} credential file(s) (${claude} claude, ${codex} codex) to ${authDir}`);
  if (claudeSopsTokens.length > 0) {
    ok(`synced ${claudeSopsTokens.length} Claude credential(s) to declared secrets-file keys and re-encrypted`);
  }
  ok(`rendered config.yaml + compose.yaml (port ${port})`);
  log('next: `kloge up` (local) or `kloge push <user@host>`');
}

// A tiny helper so `kloge render` can re-render without a pull (e.g. port change).
export async function renderOnly(port: number): Promise<void> {
  if (!existsSync(authDir)) warn(`no auth dir yet at ${authDir} — run \`kloge pull\` first`);
  renderArtifacts(port);
  await run(['true']); // keep this async-shaped for symmetry
  ok(`rendered config.yaml + compose.yaml (port ${port})`);
}
