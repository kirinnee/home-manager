import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeObservedInputAdapter,
  ClaudeTranscriptParseError,
  findClaudeTranscript,
  normalizeClaudeTranscriptRecord,
  parseClaudeTranscriptLine,
  startClaudeTranscriptWatcher,
  type ClaudeNormalizedEvent,
  type ClaudeTranscriptWatcher,
  type TranscriptCursor,
  type TranscriptWatchBackend,
} from './claude-transcript';
import { CLAUDE_INPUT_SHAPE_VERSION, type ObservedHumanInput } from './observed-human-input';

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

function queuedCommandRecord(prompt: string): Record<string, unknown> {
  return {
    parentUuid: '45a35be7-0629-474f-ba2e-de7570558f0a',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt,
      commandMode: 'prompt',
      origin: { kind: 'human' },
      timestamp: '2026-07-27T02:00:31.604Z',
    },
    type: 'attachment',
    uuid: 'b4c13ff5-4dcf-40f3-b212-5c3bfb5b8bcc',
    timestamp: '2026-07-27T02:00:31.604Z',
    sessionId: SESSION_ID,
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

  test('normalizes a consumed human native-queue prompt as chat.user', () => {
    const events = normalizeClaudeTranscriptRecord(queuedCommandRecord('mission control -- rework it please!'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'claude',
      type: 'chat.user',
      timestamp: '2026-07-27T02:00:31.604Z',
      sessionId: SESSION_ID,
      recordUuid: 'b4c13ff5-4dcf-40f3-b212-5c3bfb5b8bcc',
      parentUuid: '45a35be7-0629-474f-ba2e-de7570558f0a',
      data: { text: 'mission control -- rework it please!', nativeQueuedHuman: true },
    });
  });

  test('does not turn native-queue bookkeeping or task notifications into human chat', () => {
    expect(
      normalizeClaudeTranscriptRecord({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-07-27T02:00:31.604Z',
        sessionId: SESSION_ID,
        content: 'mission control -- rework it please!',
      }),
    ).toEqual([]);

    const taskNotification = queuedCommandRecord('<task-notification>done</task-notification>');
    (taskNotification.attachment as Record<string, unknown>).commandMode = 'task-notification';
    expect(normalizeClaudeTranscriptRecord(taskNotification)).toEqual([]);

    const originlessPrompt = queuedCommandRecord('origin is required');
    delete (originlessPrompt.attachment as Record<string, unknown>).origin;
    expect(normalizeClaudeTranscriptRecord(originlessPrompt)).toEqual([]);

    const nonHumanPrompt = queuedCommandRecord('human provenance is required');
    ((nonHumanPrompt.attachment as Record<string, unknown>).origin as Record<string, unknown>).kind = 'task';
    expect(normalizeClaudeTranscriptRecord(nonHumanPrompt)).toEqual([]);

    expect(normalizeClaudeTranscriptRecord(queuedCommandRecord('   '))).toEqual([]);
  });
});

describe('ClaudeObservedInputAdapter — human-input delivery proof', () => {
  const FALLBACK = '2026-07-27T09:00:00.000Z';
  const cursor = (startOffset = 0, endOffset = 100, file = '/fixture.jsonl'): TranscriptCursor => ({
    file,
    startOffset,
    endOffset,
  });

  function removeOp(content: string, timestamp: string): Record<string, unknown> {
    return { type: 'queue-operation', operation: 'remove', content, timestamp, sessionId: SESSION_ID };
  }
  function enqueueOp(content: string, timestamp: string): Record<string, unknown> {
    return { type: 'queue-operation', operation: 'enqueue', content, timestamp, sessionId: SESSION_ID };
  }

  test('idle submit: a normal user record emits one normal-user candidate at the record time', () => {
    const adapter = new ClaudeObservedInputAdapter();
    const inputs = adapter.observe(userRecord('Idle submitted prompt.'), cursor(), FALLBACK);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      harness: 'claude',
      text: 'Idle submitted prompt.',
      proof: 'normal-user-record',
      observedAt: '2026-01-02T03:04:05.000Z',
      shapeVersion: CLAUDE_INPUT_SHAPE_VERSION,
    });
    expect(inputs[0]!.originatedAt).toBeUndefined();
  });

  test('busy drain: observedAt is the REMOVE time, originatedAt is the attachment/enqueue time', () => {
    const adapter = new ClaudeObservedInputAdapter();
    const text = 'mission control -- rework it please!';
    // enqueue → remove(with content) → attachment, exactly the corpus order.
    expect(adapter.observe(enqueueOp(text, '2026-07-27T02:00:31.604Z'), cursor(0, 50), FALLBACK)).toEqual([]);
    expect(adapter.observe(removeOp(text, '2026-07-27T02:00:36.962Z'), cursor(50, 120), FALLBACK)).toEqual([]);
    const inputs = adapter.observe(queuedCommandRecord(text), cursor(120, 300), FALLBACK);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      harness: 'claude',
      text,
      proof: 'native-queue-drain',
      observedAt: '2026-07-27T02:00:36.962Z', // the remove op time, NOT the attachment time
      originatedAt: '2026-07-27T02:00:31.604Z', // attachment.timestamp = enqueue time
      proofKey: 'b4c13ff5-4dcf-40f3-b212-5c3bfb5b8bcc',
    });
  });

  test('busy drain without a matching remove falls back to read time, never the attachment time', () => {
    const adapter = new ClaudeObservedInputAdapter();
    const inputs = adapter.observe(queuedCommandRecord('unpaired drain'), cursor(), FALLBACK);
    expect(inputs).toHaveLength(1);
    // The attachment timestamp is the enqueue time; using it as observedAt would
    // back-date the proof, so the conservative fallback is the watcher read time.
    expect(inputs[0]!.observedAt).toBe(FALLBACK);
    expect(inputs[0]!.observedAt).not.toBe('2026-07-27T02:00:31.604Z');
    expect(inputs[0]!.originatedAt).toBe('2026-07-27T02:00:31.604Z');
  });

  test('batched three-item drain: each candidate takes its own remove timestamp, one-to-one', () => {
    const adapter = new ClaudeObservedInputAdapter();
    const items = [
      { text: 'first batched item', remove: '2026-07-27T20:00:35.100Z' },
      { text: 'Read the queued message file at /tmp/queued-abc.md', remove: '2026-07-27T20:00:35.101Z' },
      { text: 'third batched item', remove: '2026-07-27T20:00:35.102Z' },
    ];
    for (const item of items) adapter.observe(removeOp(item.text, item.remove), cursor(), FALLBACK);
    const drained = items.flatMap(item => adapter.observe(queuedCommandRecord(item.text), cursor(), FALLBACK));
    expect(drained).toHaveLength(3);
    expect(drained.map(input => input.observedAt)).toEqual(items.map(item => item.remove));
    expect(drained.map(input => input.text)).toEqual(items.map(item => item.text));
    expect(drained.every(input => input.proof === 'native-queue-drain')).toBe(true);
  });

  test('file-backed send: the candidate carries the queue instruction text (queueText), not the payload', () => {
    const adapter = new ClaudeObservedInputAdapter();
    const instruction = 'Read the queued message file at /home/x/.kteam/abc/channel/queued-77.md';
    adapter.observe(removeOp(instruction, '2026-07-27T21:00:00.000Z'), cursor(), FALLBACK);
    const inputs = adapter.observe(queuedCommandRecord(instruction), cursor(), FALLBACK);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.text).toBe(instruction);
    expect(inputs[0]!.observedAt).toBe('2026-07-27T21:00:00.000Z');
  });

  test('negatives: remove alone, task-notification, blank, and non-human origin never emit proof', () => {
    const adapter = new ClaudeObservedInputAdapter();
    // remove without a following attachment is not proof (cancellations, pane deaths).
    expect(adapter.observe(removeOp('cancelled text', '2026-07-27T02:00:00.000Z'), cursor(), FALLBACK)).toEqual([]);

    const taskNotification = queuedCommandRecord('<task-notification>done</task-notification>');
    (taskNotification.attachment as Record<string, unknown>).commandMode = 'task-notification';
    expect(adapter.observe(taskNotification, cursor(), FALLBACK)).toEqual([]);

    expect(adapter.observe(queuedCommandRecord('   '), cursor(), FALLBACK)).toEqual([]);

    const nonHuman = queuedCommandRecord('agent-authored');
    ((nonHuman.attachment as Record<string, unknown>).origin as Record<string, unknown>).kind = 'task';
    expect(adapter.observe(nonHuman, cursor(), FALLBACK)).toEqual([]);

    // A user record made only of tool_result blocks is not human input.
    const toolResultOnly: Record<string, unknown> = {
      type: 'user',
      sessionId: SESSION_ID,
      uuid: crypto.randomUUID(),
      timestamp: '2026-07-27T02:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'output', is_error: false }],
      },
    };
    expect(adapter.observe(toolResultOnly, cursor(), FALLBACK)).toEqual([]);
  });

  test('proof keys are stable across replay: record uuid when present, cursor key otherwise', () => {
    const adapter = new ClaudeObservedInputAdapter();
    const withUuid = userRecord('has a uuid');
    const firstPass = adapter.observe(withUuid, cursor(10, 60), FALLBACK)[0]!;
    const replay = new ClaudeObservedInputAdapter().observe(withUuid, cursor(10, 60), FALLBACK)[0]!;
    expect(firstPass.proofKey).toBe(withUuid.uuid as string);
    expect(replay.proofKey).toBe(firstPass.proofKey); // stable across a re-read

    const noUuid: Record<string, unknown> = {
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: '2026-07-27T02:00:00.000Z',
      message: { role: 'user', content: 'no uuid here' },
    };
    const cursorKey = adapter.observe(noUuid, cursor(200, 260, '/roll.jsonl'), FALLBACK)[0]!;
    expect(cursorKey.proofKey).toBe('/roll.jsonl#200#260');
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

describe('Remote Control announcement (session.remote_control)', () => {
  // Real shape captured 2026-07-25 from a live `--rc` session's JSONL.
  const bridgeRecord = (extra: Record<string, unknown> = {}) => ({
    parentUuid: null,
    isSidechain: false,
    type: 'system',
    subtype: 'bridge_status',
    content:
      '/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01PeGYkR3AQFt7tguRUoxdGe',
    url: 'https://claude.ai/code/session_01PeGYkR3AQFt7tguRUoxdGe',
    isMeta: false,
    timestamp: '2026-07-25T02:13:45.543Z',
    uuid: '65d2fd61-d985-4fd5-8302-dd63a3d05140',
    sessionId: '94eb6428-a5ef-41f3-b57b-6b07665925f9',
    ...extra,
  });

  test('extracts the RC url from the structured `url` field', () => {
    const events = normalizeClaudeTranscriptRecord(bridgeRecord());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('session.remote_control');
    expect(events[0]!.data).toEqual({ url: 'https://claude.ai/code/session_01PeGYkR3AQFt7tguRUoxdGe' });
    expect(events[0]!.timestamp).toBe('2026-07-25T02:13:45.543Z');
  });

  test('a bridge_status record never yields chat content', () => {
    // Its `content` is a STRING, which the generic path would otherwise have
    // read as a chat message and rendered as a transcript block.
    expect(normalizeClaudeTranscriptRecord(bridgeRecord()).some(event => event.type.startsWith('chat.'))).toBe(false);
  });

  test('ignores a bridge_status carrying no url or a foreign one', () => {
    expect(normalizeClaudeTranscriptRecord(bridgeRecord({ url: undefined }))).toHaveLength(0);
    // Only the RC surface. A link anywhere else is not this session's RC url.
    expect(normalizeClaudeTranscriptRecord(bridgeRecord({ url: 'https://evil.example/code/session_1' }))).toHaveLength(
      0,
    );
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

describe('watch scope + rediscovery throttle (2026-07-23 listener-flap fix)', () => {
  /** Records every directory/file the watcher arms a native watch on. */
  function recordingBackend(): { targets: string[]; live: () => string[]; backend: TranscriptWatchBackend } {
    const targets: string[] = [];
    const open = new Set<string>();
    return {
      targets,
      live: () => [...open],
      backend: {
        watch(target) {
          targets.push(target);
          open.add(target);
          return {
            close() {
              open.delete(target);
            },
          };
        },
      },
    };
  }

  test('watches ONE directory, not every project below the shared root', async () => {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    // The shared harness home holds every project any teammate ever ran in.
    for (const noise of ['other-a', 'other-b', 'other-c'])
      await mkdir(path.join(root, noise, 'nested'), { recursive: true });
    await mkdir(project, { recursive: true });
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await writeFile(transcript, jsonl(userRecord('Hello.')));
    const recorder = recordingBackend();
    const events: ClaudeNormalizedEvent[] = [];

    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
      reconcileIntervalMs: 20,
      watchBackend: recorder.backend,
      onEvents(next) {
        events.push(...next);
      },
    });
    runningWatchers.push(watcher);
    await waitFor(() => events.length === 1, 'first record');
    // Let several reconcile ticks pass: they must not re-walk or re-arm.
    await Bun.sleep(120);

    const live = recorder.live().sort();
    expect(live).toEqual([project, transcript].sort());
    // Nothing under an unrelated project is ever watched.
    expect(recorder.targets.some(target => target.includes('other-'))).toBe(false);
  });

  test('a rename storm cannot re-walk the tree on every notification', async () => {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    await mkdir(project, { recursive: true });
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await writeFile(transcript, jsonl(userRecord('Hello.')));
    const listeners: Array<(event: { eventType: 'change' | 'rename' }) => void> = [];
    const backend: TranscriptWatchBackend = {
      watch(_target, onChange) {
        listeners.push(onChange);
        return { close() {} };
      },
    };
    const discovered: string[] = [];
    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
      reconcileIntervalMs: 20,
      rediscoverIntervalMs: 60_000,
      watchBackend: backend,
      onDiscovered(file) {
        discovered.push(file);
      },
      onEvents() {},
    });
    runningWatchers.push(watcher);
    await waitFor(() => discovered.length === 1, 'discovery');
    const armedAfterDiscovery = listeners.length;

    // A NEWER file with the same UUID appears in another project directory.
    // Only a full-tree rediscovery walk can find it — so it is the probe for
    // whether the storm re-walks: with the throttle the watcher keeps tailing
    // the file it already holds (old behaviour: every rename notification, and
    // every 2 s tick, re-walked the whole shared home and switched to it).
    const other = path.join(root, 'other-project');
    await mkdir(other, { recursive: true });
    const decoy = path.join(other, `${SESSION_ID}.jsonl`);
    await writeFile(decoy, jsonl(userRecord('Decoy.')));
    const future = new Date(Date.now() + 60_000);
    await utimes(decoy, future, future);

    // A neighbouring session churns files: 50 rename notifications.
    for (let index = 0; index < 50; index += 1) for (const listener of listeners) listener({ eventType: 'rename' });
    await Bun.sleep(120);

    expect(discovered).toEqual([transcript]); // no rediscovery inside the throttle
    expect(listeners.length).toBe(armedAfterDiscovery); // and no re-arm storm
    expect(watcher.snapshot().file).toBe(transcript);
  });

  test('a rediscovery IS performed once the throttle window has passed', async () => {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    await mkdir(project, { recursive: true });
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await writeFile(transcript, jsonl(userRecord('Hello.')));
    const listeners: Array<(event: { eventType: 'change' | 'rename' }) => void> = [];
    const backend: TranscriptWatchBackend = {
      watch(_target, onChange) {
        listeners.push(onChange);
        return { close() {} };
      },
    };
    const discovered: string[] = [];
    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
      reconcileIntervalMs: 20,
      rediscoverIntervalMs: 0, // no throttle: every rename may re-walk
      watchBackend: backend,
      onDiscovered(file) {
        discovered.push(file);
      },
      onEvents() {},
    });
    runningWatchers.push(watcher);
    await waitFor(() => discovered.length === 1, 'discovery');

    const other = path.join(root, 'other-project');
    await mkdir(other, { recursive: true });
    const newer = path.join(other, `${SESSION_ID}.jsonl`);
    await writeFile(newer, jsonl(userRecord('Newer.')));
    const future = new Date(Date.now() + 60_000);
    await utimes(newer, future, future);
    for (const listener of listeners) listener({ eventType: 'rename' });

    await waitFor(() => watcher.snapshot().file === newer, 'rediscovery once unthrottled');
    expect(discovered).toEqual([transcript, newer]);
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
    watcher: ClaudeTranscriptWatcher;
    transcript: string;
    texts: () => string[];
    fire: () => void;
    churn: { on: boolean };
  }> {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await mkdir(project, { recursive: true });
    await writeFile(transcript, '');
    const events: ClaudeNormalizedEvent[] = [];
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
    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
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
      // flush resolved ⇒ its bounded pass reached the EOF at request time.
      expect(texts()).toContain('pre-flush');
    } finally {
      churn.on = false;
    }

    // Exactly-once: no record double-delivered by the churning loop.
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
      // flush resolved ⇒ this round's record is already delivered (never a false
      // early resolution from the settlement window).
      expect(texts()).toContain(text);
    }

    // Later work remains schedulable after the flushes, with no flush this time.
    await appendFile(transcript, jsonl(userRecord('after-flush')));
    fire();
    await waitFor(() => texts().includes('after-flush'), 'post-flush delivery');

    // Every record delivered exactly once, in order — nothing skipped or doubled.
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
    // A stopped watcher's flush resolves immediately and reads nothing further.
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
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await mkdir(project, { recursive: true });
    await writeFile(transcript, '');

    const delivered: string[] = [];
    let failNext = false;
    const control = controllableBackend();
    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
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

  test('busy-drain proof keeps its remove-op observedAt across a delivery-callback retry (does not re-consume the ring)', async () => {
    const temporary = await temporaryDirectory();
    const root = path.join(temporary, 'projects');
    const project = path.join(root, 'fixture-project');
    const transcript = path.join(project, `${SESSION_ID}.jsonl`);
    await mkdir(project, { recursive: true });
    await writeFile(transcript, '');

    // A queue-operation/remove carrying the drained prompt's content + its real
    // consumption time. The adapter buffers this in its bounded ring and pairs it
    // to the drain that follows; the pairing SPLICES it out of the ring.
    const REMOVE_AT = '2026-07-27T02:00:36.962Z';
    const prompt = 'mission control -- rework it please!';
    const removeOp = {
      type: 'queue-operation',
      operation: 'remove',
      content: prompt,
      timestamp: REMOVE_AT,
      sessionId: SESSION_ID,
    };

    const observed: ObservedHumanInput[] = [];
    let failNext = false;
    const control = controllableBackend();
    const watcher = await startClaudeTranscriptWatcher({
      transcriptRoot: root,
      sessionId: SESSION_ID,
      reconcileIntervalMs: 10_000,
      watchBackend: control.backend,
      onEvents() {},
      onObservedInput(next) {
        // Fail the drain candidate's FIRST delivery. Its remove-op timestamp was
        // already spliced from the ring when the candidate was produced. If the
        // retry re-ran the adapter (the bug), the drained ring would yield the
        // wall-clock fallback and back-date the proof; memoization must keep the
        // real REMOVE_AT time.
        if (failNext) {
          failNext = false;
          throw new Error('injected onObservedInput failure');
        }
        observed.push(...next);
      },
    });
    runningWatchers.push(watcher);

    // remove(content=prompt)@T lands and populates the ring, then the drain that
    // consumes it. The drain's delivery fails once and the record stays pending.
    await appendFile(transcript, jsonl(removeOp));
    failNext = true;
    await appendFile(transcript, jsonl(queuedCommandRecord(prompt)));
    await expect(withTimeout(watcher.flush(), 2_000, 'failing drain flush')).rejects.toThrow(
      'injected onObservedInput failure',
    );
    expect(observed).toHaveLength(0);
    expect(watcher.snapshot().queuedRecords).toBeGreaterThan(0);

    // Recovery: the retained candidate is delivered EXACTLY once and STILL
    // carries the remove-op consumption time — never a wall-clock fallback that a
    // transient >60m failure would have turned into an UNACCOUNTED verdict.
    await withTimeout(watcher.flush(), 2_000, 'recovery drain flush');
    expect(observed).toHaveLength(1);
    expect(observed[0]!.proof).toBe('native-queue-drain');
    expect(observed[0]!.observedAt).toBe(REMOVE_AT);
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
