import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSharedSqliteDir } from '../deps';
import {
  apply,
  expandAliases,
  materializeAgent,
  renderCommand,
  renderWrapper,
  resolveDefaultHomeTargets,
  wrapperName,
} from './generate';

describe('renderWrapper', () => {
  test('claude: config-dir env, autotrust, exec with flags, $ left unescaped', () => {
    const w = renderWrapper({
      name: 'kirin',
      kind: 'claude',
      env: { ANTHROPIC_AUTH_TOKEN: '$API_CLI_PROXY_TOKEN' },
      flags: ['--yolo'],
    });
    expect(w).toContain('export CLAUDE_CONFIG_DIR="$HOME/.claude-kirin"');
    // $ must survive so the token expands at runtime
    expect(w).toContain('export ANTHROPIC_AUTH_TOKEN="$API_CLI_PROXY_TOKEN"');
    expect(w).toContain('CLAUDE_AUTOTRUST');
    expect(w).toContain('# kfleet-managed');
    expect(w.trimEnd().endsWith('exec claude "--yolo" "$@"')).toBe(true);
  });

  test('codex: CODEX_HOME, no autotrust', () => {
    const w = renderWrapper({ name: 'loai', kind: 'codex' });
    expect(w).toContain('export CODEX_HOME="$HOME/.codex-loai"');
    expect(w).not.toContain('CODEX_SQLITE_HOME');
    expect(w).not.toContain('CLAUDE_AUTOTRUST');
    expect(w.trimEnd().endsWith('exec codex "$@"')).toBe(true);
  });

  test('shared codex: forces one literal absolute SQLite home after profile env', () => {
    const w = renderWrapper(
      { name: 'loai', kind: 'codex', env: { CODEX_SQLITE_HOME: '/tmp/profile-private-state' } },
      { codex: true },
    );
    expect(path.isAbsolute(codexSharedSqliteDir)).toBe(true);
    expect(w).toContain(`export CODEX_SQLITE_HOME="${codexSharedSqliteDir}"`);
    expect(w).not.toContain('/tmp/profile-private-state');
    expect(w.match(/export CODEX_SQLITE_HOME=/g)).toHaveLength(1);
  });

  test('codex sharing does not change Claude wrapper output', () => {
    const agent = { name: 'kirin', kind: 'claude' as const };
    expect(renderWrapper(agent, { codex: true })).toBe(renderWrapper(agent));
  });

  test('wrapperName is <kind>-<name>', () => {
    expect(wrapperName({ kind: 'codex', name: 'loai' })).toBe('codex-loai');
  });
});

describe('materializeAgent shared Codex settings', () => {
  const dir = (): string => mkdtempSync(path.join(os.tmpdir(), 'kfleet-generate-'));
  const sqliteMarker = (home: string): string => path.join(home, '.kfleet-sqlite-home.json');

  test('forces sqlite_home after user layers because config wins over environment', () => {
    const target = dir();
    materializeAgent(
      {
        name: 'loai',
        kind: 'codex',
        settings: [{ model: 'gpt-test', sqlite_home: '/tmp/private-state' }],
      },
      target,
      { codex: true },
    );

    const config = readFileSync(path.join(target, 'config.toml'), 'utf8');
    expect(config).toContain('model = "gpt-test"');
    expect(config).toContain(`sqlite_home = "${codexSharedSqliteDir}"`);
    expect(config).not.toContain('/tmp/private-state');
  });

  test('creates managed config for a minimal Codex home, including a bare default-home target', () => {
    const bareHome = path.join(dir(), '.codex');
    materializeAgent({ name: 'personal', kind: 'codex' }, bareHome, { codex: true });
    expect(readFileSync(path.join(bareHome, 'config.toml'), 'utf8')).toBe(`sqlite_home = "${codexSharedSqliteDir}"\n`);
    expect(existsSync(sqliteMarker(bareHome))).toBe(true);
  });

  test('disabled sharing leaves Codex sqlite settings untouched and adds nothing when absent', () => {
    const configured = dir();
    materializeAgent({ name: 'loai', kind: 'codex', settings: [{ sqlite_home: '/tmp/private-state' }] }, configured);
    expect(readFileSync(path.join(configured, 'config.toml'), 'utf8')).toBe('sqlite_home = "/tmp/private-state"\n');

    const minimal = dir();
    materializeAgent({ name: 'loai', kind: 'codex' }, minimal);
    expect(existsSync(path.join(minimal, 'config.toml'))).toBe(false);
  });

  test('per-agent enable preserves unmanaged settings and disable removes only the marked override', () => {
    const agentHome = path.join(dir(), '.codex-personal');
    const config = path.join(agentHome, 'config.toml');
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(config, 'model = "gpt-user"\n\n[features]\napps = true\n');

    materializeAgent({ name: 'personal', kind: 'codex' }, agentHome, { codex: true });
    expect(readFileSync(config, 'utf8')).toContain('model = "gpt-user"');
    expect(readFileSync(config, 'utf8')).toContain('apps = true');
    expect(readFileSync(config, 'utf8')).toContain(`sqlite_home = "${codexSharedSqliteDir}"`);

    writeFileSync(
      config,
      `model = "gpt-user-edited"\nsqlite_home = "${codexSharedSqliteDir}"\n\n[features]\napps = true\n`,
    );
    materializeAgent({ name: 'personal', kind: 'codex' }, agentHome);

    const disabled = readFileSync(config, 'utf8');
    expect(disabled).toContain('model = "gpt-user-edited"');
    expect(disabled).toContain('apps = true');
    expect(disabled).not.toContain('sqlite_home');
    expect(existsSync(sqliteMarker(agentHome))).toBe(false);
  });

  test('bare-home disable preserves a user-changed sqlite_home and removes the ownership marker', () => {
    const bareHome = path.join(dir(), '.codex');
    const config = path.join(bareHome, 'config.toml');
    mkdirSync(bareHome, { recursive: true });
    writeFileSync(config, 'model = "gpt-user"\n');
    materializeAgent({ name: 'personal', kind: 'codex' }, bareHome, { codex: true });

    writeFileSync(config, 'model = "gpt-user"\nsqlite_home = "/user/changed-it"\n');
    materializeAgent({ name: 'personal', kind: 'codex' }, bareHome);

    expect(readFileSync(config, 'utf8')).toContain('sqlite_home = "/user/changed-it"');
    expect(existsSync(sqliteMarker(bareHome))).toBe(false);
  });

  test('disable restores an unmanaged private sqlite_home replaced during enable', () => {
    const agentHome = path.join(dir(), '.codex-private');
    const config = path.join(agentHome, 'config.toml');
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(config, 'model = "gpt-user"\nsqlite_home = "/private/db"\n');

    materializeAgent({ name: 'private', kind: 'codex' }, agentHome, { codex: true });
    expect(readFileSync(config, 'utf8')).toContain(`sqlite_home = "${codexSharedSqliteDir}"`);
    materializeAgent({ name: 'private', kind: 'codex' }, agentHome);

    expect(readFileSync(config, 'utf8')).toContain('sqlite_home = "/private/db"');
    expect(readFileSync(config, 'utf8')).toContain('model = "gpt-user"');
    expect(existsSync(sqliteMarker(agentHome))).toBe(false);
  });

  test('marker failure leaves config untouched; config failure leaves a safely reconcilable marker', () => {
    const markerFailureHome = path.join(dir(), '.codex-marker-failure');
    const markerFailureConfig = path.join(markerFailureHome, 'config.toml');
    mkdirSync(markerFailureHome, { recursive: true });
    writeFileSync(markerFailureConfig, 'sqlite_home = "/private/marker"\n');
    expect(() =>
      materializeAgent(
        { name: 'marker-failure', kind: 'codex' },
        markerFailureHome,
        { codex: true },
        {
          beforeCodexMarkerWrite: () => {
            throw new Error('injected marker failure');
          },
        },
      ),
    ).toThrow(/injected marker failure/);
    expect(readFileSync(markerFailureConfig, 'utf8')).toContain('/private/marker');
    expect(existsSync(sqliteMarker(markerFailureHome))).toBe(false);

    const configFailureHome = path.join(dir(), '.codex-config-failure');
    const configFailureConfig = path.join(configFailureHome, 'config.toml');
    mkdirSync(configFailureHome, { recursive: true });
    writeFileSync(configFailureConfig, 'model = "kept"\nsqlite_home = "/private/config"\n');
    expect(() =>
      materializeAgent(
        { name: 'config-failure', kind: 'codex' },
        configFailureHome,
        { codex: true },
        {
          beforeSettingsWrite: () => {
            throw new Error('injected config failure');
          },
        },
      ),
    ).toThrow(/injected config failure/);
    expect(existsSync(sqliteMarker(configFailureHome))).toBe(true);
    expect(readFileSync(configFailureConfig, 'utf8')).toContain('/private/config');

    materializeAgent({ name: 'config-failure', kind: 'codex' }, configFailureHome);
    expect(readFileSync(configFailureConfig, 'utf8')).toContain('/private/config');
    expect(readFileSync(configFailureConfig, 'utf8')).toContain('model = "kept"');
    expect(existsSync(sqliteMarker(configFailureHome))).toBe(false);
  });

  test('enable then disable removes a config created solely for the managed override', () => {
    const agentHome = path.join(dir(), '.codex-minimal');
    materializeAgent({ name: 'minimal', kind: 'codex' }, agentHome, { codex: true });
    materializeAgent({ name: 'minimal', kind: 'codex' }, agentHome);
    expect(existsSync(path.join(agentHome, 'config.toml'))).toBe(false);
    expect(existsSync(sqliteMarker(agentHome))).toBe(false);
  });
});

describe('renderCommand', () => {
  test('execs the target wrapper with flags prepended before "$@"', () => {
    const w = renderCommand({ name: 'yolo-kirin', target: 'claude-kirin', flags: ['--dangerously-skip-permissions'] });
    expect(w).toContain('# kfleet-managed');
    expect(w).toContain('claude-kirin');
    expect(w.trimEnd().endsWith('"--dangerously-skip-permissions" "$@"')).toBe(true);
  });

  test('no flags → just exec the target', () => {
    const w = renderCommand({ name: 'c', target: 'codex-loai', flags: [] });
    expect(w.trimEnd().endsWith('codex-loai" "$@"')).toBe(true);
  });
});

describe('expandAliases', () => {
  test('alias replaces the kind prefix, keeping the variant infix', () => {
    const cmds = expandAliases({ yolo: { claude: '--dangerously-skip-permissions' } }, [
      { name: 'atomi', kind: 'claude' },
      { name: 'auto-atomi', kind: 'claude' },
      { name: 'loai', kind: 'codex' }, // not matched: yolo only lists claude
    ]);
    expect(cmds.map(c => c.name).sort()).toEqual(['yolo-atomi', 'yolo-auto-atomi']);
    const a = cmds.find(c => c.name === 'yolo-auto-atomi');
    expect(a?.target).toBe('claude-auto-atomi'); // target is the full wrapper name
    expect(a?.flags).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('apply', () => {
  test('rejects a command whose target is not a configured agent (no fs writes before validation)', () => {
    expect(() => apply([], [{ name: 'x', target: 'claude-nope', flags: [] }])).toThrow(/unknown target "claude-nope"/);
  });

  test('rejects a command name that collides with an agent wrapper', () => {
    expect(() =>
      apply([{ name: 'kirin', kind: 'claude' }], [{ name: 'claude-kirin', target: 'claude-kirin', flags: [] }]),
    ).toThrow(/collides/);
  });

  test('rejects duplicate command names', () => {
    expect(() =>
      apply(
        [{ name: 'kirin', kind: 'claude' }],
        [
          { name: 'yolo-kirin', target: 'claude-kirin', flags: [] },
          { name: 'yolo-kirin', target: 'claude-kirin', flags: ['--x'] },
        ],
      ),
    ).toThrow(/duplicate command name/);
  });

  test('rejects unknown default home targets before fs writes', () => {
    expect(() => apply([], [], { codex: 'personal' })).toThrow(/defaultHomes\.codex: unknown target "personal"/);
  });
});

describe('resolveDefaultHomeTargets', () => {
  test('accepts resolved agent names and wrapper names', () => {
    const targets = resolveDefaultHomeTargets({ claude: 'kirin', codex: 'codex-personal' }, [
      { name: 'kirin', kind: 'claude' },
      { name: 'personal', kind: 'codex' },
    ]);

    expect(targets.map(t => [t.kind, wrapperName(t.agent)])).toEqual([
      ['claude', 'claude-kirin'],
      ['codex', 'codex-personal'],
    ]);
    expect(targets.find(t => t.kind === 'claude')?.dir.endsWith('/.claude')).toBe(true);
    expect(targets.find(t => t.kind === 'codex')?.dir.endsWith('/.codex')).toBe(true);
  });
});
