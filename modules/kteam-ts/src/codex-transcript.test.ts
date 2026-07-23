import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CodexTranscriptParseError,
  normalizeCodexTranscriptRecord,
  parseCodexTranscriptLine,
  startCodexTranscriptWatcher,
  type CodexNormalizedEvent,
  type CodexTranscriptWatcher,
} from './codex-transcript';

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
