import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CodexObservedInputAdapter,
  CodexTranscriptParseError,
  normalizeCodexTranscriptRecord,
  parseCodexTranscriptLine,
  startCodexTranscriptWatcher,
  type CodexNormalizedEvent,
  type CodexTranscriptWatcher,
} from './codex-transcript';
import type { TranscriptCursor, TranscriptWatchBackend } from './claude-transcript';
import { CODEX_INPUT_SHAPE_VERSION } from './observed-human-input';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const temporaryDirectories: string[] = [];
const runningWatchers: CodexTranscriptWatcher[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kteam-codex-transcript-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(runningWatchers.splice(0).map(watcher => watcher.stop()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await Bun.sleep(10);
  }
}

function record(payload: Record<string, unknown>, type = 'response_item'): Record<string, unknown> {
  return { timestamp: '2026-01-02T03:04:05.000Z', type, payload };
}

function userRecord(text: string): Record<string, unknown> {
  return record({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}

const jsonl = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe('Codex transcript normalization', () => {
  test('normalizes the real canonical compacted record into the system-text channel', async () => {
    const line = await Bun.file(path.join(import.meta.dir, 'fixtures', 'codex-compaction-real.jsonl')).text();
    const events = parseCodexTranscriptLine(line.trim());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat.user',
      source: 'codex',
      timestamp: '2026-07-19T11:29:21.473Z',
      recordType: 'compacted',
    });
    expect((events[0]!.data as { text: string }).text).toMatch(
      /^Another language model started to solve this problem and produced a summary/,
    );
  });

  test('normalizes canonical chat, readable reasoning, and common tool records', () => {
    expect(
      normalizeCodexTranscriptRecord(userRecord('Fixture user prompt.'), { sessionId: SESSION_ID })[0],
    ).toMatchObject({
      type: 'chat.user',
      source: 'codex',
      sessionId: SESSION_ID,
      data: { text: 'Fixture user prompt.' },
    });

    const assistant = normalizeCodexTranscriptRecord(
      record({
        type: 'message',
        id: 'msg_fixture',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Fixture assistant response.' }],
      }),
    );
    expect(assistant[0]).toMatchObject({
      type: 'chat.assistant.text',
      itemId: 'msg_fixture',
      phase: 'commentary',
      data: { text: 'Fixture assistant response.' },
    });

    expect(
      normalizeCodexTranscriptRecord(
        record({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Inspect the fixture.' }],
        }),
      )[0],
    ).toMatchObject({
      type: 'chat.assistant.reasoning',
      data: { reasoning: 'Inspect the fixture.' },
    });
    expect(
      normalizeCodexTranscriptRecord(
        record({ type: 'agent_reasoning', text: 'Legacy readable reasoning.' }, 'event_msg'),
      )[0],
    ).toMatchObject({ type: 'chat.assistant.reasoning', data: { reasoning: 'Legacy readable reasoning.' } });
    expect(
      normalizeCodexTranscriptRecord(
        record(
          {
            type: 'task_started',
            turn_id: 'turn-fixture',
          },
          'event_msg',
        ),
      )[0],
    ).toMatchObject({ type: 'turn.started', data: { turnId: 'turn-fixture' } });
    expect(
      normalizeCodexTranscriptRecord(
        record(
          {
            type: 'task_complete',
            turn_id: 'turn-fixture',
          },
          'event_msg',
        ),
      )[0],
    ).toMatchObject({ type: 'turn.completed', data: { turnId: 'turn-fixture' } });

    expect(
      normalizeCodexTranscriptRecord(
        record({
          type: 'function_call',
          call_id: 'call_shell',
          name: 'exec_command',
          arguments: '{"cmd":"true"}',
        }),
      )[0],
    ).toMatchObject({
      type: 'tool.use',
      data: { toolUseId: 'call_shell', name: 'exec_command', input: { cmd: 'true' } },
    });
    expect(
      normalizeCodexTranscriptRecord(
        record({
          type: 'function_call',
          call_id: 'call_question',
          name: 'request_user_input',
          arguments: JSON.stringify({
            questions: [
              {
                header: 'Framework',
                question: 'Which framework?',
                options: [{ label: 'React', description: 'Use React' }],
                multi_select: false,
              },
            ],
          }),
        }),
      ),
    ).toMatchObject([
      { type: 'tool.use', data: { toolUseId: 'call_question', name: 'request_user_input' } },
      {
        type: 'interaction.question',
        data: { toolUseId: 'call_question', questions: [{ question: 'Which framework?', header: 'Framework' }] },
      },
    ]);
    expect(
      normalizeCodexTranscriptRecord(
        record({
          type: 'custom_tool_call',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: '*** Begin Patch',
        }),
      )[0],
    ).toMatchObject({
      type: 'tool.use',
      data: { toolUseId: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' },
    });
    expect(
      normalizeCodexTranscriptRecord(
        record({
          type: 'function_call_output',
          call_id: 'call_shell',
          output: 'done',
        }),
      )[0],
    ).toMatchObject({
      type: 'tool.result',
      data: { toolUseId: 'call_shell', content: 'done', text: 'done', isError: false },
    });
    expect(
      normalizeCodexTranscriptRecord(
        record({
          type: 'tool_search_output',
          call_id: 'call_search',
          tools: [{ name: 'fixture' }],
          status: 'failed',
        }),
      )[0],
    ).toMatchObject({
      type: 'tool.result',
      data: { toolUseId: 'call_search', content: [{ name: 'fixture' }], isError: true },
    });
  });

  test('ignores mirrored event messages and optionally emits metadata-only diagnostics', () => {
    expect(
      normalizeCodexTranscriptRecord(
        record(
          {
            type: 'agent_message',
            message: 'Mirrored assistant message.',
            phase: 'final_answer',
          },
          'event_msg',
        ),
      ),
    ).toEqual([]);
    expect(
      normalizeCodexTranscriptRecord(record({ type: 'token_count', info: { secret: 'not retained' } }, 'event_msg')),
    ).toEqual([]);
    expect(
      normalizeCodexTranscriptRecord(record({ type: 'token_count', info: { secret: 'not retained' } }, 'event_msg'), {
        includeDiagnostics: true,
      })[0],
    ).toEqual({
      source: 'codex',
      timestamp: '2026-01-02T03:04:05.000Z',
      sessionId: undefined,
      recordType: 'event_msg',
      itemType: 'token_count',
      itemId: undefined,
      phase: undefined,
      blockIndex: undefined,
      type: 'codex.diagnostic',
      data: { recordType: 'event_msg', itemType: 'token_count' },
    });
    expect(parseCodexTranscriptLine(jsonl(userRecord('One line.')).trim())[0]).toMatchObject({
      type: 'chat.user',
      data: { text: 'One line.' },
    });
  });
});

describe('CodexObservedInputAdapter — human-input delivery proof', () => {
  const FALLBACK = '2026-07-27T09:00:00.000Z';
  const cursor = (startOffset = 0, endOffset = 100, file = '/rollout.jsonl'): TranscriptCursor => ({
    file,
    startOffset,
    endOffset,
  });

  test('canonical response_item user message emits exactly one candidate at the record time', () => {
    const adapter = new CodexObservedInputAdapter();
    const inputs = adapter.observe(userRecord('Canonical Codex prompt.'), cursor(), FALLBACK);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      harness: 'codex',
      text: 'Canonical Codex prompt.',
      proof: 'normal-user-record',
      observedAt: '2026-01-02T03:04:05.000Z',
      shapeVersion: CODEX_INPUT_SHAPE_VERSION,
    });
    expect(inputs[0]!.originatedAt).toBeUndefined();
  });

  test('canonical + its event_msg mirror together yield exactly one candidate (the mirror emits none)', () => {
    const adapter = new CodexObservedInputAdapter();
    const canonical = adapter.observe(userRecord('Deduped prompt.'), cursor(), FALLBACK);
    const mirror = adapter.observe(
      record({ type: 'user_message', message: 'Deduped prompt.' }, 'event_msg'),
      cursor(),
      FALLBACK,
    );
    expect(canonical).toHaveLength(1);
    expect(mirror).toEqual([]);
  });

  test('the event_msg/user_message mirror alone never emits a candidate', () => {
    const adapter = new CodexObservedInputAdapter();
    expect(
      adapter.observe(record({ type: 'user_message', message: 'Mirror only.' }, 'event_msg'), cursor(), FALLBACK),
    ).toEqual([]);
  });

  test('a bare string user block is also proof', () => {
    const adapter = new CodexObservedInputAdapter();
    const inputs = adapter.observe(
      record({ type: 'message', role: 'user', content: 'Bare string prompt.' }),
      cursor(),
      FALLBACK,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.text).toBe('Bare string prompt.');
  });

  test('proof key uses the payload id when present, otherwise a stable cursor key', () => {
    const adapter = new CodexObservedInputAdapter();
    const withId = adapter.observe(
      record({ type: 'message', id: 'msg_abc', role: 'user', content: [{ type: 'input_text', text: 'has id' }] }),
      cursor(10, 60),
      FALLBACK,
    );
    expect(withId[0]!.proofKey).toBe('msg_abc');

    const noId = adapter.observe(userRecord('no id here'), cursor(200, 260, '/roll.jsonl'), FALLBACK);
    expect(noId[0]!.proofKey).toBe('/roll.jsonl#200#260');
    // Replaying the same record at the same cursor yields the same key.
    const replay = new CodexObservedInputAdapter().observe(
      userRecord('no id here'),
      cursor(200, 260, '/roll.jsonl'),
      FALLBACK,
    );
    expect(replay[0]!.proofKey).toBe(noId[0]!.proofKey);
  });

  test('negatives: assistant turns, session preamble, and blank content never emit proof', () => {
    const adapter = new CodexObservedInputAdapter();
    // Assistant message is not human input.
    expect(
      adapter.observe(
        record({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }),
        cursor(),
        FALLBACK,
      ),
    ).toEqual([]);

    // The structurally identifiable session/environment preamble is excluded.
    expect(
      adapter.observe(
        record({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>\ncwd=/x\n</environment_context>' }],
        }),
        cursor(),
        FALLBACK,
      ),
    ).toEqual([]);
    expect(
      adapter.observe(
        record({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<user_instructions>\nbe nice\n</user_instructions>' }],
        }),
        cursor(),
        FALLBACK,
      ),
    ).toEqual([]);

    // Blank text is not proof.
    expect(
      adapter.observe(
        record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '   ' }] }),
        cursor(),
        FALLBACK,
      ),
    ).toEqual([]);
  });

  test('observedAt falls back to the read wall-clock when the record has no timestamp', () => {
    const adapter = new CodexObservedInputAdapter();
    const inputs = adapter.observe(
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no ts' }] },
      },
      cursor(),
      FALLBACK,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.observedAt).toBe(FALLBACK);
  });
});

describe('context.usage extraction (turn-020)', () => {
  test('emits tokens + window from a real-shaped token_count event', () => {
    // Real shape captured 2026-07-23 from a live rollout JSONL.
    const events = normalizeCodexTranscriptRecord(
      {
        timestamp: '2026-07-23T06:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 4_128_238, output_tokens: 20_463, total_tokens: 4_148_701 },
            last_token_usage: {
              input_tokens: 167_531,
              cached_input_tokens: 165_632,
              cache_write_input_tokens: 0,
              output_tokens: 527,
              reasoning_output_tokens: 100,
              total_tokens: 168_058,
            },
            model_context_window: 258_400,
          },
          rate_limits: { limit_id: 'codex' },
        },
      },
      { sessionId: SESSION_ID },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'context.usage',
      data: { contextTokens: 167_531 + 527, contextWindow: 258_400 },
    });
  });

  test('token_count without last usage degrades to a diagnostic', () => {
    const events = normalizeCodexTranscriptRecord(
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
      { sessionId: SESSION_ID },
    );
    expect(events.every(event => event.type !== 'context.usage')).toBe(true);
  });
});

describe('runtime settings extraction', () => {
  test('captures the exact model and reasoning effort from thread_settings_applied', () => {
    // Real field shape observed in Codex 0.145.0 rollout JSONL.
    const events = normalizeCodexTranscriptRecord(
      record(
        {
          type: 'thread_settings_applied',
          thread_settings: {
            model: 'gpt-5.5',
            model_provider_id: 'openai',
            reasoning_effort: 'xhigh',
          },
        },
        'event_msg',
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'runtime.settings',
        data: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
      }),
    ]);
  });

  test('turn_context recovers live settings at the next turn boundary', () => {
    expect(
      normalizeCodexTranscriptRecord(
        record({ model: 'gpt-5.6-sol', effort: 'ultra', turn_id: 'turn-fixture' }, 'turn_context'),
      )[0],
    ).toMatchObject({
      type: 'runtime.settings',
      data: { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
    });
  });
});

describe('Codex transcript file watching', () => {
  test('tails only the exact rollout through partial writes, replacement, and truncation', async () => {
    const temporary = await temporaryDirectory();
    const directory = path.join(temporary, 'sessions', '2026', '01', '02');
    const transcript = path.join(directory, `rollout-fixture-${SESSION_ID}.jsonl`);
    const sibling = path.join(directory, `rollout-fixture-${OTHER_SESSION_ID}.jsonl`);
    const events: CodexNormalizedEvent[] = [];
    const errors: Error[] = [];
    const checkpoints: number[] = [];

    const watcher = await startCodexTranscriptWatcher({
      transcriptFile: transcript,
      reconcileIntervalMs: 20,
      onEvents(next) {
        events.push(...next);
      },
      onCheckpoint(cursor) {
        checkpoints.push(cursor.endOffset);
      },
      onError(error) {
        errors.push(error);
      },
    });
    runningWatchers.push(watcher);

    await mkdir(directory, { recursive: true });
    await writeFile(sibling, jsonl(userRecord('Wrong rollout.')));
    const firstLine = JSON.stringify(userRecord('First exact record.'));
    await writeFile(transcript, firstLine);
    await waitFor(() => watcher.snapshot().partialBytes === Buffer.byteLength(firstLine), 'partial rollout bytes');
    expect(events).toHaveLength(0);

    await appendFile(transcript, '\n');
    await waitFor(() => events.length === 1, 'first complete rollout record');
    expect(events[0]).toMatchObject({
      type: 'chat.user',
      sessionId: SESSION_ID,
      data: { text: 'First exact record.' },
    });

    const secondLine = jsonl(userRecord('Second exact record.'));
    await rename(transcript, `${transcript}.previous`);
    await writeFile(transcript, `${firstLine}\n${secondLine}`);
    await waitFor(() => events.length === 2, 'replacement continuation');
    expect(events.filter(event => event.type === 'chat.user').map(event => event.data.text)).toEqual([
      'First exact record.',
      'Second exact record.',
    ]);

    await writeFile(transcript, jsonl(userRecord('After truncation.')));
    await waitFor(
      () => events.some(event => event.type === 'chat.user' && event.data.text === 'After truncation.'),
      'truncation recovery',
    );
    expect(events.filter(event => event.type === 'chat.user').map(event => event.data.text)).toEqual([
      'First exact record.',
      'Second exact record.',
      'After truncation.',
    ]);
    expect(checkpoints).toHaveLength(3);
    expect(errors.filter(error => error instanceof CodexTranscriptParseError)).toEqual([]);

    await watcher.stop();
    runningWatchers.splice(runningWatchers.indexOf(watcher), 1);
    const countAfterStop = events.length;
    await appendFile(transcript, jsonl(userRecord('Not delivered after stop.')));
    await Bun.sleep(60);
    expect(events).toHaveLength(countAfterStop);
  });

  test('reports malformed complete lines without their content and continues tailing', async () => {
    const temporary = await temporaryDirectory();
    const transcript = path.join(temporary, `rollout-${SESSION_ID}.jsonl`);
    await writeFile(transcript, `{synthetic-invalid-json}\n${jsonl(userRecord('Valid after invalid.'))}`);
    const events: CodexNormalizedEvent[] = [];
    const errors: Error[] = [];
    const watcher = await startCodexTranscriptWatcher({
      transcriptFile: transcript,
      reconcileIntervalMs: 20,
      onEvents(next) {
        events.push(...next);
      },
      onError(error) {
        errors.push(error);
      },
    });
    runningWatchers.push(watcher);

    await waitFor(() => events.length === 1, 'valid record after malformed record');
    expect(events[0]).toMatchObject({ type: 'chat.user', data: { text: 'Valid after invalid.' } });
    const parseError = errors.find(error => error instanceof CodexTranscriptParseError);
    expect(parseError).toBeInstanceOf(CodexTranscriptParseError);
    expect(parseError?.message).not.toContain('synthetic-invalid-json');
  });
});

describe('flush() bounded one-pass barrier (B4 finalizeTerminalSends drain)', () => {
  // A backend whose onChange we fire on demand, so a test can inject reconcile
  // requests during a flush pass deterministically rather than via wall-clock.
  function controllableBackend(): { fire: () => void; backend: TranscriptWatchBackend } {
    const handlers = new Set<(event: { eventType: 'change' | 'rename'; filename?: string }) => void>();
    return {
      fire() {
        for (const handler of handlers) handler({ eventType: 'change' });
      },
      backend: {
        watch(_target, onChange) {
          handlers.add(onChange);
          return { close: () => void handlers.delete(onChange) };
        },
      },
    };
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function startFlushWatcher(): Promise<{
    watcher: CodexTranscriptWatcher;
    transcript: string;
    texts: () => string[];
    fire: () => void;
    churn: { on: boolean };
  }> {
    const temporary = await temporaryDirectory();
    const transcript = path.join(temporary, `rollout-fixture-${SESSION_ID}.jsonl`);
    await writeFile(transcript, '');
    const events: CodexNormalizedEvent[] = [];
    const control = controllableBackend();
    // When `churn.on`, every delivered pass SYNCHRONOUSLY writes the next record
    // and re-fires the watch. Appending inside onEvents (which runs inside
    // reconcile) with a synchronous write guarantees the following pass finds new
    // bytes and re-arms reconcileRequested again — so the coalescing loop never
    // drains. This is the faithful, disk-timing-free reproduction of the
    // production hang; an async void append would race the next read and let the
    // loop drain in the gap, masking the bug.
    const churn = { on: false };
    let churnSeq = 0;
    const watcher = await startCodexTranscriptWatcher({
      transcriptFile: transcript,
      // Large interval: only the test's fire()/churn drives reconciliation, so the
      // race is exercised deterministically rather than by timer luck.
      reconcileIntervalMs: 10_000,
      watchBackend: control.backend,
      onEvents(next) {
        events.push(...next);
        if (churn.on) {
          appendFileSync(transcript, jsonl(userRecord(`churn-${churnSeq++}`)));
          control.fire();
        }
      },
    });
    runningWatchers.push(watcher);
    const texts = (): string[] => events.flatMap(event => (event.type === 'chat.user' ? [event.data.text] : []));
    return { watcher, transcript, texts, fire: control.fire, churn };
  }

  test('resolves under a live writer that perpetually re-arms reconcile and delivers all pre-flush bytes', async () => {
    const { watcher, transcript, texts, fire, churn } = await startFlushWatcher();

    await appendFile(transcript, jsonl(userRecord('seed')));
    fire();
    await waitFor(() => texts().includes('seed'), 'seed delivered');

    // Perpetual re-arm: each delivered pass synchronously appends a fresh record
    // and re-fires, so reconcileRequested is set again before the coalescing loop
    // re-checks it — the loop NEVER drains. The OLD flush (await requestReconcile
    // → that same loop) therefore never settles and hangs finalizeTerminalSends;
    // the bounded barrier must resolve after ONE EOF pass regardless.
    churn.on = true;
    try {
      await appendFile(transcript, jsonl(userRecord('pre-flush')));
      await withTimeout(watcher.flush(), 2_000, 'flush under perpetual re-arm');
      expect(texts()).toContain('pre-flush');
    } finally {
      churn.on = false;
    }

    expect(texts().filter(text => text === 'seed')).toHaveLength(1);
    expect(texts().filter(text => text === 'pre-flush')).toHaveLength(1);
  });

  test('a reconcile request issued during each flush pass never skips or duplicates a record, and work stays schedulable after flush', async () => {
    const { watcher, transcript, texts, fire } = await startFlushWatcher();

    const written: string[] = [];
    for (let round = 0; round < 25; round += 1) {
      const text = `round-${round}`;
      written.push(text);
      await appendFile(transcript, jsonl(userRecord(text)));
      const flushed = watcher.flush();
      // Inject reconcile requests WHILE the flush pass is in flight, including
      // right as prior passes settle — the window where an unconditional
      // settlement release would have resolved this barrier before its pass ran.
      fire();
      fire();
      await withTimeout(flushed, 2_000, `flush round ${round}`);
      expect(texts()).toContain(text);
    }

    await appendFile(transcript, jsonl(userRecord('after-flush')));
    fire();
    await waitFor(() => texts().includes('after-flush'), 'post-flush delivery');

    expect(texts()).toEqual([...written, 'after-flush']);
  });

  test('flush() is a no-op after stop and never loses a record delivered before stop (stop/flush ordering)', async () => {
    const { watcher, transcript, texts, fire } = await startFlushWatcher();

    await appendFile(transcript, jsonl(userRecord('before-stop')));
    await withTimeout(watcher.flush(), 2_000, 'flush before stop');
    expect(texts()).toContain('before-stop');

    await watcher.stop();
    runningWatchers.splice(runningWatchers.indexOf(watcher), 1);

    const deliveredBeforeStop = texts().length;
    await appendFile(transcript, jsonl(userRecord('after-stop')));
    fire();
    await withTimeout(watcher.flush(), 1_000, 'flush after stop');
    expect(texts()).toHaveLength(deliveredBeforeStop);
    expect(texts()).not.toContain('after-stop');
  });

  test('flush() REJECTS when its target reconcile pass throws, and later work stays schedulable', async () => {
    const { watcher, transcript, texts } = await startFlushWatcher();

    await appendFile(transcript, jsonl(userRecord('before-fail')));
    await withTimeout(watcher.flush(), 2_000, 'baseline flush');
    expect(texts()).toContain('before-fail');

    // Fault-inject a one-shot reconcile() failure (a read/stat error class) for the
    // NEXT pass — the flush target. A prior barrier that resolved regardless of the
    // pass outcome would let finalizeTerminalSends classify on a failed drain.
    const original = (watcher as unknown as { reconcile: () => Promise<void> }).reconcile.bind(watcher);
    let injected = false;
    (watcher as unknown as { reconcile: () => Promise<void> }).reconcile = async () => {
      if (!injected) {
        injected = true;
        throw new Error('injected reconcile failure');
      }
      return original();
    };

    await appendFile(transcript, jsonl(userRecord('during-fail')));
    await expect(withTimeout(watcher.flush(), 2_000, 'failing flush')).rejects.toThrow('injected reconcile failure');

    // Recovery: restore and confirm later flushes resolve and deliver — the failed
    // pass rejected only its own barrier, it did not wedge the loop.
    (watcher as unknown as { reconcile: () => Promise<void> }).reconcile = original;
    await appendFile(transcript, jsonl(userRecord('after-fail')));
    await withTimeout(watcher.flush(), 2_000, 'recovery flush');
    expect(texts()).toContain('during-fail');
    expect(texts()).toContain('after-fail');
    // No waiter leak: every barrier settled.
    expect((watcher as unknown as { passWaiters: unknown[] }).passWaiters).toHaveLength(0);
  });

  test('flush() REJECTS when a delivery callback fails; the proof record stays pending and is delivered exactly once on recovery', async () => {
    const temporary = await temporaryDirectory();
    const transcript = path.join(temporary, `rollout-fixture-${SESSION_ID}.jsonl`);
    await writeFile(transcript, '');

    const delivered: string[] = [];
    let failNext = false;
    const control = controllableBackend();
    const watcher = await startCodexTranscriptWatcher({
      transcriptFile: transcript,
      reconcileIntervalMs: 10_000,
      watchBackend: control.backend,
      onEvents(next) {
        // A consumer (SessionManager) throwing mid-delivery must FAIL the pass, not
        // be swallowed into a silent success — otherwise flush fulfills before the
        // proof record is recorded and the send may be marked UNACCOUNTED.
        if (failNext) {
          failNext = false;
          throw new Error('injected onEvents failure');
        }
        for (const event of next) if (event.type === 'chat.user') delivered.push(event.data.text);
      },
    });
    runningWatchers.push(watcher);

    await appendFile(transcript, jsonl(userRecord('ok-1')));
    await withTimeout(watcher.flush(), 2_000, 'baseline flush');
    expect(delivered).toContain('ok-1');

    // Arm a delivery failure for the proof record, then flush → must REJECT.
    failNext = true;
    await appendFile(transcript, jsonl(userRecord('proof')));
    await expect(withTimeout(watcher.flush(), 2_000, 'failing flush')).rejects.toThrow('injected onEvents failure');
    // The record was NOT delivered and remains queued (never shifted / checkpointed).
    expect(delivered).not.toContain('proof');
    expect(watcher.snapshot().queuedRecords).toBeGreaterThan(0);

    // Recovery: the retained record is delivered EXACTLY once and flush resolves.
    await withTimeout(watcher.flush(), 2_000, 'recovery flush');
    expect(delivered.filter(text => text === 'proof')).toHaveLength(1);
    expect((watcher as unknown as { passWaiters: unknown[] }).passWaiters).toHaveLength(0);
  });

  test('observes each record exactly once across a delivery-callback retry (memoized proof, no re-resolve)', async () => {
    const temporary = await temporaryDirectory();
    const transcript = path.join(temporary, `rollout-fixture-${SESSION_ID}.jsonl`);
    await writeFile(transcript, '');

    const delivered: string[] = [];
    let failNext = false;
    const control = controllableBackend();
    const watcher = await startCodexTranscriptWatcher({
      transcriptFile: transcript,
      reconcileIntervalMs: 10_000,
      watchBackend: control.backend,
      onEvents(next) {
        if (failNext) {
          failNext = false;
          throw new Error('injected onEvents failure');
        }
        for (const event of next) if (event.type === 'chat.user') delivered.push(event.data.text);
      },
    });
    runningWatchers.push(watcher);

    // Spy on the (stateless) adapter to count how often each record is observed.
    // A delivery-callback retry that re-ran observe would re-resolve a
    // timestamp-less record's fallback observedAt to a later wall clock; the
    // memoized watcher observes each record EXACTLY ONCE, matching the Claude
    // remove-ring fix. The old double-observe path makes this count 2.
    const observedTexts: string[] = [];
    const adapter = (watcher as unknown as { observedInput: CodexObservedInputAdapter }).observedInput;
    const originalObserve = adapter.observe.bind(adapter);
    adapter.observe = (value, cursor, fallback) => {
      const result = originalObserve(value, cursor, fallback);
      for (const input of result) observedTexts.push(input.text);
      return result;
    };

    // Fail the proof record's first delivery, then recover.
    failNext = true;
    await appendFile(transcript, jsonl(userRecord('proof')));
    await expect(withTimeout(watcher.flush(), 2_000, 'failing flush')).rejects.toThrow('injected onEvents failure');
    expect(delivered).not.toContain('proof');
    expect(watcher.snapshot().queuedRecords).toBeGreaterThan(0);

    // Recovery: delivered exactly once AND observed exactly once (memoized).
    await withTimeout(watcher.flush(), 2_000, 'recovery flush');
    expect(delivered.filter(text => text === 'proof')).toHaveLength(1);
    expect(observedTexts.filter(text => text === 'proof')).toHaveLength(1);
    expect((watcher as unknown as { passWaiters: unknown[] }).passWaiters).toHaveLength(0);
  });

  test('stop() after a REJECTED flush settles cleanly and re-flush is a no-op (guillermo finally path)', async () => {
    const { watcher, transcript, texts } = await startFlushWatcher();

    await appendFile(transcript, jsonl(userRecord('ok')));
    await withTimeout(watcher.flush(), 2_000, 'baseline flush');
    expect(texts()).toContain('ok');

    // Force the next flush to reject, then do exactly what the SessionManager
    // consumer does: stop the temp watcher in a finally. stop() must settle
    // promptly (no hang on the failed pass) and leave no waiter latched.
    const original = (watcher as unknown as { reconcile: () => Promise<void> }).reconcile.bind(watcher);
    let injected = false;
    (watcher as unknown as { reconcile: () => Promise<void> }).reconcile = async () => {
      if (!injected) {
        injected = true;
        throw new Error('injected reconcile failure');
      }
      return original();
    };

    await appendFile(transcript, jsonl(userRecord('during')));
    await expect(withTimeout(watcher.flush(), 2_000, 'rejected flush')).rejects.toThrow('injected reconcile failure');

    await withTimeout(watcher.stop(), 2_000, 'stop after reject');
    runningWatchers.splice(runningWatchers.indexOf(watcher), 1);
    expect(watcher.snapshot().running).toBe(false);
    expect((watcher as unknown as { passWaiters: unknown[] }).passWaiters).toHaveLength(0);

    // A post-stop flush is an immediate no-op and delivers nothing further.
    const before = texts().length;
    await withTimeout(watcher.flush(), 1_000, 'flush after stop');
    expect(texts()).toHaveLength(before);
    expect(texts()).not.toContain('during');
  });
});
