import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { KTeamPaths } from './paths';
import { run } from './io';

const LABEL = 'com.kirin.kteamd';
const SYSTEMD_UNIT = 'kteamd.service';

type Runner = typeof run;

export interface DaemonServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  runner?: Runner;
}

/** `StandardOutput=` / `StandardError=` take a FILE SPECIFIER, not a quotable
 *  argument. systemd parses `append:/path` structurally, so wrapping it in the
 *  quotes `systemdQuote` adds makes the whole line unparseable: the unit loads
 *  but journald logs "Failed to parse output specifier, ignoring" and the
 *  setting is silently dropped.
 *
 *  The consequence is nastier than a lost setting. Output falls back to the
 *  journal, `daemon.log` stops being written, and it FREEZES at whatever it
 *  last held — so anyone debugging by reading that file is reading a fossil and
 *  does not know it. A teammate lost time to exactly that today, reasoning
 *  about five-day-old restart lines as if they were live.
 *
 *  No quoting here, therefore. `%` is still doubled because systemd expands
 *  specifiers like `%h` in this value; a literal newline would corrupt the unit
 *  and cannot be escaped in an unquoted setting, so it is refused outright
 *  rather than written out to fail confusingly at load. */
function systemdOutputSpec(value: string): string {
  if (/[\n\r]/.test(value))
    throw new Error(`kteamd unit: log path may not contain a newline: ${JSON.stringify(value)}`);
  return value.replaceAll('%', '%%');
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll('%', '%%')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export class DaemonService {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly runner: Runner;
  /** True when the caller pinned a home (a test) instead of using the real one. */
  private readonly pinnedHome: boolean;

  constructor(
    private readonly paths: KTeamPaths,
    private readonly daemonBinary: string,
    options: DaemonServiceOptions = {},
  ) {
    // Tests set KTEAM_TEST_HERMETIC=1. Under it, falling back to the REAL home
    // or the REAL command runner is a hard error — 2026-07-24 02:02Z: a test
    // constructed this class with positional args, so `options` was undefined,
    // every default applied, and install() overwrote the live
    // ~/.config/systemd/user/kteamd.service with ExecStart=/bin/kteamd plus a
    // /tmp KTEAM_HOME, then ran `systemctl --user daemon-reload`. The
    // production daemon crash-looped (203/EXEC) until a human reinstalled it.
    // `bun test` does not typecheck, so the type error never ran.
    // NODE_ENV=test covers every file `bun test` loads, whether or not it
    // remembered to opt in — the guard must not depend on load order.
    const hermetic = process.env.KTEAM_TEST_HERMETIC === '1' || process.env.NODE_ENV === 'test';
    if (hermetic && (options.home === undefined || options.runner === undefined)) {
      throw new Error(
        'DaemonService under KTEAM_TEST_HERMETIC must be given both home and runner — ' +
          'defaulting to the real ones would write the live systemd/launchd unit',
      );
    }
    this.platform = options.platform ?? process.platform;
    this.pinnedHome = options.home !== undefined;
    this.home = options.home ?? os.homedir();
    this.runner = options.runner ?? run;
  }

  private plist(): string {
    return path.join(this.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  }

  private systemdUnit(): string {
    // XDG_CONFIG_HOME only applies to the REAL home. When a caller pinned a
    // home (tests always do), that pin wins — otherwise an exported
    // XDG_CONFIG_HOME would send a temp-home test back at the live unit.
    const configHome = this.pinnedHome
      ? path.join(this.home, '.config')
      : (process.env.XDG_CONFIG_HOME ?? path.join(this.home, '.config'));
    return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
  }

  private domain(): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID ?? 0);
    return `gui/${uid}/${LABEL}`;
  }

  async install(): Promise<void> {
    if (this.platform === 'linux') {
      await mkdir(path.dirname(this.systemdUnit()), { recursive: true });
      await mkdir(this.paths.daemon, { recursive: true });
      const unit = `[Unit]
Description=KTeam daemon
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(this.daemonBinary)}
Restart=always
RestartSec=2
# EXIT_ALREADY_RUNNING (daemon-boot.ts): a healthy daemon owns the port — do
# not re-spawn against it every RestartSec.
RestartPreventExitStatus=78
# The tmux server hosting every teammate pane is spawned from this unit and
# therefore lives in its cgroup. The default control-group kill made every
# daemon restart erase the whole fleet (2026-07-22 forensics). Signal only
# kteamd; panes survive and boot recovery re-adopts them.
KillMode=process
Environment=${systemdQuote(`KTEAM_HOME=${this.paths.home}`)}
Environment=${systemdQuote(`PATH=${process.env.PATH ?? ''}`)}
StandardOutput=append:${systemdOutputSpec(this.paths.daemonLog)}
StandardError=append:${systemdOutputSpec(this.paths.daemonLog)}

[Install]
WantedBy=default.target
`;
      await writeFile(this.systemdUnit(), unit, { mode: 0o600 });
      const reload = await this.runner(['systemctl', '--user', 'daemon-reload']);
      if (reload.code !== 0) throw new Error(reload.stderr.trim() || 'systemctl daemon-reload failed');
      const enable = await this.runner(['systemctl', '--user', 'enable', SYSTEMD_UNIT]);
      if (enable.code !== 0) throw new Error(enable.stderr.trim() || 'systemctl enable failed');
      const restart = await this.runner(['systemctl', '--user', 'restart', SYSTEMD_UNIT]);
      if (restart.code !== 0) throw new Error(restart.stderr.trim() || 'systemctl restart failed');
      return;
    }
    if (this.platform !== 'darwin')
      throw new Error('service install supports launchd on macOS and systemd user services on Linux');
    await mkdir(path.dirname(this.plist()), { recursive: true });
    await mkdir(this.paths.daemon, { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xmlEscape(this.daemonBinary)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(this.paths.daemonLog)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(this.paths.daemonLog)}</string>
<key>EnvironmentVariables</key><dict><key>KTEAM_HOME</key><string>${xmlEscape(this.paths.home)}</string><key>PATH</key><string>${xmlEscape(process.env.PATH ?? '')}</string></dict>
</dict></plist>\n`;
    await writeFile(this.plist(), xml, { mode: 0o600 });
    await this.runner(['launchctl', 'bootout', this.domain()]);
    const domain = this.domain().replace(`/${LABEL}`, '');
    const result = await this.runner(['launchctl', 'bootstrap', domain, this.plist()]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'launchctl bootstrap failed');
  }

  async uninstall(): Promise<void> {
    if (this.platform === 'linux') {
      await this.runner(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]);
      await rm(this.systemdUnit(), { force: true });
      await this.runner(['systemctl', '--user', 'daemon-reload']);
      return;
    }
    if (this.platform === 'darwin') await this.runner(['launchctl', 'bootout', this.domain()]);
    await rm(this.plist(), { force: true });
  }

  async start(): Promise<void> {
    if (existsSync(this.systemdUnit()) && this.platform === 'linux') {
      const result = await this.runner(['systemctl', '--user', 'start', SYSTEMD_UNIT]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'could not start systemd user service');
      return;
    }
    if (existsSync(this.plist()) && this.platform === 'darwin') {
      const loaded = await this.runner(['launchctl', 'print', this.domain()]);
      const result =
        loaded.code === 0
          ? await this.runner(['launchctl', 'kickstart', '-k', this.domain()])
          : await this.runner(['launchctl', 'bootstrap', this.domain().replace(`/${LABEL}`, ''), this.plist()]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'could not start launchd service');
      return;
    }
    await mkdir(this.paths.daemon, { recursive: true });
    const child = Bun.spawn(['sh', '-c', 'exec "$1" >> "$2" 2>&1', 'sh', this.daemonBinary, this.paths.daemonLog], {
      env: { ...process.env, KTEAM_HOME: this.paths.home },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    child.unref();
  }

  async stop(): Promise<void> {
    if (existsSync(this.systemdUnit()) && this.platform === 'linux') {
      await this.runner(['systemctl', '--user', 'stop', SYSTEMD_UNIT]);
      return;
    }
    if (existsSync(this.plist()) && this.platform === 'darwin') {
      await this.runner(['launchctl', 'bootout', this.domain()]);
      return;
    }
    const pid = Number((await readFile(this.paths.pid, 'utf8').catch(() => '')).trim());
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(this.paths.pid, { force: true });
  }

  /** Does the SERVICE MANAGER own this pid? The one honest proof that a clean
   *  exit will be followed by a restart — an env marker leaks into every child
   *  (a daemon started by hand from a supervised pane inherits it), and a unit
   *  file on disk says nothing about who started the running process. */
  async supervises(pid: number): Promise<boolean> {
    if (this.platform === 'linux') {
      if (!existsSync(this.systemdUnit())) return false;
      const result = await this.runner(['systemctl', '--user', 'show', SYSTEMD_UNIT, '--property=MainPID']);
      if (result.code !== 0) return false;
      return Number(result.stdout.trim().split('=')[1]) === pid;
    }
    if (this.platform === 'darwin') {
      const result = await this.runner(['launchctl', 'print', this.domain()]);
      if (result.code !== 0) return false;
      return new RegExp(`\\bpid = ${pid}\\b`).test(result.stdout);
    }
    return false;
  }

  /** Startup liveness of the pid file, for the CLI's readiness wait. The daemon
   *  writes paths.pid ONLY after it binds (daemon-entry.ts), so:
   *   - 'absent'  → no usable pid file yet: pre-bind (schema rebuild, EADDRINUSE
   *                 drain) — still coming up, keep waiting.
   *   - 'alive'   → the recorded pid answers signal 0: the process is up (may
   *                 not be serving HTTP yet).
   *   - 'dead'    → a pid is recorded but the process is gone: it bound, wrote
   *                 its pid, then died.
   *  Cheaper than status() (no service-manager shell-out); safe to poll. A 'dead'
   *  verdict can also be a STALE pid from a prior crashed run, so the caller only
   *  fast-fails on 'dead' after it has seen 'alive' in the same wait. */
  async pidLiveness(): Promise<'alive' | 'dead' | 'absent'> {
    const raw = (await readFile(this.paths.pid, 'utf8').catch(() => '')).trim();
    const pid = Number(raw);
    if (!raw || !Number.isFinite(pid) || pid <= 1) return 'absent';
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch {
      return 'dead';
    }
  }

  async status(): Promise<{ running: boolean; pid?: number }> {
    const pid = Number((await readFile(this.paths.pid, 'utf8').catch(() => '')).trim());
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        return { running: true, pid };
      } catch {}
    }
    if (existsSync(this.systemdUnit()) && this.platform === 'linux') {
      const result = await this.runner([
        'systemctl',
        '--user',
        'show',
        SYSTEMD_UNIT,
        '--property=ActiveState',
        '--property=MainPID',
      ]);
      if (result.code !== 0) return { running: false };
      const properties = Object.fromEntries(
        result.stdout
          .trim()
          .split('\n')
          .map(line => line.split('=', 2) as [string, string]),
      );
      const mainPid = Number(properties.MainPID);
      return {
        running: properties.ActiveState === 'active',
        ...(Number.isFinite(mainPid) && mainPid > 0 ? { pid: mainPid } : {}),
      };
    }
    if (this.platform === 'darwin') {
      const result = await this.runner(['launchctl', 'print', this.domain()]);
      return { running: result.code === 0 };
    }
    return { running: false };
  }
}
