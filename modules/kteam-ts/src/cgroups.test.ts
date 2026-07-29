import { describe, expect, test } from 'bun:test';
import {
  CgroupController,
  agentScopeFromCgroup,
  defaultCgroupConfig,
  mergeCgroupConfig,
  validateCgroupConfig,
  type CgroupConfig,
} from './cgroups';

const enabled = (): CgroupConfig => ({
  enabled: true,
  fleet: { cpuPercent: 90, memoryPercent: 90 },
  perAgent: { cpuPercent: 25, memoryPercent: 25 },
});

describe('two-level cgroup controller', () => {
  test('converts host percentages and wraps an agent under the fleet slice', async () => {
    const commands: string[][] = [];
    const controller = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      cpus: 8,
      memoryBytes: 32_000,
      nonce: () => 'nonce',
      runner: async argv => {
        commands.push(argv);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const wrapped = await controller.agentCommand('ms-one', ['agent', '--flag']);
    expect(commands).toEqual([
      ['systemctl', '--user', 'set-property', '--runtime', 'kteam-fleet.slice', 'CPUQuota=720%', 'MemoryMax=28800'],
    ]);
    expect(wrapped).toEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=kteam-agent-ms-one-nonce.scope',
      '--slice=kteam-fleet.slice',
      '--property=CPUQuota=200%',
      '--property=MemoryMax=8000',
      '--',
      'agent',
      '--flag',
    ]);
  });

  test('bounds and sanitizes transient scope names', async () => {
    const controller = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      nonce: () => '../nonce with spaces/and/slashes',
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const command = await controller.agentCommand(`../../${'x'.repeat(300)}`, ['agent']);
    const unit = command.find(value => value.startsWith('--unit='))?.slice('--unit='.length);
    expect(unit).toMatch(/^kteam-agent-[A-Za-z0-9_.-]+\.scope$/);
    expect(unit!.length).toBeLessThan(255);
    expect(unit).not.toContain('..');
    expect(unit).not.toContain('/');
  });

  test('disabled is a genuine direct-exec bypass with no runner or proc read', async () => {
    const config = { ...enabled(), enabled: false };
    const original = ['agent', '--flag'];
    const controller = new CgroupController(config, {
      platform: 'linux',
      cgroupV2: true,
      runner: async () => {
        throw new Error('runner must not be called');
      },
      procReader: async () => {
        throw new Error('proc must not be read');
      },
    });
    expect(await controller.agentCommand('ms-one', original)).toBe(original);
  });

  test('a fleet-apply failure stays visible on the settings view', async () => {
    const controller = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      runner: async () => ({ code: 1, stdout: '', stderr: 'user manager unavailable' }),
    });
    await expect(controller.agentCommand('ms-one', ['agent'])).rejects.toThrow('user manager unavailable');
    expect((await controller.describe()).warnings).toEqual(['user manager unavailable']);
  });

  test('hot-applies managed scopes and reports unmanaged agents for relaunch', async () => {
    const commands: string[][] = [];
    const controller = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      cpus: 4,
      memoryBytes: 10_000,
      procReader: async pid =>
        pid === 10
          ? '0::/user.slice/kteam.slice/kteam-fleet.slice/kteam-agent-ms-one-old.scope\n'
          : '0::/user.slice/user@1000.service/app.slice/tmux-spawn.scope\n',
      runner: async argv => {
        commands.push(argv);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const next = mergeCgroupConfig(enabled(), {
      fleet: { cpuPercent: 80 },
      perAgent: { cpuPercent: 20, memoryPercent: 20 },
    });

    const view = await controller.apply(next, [
      { sessionId: 'ms-one', panePid: 10 },
      { sessionId: 'ms-two', panePid: 20 },
    ]);
    expect(commands).toEqual([
      ['systemctl', '--user', 'set-property', '--runtime', 'kteam-fleet.slice', 'CPUQuota=320%', 'MemoryMax=9000'],
      [
        'systemctl',
        '--user',
        'set-property',
        '--runtime',
        'kteam-agent-ms-one-old.scope',
        'CPUQuota=80%',
        'MemoryMax=2000',
      ],
    ]);
    expect(view.restartRequiredSessions).toEqual(['ms-two']);
  });

  test('disabling writes no unlimited properties and names scoped agents for relaunch', async () => {
    const commands: string[][] = [];
    const controller = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      procReader: async () => '0::/kteam-fleet.slice/kteam-agent-ms-one-old.scope\n',
      runner: async argv => {
        commands.push(argv);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const view = await controller.apply({ ...enabled(), enabled: false }, [{ sessionId: 'ms-one', panePid: 10 }]);
    expect(commands).toEqual([]);
    expect(view.restartRequiredSessions).toEqual(['ms-one']);
    expect((await controller.agentCommand('next', ['agent']))[0]).toBe('agent');
  });

  test('unknown placement never claims a disabled cap was removed', async () => {
    const controller = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      procReader: async () => {
        throw new Error('proc raced with exit');
      },
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const view = await controller.apply({ ...enabled(), enabled: false }, [{ sessionId: 'ms-unknown', panePid: 10 }]);
    expect(view.restartRequiredSessions).toEqual(['ms-unknown']);
    expect(view.warnings).toEqual([
      'could not determine cgroup placement for ms-unknown (pid 10): proc raced with exit',
    ]);
    const described = await controller.describe([{ sessionId: 'ms-still-unknown', panePid: 11 }]);
    expect(described.restartRequiredSessions).toEqual(['ms-still-unknown']);
    expect(described.warnings).toContain(
      'could not determine cgroup placement for ms-still-unknown (pid 11): proc raced with exit',
    );
  });

  test('recognizes agent and daemon cgroup placement', async () => {
    expect(agentScopeFromCgroup('0::/x/kteam-agent-abc-123.scope\n')).toBe('kteam-agent-abc-123.scope');
    expect(agentScopeFromCgroup('0::/app.slice/kteamd.service\n')).toBeUndefined();
    const outside = new CgroupController(enabled(), {
      platform: 'linux',
      cgroupV2: true,
      procReader: async pid =>
        pid === 1 ? '0::/app.slice/kteamd.service\n' : '0::/kteam.slice/kteam-fleet.slice/agent.scope\n',
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(await outside.daemonOutsideFleet(1)).toBe(true);
    expect(await outside.daemonOutsideFleet(2)).toBe(false);
  });

  test('validates both levels and keeps non-Linux disabled by default', () => {
    expect(defaultCgroupConfig('darwin').enabled).toBe(false);
    expect(() =>
      validateCgroupConfig({
        enabled: true,
        fleet: { cpuPercent: 90, memoryPercent: 90 },
        perAgent: { cpuPercent: 91, memoryPercent: 25 },
      }),
    ).toThrow('perAgent.cpuPercent');
    expect(() =>
      validateCgroupConfig({
        enabled: true,
        fleet: { cpuPercent: Number.NaN, memoryPercent: 90 },
        perAgent: { cpuPercent: 25, memoryPercent: 25 },
      }),
    ).toThrow('fleet.cpuPercent');
  });
});
