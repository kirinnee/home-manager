import { describe, expect, test } from 'bun:test';
import {
  assembleInflightReport,
  buildInflightReport,
  classifyCommand,
  classifyToolName,
  collectProcessInventory,
  descendantsOf,
  gateInflight,
  handoffMessage,
  joinOpenTools,
  parseProcessTable,
  renderInflightCli,
  renderInflightReport,
  renderMigrationOutcome,
  summarizeToolInput,
  worstVerdict,
  type InflightReport,
  type ProcessInfo,
  type OpenToolInfo,
} from './migrate-preflight';
import type { SessionState } from './types';

describe('classifyCommand — the pattern table (design §4, test 1)', () => {
  test('safe_to_kill: read-only / ephemeral commands', () => {
    for (const command of [
      'rg foo',
      'grep -r x .',
      'fd . src',
      'ls -la',
      'cat file',
      'jq . data.json',
      'tail -f log',
      'sleep 420',
    ])
      expect(classifyCommand(command)).toBe('safe_to_kill');
  });

  test('re_armable: idempotent test / build / lint commands', () => {
    for (const command of [
      'tsc --noEmit',
      'eslint .',
      'jest',
      'vitest run',
      'pytest -q',
      'make build',
      'cargo build',
      'go test ./...',
      'npm test',
      'bun run build',
    ])
      expect(classifyCommand(command)).toBe('re_armable');
  });

  test('destructive_to_interrupt: state-mutating / non-idempotent commands', () => {
    for (const command of [
      'git commit -m wip',
      'git push origin main',
      'git rebase -i HEAD~3',
      'git merge feature',
      'npm install',
      'bun add left-pad',
      'pip install requests',
      'cargo install ripgrep',
      'nix build .#foo',
      'hms',
      'darwin-rebuild switch',
      'tofu apply',
      'terraform apply',
      'kubectl delete pod x',
      'helm upgrade r c',
      'sops -d secrets.yaml',
      'rsync -a a/ b/',
      'rm -rf build',
      'mv a b',
    ])
      expect(classifyCommand(command)).toBe('destructive_to_interrupt');
  });

  test('curl/wget classify by verb: mutating → destructive, plain GET → safe', () => {
    expect(classifyCommand('curl https://api/x')).toBe('safe_to_kill');
    expect(classifyCommand('curl -X POST https://api/x -d @body')).toBe('destructive_to_interrupt');
    expect(classifyCommand('curl --request DELETE https://api/x')).toBe('destructive_to_interrupt');
    expect(classifyCommand('wget https://host/file')).toBe('safe_to_kill');
  });

  test('read-only git subcommands stay safe', () => {
    expect(classifyCommand('git status')).toBe('safe_to_kill');
    expect(classifyCommand('git diff --stat')).toBe('safe_to_kill');
    expect(classifyCommand('git log --oneline -5')).toBe('safe_to_kill');
  });

  test('a git push buried in a pipeline is still destructive (test 1)', () => {
    expect(classifyCommand('echo done && git push')).toBe('destructive_to_interrupt');
    expect(classifyCommand('rg foo | tee out && git commit -am x')).toBe('destructive_to_interrupt');
  });

  test('worst segment wins: safe + re_armable → re_armable', () => {
    expect(classifyCommand('rg foo && npm test')).toBe('re_armable');
  });

  test('empty / garbled → unknown (test 1)', () => {
    expect(classifyCommand('')).toBe('unknown');
    expect(classifyCommand('   ')).toBe('unknown');
    expect(classifyCommand('|| ;')).toBe('unknown');
    expect(classifyCommand('some-never-seen-binary --go')).toBe('unknown');
    expect(classifyCommand('npm run frobnicate')).toBe('unknown'); // unrecognized run-script
  });

  test('npm run <script> classifies by the SCRIPT name', () => {
    expect(classifyCommand('npm run build')).toBe('re_armable');
    expect(classifyCommand('npm run deploy')).toBe('destructive_to_interrupt');
    expect(classifyCommand('pnpm run publish')).toBe('destructive_to_interrupt');
  });

  test('prefixes (sudo/env/timeout) are skipped to the real command', () => {
    expect(classifyCommand('sudo rm -rf /x')).toBe('destructive_to_interrupt');
    expect(classifyCommand('env FOO=1 rg pattern')).toBe('safe_to_kill');
    expect(classifyCommand('timeout 600 npm test')).toBe('re_armable');
    expect(classifyCommand('/usr/bin/git push')).toBe('destructive_to_interrupt');
  });
});

describe('classifyToolName — non-Bash tools by name', () => {
  test('read tools are safe', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'])
      expect(classifyToolName(name)).toBe('safe_to_kill');
  });
  test('file-writing tools are re_armable', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
      expect(classifyToolName(name)).toBe('re_armable');
  });
  test('an unrecognized tool is unknown', () => {
    expect(classifyToolName('SomeMcpTool')).toBe('unknown');
    expect(classifyToolName('Bash')).toBe('unknown');
  });
});

describe('worstVerdict ordering — unknown/destructive outrank the proceeders', () => {
  test('destructive is worst', () => {
    expect(worstVerdict(['safe_to_kill', 're_armable', 'destructive_to_interrupt', 'unknown'])).toBe(
      'destructive_to_interrupt',
    );
  });
  test('unknown beats re_armable and safe', () => {
    expect(worstVerdict(['safe_to_kill', 're_armable', 'unknown'])).toBe('unknown');
  });
  test('all-safe stays safe', () => {
    expect(worstVerdict(['safe_to_kill', 'safe_to_kill'])).toBe('safe_to_kill');
  });
});

describe('joinOpenTools — state.openTools ⋈ chat tail (test 2)', () => {
  const claudeChat = [
    {
      type: 'tool.use',
      timestamp: '2026-07-26T00:00:00Z',
      data: { toolUseId: 'call_00_uFqPH', name: 'Bash', input: { command: 'sleep 420', timeout: 600000 } },
    },
    { type: 'tool.use', data: { toolUseId: 'toolu_read', name: 'Read', input: { file_path: '/x/y.ts' } } },
    { type: 'assistant.text', data: { text: 'noise' } },
  ];

  test('claude id joins to full command + verdict', () => {
    const [tool] = joinOpenTools(['call_00_uFqPH'], claudeChat);
    expect(tool!.name).toBe('Bash');
    expect(tool!.summary).toBe('sleep 420');
    expect(tool!.verdict).toBe('safe_to_kill');
    expect(tool!.startedAt).toBe('2026-07-26T00:00:00Z');
  });

  test('a Bash git push open tool joins as destructive', () => {
    const chat = [{ type: 'tool.use', data: { toolUseId: 'x1', name: 'Bash', input: { command: 'git push' } } }];
    expect(joinOpenTools(['x1'], chat)[0]!.verdict).toBe('destructive_to_interrupt');
  });

  test('codex-shaped id joins the same way', () => {
    const codexChat = [
      { type: 'tool.use', data: { toolUseId: 'shell-42', name: 'Bash', input: { command: 'cargo install foo' } } },
    ];
    expect(joinOpenTools(['shell-42'], codexChat)[0]!.verdict).toBe('destructive_to_interrupt');
  });

  test('an open id NOT present in the chat tail → unknown (fail closed)', () => {
    const [tool] = joinOpenTools(['ghost'], claudeChat);
    expect(tool!.name).toBe('?');
    expect(tool!.verdict).toBe('unknown');
    expect(tool!.summary).toContain('not found');
  });
});

describe('summarizeToolInput', () => {
  test('prefers a Bash command, then file paths', () => {
    expect(summarizeToolInput('Bash', { command: 'ls' })).toBe('ls');
    expect(summarizeToolInput('Read', { file_path: '/a/b' })).toBe('/a/b');
    expect(summarizeToolInput('Grep', { pattern: 'foo' })).toBe('foo');
  });
});

describe('parseProcessTable + descendantsOf (test 2 — ps parsing)', () => {
  const ps = [
    '  100     1   999 /bin/harness',
    '  200   100   420 zsh',
    '  300   200   400 sleep 420',
    '  400     1    10 unrelated',
    'garbled line here',
  ].join('\n');

  test('parses pid/ppid/etimes/argv, skipping garbled lines', () => {
    const rows = parseProcessTable(ps);
    expect(rows.map(r => r.pid)).toEqual([100, 200, 300, 400]);
    expect(rows.find(r => r.pid === 300)!.startedSecondsAgo).toBe(400);
    expect(rows.find(r => r.pid === 300)!.argv).toBe('sleep 420');
  });

  test('descendantsOf excludes the root and unrelated trees', () => {
    const rows = parseProcessTable(ps);
    const kids = descendantsOf(100, rows)
      .map(r => r.pid)
      .sort();
    expect(kids).toEqual([200, 300]);
  });
});

describe('collectProcessInventory — pane-pid walk with injected shell', () => {
  const psOut = ['  100     1   999 -zsh', '  100   100   999 node harness', '  200   100   400 git commit -m x'].join(
    '\n',
  );
  // Fake `run`: tmux → pane pid 100; ps → the table; readlink → a cwd.
  const fakeRun = async (argv: string[]) => {
    if (argv[0] === 'tmux') return { code: 0, stdout: '100\n', stderr: '' };
    if (argv[0] === 'ps') return { code: 0, stdout: psOut, stderr: '' };
    if (argv[0] === 'readlink') return { code: 0, stdout: '/work/repo\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };

  test('classifies each descendant by argv and attaches cwd', async () => {
    const processes = await collectProcessInventory('sess', { run: fakeRun });
    const commit = processes.find(p => p.argv.startsWith('git commit'));
    expect(commit).toBeDefined();
    expect(commit!.verdict).toBe('destructive_to_interrupt');
    expect(commit!.cwd).toBe('/work/repo');
    expect(commit!.startedSecondsAgo).toBe(400);
  });

  test('returns [] when the pane pid cannot be resolved', async () => {
    const noPane = async (argv: string[]) =>
      argv[0] === 'tmux' ? { code: 1, stdout: '', stderr: 'no session' } : { code: 0, stdout: '', stderr: '' };
    expect(await collectProcessInventory('sess', { run: noPane })).toEqual([]);
  });
});

describe('assembleInflightReport + gateInflight (design §6, test 3)', () => {
  const tool = (verdict: OpenToolInfo['verdict']): OpenToolInfo => ({
    toolUseId: 't',
    name: 'Bash',
    summary: 'x',
    verdict,
  });
  const proc = (verdict: ProcessInfo['verdict']): ProcessInfo => ({ pid: 9, argv: 'x', verdict });

  test('empty session (idle, no tools, cold ledger) → proceed, no report', () => {
    const report = assembleInflightReport({
      status: 'awaiting_user',
      turn: 3,
      openTools: [],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    expect(report.empty).toBe(true);
    expect(gateInflight(report).proceed).toBe(true);
  });

  test('active status alone (running) is NOT empty', () => {
    const report = assembleInflightReport({
      status: 'tool_running',
      turn: 1,
      openTools: [],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    expect(report.empty).toBe(false);
  });

  test('only safe/re_armable → proceed (with a report)', () => {
    const report = assembleInflightReport({
      status: 'tool_running',
      turn: 1,
      openTools: [tool('safe_to_kill'), tool('re_armable')],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    expect(report.worstVerdict).toBe('re_armable');
    const decision = gateInflight(report);
    expect(decision.proceed).toBe(true);
    expect(decision.forced).toBe(false);
  });

  test('any destructive item → refuse by default', () => {
    const report = assembleInflightReport({
      status: 'tool_running',
      turn: 1,
      openTools: [tool('safe_to_kill'), tool('destructive_to_interrupt')],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    expect(report.worstVerdict).toBe('destructive_to_interrupt');
    expect(gateInflight(report).proceed).toBe(false);
  });

  test('any unknown item → refuse by default', () => {
    const report = assembleInflightReport({
      status: 'tool_running',
      turn: 1,
      openTools: [tool('unknown')],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    expect(gateInflight(report).proceed).toBe(false);
  });

  test('--force-inflight proceeds AND records the override', () => {
    const report = assembleInflightReport({
      status: 'tool_running',
      turn: 1,
      openTools: [tool('destructive_to_interrupt')],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    const decision = gateInflight(report, { force: true });
    expect(decision.proceed).toBe(true);
    expect(decision.forced).toBe(true);
  });

  test('codex background terminals with no tree match → N unknown, refuse (test 2)', () => {
    const report = assembleInflightReport({
      status: 'tool_running',
      turn: 1,
      openTools: [],
      processes: [],
      codexBackgroundTerminals: 2,
    });
    expect(report.discrepancy).toBe(2);
    expect(report.worstVerdict).toBe('unknown');
    expect(gateInflight(report).proceed).toBe(false);
  });

  test('a warm subprocess ledger makes an otherwise-quiet session non-empty', () => {
    const report = assembleInflightReport({
      status: 'awaiting_user',
      turn: 1,
      openTools: [],
      processes: [],
      codexBackgroundTerminals: 0,
      subprocessSince: '2026-07-26T00:00:00Z',
    });
    expect(report.empty).toBe(false);
  });
});

describe('rendering + handoff (test 3, 4)', () => {
  const report: InflightReport = {
    status: 'tool_running',
    turn: 4,
    empty: false,
    openTools: [{ toolUseId: 'x', name: 'Bash', summary: 'git push origin main', verdict: 'destructive_to_interrupt' }],
    processes: [
      {
        pid: 321,
        argv: 'git push origin main',
        startedSecondsAgo: 12,
        cwd: '/w/repo',
        verdict: 'destructive_to_interrupt',
      },
    ],
    codexBackgroundTerminals: 0,
    discrepancy: 0,
    worstVerdict: 'destructive_to_interrupt',
  };

  test('CLI table names the worst verdict and each item', () => {
    const text = renderInflightCli(report);
    expect(text).toContain('DESTRUCTIVE');
    expect(text).toContain('git push origin main');
    expect(text).toContain('pid 321');
  });

  test('markdown report carries the tables, per-class guidance, and force banner', () => {
    const md = renderInflightReport(report, {
      sessionId: 'sess',
      targetAgent: 'claude-auto-x',
      targetModel: 'opus',
      forced: true,
      at: '2026-07-26T00:00:00Z',
    });
    expect(md).toContain('# Migration in-flight report');
    expect(md).toContain('claude-auto-x');
    expect(md).toContain('FORCED');
    expect(md).toContain('Open harness tools');
    expect(md).toContain('VERIFY state first');
    expect(md).toContain('git push origin main');
  });

  test('handoff message names the report path', () => {
    expect(handoffMessage('/dir/migration-inflight.md')).toContain('/dir/migration-inflight.md');
    expect(handoffMessage('/dir/migration-inflight.md')).toContain('migrated');
  });

  test('the pre-API half states the target as REQUESTED and never claims the move happened', () => {
    const md = renderInflightReport(report, {
      sessionId: 'sess',
      targetAgent: 'claude-auto-x',
      targetModel: 'opus',
      forced: true,
      at: '2026-07-26T00:00:00Z',
    });
    // It is written BEFORE the daemon call, so this exact claim must be absent.
    expect(md).not.toContain('Migrated onto');
    expect(md).toContain('Migration requested onto');
    expect(md).toContain('PENDING');
    // …while still naming the target and carrying the forensic content.
    expect(md).toContain('claude-auto-x');
    expect(md).toContain('FORCED');
  });
});

describe('renderMigrationOutcome — the settled truth appended after the daemon call', () => {
  const base = {
    from: 'claude-auto-a',
    targetAgent: 'claude-auto-b',
    targetModel: 'opus',
    at: '2026-07-26T01:00:00Z',
  };

  test('success is clearly distinct and names the observed wrapper, model, and status', () => {
    const md = renderMigrationOutcome({
      ...base,
      ok: true,
      observed: { binary: 'claude-auto-b', model: 'opus', status: 'running' },
    });
    expect(md).toContain('MIGRATION SUCCEEDED');
    expect(md).not.toContain('MIGRATION FAILED');
    expect(md).not.toContain('UNKNOWN');
    expect(md).toContain('claude-auto-b');
    expect(md).toContain('`opus`');
    expect(md).toContain('`running`');
  });

  test('failure carries the error detail and the observed restored wrapper + status', () => {
    const md = renderMigrationOutcome({
      ...base,
      ok: false,
      detail: 'migration to claude-auto-b failed: pane never became ready',
      observed: { binary: 'claude-auto-a', model: 'glm-5.2', status: 'failed' },
    });
    expect(md).toContain('MIGRATION FAILED');
    expect(md).not.toContain('MIGRATION SUCCEEDED');
    expect(md).toContain('did NOT complete');
    expect(md).toContain('pane never became ready');
    expect(md).toContain('claude-auto-a');
    expect(md).toContain('the ORIGINAL account; the session did not move');
    expect(md).toContain('`failed`');
  });

  test('a failure still staged on the target reports an INCOMPLETE rollback, not a restore', () => {
    const md = renderMigrationOutcome({
      ...base,
      ok: false,
      detail: 'daemon died mid-migrate',
      observed: { binary: 'claude-auto-b', status: 'kill_failed' },
    });
    expect(md).toContain('the rollback did not complete');
    expect(md).toContain('`kill_failed`');
    expect(md).not.toContain('the session did not move');
  });

  test('a daemon-side refusal that never moved the session is reported truthfully', () => {
    const md = renderMigrationOutcome({
      ...base,
      ok: false,
      detail: 'refusing context-window downgrade from claude-opus-5[1m] (1000000 tokens)',
      observed: { binary: 'claude-auto-a', model: 'claude-opus-5[1m]', status: 'rate_limited' },
    });
    expect(md).toContain('refusing context-window downgrade');
    expect(md).toContain('the session did not move');
    expect(md).toContain('`rate_limited`');
    expect(md).not.toContain('rollback did not complete');
  });

  test('an unfetchable post-failure state stays explicitly UNKNOWN and claims no rollback', () => {
    const md = renderMigrationOutcome({ ...base, ok: false, detail: 'socket hang up' });
    expect(md).toContain('MIGRATION FAILED');
    expect(md).toContain('socket hang up');
    expect(md).toContain('**UNKNOWN**');
    expect(md).toContain('NOT confirmed');
    // Never assert a restore the CLI could not observe.
    expect(md).not.toContain('the session did not move');
    expect(md).not.toContain('Session now on:');
  });

  test('a missing error detail still renders a failure rather than an empty line', () => {
    const md = renderMigrationOutcome({ ...base, ok: false, observed: { status: 'failed' } });
    expect(md).toContain('Error: no detail reported');
    expect(md).toContain('the daemon reported no wrapper');
  });
});

describe('buildInflightReport — orchestration with injected deps', () => {
  const state = (extra: Partial<SessionState>): SessionState => ({
    id: 's',
    status: 'tool_running',
    turn: 2,
    ...extra,
  });

  test('joins openTools via fetchChat and the local process walk', async () => {
    const view = {
      state: state({ openTools: ['call_1'] }),
      config: { harness: 'claude', tmuxSession: 'sess' },
    };
    const report = await buildInflightReport(view, {
      fetchChat: async () => [
        { type: 'tool.use', data: { toolUseId: 'call_1', name: 'Bash', input: { command: 'git commit -m x' } } },
      ],
      run: async (argv: string[]) => {
        if (argv[0] === 'tmux') return { code: 0, stdout: '500\n', stderr: '' };
        if (argv[0] === 'ps') return { code: 0, stdout: '  600   500   30 rm -rf dist', stderr: '' };
        return { code: 1, stdout: '', stderr: '' };
      },
      readCwd: async () => undefined,
    });
    expect(report.openTools[0]!.verdict).toBe('destructive_to_interrupt');
    expect(report.processes[0]!.verdict).toBe('destructive_to_interrupt');
    expect(report.worstVerdict).toBe('destructive_to_interrupt');
    expect(report.empty).toBe(false);
  });

  test('does not fetch chat when there are no open tools; codex footer counts', async () => {
    let chatCalls = 0;
    const view = {
      state: state({ status: 'tool_running', openTools: [] }),
      config: { harness: 'codex', tmuxSession: 'sess' },
    };
    const report = await buildInflightReport(view, {
      fetchChat: async () => {
        chatCalls++;
        return [];
      },
      fetchSnapshot: async () => 'foo\n1 background terminal running\nbar',
      run: async (argv: string[]) =>
        argv[0] === 'tmux' ? { code: 1, stdout: '', stderr: 'x' } : { code: 0, stdout: '', stderr: '' },
    });
    expect(chatCalls).toBe(0);
    expect(report.codexBackgroundTerminals).toBe(1);
    expect(report.worstVerdict).toBe('unknown');
  });
});
