import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { DaemonService } from './daemon-service';
import { createPaths } from './paths';

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-daemon-service-test-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe('Linux systemd user service', () => {
  test('installs, controls, reports, and removes the user unit', async () => {
    const home = await temporaryHome();
    const teamHome = path.join(home, 'team % data');
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      if (argv.includes('show')) {
        return { code: 0, stdout: 'ActiveState=active\nMainPID=4242\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const service = new DaemonService(createPaths(teamHome), '/opt/K Team/kteamd%canary', {
      platform: 'linux',
      home,
      runner,
    });

    await service.install();
    const unitFile = path.join(home, '.config', 'systemd', 'user', 'kteamd.service');
    const unit = await readFile(unitFile, 'utf8');
    expect(unit).toContain('ExecStart="/opt/K Team/kteamd%%canary"');
    expect(unit).toContain(`Environment="KTEAM_HOME=${teamHome.replace('%', '%%')}"`);
    expect(unit).toContain(`StandardOutput="append:${path.join(teamHome, 'daemon', 'daemon.log').replace('%', '%%')}"`);
    // A healthy standalone daemon owning the port must not make Restart=always
    // re-spawn the unit forever (EXIT_ALREADY_RUNNING from daemon-boot.ts).
    expect(unit).toContain('RestartSec=2');
    expect(unit).toContain('RestartPreventExitStatus=78');
    // A1: the tmux server (and every teammate pane) lives in this unit's
    // cgroup; only KillMode=process keeps a daemon restart from erasing the
    // whole fleet.
    expect(unit).toContain('KillMode=process');
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'kteamd.service'],
      ['systemctl', '--user', 'restart', 'kteamd.service'],
    ]);

    calls.length = 0;
    await service.start();
    expect(await service.status()).toEqual({ running: true, pid: 4242 });
    await service.stop();
    await service.uninstall();
    expect(calls).toEqual([
      ['systemctl', '--user', 'start', 'kteamd.service'],
      ['systemctl', '--user', 'show', 'kteamd.service', '--property=ActiveState', '--property=MainPID'],
      ['systemctl', '--user', 'stop', 'kteamd.service'],
      ['systemctl', '--user', 'disable', '--now', 'kteamd.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(await Bun.file(unitFile).exists()).toBe(false);
  });

  test('surfaces systemctl install failures', async () => {
    const home = await temporaryHome();
    const service = new DaemonService(createPaths(path.join(home, '.kteam')), '/usr/bin/kteamd', {
      platform: 'linux',
      home,
      runner: async argv =>
        argv.includes('daemon-reload')
          ? { code: 1, stdout: '', stderr: 'user manager unavailable' }
          : { code: 0, stdout: '', stderr: '' },
    });

    expect(service.install()).rejects.toThrow('user manager unavailable');
  });
});

describe('macOS launchd service', () => {
  test('retains launchd installation and start behavior', async () => {
    const home = await temporaryHome();
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === 'bootout' || argv[1] === 'print') return { code: 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const service = new DaemonService(createPaths(path.join(home, '.kteam')), '/usr/local/bin/kteamd', {
      platform: 'darwin',
      home,
      runner,
    });

    await service.install();
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.kirin.kteamd.plist');
    const xml = await readFile(plist, 'utf8');
    expect(xml).toContain('<string>/usr/local/bin/kteamd</string>');
    // A1 (launchd equivalent of KillMode=process): without AbandonProcessGroup
    // a bootout kills the tmux server spawned from the daemon.
    expect(xml).toContain('<key>AbandonProcessGroup</key><true/>');
    await service.start();

    expect(calls.some(argv => argv[0] === 'launchctl' && argv[1] === 'bootstrap')).toBe(true);
  });
});
