// `kfleet serve` — a tiny always-on HTTP server exposing Prometheus metrics for
// the agent fleet. A background loop re-probes every auto-* agent on an interval
// and caches the result; scrapes of /metrics read the cache (they NEVER trigger
// a probe, since each probe is a real LLM call). For the on-demand human view,
// use `kfleet health`.
import { Command } from 'commander';
import { loadConfig } from '../core/config';
import { type AgentHealth, autoAgents, probeFleet } from '../core/health';
import { logInfo, logOk, logWarn } from '../util/format';

export const DEFAULT_PORT = 47318;

interface Cache {
  results: AgentHealth[];
  at: number; // epoch ms of the last completed probe cycle (0 = never)
  running: boolean;
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function renderMetrics(cache: Cache): string {
  const lines: string[] = [];
  const up = cache.results.filter(r => r.up).length;
  lines.push('# HELP kfleet_agents_total Number of auto-* agents probed.');
  lines.push('# TYPE kfleet_agents_total gauge');
  lines.push(`kfleet_agents_total ${cache.results.length}`);
  lines.push('# HELP kfleet_agents_up Number of agents that passed their health probe.');
  lines.push('# TYPE kfleet_agents_up gauge');
  lines.push(`kfleet_agents_up ${up}`);
  lines.push('# HELP kfleet_probe_age_seconds Seconds since the last completed probe cycle (-1 = never).');
  lines.push('# TYPE kfleet_probe_age_seconds gauge');
  lines.push(`kfleet_probe_age_seconds ${cache.at ? ((Date.now() - cache.at) / 1000).toFixed(0) : -1}`);
  lines.push('# HELP kfleet_agent_up Per-agent health (1=healthy, 0=unhealthy).');
  lines.push('# TYPE kfleet_agent_up gauge');
  for (const r of cache.results) {
    lines.push(`kfleet_agent_up{binary="${esc(r.binary)}",kind="${esc(r.kind)}"} ${r.up ? 1 : 0}`);
  }
  lines.push('# HELP kfleet_agent_probe_duration_seconds Wall-time of the last probe per agent.');
  lines.push('# TYPE kfleet_agent_probe_duration_seconds gauge');
  for (const r of cache.results) {
    lines.push(
      `kfleet_agent_probe_duration_seconds{binary="${esc(r.binary)}",kind="${esc(r.kind)}"} ${(r.ms / 1000).toFixed(3)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Re-probe the fleet and update the cache. Skips if a cycle is already running.
 *  Concurrency + per-probe timeout come from config.health. */
async function refresh(cache: Cache): Promise<void> {
  if (cache.running) return;
  cache.running = true;
  try {
    const cfg = loadConfig();
    const agents = autoAgents(cfg);
    cache.results = await probeFleet(agents, cfg.health.concurrency, cfg.health.timeout * 1000);
    cache.at = Date.now();
  } catch {
    /* leave the previous results in place on a transient config error */
  } finally {
    cache.running = false;
  }
}

export function createServeCommand(): Command {
  return new Command('serve')
    .description('expose Prometheus fleet-health metrics on /metrics (background re-probe)')
    .option('--port <n>', 'port to listen on', v => Number.parseInt(v, 10), DEFAULT_PORT)
    .option('--host <h>', 'host to bind', '127.0.0.1')
    .option('--probe', 'force background probing ON (overrides health.enabled)')
    .option('--interval <sec>', 're-probe interval in seconds (default: config health.interval)', v =>
      Number.parseInt(v, 10),
    )
    .action(async (opts: { port: number; host: string; probe?: boolean; interval?: number }) => {
      const health = loadConfig().health;
      const enabled = opts.probe || health.enabled;
      const interval = opts.interval ?? health.interval;
      const cache: Cache = { results: [], at: 0, running: false };

      Bun.serve({
        port: opts.port,
        hostname: opts.host,
        idleTimeout: 30,
        fetch(req): Response {
          const { pathname } = new URL(req.url);
          if (pathname === '/metrics') {
            return new Response(renderMetrics(cache), {
              headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
            });
          }
          if (pathname === '/healthz') return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
          return new Response('kfleet metrics — see /metrics\n', { headers: { 'content-type': 'text/plain' } });
        },
      });

      logOk(`kfleet metrics on http://${opts.host}:${opts.port}/metrics`);
      if (enabled) {
        logInfo(`re-probing the fleet every ${interval}s (each probe is a real LLM call)`);
        void refresh(cache); // initial probe in the background
        setInterval(() => void refresh(cache), interval * 1000);
      } else {
        logWarn(
          'background probing OFF — set health.enabled: true in ~/.kfleet/config.yaml (or pass --probe). `kfleet health` still runs a one-shot.',
        );
      }
      await new Promise(() => {
        /* run until killed */
      });
    });
}
