import { describe, expect, test } from 'bun:test';
import type { SessionView } from './service';
import {
  buildStopPlan,
  confirmationPhrase,
  executeStopSweep,
  inheritStopReason,
  renderStopPlan,
  renderStopSweep,
  runBulkStop,
  type BulkStopIo,
} from './stop-cli';

describe('inheritStopReason', () => {
  test('preserves a reason consumed before the named mode and lets the mode-local value win', () => {
    expect(inheritStopReason({ dryRun: true }, 'written before cascade')).toEqual({
      dryRun: true,
      reason: 'written before cascade',
    });
    expect(inheritStopReason({ reason: 'written after the id' }, 'parent value')).toEqual({
      reason: 'written after the id',
    });
  });
});

function session(
  id: string,
  options: { parent?: string; label?: string; teammate?: string; name?: string; status?: string } = {},
): SessionView {
  return {
    config: {
      id,
      name: options.name ?? `Task ${id}`,
      teammate: options.teammate,
      label: options.label,
      parent: options.parent,
      binary: 'codex-auto-loge',
      harness: 'codex',
      modelHint: 'gpt-5.6-sol',
      mode: 'auto',
      cwd: '/repo',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      turn: 1,
      harnessSessionId: id,
      systemPromptFile: `/sessions/${id}/system-prompt.md`,
      originalPromptFile: `/sessions/${id}/original-prompt.md`,
      tmuxSession: id,
      watcherSession: `${id}-watcher`,
      intervalSeconds: 30,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 20,
    },
    state: { id, status: (options.status ?? 'running') as never, turn: 1 },
    directory: `/sessions/${id}`,
  };
}

describe('buildStopPlan', () => {
  test('cascade walks every generation parent-first while children excludes only the root', () => {
    const fleet = [session('root'), session('child', { parent: 'root' }), session('grandchild', { parent: 'child' })];
    const cascade = buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' });
    const children = buildStopPlan(fleet, { kind: 'children', rootId: 'root' });

    expect(cascade.targets.map(target => target.id)).toEqual(['root', 'child', 'grandchild']);
    expect(children.targets.map(target => target.id)).toEqual(['child', 'grandchild']);
  });

  test('orphan stops only the root and foregrounds every live descendant left running', () => {
    const fleet = [
      session('root', { teammate: 'lead' }),
      session('child', { parent: 'root', teammate: 'worker' }),
      session('grandchild', { parent: 'child', teammate: 'reviewer' }),
      session('done', { parent: 'root', status: 'completed' }),
    ];
    const orphan = buildStopPlan(fleet, { kind: 'orphan', rootId: 'root' });

    expect(orphan.targets.map(target => target.id)).toEqual(['root']);
    expect(orphan.leftRunning.map(target => target.id)).toEqual(['child', 'grandchild']);
    expect(renderStopPlan(orphan)).toContain('Will leave 2 live descendants running without this parent');
    expect(renderStopPlan(orphan)).toContain('reviewer — Task grandchild (grandchild)');
    expect(confirmationPhrase(orphan)).toBe('stop 1 leaving 2');

    const alone = buildStopPlan([session('alone')], { kind: 'orphan', rootId: 'alone' });
    expect(renderStopPlan(alone)).toContain('No live descendants will be orphaned.');
    expect(confirmationPhrase(alone)).toBe('stop 1');
  });

  test('a malformed parent cycle terminates and selects each session once', () => {
    const fleet = [
      session('root', { parent: 'grandchild' }),
      session('child', { parent: 'root' }),
      session('grandchild', { parent: 'child' }),
    ];

    expect(buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' }).targets.map(target => target.id)).toEqual([
      'root',
      'child',
      'grandchild',
    ]);
    expect(buildStopPlan(fleet, { kind: 'children', rootId: 'root' }).targets.map(target => target.id)).toEqual([
      'child',
      'grandchild',
    ]);
  });

  test('label selection is exact and remains distinct from the lineage subtree', () => {
    const fleet = [
      session('root', { label: 'batch-a' }),
      session('child-other-label', { parent: 'root', label: 'batch-b' }),
      session('unrelated-same-label', { label: 'batch-a' }),
      session('prefix-only', { label: 'batch-a-extra' }),
    ];

    expect(buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' }).targets.map(target => target.id)).toEqual([
      'root',
      'child-other-label',
    ]);
    expect(
      buildStopPlan(fleet, { kind: 'label', label: 'batch-a' })
        .targets.map(target => target.id)
        .sort(),
    ).toEqual(['root', 'unrelated-same-label']);
  });

  test('terminal sessions are omitted but kill_failed remains eligible for a retry', () => {
    const fleet = [
      session('completed', { label: 'batch', status: 'completed' }),
      session('failed', { label: 'batch', status: 'failed' }),
      session('kill-failed', { label: 'batch', status: 'kill_failed' }),
    ];
    expect(buildStopPlan(fleet, { kind: 'label', label: 'batch' }).targets.map(target => target.id)).toEqual([
      'kill-failed',
    ]);
  });

  test('the caller is visibly excluded by default and its lead chain is flagged', () => {
    const fleet = [
      session('lead', { label: 'batch', teammate: 'zelda' }),
      session('parent', { parent: 'lead', label: 'batch', teammate: 'mira' }),
      session('caller', { parent: 'parent', label: 'batch', teammate: 'ambrosia' }),
    ];
    const safe = buildStopPlan(fleet, { kind: 'label', label: 'batch' }, { callerId: 'caller' });
    expect(safe.excluded.map(target => target.id)).toEqual(['caller']);
    expect(safe.targets.map(target => [target.id, target.callerAncestor])).toEqual([
      ['lead', true],
      ['parent', true],
    ]);
    expect(confirmationPhrase(safe)).toBe('stop 2 including lead');
    expect(renderStopPlan(safe)).toContain('Excluded for caller safety');
    expect(renderStopPlan(safe)).toContain('CALLER ANCESTOR / POSSIBLE LEAD');

    const explicit = buildStopPlan(
      fleet,
      { kind: 'label', label: 'batch' },
      { callerId: 'caller', includeCaller: true },
    );
    expect(explicit.targets.at(-1)?.id).toBe('caller');
    expect(confirmationPhrase(explicit)).toBe('stop 3 including caller and lead');
  });
});

describe('executeStopSweep', () => {
  test('propagates one reason, reports every outcome, and catches a child spawned during the sweep', async () => {
    const initial = [session('root'), session('child', { parent: 'root', teammate: 'kid' })];
    const plan = buildStopPlan(initial, { kind: 'cascade', rootId: 'root' });
    const calls: Array<[string, string]> = [];
    const result = await executeStopSweep(plan, 'closing the review batch', {
      stop: async (id, reason) => {
        calls.push([id, reason]);
        if (id === 'child') throw new Error('pane refused to exit');
        return session(id, { status: 'stopped' });
      },
      list: async () => [...initial, session('late-grandchild', { parent: 'child', teammate: 'late' })],
    });

    expect(calls).toEqual([
      ['root', 'closing the review batch'],
      ['child', 'closing the review batch'],
    ]);
    expect(result.outcomes.map(outcome => [outcome.target.id, outcome.ok])).toEqual([
      ['root', true],
      ['child', false],
    ]);
    expect(result.appeared.map(target => target.id)).toEqual(['late-grandchild']);
    const output = renderStopSweep(result);
    expect(output).toContain('FAILED kid');
    expect(output).toContain('appeared after confirmation and was NOT stopped');
  });

  test('orphan re-scan reports a descendant that appeared after confirmation without stopping it', async () => {
    const initial = [session('root'), session('child', { parent: 'root', teammate: 'worker' })];
    const plan = buildStopPlan(initial, { kind: 'orphan', rootId: 'root' });
    const result = await executeStopSweep(plan, 'orphaning root', {
      stop: async () => session('root', { status: 'stopped' }),
      list: async () => [
        session('root', { status: 'stopped' }),
        session('child', { parent: 'root', teammate: 'worker' }),
        session('late', { parent: 'child', teammate: 'auditor' }),
      ],
    });

    expect(result.appeared).toEqual([]);
    expect(result.leftRunning.map(target => target.id)).toEqual(['child', 'late']);
    expect(result.appearedLeftRunning.map(target => target.id)).toEqual(['late']);
    expect(renderStopSweep(result)).toContain('auditor — Task late (late)');
    expect(renderStopSweep(result)).toContain('intentionally NOT stopped');
  });

  test('a failed post-pass list is explicit rather than pretending the race check passed', async () => {
    const fleet = [session('root')];
    const result = await executeStopSweep(buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' }), 'reason', {
      stop: async () => session('root', { status: 'stopped' }),
      list: async () => {
        throw new Error('daemon unavailable');
      },
    });
    expect(result.raceCheckError).toBe('daemon unavailable');
    expect(renderStopSweep(result)).toContain('RACE CHECK FAILED');
  });
});

function captureIo(interactive = false, answer = ''): { io: BulkStopIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: text => out.push(text),
      stderr: text => err.push(text),
      isInteractive: interactive,
      confirm: async () => answer,
    },
  };
}

describe('runBulkStop', () => {
  test('dry-run lists exact names and count without confirmation or mutation', async () => {
    const fleet = [
      session('root', { teammate: 'zelda', name: 'Lead' }),
      session('child', { parent: 'root', teammate: 'mira' }),
    ];
    const capture = captureIo();
    let stopCalls = 0;
    const result = await runBulkStop(
      { kind: 'cascade', rootId: 'zelda' },
      { dryRun: true },
      {
        get: async () => fleet[0]!,
        list: async () => fleet,
        stop: async () => {
          stopCalls += 1;
          return fleet[0]!;
        },
        io: capture.io,
      },
      'outside-this-tree',
    );

    expect(result.exitCode).toBe(0);
    expect(stopCalls).toBe(0);
    expect(capture.out.join('')).toContain('Will stop 2 sessions');
    expect(capture.out.join('')).toContain('zelda — Lead (root)');
    expect(capture.out.join('')).toContain('mira — Task child (child)');
    expect(capture.out.join('')).toContain('Dry run');
  });

  test('non-interactive mutation refuses unless --yes follows the printed plan', async () => {
    const root = session('root', { teammate: 'zelda' });
    const capture = captureIo(false);
    let stopped = false;
    const result = await runBulkStop(
      { kind: 'cascade', rootId: 'root' },
      {},
      {
        get: async () => root,
        list: async () => [root],
        stop: async () => {
          stopped = true;
          return root;
        },
        io: capture.io,
      },
      'someone-else',
    );

    expect(result.exitCode).toBe(1);
    expect(stopped).toBe(false);
    expect(capture.out.join('')).toContain('Will stop 1 session');
    expect(capture.err.join('')).toContain('Refusing an unconfirmed bulk stop');
  });

  test('typed confirmation must match the caller-aware phrase exactly', async () => {
    const root = session('root', { parent: 'lead', label: 'batch' });
    const lead = session('lead', { label: 'batch' });
    const capture = captureIo(true, 'stop 2');
    let stopped = 0;
    const result = await runBulkStop(
      { kind: 'label', label: 'batch' },
      {},
      {
        get: async () => root,
        list: async () => [lead, root],
        stop: async id => {
          stopped += 1;
          return session(id, { status: 'stopped' });
        },
        io: capture.io,
      },
      'root',
    );
    expect(result.confirmed).toBe(false);
    expect(stopped).toBe(0);
    expect(capture.err.join('')).toContain('Confirmation did not match');
  });
});
