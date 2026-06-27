// khost self-metrics: a Prometheus exporter for the host-exposure suite itself.
//
//   khost metrics serve     run the exporter (/metrics + /healthz)
//   khost metrics show      print the metrics once (debug)
//   khost metrics service … run `serve` as a launchd/systemd background service
//
// Local up-checks (ssh-into-self, alloy, docker) run per-scrape — cheap.
// The Cloudflare-API checks (tunnel health, route drift, creds) are refreshed on
// an interval and cached, since that API is rate-limited.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  cfConfigured,
  findTunnel,
  getTunnelConnections,
  getTunnelIngress,
  getTunnelStatus,
  verifyAccount,
  verifyToken,
} from './cloudflare';
import { config } from './config';
import { alloyContainer, alloyPort, machineId, meshListen, metricsPort, sshPort, tunnelName } from './deps';
import { die, ok, run } from './exec';
import { expandMachine } from './routes';

// ---- local probes (per-scrape) --------------------------------------------

interface SshProbe {
  up: boolean;
  latencyMs: number;
}

/** TCP-connect and confirm an SSH banner ("SSH-…"). up=true means sshd is up and
 *  accepting on that bind — the literal "can I SSH into myself" check. */
function sshProbe(host: string, port: number, timeoutMs = 2500): Promise<SshProbe> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (up: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ up, latencyMs: Date.now() - t0 });
    };
    sock.setTimeout(timeoutMs);
    sock.on('data', d => finish(d.toString('utf8', 0, 8).startsWith('SSH-')));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/** True if the URL answers at all (any HTTP status) within the timeout. */
async function httpUp(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status > 0;
  } catch {
    return false;
  }
}

async function containerRunning(name: string): Promise<boolean> {
  const r = await run(['docker', 'inspect', name, '--format', '{{.State.Running}}']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function containerRestarts(name: string): Promise<number> {
  const r = await run(['docker', 'inspect', name, '--format', '{{.RestartCount}}']);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

const dockerUp = async (): Promise<boolean> => (await run(['docker', 'version'])).code === 0;

// ---- Cloudflare probes (cached) -------------------------------------------

interface CfCache {
  at: number; // last completed probe (0 = never)
  running: boolean;
  configured: boolean;
  tokenOk: boolean;
  accountOk: boolean;
  tunnelUp: boolean;
  tunnelStatus: string;
  tunnelConns: number;
  routesConfigured: number;
  routesLive: number;
  routesMissing: number;
}

const newCfCache = (): CfCache => ({
  at: 0,
  running: false,
  configured: false,
  tokenOk: false,
  accountOk: false,
  tunnelUp: false,
  tunnelStatus: 'unknown',
  tunnelConns: 0,
  routesConfigured: 0,
  routesLive: 0,
  routesMissing: 0,
});

async function refreshCf(c: CfCache): Promise<void> {
  if (c.running) return;
  c.running = true;
  try {
    c.configured = cfConfigured();
    if (!c.configured) {
      c.at = Date.now();
      return;
    }
    c.tokenOk = (await verifyToken()).ok;
    c.accountOk = (await verifyAccount()).ok;
    const desired = expandMachine(config.routes, machineId).map(r => r.hostname);
    const tunnel = await findTunnel(tunnelName).catch(() => null);
    if (tunnel) {
      c.tunnelStatus = await getTunnelStatus(tunnel.id).catch(() => 'unknown');
      c.tunnelUp = c.tunnelStatus === 'healthy';
      c.tunnelConns = await getTunnelConnections(tunnel.id).catch(() => 0);
      const live = (await getTunnelIngress(tunnel.id).catch(() => []))
        .map(i => i.hostname)
        .filter((h): h is string => Boolean(h));
      const liveSet = new Set(live);
      c.routesConfigured = desired.length;
      c.routesLive = live.length;
      c.routesMissing = desired.filter(h => !liveSet.has(h)).length;
    } else {
      c.tunnelUp = false;
      c.tunnelStatus = 'absent';
      c.tunnelConns = 0;
      c.routesConfigured = desired.length;
      c.routesLive = 0;
      c.routesMissing = desired.length;
    }
    c.at = Date.now();
  } catch {
    /* keep the previous cache on a transient API error */
  } finally {
    c.running = false;
  }
}

// ---- render ----------------------------------------------------------------

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function render(cf: CfCache): Promise<string> {
  const meshHost = meshListen || null;
  const [sshLoop, sshMesh, alloyRun, alloyHttp, dockerOk, alloyRe] = await Promise.all([
    sshProbe('127.0.0.1', sshPort),
    meshHost ? sshProbe(meshHost, sshPort) : Promise.resolve(null),
    containerRunning(alloyContainer),
    httpUp(`http://127.0.0.1:${alloyPort}/-/ready`),
    dockerUp(),
    containerRestarts(alloyContainer),
  ]);

  const L: string[] = [];
  const gauge = (name: string, help: string, val: number | string, labels = ''): void => {
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${val}`);
  };

  // ssh-into-self
  L.push('# HELP khost_ssh_up sshd reachable on a bind (SSH banner seen).', '# TYPE khost_ssh_up gauge');
  L.push(`khost_ssh_up{target="loopback"} ${sshLoop.up ? 1 : 0}`);
  if (sshMesh) L.push(`khost_ssh_up{target="mesh"} ${sshMesh.up ? 1 : 0}`);
  L.push(
    '# HELP khost_ssh_banner_latency_seconds Time to receive the SSH banner.',
    '# TYPE khost_ssh_banner_latency_seconds gauge',
  );
  L.push(`khost_ssh_banner_latency_seconds{target="loopback"} ${(sshLoop.latencyMs / 1000).toFixed(3)}`);
  if (sshMesh) L.push(`khost_ssh_banner_latency_seconds{target="mesh"} ${(sshMesh.latencyMs / 1000).toFixed(3)}`);

  // local services
  gauge('khost_alloy_up', 'Alloy container running and ready.', alloyRun && alloyHttp ? 1 : 0);
  gauge('khost_docker_up', 'docker daemon reachable.', dockerOk ? 1 : 0);
  L.push(
    '# HELP khost_container_restarts Container restart count (flap detection).',
    '# TYPE khost_container_restarts gauge',
  );
  L.push(`khost_container_restarts{container="${esc(alloyContainer)}"} ${alloyRe}`);

  // cloudflare (cached)
  gauge('khost_cloudflare_configured', 'Cloudflare creds present (config/env).', cf.configured ? 1 : 0);
  if (cf.configured) {
    gauge('khost_cloudflare_token_valid', 'Cloudflare API token verifies as active.', cf.tokenOk ? 1 : 0);
    gauge('khost_cloudflare_account_ok', 'Account + tunnel scope usable by the token.', cf.accountOk ? 1 : 0);
    gauge('khost_tunnel_up', 'Cloudflare Tunnel status is healthy.', cf.tunnelUp ? 1 : 0);
    gauge('khost_tunnel_connections', 'Active tunnel connector connections.', cf.tunnelConns);
    gauge('khost_routes_configured', 'Routes defined in config.yaml.', cf.routesConfigured);
    gauge('khost_routes_live', 'Routes live in the tunnel ingress.', cf.routesLive);
    gauge('khost_routes_missing', 'Configured routes not yet live (drift).', cf.routesMissing);
    gauge(
      'khost_cf_probe_age_seconds',
      'Seconds since the last Cloudflare probe (-1 = never).',
      cf.at ? ((Date.now() - cf.at) / 1000).toFixed(0) : -1,
    );
  }

  return `${L.join('\n')}\n`;
}

// ---- service install (launchd / systemd) ----------------------------------

const LABEL = 'com.kirin.khost-metrics';
const UNIT = 'khost-metrics.service';
const BUN = process.execPath;
const ENTRY = path.resolve(import.meta.dir, 'index.ts');
const serveArgs = (port: number): string[] => [ENTRY, 'metrics', 'serve', '--port', String(port)];

const uid = (): number => process.getuid?.() ?? 0;
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sysQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sh = (cmd: string[]): { ok: boolean; out: string } => {
  const p = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  return { ok: p.success, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};
const plistPath = (): string => path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitPath = (): string => path.join(homedir(), '.config', 'systemd', 'user', UNIT);

/** Commander coercion: reject NaN / out-of-range so we never write `--port NaN`. */
const parsePort = (v: string): number => {
  const p = Number.parseInt(v, 10);
  if (!/^\d+$/.test(v) || p < 1 || p > 65535) die(`invalid port: ${v}`);
  return p;
};

/** Read the port back out of the installed unit/plist so `status` is accurate. */
const readInstalledPort = (isMac: boolean): number | null => {
  const read = (file: string, re: RegExp): number | null => {
    try {
      const m = readFileSync(file, 'utf8').match(re);
      return m?.[1] ? Number.parseInt(m[1], 10) : null;
    } catch {
      return null;
    }
  };
  return isMac
    ? read(plistPath(), /<string>--port<\/string>\s*<string>(\d+)<\/string>/)
    : read(unitPath(), /--port (\d+)/);
};

function macInstall(port: number): void {
  const home = homedir();
  const argv = [BUN, ...serveArgs(port)];
  const argXml = argv.map(a => `      <string>${xml(a)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${xml(home)}</string></dict>
  <key>StandardOutPath</key><string>${xml(path.join(home, 'Library', 'Logs', 'khost-metrics.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(home, 'Library', 'Logs', 'khost-metrics.err.log'))}</string>
</dict>
</plist>
`;
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), plist);
  sh(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]);
  const r = sh(['launchctl', 'bootstrap', `gui/${uid()}`, plistPath()]);
  if (!r.ok) {
    sh(['launchctl', 'unload', plistPath()]);
    const r2 = sh(['launchctl', 'load', '-w', plistPath()]);
    if (!r2.ok) die(`launchctl failed: ${r2.out || r.out}`);
  }
}

function linuxInstall(port: number): void {
  // First ExecStart token (bun) stays unquoted (systemd requires the executable
  // unquoted; process.execPath is a space-free nix store path); the rest quoted.
  const unit = `[Unit]
Description=khost self-metrics (serve)
After=default.target

[Service]
ExecStart=${BUN} ${serveArgs(port).map(sysQuote).join(' ')}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
  mkdirSync(path.dirname(unitPath()), { recursive: true });
  writeFileSync(unitPath(), unit);
  sh(['systemctl', '--user', 'daemon-reload']);
  const r = sh(['systemctl', '--user', 'enable', '--now', UNIT]);
  if (!r.ok) die(`systemctl failed: ${r.out}`);
  if (!sh(['loginctl', 'enable-linger']).ok)
    console.log(pc.dim('note: enable-linger failed — runs only while logged in'));
}

function createServiceCommand(): Command {
  const svc = new Command('service').description('run "khost metrics serve" as a launchd/systemd background service');
  const isMac = platform() === 'darwin';
  const isLinux = platform() === 'linux';
  const guardOs = (): void => {
    if (!isMac && !isLinux) die(`unsupported platform: ${platform()} (only macOS and Linux)`);
  };
  const installed = (): boolean => (isMac ? existsSync(plistPath()) : existsSync(unitPath()));

  svc
    .command('install')
    .option('--port <n>', 'port to listen on', parsePort)
    .action((opts: { port?: number }) => {
      guardOs();
      const port = opts.port ?? metricsPort;
      if (isMac) macInstall(port);
      else linuxInstall(port);
      ok(`khost metrics service installed — http://localhost:${port}/metrics`);
    });
  svc.command('uninstall').action(() => {
    guardOs();
    if (isMac) {
      sh(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]);
      if (existsSync(plistPath())) rmSync(plistPath());
    } else {
      sh(['systemctl', '--user', 'disable', '--now', UNIT]);
      if (existsSync(unitPath())) rmSync(unitPath());
      sh(['systemctl', '--user', 'daemon-reload']);
    }
    ok('khost metrics service removed');
  });
  svc.command('restart').action(() => {
    guardOs();
    if (!installed()) die('khost metrics service is not installed — run `khost metrics service install` first');
    const r = isMac
      ? sh(['launchctl', 'kickstart', '-k', `gui/${uid()}/${LABEL}`])
      : sh(['systemctl', '--user', 'restart', UNIT]);
    if (!r.ok) die('restart failed');
    ok('khost metrics service restarted');
  });
  svc.command('status').action(() => {
    guardOs();
    const running = isMac
      ? sh(['launchctl', 'print', `gui/${uid()}/${LABEL}`]).ok
      : sh(['systemctl', '--user', 'is-active', UNIT]).out === 'active';
    console.log(
      `khost metrics: ${installed() ? pc.green('installed') : pc.yellow('not installed')}, ${running ? pc.green('running') : pc.red('stopped')}`,
    );
    if (installed()) console.log(pc.dim(`http://localhost:${readInstalledPort(isMac) ?? metricsPort}/metrics`));
  });
  svc.action(() => svc.help());
  return svc;
}

// ---- command group ---------------------------------------------------------

export function createMetricsCommand(): Command {
  const m = new Command('metrics').description('khost self-metrics (Prometheus exporter)');

  m.command('serve')
    .description('expose /metrics (local up-checks per-scrape; Cloudflare checks cached)')
    .option('--port <n>', 'port to listen on', v => Number.parseInt(v, 10), metricsPort)
    .option('--host <h>', 'host to bind', '127.0.0.1')
    .option('--interval <sec>', 'Cloudflare re-probe interval', v => Number.parseInt(v, 10), 60)
    .action(async (opts: { port: number; host: string; interval: number }) => {
      const cf = newCfCache();
      Bun.serve({
        port: opts.port,
        hostname: opts.host,
        idleTimeout: 30,
        async fetch(req): Promise<Response> {
          const { pathname } = new URL(req.url);
          if (pathname === '/metrics') {
            return new Response(await render(cf), {
              headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
            });
          }
          if (pathname === '/healthz') return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
          return new Response('khost metrics — see /metrics\n', { headers: { 'content-type': 'text/plain' } });
        },
      });
      ok(`khost metrics on http://${opts.host}:${opts.port}/metrics`);
      void refreshCf(cf);
      setInterval(() => void refreshCf(cf), opts.interval * 1000);
      await new Promise(() => {
        /* run until killed */
      });
    });

  m.command('show')
    .description('print the metrics once (probes Cloudflare synchronously)')
    .action(async () => {
      const cf = newCfCache();
      await refreshCf(cf);
      console.log(await render(cf));
    });

  m.addCommand(createServiceCommand());
  m.action(() => m.help());
  return m;
}
