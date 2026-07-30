// Fleet health probing: actually LAUNCH each generated agent wrapper with a tiny
// "echo a sentinel" prompt and see whether it comes back. This catches real
// breakage a PATH check can't — bad auth, a dead proxy (auto-* agents point at
// the local CLI proxy), a misconfigured model, etc. Each probe is a real (cheap)
// LLM call, so callers cache/interval it rather than running it per scrape.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { binDir } from '../deps';
import { seedFirstRunFlags } from './firstrun';
import {
  DEFAULT_HARNESS_PROBE_TIMEOUT_MS,
  probeHarness,
  sanitizeHarnessEnv,
  type HarnessProbeFailureKind,
} from './harness-probe';
import { KIND_SPECS } from './kinds';
import { resolveAll } from './merge';
import type { Config, Kind } from './types';

export interface AgentHealth {
  name: string; // e.g. "auto-glm52a"
  kind: Kind; // e.g. "claude"
  binary: string; // e.g. "claude-auto-glm52a"
  up: boolean;
  ms: number; // probe wall-time
  cached?: boolean;
  checkedAt?: string;
  failureKind?: HarnessProbeFailureKind;
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
  return sanitizeHarnessEnv(env, preserve);
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
  cachePath?: string | false;
  now?: () => number;
}

/** Launch one agent wrapper and decide up/down. Healthy = exit 0 AND an exact
 * sentinel reply (so a silent auth/proxy failure that exits 0 still fails). */
export async function probeAgent(
  a: AgentProbeTarget,
  timeoutMs = DEFAULT_HARNESS_PROBE_TIMEOUT_MS,
  deps: ProbeAgentDeps = {},
): Promise<AgentHealth> {
  const { binary, resolved } = (deps.resolveWrapper ?? resolveAgentWrapper)(a);
  if (!resolved) {
    return { name: a.name, kind: a.kind, binary, up: false, ms: 0, error: 'wrapper not found — run `kfleet apply`' };
  }
  const baseEnv = prepareAgentEnv(a.env, process.env);
  const configDir = deps.configDir?.(a) ?? KIND_SPECS[a.kind].configDir(a.name);
  const result = await probeHarness({
    binary,
    wrapper: resolved,
    kind: a.kind,
    env: baseEnv,
    timeoutMs,
    cachePath: deps.cachePath,
    now: deps.now,
    beforeSpawn: cwd => {
      seedFirstRunFlags(a.kind, configDir, cwd, baseEnv);
    },
  });
  return {
    name: a.name,
    kind: a.kind,
    binary,
    up: result.up,
    ms: result.ms,
    cached: result.cached,
    checkedAt: result.checkedAt,
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
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
