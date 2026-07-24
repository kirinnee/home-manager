import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { DaemonService } from './daemon-service';
import { createPaths } from './paths';

// Hermeticity (2026-07-24 02:02Z incident): a test that reached the real home
// wrote the LIVE systemd unit and crash-looped the production daemon. Under
// this flag DaemonService refuses to default to the real home or the real
// runner, so the mistake fails loudly in the test instead of on the machine.
process.env.KTEAM_TEST_HERMETIC = '1';

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

describe('supervises(pid) — the gate on self-restart', () => {
  test('systemd: only the unit MainPID counts, and only with a unit installed', async () => {
    const home = await temporaryHome();
    const commands: string[][] = [];
    const runner = async (argv: string[]) => {
      commands.push(argv);
      return { code: 0, stdout: 'MainPID=4242\n', stderr: '' };
    };
    const service = new DaemonService(createPaths(path.join(home, '.kteam')), '/usr/bin/kteamd', {
      platform: 'linux',
      home,
      runner,
    });
    // No unit file on disk: nothing is supervising us, whatever systemd says.
    expect(await service.supervises(4242)).toBe(false);
    expect(commands).toEqual([]);

    await service.install();
    commands.length = 0;
    expect(await service.supervises(4242)).toBe(true);
    expect(await service.supervises(4243)).toBe(false); // another process's pid
    expect(commands[0]).toContain('--property=MainPID');
  });

  test('systemd: a failed query is never taken as proof of supervision', async () => {
    const home = await temporaryHome();
    const service = new DaemonService(createPaths(path.join(home, '.kteam')), '/usr/bin/kteamd', {
      platform: 'linux',
      home,
      runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    });
    await service.install().catch(() => undefined);
    expect(await service.supervises(4242)).toBe(false);
  });

  test('launchd: the printed pid must match', async () => {
    const home = await temporaryHome();
    const service = new DaemonService(createPaths(path.join(home, '.kteam')), '/usr/bin/kteamd', {
      platform: 'darwin',
      home,
      runner: async () => ({ code: 0, stdout: 'state = running\n\tpid = 909\n', stderr: '' }),
    });
    expect(await service.supervises(909)).toBe(true);
    expect(await service.supervises(910)).toBe(false);
  });
});

describe('test hermeticity (2026-07-24 live-unit clobber)', () => {
  test('defaulting to the real home or runner is refused under the flag', () => {
    // The incident in one line: `new DaemonService(paths, bin, runner, 'linux')`
    // passed the runner as `options`, so every default applied — real home,
    // real `systemctl` — and install() replaced the production unit.
    expect(() => new DaemonService(createPaths('/tmp/kteam-hermetic-probe'), '/bin/kteamd')).toThrow(
      'KTEAM_TEST_HERMETIC',
    );
    expect(
      () => new DaemonService(createPaths('/tmp/kteam-hermetic-probe'), '/bin/kteamd', { home: '/tmp/x' }),
    ).toThrow('KTEAM_TEST_HERMETIC');
  });

  test('an install under a temp home never touches the real unit path', async () => {
    const home = await temporaryHome();
    const service = new DaemonService(createPaths(path.join(home, '.kteam')), '/usr/bin/kteamd', {
      platform: 'linux',
      home,
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    await service.install();
    const written = path.join(home, '.config', 'systemd', 'user', 'kteamd.service');
    expect(await readFile(written, 'utf8')).toContain('/usr/bin/kteamd');
    expect(written.startsWith(os.tmpdir())).toBe(true);
  });
});
