// Fleet health probing: actually LAUNCH each generated agent wrapper with a tiny
// "echo a sentinel" prompt and see whether it comes back. This catches real
// breakage a PATH check can't — bad auth, a dead proxy (auto-* agents point at
// the local CLI proxy), a misconfigured model, etc. Each probe is a real (cheap)
// LLM call, so callers cache/interval it rather than running it per scrape.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { binDir } from '../deps';
import { seedFirstRunFlags } from './firstrun';
import { KIND_SPECS } from './kinds';
import { resolveAll } from './merge';
import type { Config, Kind } from './types';

const SENTINEL = 'KFLEET_HEALTH_OK';
const PROMPT = `Reply with exactly: ${SENTINEL} and nothing else.`;
const DEFAULT_TIMEOUT_MS = 90_000;

const INHERITED_AGENT_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
]);

export interface AgentHealth {
  name: string; // e.g. "auto-glm52a"
  kind: Kind; // e.g. "claude"
  binary: string; // e.g. "claude-auto-glm52a"
  up: boolean;
  ms: number; // probe wall-time
  error?: string; // short reason when down
}

export interface AgentProbeTarget {
  name: string;
  kind: Kind;
  /** Fully resolved wrapper env. Its keys are intentional and may depend on
   * same-named inherited variables (for example OPENAI_API_KEY=$OPENAI_API_KEY). */
  env?: Record<string, string>;
}

/** Remove provider/session state inherited from whichever agent launched
 * kfleet. Generated wrappers re-export their own configured values; retaining
 * another account's values here could make a probe test the wrong credential. */
export function sanitizeAgentEnv(env: Readonly<NodeJS.ProcessEnv>, preserve: Iterable<string> = []): NodeJS.ProcessEnv {
  const clean = { ...env };
  const preserved = new Set(preserve);
  for (const key of Object.keys(clean)) {
    if (!preserved.has(key) && (INHERITED_AGENT_ENV.has(key) || /^ANTHROPIC_DEFAULT_.*_MODEL$/.test(key))) {
      delete clean[key];
    }
  }
  return clean;
}

const envRefName = (value: string): string | undefined => {
  const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(value.trim());
  return match?.[1] ?? match?.[2];
};

/** Build the environment a target wrapper is meant to see. Only explicitly
 * referenced source variables survive sanitization; configured literals and
 * resolved $VAR/${VAR} references then override inherited values. */
export function prepareAgentEnv(
  configured: Record<string, string> | undefined,
  inherited: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const entries = Object.entries(configured ?? {});
  const sourceNames = entries.flatMap(([, value]) => {
    const name = envRefName(value);
    return name ? [name] : [];
  });
  const prepared = sanitizeAgentEnv(inherited, sourceNames);
  for (const [key, value] of entries) {
    const sourceName = envRefName(value);
    prepared[key] = sourceName ? (inherited[sourceName] ?? '') : value;
  }
  return prepared;
}

/** The `auto-*` agents — the non-interactive wrappers automation actually drives.
 *  `auto-` is a variant infix added during expansion, so resolve agents × variants
 *  first (the raw config.agents have no prefix). */
export function autoAgents(config: Config): AgentProbeTarget[] {
  return resolveAll(config)
    .filter(a => a.name.startsWith('auto-'))
    .map(a => ({ name: a.name, kind: a.kind, ...(a.env ? { env: a.env } : {}) }));
}

/** Harness-aware, non-interactive "say the sentinel" invocation for a wrapper. */
function probeCmd(kind: Kind, bin: string): { cmd: string[]; env?: Record<string, string> } {
  switch (kind) {
    case 'claude':
      return { cmd: [bin, '--dangerously-skip-permissions', '--print', PROMPT] };
    case 'codex':
      return { cmd: [bin, 'exec', '--skip-git-repo-check', PROMPT] };
  }
}

/** Resolve a concrete generated wrapper, whether it is on PATH or only in
 * kfleet's managed bin directory. */
export function resolveAgentWrapper(a: { name: string; kind: Kind }): { binary: string; resolved?: string } {
  const binary = `${a.kind}-${a.name}`;
  const candidate = Bun.which(binary) ?? path.join(binDir, binary);
  return existsSync(candidate) ? { binary, resolved: candidate } : { binary };
}

interface ProbeAgentDeps {
  configDir?: (target: AgentProbeTarget) => string;
  resolveWrapper?: typeof resolveAgentWrapper;
}

/** Launch one agent wrapper and decide up/down. Healthy = exit 0 AND the reply
 *  contains the sentinel (so a silent auth/proxy failure that exits 0 still fails). */
export async function probeAgent(
  a: AgentProbeTarget,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deps: ProbeAgentDeps = {},
): Promise<AgentHealth> {
  const { binary, resolved } = (deps.resolveWrapper ?? resolveAgentWrapper)(a);
  const t0 = Date.now();
  if (!resolved) {
    return { name: a.name, kind: a.kind, binary, up: false, ms: 0, error: 'wrapper not found — run `kfleet apply`' };
  }
  const { cmd, env } = probeCmd(a.kind, resolved);
  try {
    const cwd = tmpdir();
    const baseEnv = prepareAgentEnv(a.env, process.env);
    const configDir = deps.configDir?.(a) ?? KIND_SPECS[a.kind].configDir(a.name);
    seedFirstRunFlags(a.kind, configDir, cwd, baseEnv);
    const proc = Bun.spawn({
      cmd,
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: env ? { ...baseEnv, ...env } : baseEnv,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const up = code === 0 && out.includes(SENTINEL);
    // Only call it a timeout if the kill actually robbed us of a success — a
    // process that finished right at the boundary still counts if it replied.
    if (timedOut && !up) {
      return {
        name: a.name,
        kind: a.kind,
        binary,
        up: false,
        ms,
        error: `timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    const error = up ? undefined : err.trim().split('\n').pop()?.slice(0, 200) || `exit ${code}, no sentinel`;
    return { name: a.name, kind: a.kind, binary, up, ms, error };
  } catch (e) {
    return { name: a.name, kind: a.kind, binary, up: false, ms: Date.now() - t0, error: (e as Error).message };
  }
}

/** Probe many agents at once, capped so we don't spawn the whole fleet of LLMs
 *  simultaneously. Results are returned in the same order as `agents`.
 *  `timeoutMs`, if given, is the per-probe budget. */
export async function probeFleet(
  agents: AgentProbeTarget[],
  concurrency = 8,
  timeoutMs?: number,
): Promise<AgentHealth[]> {
  const results: AgentHealth[] = new Array(agents.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < agents.length) {
      const idx = next++;
      results[idx] = await probeAgent(agents[idx]!, timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, agents.length) }, worker));
  return results;
}
