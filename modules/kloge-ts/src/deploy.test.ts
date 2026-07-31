import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRemoteStartCommand } from './deploy';

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
