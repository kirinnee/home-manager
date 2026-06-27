// Fleet health probing: actually LAUNCH each generated agent wrapper with a tiny
// "echo a sentinel" prompt and see whether it comes back. This catches real
// breakage a PATH check can't — bad auth, a dead proxy (auto-* agents point at
// the local CLI proxy), a misconfigured model, etc. Each probe is a real (cheap)
// LLM call, so callers cache/interval it rather than running it per scrape.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { binDir } from '../deps';
import { resolveAll } from './merge';
import type { Config, Kind } from './types';

const SENTINEL = 'KFLEET_HEALTH_OK';
const PROMPT = `Reply with exactly: ${SENTINEL} and nothing else.`;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface AgentHealth {
  name: string; // e.g. "auto-glm52a"
  kind: Kind; // e.g. "claude"
  binary: string; // e.g. "claude-auto-glm52a"
  up: boolean;
  ms: number; // probe wall-time
  error?: string; // short reason when down
}

/** The `auto-*` agents — the non-interactive wrappers automation actually drives.
 *  `auto-` is a variant infix added during expansion, so resolve agents × variants
 *  first (the raw config.agents have no prefix). */
export function autoAgents(config: Config): { name: string; kind: Kind }[] {
  return resolveAll(config)
    .filter(a => a.name.startsWith('auto-'))
    .map(a => ({ name: a.name, kind: a.kind }));
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

/** Launch one agent wrapper and decide up/down. Healthy = exit 0 AND the reply
 *  contains the sentinel (so a silent auth/proxy failure that exits 0 still fails). */
async function probeAgent(a: { name: string; kind: Kind }, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AgentHealth> {
  const binary = `${a.kind}-${a.name}`;
  const t0 = Date.now();
  const resolved = Bun.which(binary) ?? path.join(binDir, binary);
  if (!existsSync(resolved)) {
    return { name: a.name, kind: a.kind, binary, up: false, ms: 0, error: 'wrapper not found — run `kfleet apply`' };
  }
  const { cmd, env } = probeCmd(a.kind, resolved);
  try {
    const proc = Bun.spawn({
      cmd,
      cwd: tmpdir(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: env ? { ...process.env, ...env } : process.env,
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
  agents: { name: string; kind: Kind }[],
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
