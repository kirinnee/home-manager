import { describe, expect, test } from 'bun:test';
import { apply, expandAliases, renderCommand, renderWrapper, resolveDefaultHomeTargets, wrapperName } from './generate';

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
    expect(w).not.toContain('CLAUDE_AUTOTRUST');
    expect(w.trimEnd().endsWith('exec codex "$@"')).toBe(true);
  });

  test('wrapperName is <kind>-<name>', () => {
    expect(wrapperName({ kind: 'codex', name: 'loai' })).toBe('codex-loai');
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
