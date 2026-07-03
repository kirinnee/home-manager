// `kfleet serve` — a tiny always-on HTTP server exposing Prometheus metrics for
// fleet health and account usage, plus usage JSON for kloop. Background loops
// cache probe results; scrapes of /metrics never trigger health probes because
// each health probe is a real LLM call. For the on-demand human view, use
// `kfleet health` / `kfleet usage`.
import { Command } from 'commander';
import { loadConfig } from '../core/config';
import { type AgentHealth, autoAgents, probeFleet } from '../core/health';
import { type AccountUsage, probeUsage } from '../core/usage';
import { logInfo, logOk, logWarn } from '../util/format';

export const DEFAULT_PORT = 47318;

interface Cache {
  results: AgentHealth[];
  at: number; // epoch ms of the last completed probe cycle (0 = never)
  running: boolean;
}

interface UsageCache {
  results: AccountUsage[];
  at: number; // epoch ms of the last completed probe cycle (0 = never)
  running: boolean;
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Re-run `fn` forever with a per-cycle jittered delay (baseMs ± jitterFrac). A
 *  self-rescheduling timeout (not setInterval) so each interval is independently
 *  randomized — keeps a fleet of servers from synchronizing their probe bursts.
 *  The next cycle is scheduled only AFTER `fn` settles, so slow probes never pile up. */
function scheduleJittered(fn: () => Promise<void>, baseMs: number, jitterFrac: number): void {
  const tick = (): void => {
    // baseMs ± jitterFrac, floored at 1s so jitterFrac=1 (or a tiny baseMs) can never
    // collapse to a 0ms delay and busy-loop.
    const delay = Math.max(1_000, baseMs * (1 - jitterFrac + Math.random() * 2 * jitterFrac));
    setTimeout(() => void fn().finally(tick), delay);
  };
  tick();
}

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

/** Render the per-account usage metrics (5h + weekly utilization, reset times,
 *  at-limit + usage-based flags). One `usage_based` series per resolved agent;
 *  the windowed series only for accounts we could actually probe. */
function renderUsageMetrics(cache: UsageCache): string {
  const lines: string[] = [];
  const lbl = (r: AccountUsage): string =>
    `binary="${esc(r.binary)}",kind="${esc(r.kind)}",provider="${esc(r.provider ?? '')}"`;

  lines.push('# HELP kfleet_account_usage_based Whether the account is a usage-windowed subscription (1) or not (0).');
  lines.push('# TYPE kfleet_account_usage_based gauge');
  for (const r of cache.results) lines.push(`kfleet_account_usage_based{${lbl(r)}} ${r.usageBased ? 1 : 0}`);

  lines.push('# HELP kfleet_account_usage_ok Whether the last usage probe succeeded (1) or failed (0).');
  lines.push('# TYPE kfleet_account_usage_ok gauge');
  for (const r of cache.results.filter(r => r.usageBased))
    lines.push(`kfleet_account_usage_ok{${lbl(r)}} ${r.ok ? 1 : 0}`);

  lines.push(
    '# HELP kfleet_account_auth_ok Whether the account is logged in / has valid credentials (1=yes, 0=no). Omitted when undeterminable.',
  );
  lines.push('# TYPE kfleet_account_auth_ok gauge');
  for (const r of cache.results.filter(r => r.usageBased && typeof r.authOk === 'boolean'))
    lines.push(`kfleet_account_auth_ok{${lbl(r)}} ${r.authOk ? 1 : 0}`);

  lines.push('# HELP kfleet_account_usage_5h_percent Utilization of the 5-hour window (0-100).');
  lines.push('# TYPE kfleet_account_usage_5h_percent gauge');
  for (const r of cache.results)
    if (r.ok && typeof r.fiveHourPercent === 'number')
      lines.push(`kfleet_account_usage_5h_percent{${lbl(r)}} ${r.fiveHourPercent}`);

  lines.push('# HELP kfleet_account_usage_weekly_percent Utilization of the weekly window (0-100).');
  lines.push('# TYPE kfleet_account_usage_weekly_percent gauge');
  for (const r of cache.results)
    if (r.ok && typeof r.weeklyPercent === 'number')
      lines.push(`kfleet_account_usage_weekly_percent{${lbl(r)}} ${r.weeklyPercent}`);

  lines.push('# HELP kfleet_account_usage_5h_reset_seconds Unix time the 5-hour window resets.');
  lines.push('# TYPE kfleet_account_usage_5h_reset_seconds gauge');
  for (const r of cache.results)
    if (r.ok && typeof r.fiveHourResetAt === 'number')
      lines.push(`kfleet_account_usage_5h_reset_seconds{${lbl(r)}} ${(r.fiveHourResetAt / 1000).toFixed(0)}`);

  lines.push('# HELP kfleet_account_usage_weekly_reset_seconds Unix time the weekly window resets.');
  lines.push('# TYPE kfleet_account_usage_weekly_reset_seconds gauge');
  for (const r of cache.results)
    if (r.ok && typeof r.weeklyResetAt === 'number')
      lines.push(`kfleet_account_usage_weekly_reset_seconds{${lbl(r)}} ${(r.weeklyResetAt / 1000).toFixed(0)}`);

  lines.push('# HELP kfleet_account_at_limit Whether the account is exhausted (5h OR weekly at limit): 1=exhausted.');
  lines.push('# TYPE kfleet_account_at_limit gauge');
  for (const r of cache.results.filter(r => r.usageBased))
    lines.push(`kfleet_account_at_limit{${lbl(r)}} ${r.atLimit ? 1 : 0}`);

  lines.push('# HELP kfleet_usage_probe_age_seconds Seconds since the last completed usage probe cycle (-1 = never).');
  lines.push('# TYPE kfleet_usage_probe_age_seconds gauge');
  lines.push(`kfleet_usage_probe_age_seconds ${cache.at ? ((Date.now() - cache.at) / 1000).toFixed(0) : -1}`);
  return `${lines.join('\n')}\n`;
}

/** Re-probe account usage and update the cache. Skips if a cycle is already
 *  running. Read-only HTTP per credential — does NOT consume any quota. */
async function refreshUsage(cache: UsageCache): Promise<void> {
  if (cache.running) return;
  cache.running = true;
  try {
    const cfg = loadConfig();
    cache.results = await probeUsage(cfg, {
      concurrency: cfg.usage.concurrency,
      timeoutMs: cfg.usage.timeout * 1000,
      atLimitPercent: cfg.usage.atLimitPercent,
      relogin: cfg.usage.relogin,
    });
    cache.at = Date.now();
  } catch {
    // Fail open for consumers like kloop: stale at-limit data must not block runs.
    cache.results = [];
    cache.at = 0;
  } finally {
    cache.running = false;
  }
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
    .description('expose Prometheus fleet-health + usage metrics on /metrics and usage JSON on /usage')
    .option('--port <n>', 'port to listen on', v => Number.parseInt(v, 10), DEFAULT_PORT)
    .option('--host <h>', 'host to bind', '127.0.0.1')
    .option('--probe', 'force background probing ON (overrides health.enabled)')
    .option('--interval <sec>', 're-probe interval in seconds (default: config health.interval)', v =>
      Number.parseInt(v, 10),
    )
    .action(async (opts: { port: number; host: string; probe?: boolean; interval?: number }) => {
      const cfg = loadConfig();
      const health = cfg.health;
      const usage = cfg.usage;
      const enabled = opts.probe || health.enabled;
      const interval = opts.interval ?? health.interval;
      const cache: Cache = { results: [], at: 0, running: false };
      const usageCache: UsageCache = { results: [], at: 0, running: false };

      Bun.serve({
        port: opts.port,
        hostname: opts.host,
        idleTimeout: 30,
        fetch(req): Response {
          const { pathname } = new URL(req.url);
          if (pathname === '/metrics') {
            return new Response(`${renderMetrics(cache)}${renderUsageMetrics(usageCache)}`, {
              headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
            });
          }
          if (pathname === '/usage') {
            // Machine-readable snapshot for kloop's usage-aware account selection.
            return new Response(JSON.stringify({ at: usageCache.at, accounts: usageCache.results }), {
              headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
            });
          }
          if (pathname === '/healthz') return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
          return new Response('kfleet metrics — see /metrics and /usage\n', {
            headers: { 'content-type': 'text/plain' },
          });
        },
      });

      logOk(`kfleet metrics on http://${opts.host}:${opts.port}/metrics (usage JSON on /usage)`);
      if (enabled) {
        logInfo(`re-probing the fleet every ${interval}s (each probe is a real LLM call)`);
        void refresh(cache); // initial probe in the background
        setInterval(() => void refresh(cache), interval * 1000);
      } else {
        logWarn(
          'background health probing OFF — set health.enabled: true in ~/.kfleet/config.yaml (or pass --probe). `kfleet health` still runs a one-shot.',
        );
      }
      if (usage.enabled) {
        logInfo(
          `re-probing account usage every ~${usage.interval}s (±${Math.round(usage.jitter * 100)}% jitter, read-only, no quota used)`,
        );
        void refreshUsage(usageCache); // initial probe in the background
        scheduleJittered(() => refreshUsage(usageCache), usage.interval * 1000, usage.jitter);
      } else {
        logWarn('background usage probing OFF — set usage.enabled: true in ~/.kfleet/config.yaml.');
      }
      await new Promise(() => {
        /* run until killed */
      });
    });
}
