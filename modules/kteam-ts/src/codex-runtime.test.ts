import { describe, expect, test } from 'bun:test';
import {
  CodexRuntimeModelCatalogCache,
  codexPickerMatchesExpectation,
  driveCodexModelPicker,
  parseCodexModelListPage,
  parseCodexPickerScreen,
  parseCodexThreadSettingsAppliedLine,
  waitForCodexRuntimeObservation,
  waitForCodexThreadSettingsApplied,
  type CodexPickerPane,
  type CodexPickerTransport,
} from './codex-runtime';

describe('Codex app-server model catalog', () => {
  test('preserves authoritative model and effort order while filtering hidden rows', () => {
    expect(
      parseCodexModelListPage({
        id: 2,
        result: {
          data: [
            {
              id: 'sol',
              model: 'gpt-5.6-sol',
              displayName: 'GPT-5.6 Sol',
              description: 'Frontier',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'ultra', description: 'Delegates' },
              ],
            },
            { id: 'internal-only', displayName: 'Missing thread-setting value', hidden: false },
            { id: 'review', model: 'codex-auto-review', hidden: true },
          ],
          nextCursor: 'next-page',
        },
      }),
    ).toEqual({
      choices: [
        {
          value: 'gpt-5.6-sol',
          label: 'GPT-5.6 Sol',
          description: 'Frontier',
          isDefault: true,
          reasoningEfforts: [
            { value: 'medium', description: 'Balanced' },
            { value: 'ultra', description: 'Delegates' },
          ],
          defaultReasoningEffort: 'medium',
        },
      ],
      nextCursor: 'next-page',
    });
  });

  test('coalesces probes, honours the five-minute-style TTL, and never caches failures', async () => {
    let now = 10;
    let calls = 0;
    const cache = new CodexRuntimeModelCatalogCache(
      async () => {
        calls++;
        if (calls === 1) throw new Error('temporary');
        return [{ value: 'm', label: 'M', reasoningEfforts: [{ value: 'high' }] }];
      },
      100,
      () => now,
    );
    await expect(cache.get('/wrapper', '/repo')).rejects.toThrow('temporary');
    const [left, right] = await Promise.all([cache.get('/wrapper', '/repo'), cache.get('/wrapper', '/repo')]);
    expect(left).toBe(right);
    expect(calls).toBe(2);
    now = 109;
    expect(await cache.get('/wrapper', '/repo')).toBe(left);
    now = 111;
    await cache.get('/wrapper', '/repo');
    expect(calls).toBe(3);
  });
});

describe('screen-verified Codex picker driving', () => {
  const pane = (visiblePane: string, promptReady = false): CodexPickerPane => ({
    alive: true,
    dead: false,
    promptReady,
    visiblePane,
  });

  class ScriptedPicker implements CodexPickerTransport {
    readonly keys: string[] = [];
    private index = 0;
    constructor(
      private readonly frames: CodexPickerPane[],
      private readonly openResult: 'handled-local' | 'turn-started' = 'handled-local',
    ) {}
    async openPicker() {
      return this.openResult;
    }
    async readPane() {
      return this.frames[Math.min(this.index++, this.frames.length - 1)]!;
    }
    async sendKey(key: string) {
      this.keys.push(key);
    }
  }

  test('parses rows only below the active picker title and strips markers and description columns', () => {
    expect(
      parseCodexPickerScreen(
        [
          'old transcript',
          '  8. not-a-row',
          'Select Model and Effort',
          '› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.',
          '  2. gpt-5.5 (default)  Frontier model for complex work.',
        ].join('\n'),
      ),
    ).toEqual({
      kind: 'all-models',
      title: 'Select Model and Effort',
      rows: [
        { number: 1, name: 'gpt-5.6-sol' },
        { number: 2, name: 'gpt-5.5' },
      ],
    });
  });

  test('revalidation rejects a changed screen, row, or stale picker above an idle prompt', () => {
    const expected = {
      kind: 'all-models' as const,
      title: 'Select Model and Effort',
      row: { number: 2, name: 'gpt-5.5' },
    };
    expect(
      codexPickerMatchesExpectation(
        ['Select Model and Effort', '  1. gpt-5.6-sol', '› 2. gpt-5.5  Frontier model'].join('\n'),
        expected,
      ),
    ).toBe(true);
    expect(codexPickerMatchesExpectation(['Select Model and Effort', '› 2. gpt-5.2'].join('\n'), expected)).toBe(false);
    expect(
      codexPickerMatchesExpectation(['Select Model and Effort', '› 2. gpt-5.5', '› Ask Codex'].join('\n'), expected),
    ).toBe(false);
  });

  test('selects exact visible model and effort rows without arrows or Enter', async () => {
    const picker = new ScriptedPicker([
      pane(['Select Model and Effort', '  1. gpt-5.6-sol (current)', '› 2. gpt-5.5'].join('\n')),
      pane(['Select Reasoning Level for gpt-5.5', '  1. Low', '› 2. Medium (default)', '  3. High'].join('\n')),
      pane('› ', true),
    ]);
    await driveCodexModelPicker(picker, { model: 'gpt-5.5', effort: 'high' }, { pollMs: 0 });
    expect(picker.keys).toEqual(['2', '3']);
  });

  test('never treats picker-looking scrollback at an idle prompt as the live selector', async () => {
    const picker = new ScriptedPicker([
      pane(['Select Model and Effort', '  1. stale-model'].join('\n'), true),
      pane(['Select Model and Effort', '  1. gpt-5.5'].join('\n')),
      pane(['Select Reasoning Level for gpt-5.5', '  1. High'].join('\n')),
      pane('› ', true),
    ]);
    await driveCodexModelPicker(picker, { model: 'gpt-5.5', effort: 'high' }, { pollMs: 0 });
    expect(picker.keys).toEqual(['1', '1']);
  });

  test('refuses to send picker shortcuts when /model was consumed as a turn', async () => {
    const picker = new ScriptedPicker([pane(['Select Model and Effort', '  1. gpt-5.5'].join('\n'))], 'turn-started');
    await expect(driveCodexModelPicker(picker, { model: 'gpt-5.5', effort: 'high' }, { pollMs: 0 })).rejects.toThrow(
      'instead of opening its native picker',
    );
    expect(picker.keys).toEqual([]);
  });

  test('drives the explicit advanced and Plan-scope stages by their verified row labels', async () => {
    const picker = new ScriptedPicker([
      pane(['Select Model', '  1. codex-auto-fast', '› 2. All models'].join('\n')),
      pane(['Select Model and Effort', '› 1. gpt-5.6-sol'].join('\n')),
      pane(['Select Reasoning Level for gpt-5.6-sol', '  1. Low', '› 2. More reasoning…'].join('\n')),
      pane(['Advanced Reasoning', '  1. Max', '› 2. Ultra'].join('\n')),
      pane(
        [
          'Apply reasoning change',
          '  1. Apply to Plan mode override',
          '› 2. Apply to global default and Plan mode override',
        ].join('\n'),
      ),
    ]);
    await driveCodexModelPicker(picker, { model: 'gpt-5.6-sol', effort: 'ultra' }, { pollMs: 0 });
    expect(picker.keys).toEqual(['2', '1', '2', '2', '2']);
  });

  test('fails visibly instead of guessing when the named row is absent or beyond digit addressing', async () => {
    const missing = new ScriptedPicker([pane(['Select Model and Effort', '  1. gpt-5.5'].join('\n'))]);
    await expect(
      driveCodexModelPicker(missing, { model: 'gpt-5.6-sol', effort: 'high' }, { pollMs: 0, timeoutMs: 5 }),
    ).rejects.toThrow('did not advertise gpt-5.6-sol');

    const tenth = new ScriptedPicker([pane(['Select Model and Effort', '  10. gpt-future'].join('\n'))]);
    await expect(
      driveCodexModelPicker(tenth, { model: 'gpt-future', effort: 'high' }, { pollMs: 0, timeoutMs: 5 }),
    ).rejects.toThrow('not safely addressable');
    expect(tenth.keys).toEqual([]);
  });
});

describe('Codex runtime observation', () => {
  test('attributes confirmation only to the raw post-input thread_settings_applied record', async () => {
    const applied = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.5', reasoning_effort: 'high' },
      },
    });
    expect(parseCodexThreadSettingsAppliedLine(applied)).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(
      parseCodexThreadSettingsAppliedLine(
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high' } }),
      ),
    ).toBeUndefined();

    let appended = '';
    let sleeps = 0;
    const confirmed = await waitForCodexThreadSettingsApplied(
      async () => appended,
      { model: 'gpt-5.5', effort: 'high' },
      {
        pollMs: 0,
        sleep: async () => {
          sleeps++;
          appended = `${applied}\n`;
        },
      },
    );
    expect(confirmed).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(sleeps).toBe(1);
  });

  test('fails immediately when the raw applied record conflicts with the requested target', async () => {
    await expect(
      waitForCodexThreadSettingsApplied(
        async () =>
          `${JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'thread_settings_applied',
              thread_settings: { model: 'gpt-5.2', reasoning_effort: 'medium' },
            },
          })}\n`,
        { model: 'gpt-5.5', effort: 'high' },
        { pollMs: 0 },
      ),
    ).rejects.toThrow('reported gpt-5.2 · medium instead of gpt-5.5 · high');
  });

  test('requires a fresh exact thread-settings observation, including for same-value confirmation', async () => {
    const states = [
      { observedModel: 'gpt-5.5', observedReasoningEffort: 'high', observedModelAt: 'before', transcriptOffset: 100 },
      { observedModel: 'gpt-5.5', observedReasoningEffort: 'high', observedModelAt: 'after', transcriptOffset: 120 },
    ];
    const confirmed = await waitForCodexRuntimeObservation(
      async () => states.shift()!,
      'before',
      { model: 'gpt-5.5', effort: 'high' },
      { pollMs: 0, afterTranscriptOffset: 100 },
    );
    expect(confirmed.observedModelAt).toBe('after');
  });

  test('fails immediately on a fresh conflicting runtime-settings observation', async () => {
    let reads = 0;
    await expect(
      waitForCodexRuntimeObservation(
        async () => {
          reads++;
          return {
            observedModel: 'gpt-5.2',
            observedReasoningEffort: 'medium',
            observedModelAt: 'after',
            transcriptOffset: 120,
          };
        },
        'before',
        { model: 'gpt-5.5', effort: 'high' },
        { pollMs: 0, afterTranscriptOffset: 100 },
      ),
    ).rejects.toThrow('reported gpt-5.2 · medium instead of gpt-5.5 · high');
    expect(reads).toBe(1);
  });

  test('names the requested and last-observed settings on timeout', async () => {
    await expect(
      waitForCodexRuntimeObservation(
        async () => ({ observedModel: 'gpt-5.5', observedReasoningEffort: 'low', observedModelAt: 'before' }),
        'before',
        { model: 'gpt-5.6-sol', effort: 'high' },
        { timeoutMs: 2, pollMs: 0 },
      ),
    ).rejects.toThrow('gpt-5.6-sol · high within 0s (last observed: gpt-5.5 · low)');
  });
});
