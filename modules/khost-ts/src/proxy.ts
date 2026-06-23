// CLIProxyAPI (the :8317 LLM proxy) lifecycle: config split/merge, docker.
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import {
  composeTemplatePath,
  fragmentPath,
  proxyContainer,
  proxyPort,
  proxyRuntimeCompose,
  proxyRuntimeConfig,
  proxyState,
  repoProxyDir,
  secretPaths,
  skeletonPath,
} from './deps';
import { die, dockerCompose, log, need, ok, run, runOrThrow, warn } from './exec';

// --- sops helpers ---------------------------------------------------------
// Force yaml types: sops infers format from extension, and our temp/stream
// targets have none — without this it wraps everything under a `data:` blob.
async function sopsDecrypt(file: string): Promise<string> {
  return runOrThrow(['sops', '-d', '--input-type', 'yaml', '--output-type', 'yaml', file]);
}
async function sopsEncrypt(yamlText: string): Promise<string> {
  return runOrThrow(['sops', '-e', '--input-type', 'yaml', '--output-type', 'yaml', '/dev/stdin'], {
    input: yamlText,
  });
}

// --- config split (import) + merge (up) -----------------------------------

/** Build the runtime config.yaml from skeleton + decrypted fragment. */
async function renderConfig(): Promise<void> {
  if (!existsSync(skeletonPath)) die(`skeleton missing: ${skeletonPath} (run: khost proxy import)`);
  if (!existsSync(fragmentPath)) die(`secret fragment missing: ${fragmentPath} (run: khost proxy import)`);
  await need('sops');

  await mkdir(join(proxyState, 'auths'), { recursive: true });
  await mkdir(join(proxyState, 'logs'), { recursive: true });

  const skeleton = parse(await readFile(skeletonPath, 'utf8')) ?? {};
  const fragment = parse(await sopsDecrypt(fragmentPath)) ?? {};

  // Deep-merge: fragment (secrets) wins over skeleton.
  const merged = deepMerge(skeleton, fragment) as Record<string, unknown>;

  await writeFile(proxyRuntimeConfig, stringify(merged), { mode: 0o600 });
  await chmod(proxyRuntimeConfig, 0o600);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function deepMerge(a: unknown, b: unknown): unknown {
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
    return out;
  }
  return b === undefined ? a : b;
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

// --- secret split helpers (shared by import + capture) --------------------

/** Pull the secret subtrees (+ remote-management.secret-key) out of a parsed
 *  config into the fragment object. */
function buildFragment(full: Record<string, unknown>): Record<string, unknown> {
  const fragment: Record<string, unknown> = {};
  for (const p of secretPaths) if (p in full) fragment[p] = full[p];
  const rm = full['remote-management'];
  if (isObj(rm) && 'secret-key' in rm) fragment['remote-management'] = { 'secret-key': rm['secret-key'] };
  return fragment;
}

/** A deep clone of `full` with every secret subtree removed — the non-secret
 *  view that belongs in the plaintext skeleton. */
function stripSecrets(full: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(full)) as Record<string, unknown>;
  for (const p of secretPaths) delete out[p];
  if (isObj(out['remote-management'])) delete (out['remote-management'] as Record<string, unknown>)['secret-key'];
  return out;
}

/** Apply only the changed/added/removed keys of `next` onto an existing yaml
 *  Document, recursing into maps so untouched nodes keep their comments. */
function applyDiff(
  doc: ReturnType<typeof parseDocument>,
  path: string[],
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    const bp = [...path, k];
    if (isObj(v) && isObj(base[k])) {
      if (applyDiff(doc, bp, base[k] as Record<string, unknown>, v)) changed = true;
    } else if (!deepEqual(base[k], v)) {
      doc.setIn(bp, v);
      changed = true;
    }
  }
  for (const k of Object.keys(base)) {
    if (!(k in next)) {
      doc.deleteIn([...path, k]);
      changed = true;
    }
  }
  return changed;
}

/** Assert no known secret leaked into the skeleton text before writing it. */
function assertNoLeak(skeletonText: string): void {
  const skel = parse(skeletonText) as Record<string, unknown>;
  const leaked =
    secretPaths.some(p => p in skel) ||
    (isObj(skel['remote-management']) && 'secret-key' in (skel['remote-management'] as object));
  if (leaked) die('refusing to write skeleton: secret data still present after split');
}

/** One-time migration: split a live config.yaml into committed skeleton +
 *  sops-encrypted fragment, and seed auths/. */
export async function proxyImport(srcArg?: string): Promise<void> {
  await need('sops');
  const src = srcArg ?? join(process.env.HOME ?? '', 'Workspace/work/vungle/playground/proxy/config.yaml');
  if (!existsSync(src)) die(`source config not found: ${src} (pass: khost proxy import <config.yaml>)`);
  await mkdir(repoProxyDir, { recursive: true });
  log(`Importing from ${src}`);

  const full = parse(await readFile(src, 'utf8')) as Record<string, unknown>;

  // Fragment: only the secret subtrees (+ remote-management.secret-key).
  const fragment = buildFragment(full);

  // Skeleton: full config minus the secret subtrees (preserve comments).
  const skelDoc = parseDocument(await readFile(src, 'utf8'));
  for (const p of secretPaths) skelDoc.delete(p);
  const rmNode = skelDoc.get('remote-management');
  if (rmNode && typeof (rmNode as { delete?: unknown }).delete === 'function') {
    (rmNode as { delete: (k: string) => void }).delete('secret-key');
  }

  // Safety: assert no known secret remains in the skeleton before writing.
  assertNoLeak(skelDoc.toString());

  const header =
    '# CLIProxyAPI non-secret configuration skeleton (committed plaintext).\n' +
    "# Generated by 'khost proxy import'. Secret subtrees live in the sops\n" +
    "# fragment (config.secrets.enc.yaml) and are merged in at 'khost proxy up'.\n\n";
  await writeFile(skeletonPath, header + skelDoc.toString());
  await writeFile(fragmentPath, await sopsEncrypt(stringify(fragment)));

  // Seed auths/ (rotating OAuth creds -> host-local, not committed).
  const srcAuths = join(dirname(src), 'auths');
  if (existsSync(srcAuths)) {
    await mkdir(join(proxyState, 'auths'), { recursive: true });
    await cp(srcAuths, join(proxyState, 'auths'), { recursive: true });
    ok(`Seeded auths/ -> ${join(proxyState, 'auths')}`);
  } else {
    warn("no auths/ beside source; use 'khost proxy auth <provider>' later");
  }

  ok(`Wrote skeleton: ${skeletonPath}`);
  ok(`Wrote fragment: ${fragmentPath} (sops-encrypted)`);
  log("Next: git add the skeleton+fragment, then 'khost proxy up'");
}

/** Fold live edits (made via the CLIProxyAPI control panel / management API)
 *  from the runtime config.yaml back into the committed skeleton + sops
 *  fragment, so they survive the next `khost proxy up` re-render.
 *
 *  Idempotent: writes nothing when the runtime config already matches what
 *  skeleton+fragment render to. Secret subtrees go to the encrypted fragment;
 *  everything else is diffed onto the skeleton in place (comments preserved).
 *
 *  In `auto` mode (called from up/down) it never throws or aborts the caller —
 *  missing state or a sops hiccup just skips the capture with a warning. */
export async function proxyCapture(opts: { auto?: boolean } = {}): Promise<boolean> {
  const auto = opts.auto ?? false;
  const bail = (msg: string): boolean => {
    if (auto) {
      warn(`auto-capture skipped: ${msg}`);
      return false;
    }
    die(msg);
  };

  if (!existsSync(proxyRuntimeConfig)) return bail(`no runtime config: ${proxyRuntimeConfig} (run: khost proxy up)`);
  if (!existsSync(skeletonPath) || !existsSync(fragmentPath))
    return bail('skeleton/fragment missing (run: khost proxy import)');
  await need('sops');

  const live = (parse(await readFile(proxyRuntimeConfig, 'utf8')) ?? {}) as Record<string, unknown>;

  // Secrets -> fragment (only rewrite + re-encrypt when they actually changed,
  // since sops ciphertext is non-deterministic and would churn every run).
  const newFragment = buildFragment(live);
  const curFragment = (parse(await sopsDecrypt(fragmentPath)) ?? {}) as Record<string, unknown>;
  const fragmentChanged = !deepEqual(curFragment, newFragment);

  // Non-secret -> skeleton (apply only the diff to keep the doc comments).
  const skelDoc = parseDocument(await readFile(skeletonPath, 'utf8'));
  const curSkel = (parse(skelDoc.toString()) ?? {}) as Record<string, unknown>;
  const skeletonChanged = applyDiff(skelDoc, [], curSkel, stripSecrets(live));

  if (!fragmentChanged && !skeletonChanged) {
    if (!auto) ok('proxy config already in sync — nothing to capture');
    return false;
  }

  if (skeletonChanged) {
    assertNoLeak(skelDoc.toString());
    await writeFile(skeletonPath, skelDoc.toString());
  }
  if (fragmentChanged) await writeFile(fragmentPath, await sopsEncrypt(stringify(newFragment)));

  const what = [skeletonChanged ? 'skeleton' : null, fragmentChanged ? 'fragment (sops)' : null]
    .filter(Boolean)
    .join(' + ');
  ok(`captured live proxy edits → ${what}`);
  if (!auto) log(`Review & commit: git add ${repoProxyDir}`);
  return true;
}

// --- compose rendering + lifecycle ----------------------------------------

async function renderCompose(): Promise<void> {
  await mkdir(proxyState, { recursive: true });
  let tmpl = await readFile(composeTemplatePath, 'utf8');
  tmpl = tmpl.replaceAll('@STATE_DIR@', proxyState);
  await writeFile(proxyRuntimeCompose, tmpl);
}

async function runningImage(): Promise<string> {
  const r = await run(['docker', 'inspect', proxyContainer, '--format', '{{.Image}}']);
  return r.code === 0 ? r.stdout.trim() : 'none';
}

/** Idempotent proxy bring-up. Renders the config and (re)creates the container
 *  only when the rendered config actually changed — so re-running applies edits
 *  but doesn't churn a healthy container. Binds 127.0.0.1 only. */
export async function proxyUp(): Promise<void> {
  await need('docker');
  // Absorb any live control-panel edits back into the repo BEFORE re-rendering,
  // otherwise skeleton+fragment would clobber them. No-ops when already in sync.
  await proxyCapture({ auto: true });
  const before = existsSync(proxyRuntimeConfig) ? await readFile(proxyRuntimeConfig, 'utf8') : '';
  await renderConfig();
  await renderCompose();
  const after = await readFile(proxyRuntimeConfig, 'utf8');
  const changed = before !== after;
  log(`Starting CLIProxyAPI on :${proxyPort}${changed ? ' (config changed → recreate)' : ''}`);
  const args = changed ? ['up', '-d', '--force-recreate'] : ['up', '-d'];
  const r = await dockerCompose(args, { cwd: proxyState, interactive: true });
  if (r.code !== 0) die('docker compose up failed');
  ok('proxy up');
}

export async function proxyDown(): Promise<void> {
  if (!existsSync(proxyRuntimeCompose)) {
    warn('no runtime compose; nothing to stop');
    return;
  }
  // Persist any live control-panel edits before tearing the container down.
  await proxyCapture({ auto: true });
  await dockerCompose(['down'], { cwd: proxyState, interactive: true });
  ok('proxy down');
}

export async function proxyRestart(): Promise<void> {
  await proxyDown();
  await proxyUp();
}

export async function proxyStatus(): Promise<void> {
  if (!existsSync(proxyRuntimeCompose)) {
    warn('proxy not initialised (no runtime compose); run: khost proxy up');
    return;
  }
  await dockerCompose(['ps'], { cwd: proxyState, interactive: true });
  const img = await runningImage();
  if (img !== 'none') console.log(`running image: ${img}`);
}

export async function proxyLogs(args: string[]): Promise<void> {
  await dockerCompose(['logs', ...args], { cwd: proxyState, interactive: true });
}

/** Pull newest image THEN recreate (fixes pull-without-recreate drift). */
export async function proxyUpdate(): Promise<void> {
  await need('docker');
  if (!existsSync(proxyRuntimeCompose)) die('proxy not initialised; run: khost proxy up');
  const before = await runningImage();
  await dockerCompose(['pull'], { cwd: proxyState, interactive: true });
  await dockerCompose(['up', '-d'], { cwd: proxyState, interactive: true });
  const after = await runningImage();
  ok('update complete');
  console.log(`  before: ${before}\n  after : ${after}`);
  if (before === after) log('(already on latest image)');
}

/** Freeze the runtime compose to a specific image digest. */
export async function proxyPin(digest?: string): Promise<void> {
  if (!digest) die('usage: khost proxy pin <sha256:...>');
  if (!existsSync(proxyRuntimeCompose)) die('proxy not initialised; run: khost proxy up');
  const doc = await readFile(proxyRuntimeCompose, 'utf8');
  const pinned = doc.replace(/(image:\s*eceasy\/cli-proxy-api)[^\n]*/, `$1@${digest}`);
  await writeFile(proxyRuntimeCompose, pinned);
  await dockerCompose(['up', '-d'], { cwd: proxyState, interactive: true });
  ok(`pinned to ${digest}`);
}

export async function proxyAuth(provider?: string): Promise<void> {
  if (!provider) die('usage: khost proxy auth <provider>');
  if (!existsSync(proxyRuntimeCompose)) die('proxy not initialised; run: khost proxy up');
  log(`Launching CLIProxyAPI login for '${provider}' (follow the printed URL)`);
  const r = await run(['docker', 'exec', '-it', proxyContainer, '/CLIProxyAPI/CLIProxyAPI', 'auth', provider], {
    interactive: true,
  });
  if (r.code !== 0) {
    die(
      'auth failed — check the exact subcommand with: docker exec ' +
        proxyContainer +
        ' /CLIProxyAPI/CLIProxyAPI --help',
    );
  }
}

export async function proxyEdit(): Promise<void> {
  await need('sops');
  await run(['sops', fragmentPath], { interactive: true });
}
