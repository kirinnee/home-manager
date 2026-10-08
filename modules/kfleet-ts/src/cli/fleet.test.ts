import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretsFileKeysPresent } from '../core/creds';
import { partitionByCredential } from '../core/generate';
import type { ResolvedAgent } from '../core/types';

const ENTRY = path.join(import.meta.dir, '..', 'index.ts');

const CONFIG = `
variants:
  auto: {}
aliases:
  yolo:
    claude: --dangerously-skip-permissions
agents:
  - name: kirin
    kind: claude
  - name: loge1
    kind: claude
    credential: { source: secrets-file, key: LOGE_CLAUDE_1_TOKEN }
    env: { CLAUDE_CODE_OAUTH_TOKEN: $LOGE_CLAUDE_1_TOKEN }
  - name: loge2
    kind: claude
    credential: { source: secrets-file, key: LOGE_CLAUDE_2_TOKEN }
    env: { CLAUDE_CODE_OAUTH_TOKEN: $LOGE_CLAUDE_2_TOKEN }
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway HOME + KFLEET_HOME so `kfleet apply` never touches the real fleet. */
function sandbox() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kf-fleet-'));
  dirs.push(home);
  const kfleetHome = path.join(home, '.kfleet');
  mkdirSync(kfleetHome, { recursive: true });
  writeFileSync(path.join(kfleetHome, 'config.yaml'), CONFIG);
  const secrets = (body: string) => writeFileSync(path.join(home, '.secrets'), body);
  const apply = () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, ENTRY, 'apply'],
      env: { PATH: process.env.PATH ?? '', HOME: home, KFLEET_HOME: kfleetHome, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = child.stdout.toString() + child.stderr.toString();
    expect({ code: child.exitCode, out }).toMatchObject({ code: 0 });
    return out;
  };
  const has = (name: string) => existsSync(path.join(kfleetHome, 'bin', name));
  return { home, secrets, apply, has };
}

describe('kfleet apply: upstream-following secrets-file accounts', () => {
  test('skips an agent whose token is absent/empty, removes its old wrappers, restores them later', () => {
    const fleet = sandbox();
    fleet.secrets('export LOGE_CLAUDE_1_TOKEN=one\nexport LOGE_CLAUDE_2_TOKEN=two\n');
    fleet.apply();
    for (const name of ['claude-loge2', 'claude-auto-loge2', 'yolo-loge2', 'yolo-auto-loge2']) {
      expect(fleet.has(name)).toBe(true);
    }

    // Upstream dropped token 2 (load-secrets wrote it empty / left it out).
    fleet.secrets('export LOGE_CLAUDE_1_TOKEN=one\nexport LOGE_CLAUDE_2_TOKEN=\n');
    const out = fleet.apply();
    const notices = out.split('\n').filter(line => line.includes('upstream — skipped'));
    expect(notices).toEqual(['• loge2: no LOGE_CLAUDE_2_TOKEN upstream — skipped']);
    for (const name of ['claude-loge2', 'claude-auto-loge2', 'yolo-loge2', 'yolo-auto-loge2']) {
      expect(fleet.has(name)).toBe(false);
    }
    for (const name of ['claude-kirin', 'claude-loge1', 'claude-auto-loge1', 'yolo-loge1']) {
      expect(fleet.has(name)).toBe(true);
    }
    // Account data in the config dir is never deleted, only the wrappers.
    expect(existsSync(path.join(fleet.home, '.claude-loge2'))).toBe(true);

    fleet.secrets('export LOGE_CLAUDE_1_TOKEN=one\nexport LOGE_CLAUDE_2_TOKEN=two\n');
    expect(fleet.apply()).not.toContain('skipped');
    expect(fleet.has('claude-auto-loge2')).toBe(true);
    expect(fleet.has('yolo-auto-loge2')).toBe(true);
  });

  test('no secrets file at all = no tokens upstream: only tokenless agents get wrappers', () => {
    const fleet = sandbox();
    const out = fleet.apply();
    expect(out).toContain('loge1: no LOGE_CLAUDE_1_TOKEN upstream — skipped');
    expect(out).toContain('loge2: no LOGE_CLAUDE_2_TOKEN upstream — skipped');
    expect(fleet.has('claude-kirin')).toBe(true);
    expect(fleet.has('claude-loge1')).toBe(false);
  });

  test('an unreadable secrets file skips nothing (never wipe wrappers on a parse error)', () => {
    const fleet = sandbox();
    fleet.secrets('export LOGE_CLAUDE_1_TOKEN=one\nif then fi (\n');
    const out = fleet.apply();
    expect(out).toContain('could not read');
    expect(out).not.toContain('skipped');
    expect(fleet.has('claude-loge2')).toBe(true);
  });
});

describe('secretsFileKeysPresent', () => {
  test('reports only non-empty keys from the file, ignoring the ambient env', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kf-secrets-'));
    dirs.push(dir);
    const file = path.join(dir, '.secrets');
    writeFileSync(file, "export A_TOKEN='a b'\nB_TOKEN=\n");
    process.env.C_TOKEN = 'ambient';
    try {
      expect(secretsFileKeysPresent(['A_TOKEN', 'B_TOKEN', 'C_TOKEN'], file)).toEqual(new Set(['A_TOKEN']));
    } finally {
      delete process.env.C_TOKEN;
    }
    expect(secretsFileKeysPresent(['A_TOKEN'], path.join(dir, 'missing'))).toEqual(new Set());
  });
});

describe('partitionByCredential', () => {
  const agents: ResolvedAgent[] = [
    { name: 'kirin', kind: 'claude', base: 'kirin', variant: 'default' },
    {
      name: 'loge4',
      kind: 'claude',
      base: 'loge4',
      variant: 'default',
      credential: { source: 'secrets-file', key: 'K4' },
    },
    {
      name: 'auto-loge4',
      kind: 'claude',
      base: 'loge4',
      variant: 'auto',
      credential: { source: 'secrets-file', key: 'K4' },
    },
    {
      name: 'loge1',
      kind: 'claude',
      base: 'loge1',
      variant: 'default',
      credential: { source: 'secrets-file', key: 'K1' },
    },
  ];

  test('groups every variant of a tokenless agent into one skip entry', () => {
    const { agents: kept, skipped } = partitionByCredential(agents, new Set(['K1']));
    expect(kept.map(a => a.name)).toEqual(['kirin', 'loge1']);
    expect(skipped).toEqual([{ agent: 'loge4', key: 'K4', wrappers: ['claude-loge4', 'claude-auto-loge4'] }]);
  });

  test('null (unreadable secrets) keeps everyone', () => {
    expect(partitionByCredential(agents, null)).toEqual({ agents, skipped: [] });
  });
});

describe('withoutTokenlessAgents (what usage/serve probe)', () => {
  test('drops agents apply would skip, keeps the rest; unchanged when every token is present', async () => {
    const { loadConfig } = await import('../core/config');
    const { withoutTokenlessAgents } = await import('./fleet');
    const fleet = sandbox();
    const config = loadConfig(path.join(fleet.home, '.kfleet', 'config.yaml'));
    const secretsFile = path.join(fleet.home, '.secrets');

    fleet.secrets('export LOGE_CLAUDE_1_TOKEN=one\n');
    expect(withoutTokenlessAgents(config, secretsFile).agents.map(a => a.name)).toEqual(['kirin', 'loge1']);

    fleet.secrets('export LOGE_CLAUDE_1_TOKEN=one\nexport LOGE_CLAUDE_2_TOKEN=two\n');
    expect(withoutTokenlessAgents(config, secretsFile)).toBe(config);
  });
});
