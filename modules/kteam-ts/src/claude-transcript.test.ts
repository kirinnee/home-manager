import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeTranscriptParseError,
  findClaudeTranscript,
  normalizeClaudeTranscriptRecord,
  parseClaudeTranscriptLine,
  startClaudeTranscriptWatcher,
  type ClaudeNormalizedEvent,
  type ClaudeTranscriptWatcher,
} from './claude-transcript';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const temporaryDirectories: string[] = [];
const runningWatchers: ClaudeTranscriptWatcher[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kteam-transcript-test-'));
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

function userRecord(text: string): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: SESSION_ID,
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: 'user', content: text },
  };
}

function assistantRecord(content: unknown[], stopReason = 'tool_use'): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId: SESSION_ID,
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
    timestamp: '2026-01-02T03:04:06.000Z',
    message: {
      id: 'msg_fixture',
      role: 'assistant',
      stop_reason: stopReason,
      content,
    },
  };
}

const jsonl = (record: unknown): string => `${JSON.stringify(record)}\n`;

describe('Claude transcript normalization', () => {
  test('normalizes text, thinking, tools, structured questions, and results', () => {
    const assistant = normalizeClaudeTranscriptRecord(
      assistantRecord([
        { type: 'thinking', thinking: 'Consider the bounded fixture.' },
        { type: 'text', text: 'A fixture response.' },
        {
          type: 'tool_use',
          id: 'toolu_question',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Choice',
                question: 'Which fixture option?',
                options: [
                  { label: 'Alpha', description: 'Use alpha.' },
                  { label: 'Beta', description: 'Use beta.', preview: 'beta-preview' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        { type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command: 'true' } },
      ]),
    );

    expect(assistant.map(event => event.type)).toEqual([
      'chat.assistant.thinking',
      'chat.assistant.text',
      'tool.use',
      'interaction.question',
      'tool.use',
    ]);
    const question = assistant.find(event => event.type === 'interaction.question');
    expect(question?.data).toEqual({
      toolUseId: 'toolu_question',
      questions: [
        {
          header: 'Choice',
          question: 'Which fixture option?',
          options: [
            { label: 'Alpha', description: 'Use alpha.', preview: undefined },
            { label: 'Beta', description: 'Use beta.', preview: 'beta-preview' },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(assistant.every(event => event.source === 'claude')).toBe(true);
    expect(assistant[0]?.stopReason).toBe('tool_use');

    expect(
      normalizeClaudeTranscriptRecord(assistantRecord([{ type: 'text', text: 'Done.' }], 'end_turn')).map(
        event => event.type,
      ),
    ).toEqual(['chat.assistant.text', 'turn.completed']);

    const result = normalizeClaudeTranscriptRecord({
      type: 'user',
      sessionId: SESSION_ID,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_shell',
            content: [{ type: 'text', text: 'Fixture tool output.' }],
            is_error: false,
          },
        ],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool.result',
      data: { toolUseId: 'toolu_shell', text: 'Fixture tool output.', isError: false },
    });

    expect(parseClaudeTranscriptLine(JSON.stringify(userRecord('Fixture user prompt.')))[0]).toMatchObject({
      type: 'chat.user',
      data: { text: 'Fixture user prompt.' },
    });
    expect(normalizeClaudeTranscriptRecord({ type: 'progress', data: { synthetic: true } })).toEqual([]);
  });
});

describe('context.usage extraction (turn-020)', () => {
  test('emits context tokens from a real-shaped assistant usage block', () => {
    const record = assistantRecord([{ type: 'text', text: 'ok' }], 'end_turn');
    (record.message as Record<string, unknown>).model = 'claude-fable-5[1m]';
    (record.message as Record<string, unknown>).usage = {
      // Real shape captured 2026-07-23 from a live session JSONL.
      input_tokens: 2,
      cache_creation_input_tokens: 339,
      cache_read_input_tokens: 757_130,
      output_tokens: 294,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    };
    const events = normalizeClaudeTranscriptRecord(record);
    const usage = events.find(event => event.type === 'context.usage');
    expect(usage?.data).toEqual({ contextTokens: 2 + 339 + 757_130, model: 'claude-fable-5[1m]' });
  });

  test('no usage block or zero totals emit nothing', () => {
    expect(
      normalizeClaudeTranscriptRecord(assistantRecord([{ type: 'text', text: 'x' }])).filter(
        event => event.type === 'context.usage',
      ),
    ).toHaveLength(0);
    const zero = assistantRecord([{ type: 'text', text: 'x' }]);
    (zero.message as Record<string, unknown>).usage = { input_tokens: 0, output_tokens: 5 };
    expect(normalizeClaudeTranscriptRecord(zero).filter(event => event.type === 'context.usage')).toHaveLength(0);
  });
});

describe('Claude transcript file watching', () => {
  test('discovers only the exact UUID and tails partial, replaced, and truncated files', async () => {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    const events: ClaudeNormalizedEvent[] = [];
    const errors: Error[] = [];
    const checkpoints: number[] = [];

    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
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

    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, `${OTHER_SESSION_ID}.jsonl`), jsonl(userRecord('Wrong session.')));
    const firstLine = JSON.stringify(userRecord('First exact record.'));
    await writeFile(transcript, firstLine);

    await waitFor(() => watcher.snapshot().partialBytes === Buffer.byteLength(firstLine), 'partial JSONL bytes');
    expect(events).toHaveLength(0);

    await appendFile(transcript, '\n');
    await waitFor(() => events.some(event => event.type === 'chat.user'), 'first complete record');
    expect(events.filter(event => event.type === 'chat.user').map(event => event.data.text)).toEqual([
      'First exact record.',
    ]);

    const secondLine = jsonl(userRecord('Second exact record.'));
    await rename(transcript, `${transcript}.previous`);
    await writeFile(transcript, `${firstLine}\n${secondLine}`);
    await waitFor(
      () => events.filter(event => event.type === 'chat.user').length === 2,
      'inode replacement continuation',
    );
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
    expect(checkpoints.length).toBe(3);
    expect(checkpoints.every((offset, index) => index === 0 || offset > 0)).toBe(true);
    expect(errors.filter(error => error instanceof ClaudeTranscriptParseError)).toEqual([]);

    const found = await findClaudeTranscript(root, SESSION_ID);
    expect(found).toBe(transcript);
    await watcher.stop();
    runningWatchers.splice(runningWatchers.indexOf(watcher), 1);
    const countAfterStop = events.length;
    await appendFile(transcript, jsonl(userRecord('Not delivered after stop.')));
    await Bun.sleep(60);
    expect(events).toHaveLength(countAfterStop);
  });

  test('reports malformed complete lines without exposing their contents and keeps tailing', async () => {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await mkdir(project, { recursive: true });
    await writeFile(transcript, `{synthetic-invalid-json}\n${jsonl(userRecord('Valid after invalid.'))}`);
    const events: ClaudeNormalizedEvent[] = [];
    const errors: Error[] = [];

    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
      reconcileIntervalMs: 20,
      onEvents(next) {
        events.push(...next);
      },
      onError(error) {
        errors.push(error);
      },
    });
    runningWatchers.push(watcher);

    await waitFor(() => events.length === 1, 'valid line after malformed line');
    expect(events[0]).toMatchObject({ type: 'chat.user', data: { text: 'Valid after invalid.' } });
    const parseError = errors.find(error => error instanceof ClaudeTranscriptParseError);
    expect(parseError).toBeInstanceOf(ClaudeTranscriptParseError);
    expect(parseError?.message).not.toContain('synthetic-invalid-json');
  });
});
