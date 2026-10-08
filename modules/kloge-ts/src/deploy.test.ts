import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRemoteStartCommand, remoteCredentialLoss, requirePushConfirmation, restartIfRunning } from './deploy';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function runRemoteStart(tools: { docker?: 'with-compose' | 'without-compose'; dockerCompose?: boolean }): {
  code: number | null;
  stderr: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'kloge-deploy-'));
  tempDirs.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const remoteDir = join(root, 'remote');
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(remoteDir);

  if (tools.docker) {
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!/bin/sh\n${tools.docker === 'with-compose' ? 'exit 0' : 'exit 1'}\n`);
    chmodSync(docker, 0o755);
  }
  if (tools.dockerCompose) {
    const dockerCompose = join(bin, 'docker-compose');
    writeFileSync(dockerCompose, '#!/bin/sh\nexit 0\n');
    chmodSync(dockerCompose, 0o755);
  }

  const result = Bun.spawnSync(['/bin/sh', '-c', buildRemoteStartCommand({ host: 'example.test', remoteDir })], {
    env: { HOME: home, PATH: bin },
    stderr: 'pipe',
  });
  return { code: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
}

describe('buildRemoteStartCommand', () => {
  test('prepends both Nix profile paths before the inherited PATH', () => {
    const command = buildRemoteStartCommand({ host: 'example.test', remoteDir: '/srv/kloge' });

    expect(command).toStartWith('export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH";');
    expect(command).toContain('if docker compose version');
    expect(command).toContain('elif command -v docker-compose');
  });

  test('reports unavailable Compose when Docker exists without a Compose command', () => {
    const result = runRemoteStart({ docker: 'without-compose' });

    expect(result.code).toBe(127);
    expect(result.stderr).toContain('Docker Compose unavailable on example.test');
    expect(result.stderr).not.toContain('docker not found');
  });

  test('reports Docker missing only when neither Docker nor docker-compose exists', () => {
    const result = runRemoteStart({});

    expect(result.code).toBe(127);
    expect(result.stderr).toContain('docker not found on example.test');
  });

  test('keeps inherited system Docker and docker-compose v1 as fallbacks', () => {
    expect(runRemoteStart({ docker: 'with-compose' }).code).toBe(0);
    expect(runRemoteStart({ dockerCompose: true }).code).toBe(0);
  });
});

describe('pull restart', () => {
  test('recreates a running proxy and waits for served models', async () => {
    const calls: string[][] = [];
    let probes = 0;
    await restartIfRunning({
      runCommand: async cmd => {
        calls.push(cmd);
        if (cmd[0] === 'docker') return { code: 0, stdout: 'true\n', stderr: '' };
        probes += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ data: probes === 1 ? [] : [{ id: 'claude-fable-5-1' }] }),
          stderr: '',
        };
      },
      compose: async args => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      sleep: async () => {},
    });
    expect(calls.some(call => call.includes('--force-recreate'))).toBe(true);
    expect(probes).toBe(2);
  });

  test('leaves an absent container stopped', async () => {
    let composeCalled = false;
    await restartIfRunning({
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'No such object: kloge-cliproxy' }),
      compose: async () => {
        composeCalled = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(composeCalled).toBe(false);
  });
});

describe('push credential deletion guard', () => {
  test('reports only remote credential files absent locally', async () => {
    const calls: string[][] = [];
    const losses = await remoteCredentialLoss(
      { host: 'example.test', remoteDir: '.kloge' },
      ['claude-1.json', 'config.yaml'],
      async cmd => {
        calls.push(cmd);
        return { code: 0, stdout: 'claude-1.json\nclaude-2.json\nlogs\n', stderr: '' };
      },
    );
    expect(calls[0]).toEqual([
      'ssh',
      '-o',
      'ClearAllForwardings=yes',
      'example.test',
      "if test -d '.kloge/auth'; then LC_ALL=C ls -1A '.kloge/auth'; fi",
    ]);
    expect(losses).toEqual(['claude-2.json']);
    expect(() => requirePushConfirmation(losses, false)).toThrow('delete 1 remote-only credential file');
    expect(() => requirePushConfirmation(losses, true)).not.toThrow();
  });

  test('fails closed when remote auth cannot be inspected', async () => {
    expect(
      remoteCredentialLoss({ host: 'example.test', remoteDir: '.kloge' }, [], async () => ({
        code: 255,
        stdout: '',
        stderr: 'ssh unavailable',
      })),
    ).rejects.toThrow('ssh unavailable');
  });
});
