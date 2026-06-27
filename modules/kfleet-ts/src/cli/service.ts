import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PORT } from './serve';

// ============================================================================
// `kfleet service <install|uninstall|status|restart>` — run `kfleet serve` as a
// self-managed, always-on background service via the OS's native per-user
// service manager. No Nix / home-manager involvement: the binary writes and
// loads the unit itself, so it works anywhere the binary is installed.
//
//   macOS  -> launchd user agent   (~/Library/LaunchAgents/<LABEL>.plist)
//   Linux  -> systemd user service (~/.config/systemd/user/<UNIT>)
// ============================================================================

const TOOL = 'kfleet';
const LABEL = 'com.kirin.kfleet-serve'; // launchd label (macOS)
const UNIT = 'kfleet-serve.service'; // systemd unit name (Linux)

// Absolute bun + entrypoint, captured at install time so the service needs no
// PATH and no Nix wrapper. Re-run `kfleet service install` after a bun upgrade.
const BUN = process.execPath;
const ENTRY = path.resolve(import.meta.dir, '../index.ts');

function die(m: string): never {
  console.error(pc.red(`✗ ${m}`));
  process.exit(1);
}

/** Commander coercion for `--port`: reject NaN / out-of-range up front so we
 *  never write a `--port NaN` into the service definition. */
function parsePort(v: string): number {
  // Require all-digits so "1.5"/"1 x" don't silently truncate to a valid port.
  const p = Number.parseInt(v, 10);
  if (!/^\d+$/.test(v) || p < 1 || p > 65535) die(`invalid port: ${v}`);
  return p;
}

/** Read the configured port back out of an installed service file (plist/unit),
 *  so `status` reflects a custom `--port`. Null if absent/unreadable. */
function readPort(file: string, re: RegExp): number | null {
  try {
    const m = readFileSync(file, 'utf8').match(re);
    return m?.[1] ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** Run a command, capturing combined output; never throws. */
function sh(cmd: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  return { ok: p.success, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}

const uid = (): number => process.getuid?.() ?? 0;
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sysQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ---- macOS (launchd) -------------------------------------------------------

const plistPath = (): string => path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function macInstall(port: number): void {
  const home = homedir();
  const logDir = path.join(home, 'Library', 'Logs');
  const argv = [BUN, ENTRY, 'serve', '--port', String(port)];
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
  <dict>
    <key>HOME</key><string>${xml(home)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, `${TOOL}-serve.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, `${TOOL}-serve.err.log`))}</string>
</dict>
</plist>
`;
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), plist);

  // Reload cleanly: bootout any prior instance (ignore errors), then bootstrap.
  sh(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]);
  const r = sh(['launchctl', 'bootstrap', `gui/${uid()}`, plistPath()]);
  if (!r.ok) {
    // Fallback for older macOS that lacks bootstrap/bootout.
    sh(['launchctl', 'unload', plistPath()]);
    const r2 = sh(['launchctl', 'load', '-w', plistPath()]);
    if (!r2.ok) die(`launchctl failed: ${r2.out || r.out}`);
  }
}

function macUninstall(): void {
  sh(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]);
  if (existsSync(plistPath())) rmSync(plistPath());
}

const macRestart = (): boolean => sh(['launchctl', 'kickstart', '-k', `gui/${uid()}/${LABEL}`]).ok;
const macRunning = (): boolean => sh(['launchctl', 'print', `gui/${uid()}/${LABEL}`]).ok;
const macInstalled = (): boolean => existsSync(plistPath());
const macPort = (): number | null => readPort(plistPath(), /<string>--port<\/string>\s*<string>(\d+)<\/string>/);

// ---- Linux (systemd --user) ------------------------------------------------

const unitPath = (): string => path.join(homedir(), '.config', 'systemd', 'user', UNIT);

function linuxInstall(port: number): void {
  // systemd requires the first token of ExecStart to be an UNQUOTED absolute
  // path; quote only the remaining args (in case ENTRY sits under a spacey path).
  const exec = `${BUN} ${sysQuote(ENTRY)} serve --port ${port}`;
  const unit = `[Unit]
Description=${TOOL} fleet-health metrics (serve)
After=default.target

[Service]
ExecStart=${exec}
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
  // Best-effort: keep the service running without an active login session.
  if (!sh(['loginctl', 'enable-linger']).ok) {
    console.log(pc.dim('note: enable-linger failed — service runs only while logged in'));
  }
}

function linuxUninstall(): void {
  sh(['systemctl', '--user', 'disable', '--now', UNIT]);
  if (existsSync(unitPath())) rmSync(unitPath());
  sh(['systemctl', '--user', 'daemon-reload']);
}

const linuxRestart = (): boolean => sh(['systemctl', '--user', 'restart', UNIT]).ok;
const linuxRunning = (): boolean => sh(['systemctl', '--user', 'is-active', UNIT]).out === 'active';
const linuxInstalled = (): boolean => existsSync(unitPath());
const linuxPort = (): number | null => readPort(unitPath(), /--port (\d+)/);

// ---- platform dispatch -----------------------------------------------------

interface Backend {
  install: (port: number) => void;
  uninstall: () => void;
  restart: () => boolean;
  running: () => boolean;
  installed: () => boolean;
  port: () => number | null;
}

function backend(): Backend {
  const os = platform();
  if (os === 'darwin')
    return {
      install: macInstall,
      uninstall: macUninstall,
      restart: macRestart,
      running: macRunning,
      installed: macInstalled,
      port: macPort,
    };
  if (os === 'linux')
    return {
      install: linuxInstall,
      uninstall: linuxUninstall,
      restart: linuxRestart,
      running: linuxRunning,
      installed: linuxInstalled,
      port: linuxPort,
    };
  return die(`unsupported platform: ${os} (only macOS and Linux are supported)`);
}

function report(b: Backend, port: number): void {
  const inst = b.installed();
  console.log(
    `${TOOL} service: ${inst ? pc.green('installed') : pc.yellow('not installed')}, ${b.running() ? pc.green('running') : pc.red('stopped')}`,
  );
  if (inst) console.log(pc.dim(`http://localhost:${port}/metrics`));
}

export function createServiceCommand(): Command {
  const svc = new Command('service').description(
    `Run "${TOOL} serve" as an always-on background service (launchd on macOS, systemd --user on Linux)`,
  );

  svc
    .command('install')
    .description('Install + start the service (auto-starts at login)')
    .option('--port <n>', 'port to listen on', parsePort)
    .action((opts: { port?: number }) => {
      const port = opts.port ?? DEFAULT_PORT;
      backend().install(port);
      console.log(pc.green(`${TOOL} service installed — http://localhost:${port}/metrics`));
      console.log(pc.dim(`${TOOL} service status      check state`));
      console.log(pc.dim(`${TOOL} service restart     reload after editing src/`));
      console.log(pc.dim(`${TOOL} service uninstall   stop + remove`));
    });

  svc
    .command('uninstall')
    .description('Stop + remove the service')
    .action(() => {
      backend().uninstall();
      console.log(pc.green(`${TOOL} service removed`));
    });

  svc
    .command('restart')
    .description('Restart the service (picks up edited src/)')
    .action(() => {
      const b = backend();
      if (!b.installed()) die(`${TOOL} service is not installed — run \`${TOOL} service install\` first`);
      if (!b.restart()) die(`${TOOL} service restart failed`);
      console.log(pc.green(`${TOOL} service restarted`));
    });

  svc
    .command('status')
    .description('Show whether the service is installed and running')
    .action(() => {
      const b = backend();
      report(b, b.port() ?? DEFAULT_PORT);
    });

  svc.action(() => svc.help());
  return svc;
}
