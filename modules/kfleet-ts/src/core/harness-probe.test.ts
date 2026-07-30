import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_PROBE_SENTINEL,
  HARNESS_PROBE_SUCCESS_TTL_MS,
  prepareHarnessProbeEnv,
  probeHarness,
  type HarnessProbeOptions,
} from './harness-probe';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(name: string, source: string): Promise<{ root: string; wrapper: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-probe-test-'));
  temporaryDirectories.push(root);
  const wrapper = path.join(root, name);
  await writeFile(wrapper, `#!/bin/sh\n${source}\n`);
  await chmod(wrapper, 0o755);
  return { root, wrapper };
}

function options(
  binary: string,
  wrapper: string,
  kind: 'claude' | 'codex',
  extra: Partial<HarnessProbeOptions> = {},
): HarnessProbeOptions {
  return { binary, wrapper, kind, cachePath: false, ...extra };
}

describe('cheap harness command', () => {
  test('preserves ambient credentials referenced by a generated wrapper while removing unrelated agent state', async () => {
    const { wrapper } = await fixture(
      'codex-auto-source-ref',
      'export OPENAI_API_KEY="$OPENAI_API_KEY"\nexport CODEX_HOME="$HOME/.codex-target"',
    );
    const prepared = await prepareHarnessProbeEnv(wrapper, {
      PATH: '/bin',
      OPENAI_API_KEY: 'target-source-secret',
      OPENAI_BASE_URL: 'https://wrong.example',
      CODEX_HOME: '/wrong-home',
    });

    expect(prepared.PATH).toBe('/bin');
    expect(prepared.OPENAI_API_KEY).toBe('target-source-secret');
    expect(prepared.OPENAI_BASE_URL).toBeUndefined();
    expect(prepared.CODEX_HOME).toBeUndefined();
  });

  test('Claude API-key wrappers use bare mode and disable context, tools, skills, persistence, and Chrome', async () => {
    const { root, wrapper } = await fixture(
      'claude-auto-key',
      `export ANTHROPIC_API_KEY="test-only"\nprintf '%s\\n' "$@" > "$PROBE_ARGS_FILE"\npwd > "$PROBE_CWD_FILE"\nprintf '${HARNESS_PROBE_SENTINEL}\\n'`,
    );
    const argsFile = path.join(root, 'args');
    const cwdFile = path.join(root, 'cwd');
    const result = await probeHarness(
      options('claude-auto-key', wrapper, 'claude', {
        env: { ...process.env, PROBE_ARGS_FILE: argsFile, PROBE_CWD_FILE: cwdFile },
      }),
    );

    expect(result.up).toBe(true);
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    for (const flag of [
      '--bare',
      '--print',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--no-chrome',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--tools',
      '--system-prompt',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args.at(-2)).toBe(`Reply with exactly: ${HARNESS_PROBE_SENTINEL} and nothing else.`);
    expect((await readFile(cwdFile, 'utf8')).trim()).not.toBe(root);
  });

  test('Claude OAuth wrappers retain auth by omitting bare while keeping the other cheap flags', async () => {
    const { root, wrapper } = await fixture(
      'claude-auto-oauth',
      `export CLAUDE_CODE_OAUTH_TOKEN="test-only"\nprintf '%s\\n' "$@" > "$PROBE_ARGS_FILE"\nprintf '${HARNESS_PROBE_SENTINEL}\\n'`,
    );
    const argsFile = path.join(root, 'args');
    const result = await probeHarness(
      options('claude-auto-oauth', wrapper, 'claude', {
        env: { ...process.env, PROBE_ARGS_FILE: argsFile },
      }),
    );

    expect(result.up).toBe(true);
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    expect(args).not.toContain('--bare');
    expect(args).toContain('--setting-sources');
    expect(args).toContain('--tools');
    expect(args).toContain('--no-session-persistence');
  });

  test('Codex keeps provider config and disables repo context, rules, hooks, writes, and persistence', async () => {
    const { root, wrapper } = await fixture(
      'codex-auto-loge',
      `printf '%s\\n' "$@" > "$PROBE_ARGS_FILE"\npwd > "$PROBE_CWD_FILE"\nprintf '${HARNESS_PROBE_SENTINEL}\\n'`,
    );
    const argsFile = path.join(root, 'args');
    const cwdFile = path.join(root, 'cwd');
    const result = await probeHarness(
      options('codex-auto-loge', wrapper, 'codex', {
        env: { ...process.env, PROBE_ARGS_FILE: argsFile, PROBE_CWD_FILE: cwdFile },
      }),
    );

    expect(result.up).toBe(true);
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('features.hooks=false');
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).not.toContain('--ignore-user-config');
    expect((await readFile(cwdFile, 'utf8')).trim()).not.toBe(root);
  });
});

describe('success cache', () => {
  test('coalesces probes, caches per wrapper for strictly less than 15 minutes, and records auditable timestamps', async () => {
    const { root, wrapper } = await fixture(
      'probe-wrapper',
      `printf 'x\\n' >> "$PROBE_COUNT_FILE"\nprintf '${HARNESS_PROBE_SENTINEL}\\n'`,
    );
    const countFile = path.join(root, 'count');
    const cachePath = path.join(root, 'cache', 'harness-probes.json');
    let nowMs = Date.parse('2026-07-30T20:00:00.000Z');
    const base = {
      wrapper,
      kind: 'codex' as const,
      cachePath,
      now: () => nowMs,
      env: { ...process.env, PROBE_COUNT_FILE: countFile },
    };

    const [first, concurrent] = await Promise.all([
      probeHarness({ ...base, binary: 'codex-auto-loge' }),
      probeHarness({ ...base, binary: 'codex-auto-loge' }),
    ]);
    expect(first.up).toBe(true);
    expect(concurrent.up).toBe(true);
    expect((await readFile(countFile, 'utf8')).trim().split('\n')).toHaveLength(1);

    nowMs += HARNESS_PROBE_SUCCESS_TTL_MS - 1;
    expect((await probeHarness({ ...base, binary: 'codex-auto-loge' })).cached).toBe(true);
    nowMs += 1;
    expect((await probeHarness({ ...base, binary: 'codex-auto-loge' })).cached).toBe(false);
    await probeHarness({ ...base, binary: 'codex-auto-atomi' });

    expect((await readFile(countFile, 'utf8')).trim().split('\n')).toHaveLength(3);
    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
      wrappers: Record<string, { lastSuccessAt: string }>;
    };
    expect(Object.keys(cache.wrappers).sort()).toEqual(['codex-auto-atomi', 'codex-auto-loge']);
    expect(cache.wrappers['codex-auto-loge']?.lastSuccessAt).toBe('2026-07-30T20:15:00.000Z');
  });

  test('never caches a 429/quota failure and preserves its structured reason', async () => {
    const { root, wrapper } = await fixture(
      'claude-auto-limited',
      `printf 'x\\n' >> "$PROBE_COUNT_FILE"\nprintf "You've hit your org's monthly spend limit\\n" >&2\nexit 1`,
    );
    const countFile = path.join(root, 'count');
    const cachePath = path.join(root, 'cache', 'harness-probes.json');
    const input = options('claude-auto-limited', wrapper, 'claude', {
      cachePath,
      env: { ...process.env, PROBE_COUNT_FILE: countFile },
    });

    const first = await probeHarness(input);
    const second = await probeHarness(input);
    expect(first.up).toBe(false);
    expect(first.failureKind).toBe('rate_limited');
    expect(first.error).toContain('monthly spend limit');
    expect(second.cached).toBe(false);
    expect((await readFile(countFile, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(await readFile(cachePath, 'utf8').catch(() => '')).not.toContain('claude-auto-limited');
  });

  test('rejects wrong output and timeouts when no exact reply arrives', async () => {
    const wrong = await fixture('codex-auto-wrong', `printf 'banner\\n${HARNESS_PROBE_SENTINEL}\\n'`);
    const slow = await fixture(
      'codex-auto-slow',
      'sleep 10 & child=$!\nprintf \'%s\\n\' "$child" > "$CHILD_PID_FILE"\nwait "$child"',
    );
    const childPidFile = path.join(slow.root, 'child-pid');

    const wrongResult = await probeHarness(options('codex-auto-wrong', wrong.wrapper, 'codex'));
    const timeoutResult = await probeHarness(
      options('codex-auto-slow', slow.wrapper, 'codex', {
        timeoutMs: 100,
        env: { ...process.env, CHILD_PID_FILE: childPidFile },
      }),
    );
    expect(wrongResult.failureKind).toBe('unexpected_reply');
    expect(wrongResult.error).toContain('expected exact reply');
    expect(timeoutResult.failureKind).toBe('timeout');
    expect(timeoutResult.ms).toBeLessThan(1_000);
    if (process.platform !== 'win32') {
      const childPid = Number((await readFile(childPidFile, 'utf8')).trim());
      expect(() => process.kill(childPid, 0)).toThrow();
    }
  });
});
