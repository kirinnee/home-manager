// `kloge pull` — read the loge credential Secret out of the LLM cluster and
// render it into local CLIProxyAPI auth files + config + compose.
//
// GitHub org secrets are write-only, so the only readable source is the
// Kubernetes Secret loge/loge-credentials. Access goes through plain kubectl
// against the configured context (kubeconfig + AWS auth must already be valid;
// the LLM cluster only authorizes the DevOps role). This copies SHARED
// PRODUCTION credentials onto this machine — see README for the risk note.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authDir, CLAUDE_KEY_RE, CODEX_KEY_RE, dataDir, resolvePort } from './paths';
import { renderArtifacts } from './render';
import { normalizeClaudeTokenJson, normalizeCodexTokenJson } from './tokens';
import { die, log, must, need, ok, run, warn } from './exec';

export interface PullOpts {
  context: string; // kube context
  namespace: string;
  secret: string;
  port?: number;
}

interface K8sSecret {
  data?: Record<string, string>;
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

  // Start from a clean auth dir so removed credentials don't linger.
  if (existsSync(authDir)) rmSync(authDir, { recursive: true, force: true });
  mkdirSync(authDir, { recursive: true, mode: 0o700 });

  // Discover every codex/claude token key present (count is not fixed at 1..3).
  // Other keys in the secret (CODEX_BASE_URL, API keys, …) are ignored here.
  let codex = 0;
  let claude = 0;
  for (const [key, b64] of Object.entries(data)) {
    let m: RegExpMatchArray | null;
    if ((m = key.match(CODEX_KEY_RE))) {
      const json = normalizeCodexTokenJson(key, decode(b64));
      writeFileSync(join(authDir, `codex-${m[1]}.json`), json, { mode: 0o600 });
      codex += 1;
    } else if ((m = key.match(CLAUDE_KEY_RE))) {
      const json = normalizeClaudeTokenJson(key, decode(b64));
      writeFileSync(join(authDir, `claude-${m[1]}.json`), json, { mode: 0o600 });
      claude += 1;
    }
  }
  const written = codex + claude;

  if (written === 0) die('no CODEX_/CLAUDE_ token keys found in the secret');

  const port = opts.port ?? resolvePort();
  renderArtifacts(port);
  // Lock down the dir — it holds live provider credentials.
  chmodSync(dataDir, 0o700);

  ok(`wrote ${written} credential file(s) (${claude} claude, ${codex} codex) to ${authDir}`);
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
