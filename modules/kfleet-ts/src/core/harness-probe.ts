import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const HARNESS_PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_HARNESS_PROBE_TIMEOUT_MS = 30_000;
export const HARNESS_PROBE_SENTINEL = 'KFLEET_HEALTH_OK';

const HARNESS_PROBE_PROMPT = `Reply with exactly: ${HARNESS_PROBE_SENTINEL} and nothing else.`;
const CLAUDE_PROBE_SYSTEM_PROMPT = 'You are a liveness probe. Reply exactly as requested.';

const INHERITED_AGENT_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SIMPLE',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
]);

type HarnessProbeKind = 'claude' | 'codex';
export type HarnessProbeFailureKind =
  | 'rate_limited'
  | 'authentication'
  | 'timeout'
  | 'launch'
  | 'process_error'
  | 'unexpected_reply';

export interface HarnessProbeResult {
  binary: string;
  up: boolean;
  cached: boolean;
  ms: number;
  checkedAt: string;
  failureKind?: HarnessProbeFailureKind;
  error?: string;
}

export interface HarnessProbeOptions {
  /** Stable cache key: the wrapper binary name, not a harness family. */
  binary: string;
  /** Resolved executable path. */
  wrapper: string;
  kind: HarnessProbeKind;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** false disables persistence; useful for focused callers/tests. */
  cachePath?: string | false;
  now?: () => number;
  /** Called after the empty temporary cwd exists but before the wrapper runs. */
  beforeSpawn?: (cwd: string) => void | Promise<void>;
}

interface ProbeCacheEntry {
  lastSuccessAt: string;
}

interface ProbeCache {
  version: 1;
  wrappers: Record<string, ProbeCacheEntry>;
}

const inFlight = new Map<string, Promise<HarnessProbeResult>>();
let cacheWriteQueue: Promise<void> = Promise.resolve();

function defaultHarnessProbeCachePath(): string {
  const fleetHome = process.env.KFLEET_HOME ?? path.join(os.homedir(), '.kfleet');
  return path.join(fleetHome, 'cache', 'harness-probes.json');
}

/** Remove provider/session state inherited from whichever agent launched the
 * caller. The generated wrapper exports its own account-specific values. */
export function sanitizeHarnessEnv(
  env: Readonly<NodeJS.ProcessEnv>,
  preserve: Iterable<string> = [],
): NodeJS.ProcessEnv {
  const clean = { ...env };
  const preserved = new Set(preserve);
  for (const key of Object.keys(clean)) {
    if (!preserved.has(key) && (INHERITED_AGENT_ENV.has(key) || /^ANTHROPIC_DEFAULT_.*_MODEL$/.test(key))) {
      delete clean[key];
    }
  }
  return clean;
}

/** Generated wrappers may intentionally source a credential from the daemon's
 * environment (for example OPENAI_API_KEY="$OPENAI_API_KEY"). Preserve every
 * variable referenced by an export while still removing unrelated agent state. */
export async function prepareHarnessProbeEnv(
  wrapper: string,
  inherited: Readonly<NodeJS.ProcessEnv>,
): Promise<NodeJS.ProcessEnv> {
  const source = await readFile(wrapper, 'utf8').catch(() => '');
  const references = new Set<string>();
  for (const line of source.split('\n')) {
    const rhs = line.match(/^\s*export\s+[A-Za-z_][A-Za-z0-9_]*=(.*)$/)?.[1];
    if (!rhs) continue;
    for (const match of rhs.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      references.add(match[1] ?? match[2]!);
    }
  }
  return sanitizeHarnessEnv(inherited, references);
}

function isTestProcess(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.argv.some(argument => argument === 'test' || /\.test\.[cm]?[jt]sx?$/.test(argument))
  );
}

function cachePathFor(options: HarnessProbeOptions): string | undefined {
  if (options.cachePath === false) return undefined;
  if (options.cachePath) return options.cachePath;
  return isTestProcess() ? undefined : defaultHarnessProbeCachePath();
}

async function readProbeCache(cachePath: string): Promise<ProbeCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<ProbeCache>;
    if (parsed.version !== 1 || !parsed.wrappers || typeof parsed.wrappers !== 'object') throw new Error('bad cache');
    return { version: 1, wrappers: parsed.wrappers as Record<string, ProbeCacheEntry> };
  } catch {
    return { version: 1, wrappers: {} };
  }
}

async function cachedSuccess(
  cachePath: string | undefined,
  binary: string,
  nowMs: number,
): Promise<HarnessProbeResult | undefined> {
  if (!cachePath) return undefined;
  const entry = (await readProbeCache(cachePath)).wrappers[binary];
  const successMs = entry ? Date.parse(entry.lastSuccessAt) : Number.NaN;
  const ageMs = nowMs - successMs;
  if (!Number.isFinite(successMs) || ageMs < 0 || ageMs >= HARNESS_PROBE_SUCCESS_TTL_MS) return undefined;
  return { binary, up: true, cached: true, ms: 0, checkedAt: entry!.lastSuccessAt };
}

async function recordSuccess(cachePath: string | undefined, binary: string, checkedAt: string): Promise<void> {
  if (!cachePath) return;
  const write = cacheWriteQueue.then(async () => {
    const cache = await readProbeCache(cachePath);
    cache.wrappers[binary] = { lastSuccessAt: checkedAt };
    await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(cachePath),
      `.${path.basename(cachePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, cachePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  cacheWriteQueue = write.catch(() => undefined);
  // A cache-write failure must not turn a proven-live wrapper into a failed
  // probe. It only means the next start pays for another real check.
  await write.catch(() => undefined);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function finalNonEmptyLine(value: string): string {
  return (
    stripAnsi(value)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

const RATE_LIMIT_PATTERN =
  /(?:\b429\b|rate[ -]?limit|too many requests|spend limit|usage (?:limit|cap)|insufficient_quota|credit balance|resource exhausted|(?:limit|quota).*(?:reached|exceed|exhaust)|(?:hit|exceed|exhaust).*(?:limit|quota))/i;
const AUTH_PATTERN =
  /(?:\b401\b|not logged in|login required|unauthori[sz]ed|authentication failed|invalid (?:api )?key|credentials? (?:were )?rejected|(?:invalid|expired).*token|token.*(?:invalid|expired)|please run \/login)/i;

function matchingDiagnostic(value: string, pattern: RegExp): string {
  const lines = stripAnsi(value)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return (lines.find(line => pattern.test(line)) ?? lines.at(-1) ?? 'no diagnostic output').slice(0, 300);
}

function lastDiagnostic(value: string): string {
  return finalNonEmptyLine(value).slice(0, 300) || 'no diagnostic output';
}

async function claudeSupportsBare(wrapper: string, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) return true;
  const source = await readFile(wrapper, 'utf8').catch(() => '');
  // Current Claude documents that --bare intentionally refuses OAuth and
  // keychain auth. Use it only for auth modes the flag explicitly preserves;
  // otherwise the probe itself would manufacture a false "not logged in".
  return /(?:export\s+)?ANTHROPIC_API_KEY=|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX)=/.test(source);
}

/** The exact cheap invocation used by both kfleet and kteam. Codex deliberately
 * retains config.toml: some wrappers define their provider/base URL there, and
 * --ignore-user-config would silently probe the wrong endpoint. */
async function harnessProbeCommand(options: HarnessProbeOptions): Promise<string[]> {
  if (options.kind === 'claude') {
    const bare = await claudeSupportsBare(options.wrapper, options.env ?? process.env);
    return [
      options.wrapper,
      ...(bare ? ['--bare'] : []),
      '--print',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--no-chrome',
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--tools',
      '',
      '--system-prompt',
      CLAUDE_PROBE_SYSTEM_PROMPT,
      HARNESS_PROBE_PROMPT,
    ];
  }
  return [
    options.wrapper,
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    'features.hooks=false',
    HARNESS_PROBE_PROMPT,
  ];
}

async function runProbe(options: HarnessProbeOptions, cachePath: string | undefined): Promise<HarnessProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HARNESS_PROBE_TIMEOUT_MS;
  const clock = options.now ?? Date.now;
  const started = Date.now();
  let probeCwd: string | undefined;
  try {
    probeCwd = await mkdtemp(path.join(os.tmpdir(), 'kfleet-harness-probe-'));
    await options.beforeSpawn?.(probeCwd);
    const cmd = await harnessProbeCommand(options);
    const detached = process.platform !== 'win32';
    const proc = Bun.spawn({
      cmd,
      cwd: probeCwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: options.env ?? process.env,
      detached,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill(9);
      } catch {}
    }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    const checkedAt = new Date(clock()).toISOString();
    const ms = Date.now() - started;
    const reply = stripAnsi(stdout).trim();
    // If the process returned the exact reply at the timeout boundary, it is
    // live; a timer callback racing stream cleanup must not manufacture a
    // failure after success already arrived.
    if (code === 0 && reply === HARNESS_PROBE_SENTINEL) {
      const result = { binary: options.binary, up: true, cached: false, ms, checkedAt } satisfies HarnessProbeResult;
      await recordSuccess(cachePath, options.binary, checkedAt);
      return result;
    }
    const output = `${stdout}\n${stderr}`;
    if (timedOut) {
      return {
        binary: options.binary,
        up: false,
        cached: false,
        ms,
        checkedAt,
        failureKind: 'timeout',
        error: `timed out after ${Math.round(timeoutMs / 1_000)}s`,
      };
    }
    if (RATE_LIMIT_PATTERN.test(output)) {
      return {
        binary: options.binary,
        up: false,
        cached: false,
        ms,
        checkedAt,
        failureKind: 'rate_limited',
        error: `rate/quota limited (exit ${code}): ${matchingDiagnostic(output, RATE_LIMIT_PATTERN)}`,
      };
    }
    if (AUTH_PATTERN.test(output)) {
      return {
        binary: options.binary,
        up: false,
        cached: false,
        ms,
        checkedAt,
        failureKind: 'authentication',
        error: `authentication failed (exit ${code}): ${matchingDiagnostic(output, AUTH_PATTERN)}`,
      };
    }
    if (code !== 0) {
      return {
        binary: options.binary,
        up: false,
        cached: false,
        ms,
        checkedAt,
        failureKind: 'process_error',
        error: `probe exited ${code}: ${lastDiagnostic(output)}`,
      };
    }
    return {
      binary: options.binary,
      up: false,
      cached: false,
      ms,
      checkedAt,
      failureKind: 'unexpected_reply',
      error: `expected exact reply ${JSON.stringify(HARNESS_PROBE_SENTINEL)}, got ${JSON.stringify(
        reply.slice(0, 300) || '<empty>',
      )}`,
    };
  } catch (error) {
    return {
      binary: options.binary,
      up: false,
      cached: false,
      ms: Date.now() - started,
      checkedAt: new Date(clock()).toISOString(),
      failureKind: 'launch',
      error: `could not launch probe: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (probeCwd) await rm(probeCwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Probe one wrapper, coalescing concurrent calls and reusing only a recent
 * exact-reply SUCCESS. Failures are intentionally never cached. */
export async function probeHarness(options: HarnessProbeOptions): Promise<HarnessProbeResult> {
  const clock = options.now ?? Date.now;
  const cachePath = cachePathFor(options);
  const cached = await cachedSuccess(cachePath, options.binary, clock());
  if (cached) return cached;

  const key = `${cachePath ?? '<memory>'}\0${options.binary}`;
  const running = inFlight.get(key);
  if (running) return await running;
  const probe = runProbe(options, cachePath);
  inFlight.set(key, probe);
  try {
    return await probe;
  } finally {
    if (inFlight.get(key) === probe) inFlight.delete(key);
  }
}
