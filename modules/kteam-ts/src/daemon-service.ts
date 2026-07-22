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

  constructor(
    private readonly paths: KTeamPaths,
    private readonly daemonBinary: string,
    options: DaemonServiceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? os.homedir();
    this.runner = options.runner ?? run;
  }

  private plist(): string {
    return path.join(this.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  }

  private systemdUnit(): string {
    const configHome = process.env.XDG_CONFIG_HOME ?? path.join(this.home, '.config');
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
StandardOutput=${systemdQuote(`append:${this.paths.daemonLog}`)}
StandardError=${systemdQuote(`append:${this.paths.daemonLog}`)}

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
