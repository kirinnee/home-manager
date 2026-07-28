import { afterEach, describe, expect, test } from 'bun:test';
import type { KTeamEvent } from '../types';
import { classifySystemText } from './system-blocks';
import type { TranscriptBlock } from './transcript';
import {
  applyTranscriptBoundaries,
  deriveJournalClearBoundaries,
  deriveLedgerClearBoundaries,
  deriveTranscriptClearBoundaries,
  emptyTranscriptBoundaryStore,
  getTranscriptBoundaryStore,
  loadTranscriptBoundaryStore,
  MAX_BOUNDARIES_PER_SESSION,
  MAX_BOUNDARY_SESSIONS,
  mergeTranscriptBoundaries,
  parseTranscriptBoundaryStore,
  rememberTranscriptBoundaries,
  resetTranscriptBoundaries,
  resolveTranscriptBoundaryIndex,
  revealTranscriptHistory,
  saveTranscriptBoundaryStore,
  subscribeTranscriptBoundaries,
  TRANSCRIPT_BOUNDARIES_KEY,
  type TranscriptBoundary,
  type TranscriptBoundaryStorage,
} from './transcript-boundaries';

const SESSION = 'ms-boundary-fixture';
const AT = '2026-07-27T05:17:45.615Z';

function boundary(overrides: Partial<TranscriptBoundary> = {}): TranscriptBoundary {
  return {
    id: 'send:20',
    kind: 'clear',
    origin: 'journal-send',
    at: AT,
    sequence: 20,
    ...overrides,
  };
}

function event(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  options: { sessionId?: string; time?: string } = {},
): KTeamEvent {
  return {
    sequence,
    time: options.time ?? AT,
    sessionId: options.sessionId ?? SESSION,
    turn: 4,
    type,
    source: 'client',
    data,
  };
}

function memoryStorage(
  initial: string | null = null,
): TranscriptBoundaryStorage & { key: string | null; value: string | null } {
  return {
    key: null,
    value: initial,
    getItem() {
      return this.value;
    },
    setItem(key, value) {
      this.key = key;
      this.value = value;
    },
  };
}

function assistant(id: string, ts: string, text = id): TranscriptBlock {
  return { id, kind: 'assistant', text, ts, source: 'claude' };
}

afterEach(() => resetTranscriptBoundaries());

describe('transcript boundary persistence', () => {
  test('absent, malformed, non-object, and future payloads degrade to an empty v1 store', () => {
    expect(parseTranscriptBoundaryStore(null)).toEqual(emptyTranscriptBoundaryStore());
    expect(parseTranscriptBoundaryStore('{nope')).toEqual(emptyTranscriptBoundaryStore());
    expect(parseTranscriptBoundaryStore('[]')).toEqual(emptyTranscriptBoundaryStore());
    expect(parseTranscriptBoundaryStore(JSON.stringify({ v: 99, sessions: {} }))).toEqual(
      emptyTranscriptBoundaryStore(),
    );
  });

  test('drops one malformed boundary without losing valid siblings or retaining unknown fields', () => {
    const parsed = parseTranscriptBoundaryStore(
      JSON.stringify({
        v: 1,
        ignored: true,
        sessions: {
          [SESSION]: {
            at: 42,
            ignored: 'field',
            revealedBoundaryId: 'send:20',
            boundaries: [
              boundary(),
              { ...boundary({ id: 'bad' }), at: 'not-a-date' },
              boundary({ id: 'command:21', origin: 'journal-command', sequence: 21 }),
            ],
          },
          malformed: { at: 'yesterday', boundaries: [boundary()] },
        },
      }),
    );

    expect(parsed.sessions[SESSION]).toEqual({
      at: 42,
      revealedBoundaryId: 'send:20',
      boundaries: [boundary(), boundary({ id: 'command:21', origin: 'journal-command', sequence: 21 })],
    });
    expect(parsed.sessions['malformed']).toBeUndefined();
    expect(parsed).not.toHaveProperty('ignored');
  });

  test('storage denial is ordinary: reads empty and writes fail without throwing', () => {
    const denied: TranscriptBoundaryStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadTranscriptBoundaryStore(denied)).toEqual(emptyTranscriptBoundaryStore());
    expect(saveTranscriptBoundaryStore(emptyTranscriptBoundaryStore(), denied)).toBe(false);
    expect(rememberTranscriptBoundaries(SESSION, [boundary()], denied, 100)).toBe(false);
    expect(getTranscriptBoundaryStore(denied).sessions[SESSION]?.boundaries).toEqual([boundary()]);
  });

  test('writes one versioned key and publishes an identity-stable in-memory snapshot', () => {
    const storage = memoryStorage();
    let changes = 0;
    const unsubscribe = subscribeTranscriptBoundaries(() => {
      changes += 1;
    });

    expect(rememberTranscriptBoundaries(SESSION, [boundary()], storage, 123)).toBe(true);
    expect(changes).toBe(1);
    const first = getTranscriptBoundaryStore(storage);
    expect(storage.key).toBe(TRANSCRIPT_BOUNDARIES_KEY);
    expect(JSON.parse(storage.value!)).toEqual(first);
    // Re-observing the same durable boundary is a no-op, not one write per render.
    expect(rememberTranscriptBoundaries(SESSION, [boundary()], storage, 456)).toBe(true);
    expect(getTranscriptBoundaryStore(storage)).toBe(first);
    expect(changes).toBe(1);
    unsubscribe();
  });

  test('caps oldest boundaries and least-recently-written sessions in the safe direction', () => {
    const storage = memoryStorage();
    const many = Array.from({ length: MAX_BOUNDARIES_PER_SESSION + 3 }, (_, index) =>
      boundary({
        id: `send:${index + 1}`,
        sequence: index + 1,
        at: new Date(Date.parse(AT) + index).toISOString(),
      }),
    );
    expect(rememberTranscriptBoundaries(SESSION, many, storage, 1)).toBe(true);
    const kept = getTranscriptBoundaryStore(storage).sessions[SESSION]!.boundaries;
    expect(kept).toHaveLength(MAX_BOUNDARIES_PER_SESSION);
    expect(kept[0]!.id).toBe('send:4');

    for (let index = 0; index < MAX_BOUNDARY_SESSIONS + 2; index += 1) {
      rememberTranscriptBoundaries(`session-${index}`, [boundary({ id: `send:${index + 100}` })], storage, index + 2);
    }
    const sessions = getTranscriptBoundaryStore(storage).sessions;
    expect(Object.keys(sessions)).toHaveLength(MAX_BOUNDARY_SESSIONS);
    expect(sessions[SESSION]).toBeUndefined();
    expect(sessions['session-0']).toBeUndefined();
    expect(sessions[`session-${MAX_BOUNDARY_SESSIONS + 1}`]).toBeDefined();
  });

  test('a reveal survives reload for this boundary id; a newer clear is unrevealed', () => {
    const storage = memoryStorage();
    rememberTranscriptBoundaries(SESSION, [boundary()], storage, 1);
    expect(revealTranscriptHistory(SESSION, 'send:20', storage, 2)).toBe(true);
    resetTranscriptBoundaries();
    expect(loadTranscriptBoundaryStore(storage).sessions[SESSION]?.revealedBoundaryId).toBe('send:20');

    expect(
      rememberTranscriptBoundaries(
        SESSION,
        [boundary({ id: 'send:30', sequence: 30, at: '2026-07-27T05:20:00.000Z' })],
        storage,
        3,
      ),
    ).toBe(true);
    expect(getTranscriptBoundaryStore(storage).sessions[SESSION]?.revealedBoundaryId).toBe('send:20');
  });
});

describe('clear evidence derivation', () => {
  test('real Claude and Codex control.send records both produce durable clear boundaries', async () => {
    const raw = await Bun.file(new URL('../../../src/fixtures/clear-send-real.jsonl', import.meta.url)).text();
    const stored = raw
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {
            sequence: number;
            time: string;
            sessionId: string;
            type: string;
            data: { source: KTeamEvent['source']; turn: number; payload: Record<string, unknown> };
          },
      );
    const events = stored.map<KTeamEvent>(record => ({
      sequence: record.sequence,
      time: record.time,
      sessionId: record.sessionId,
      turn: record.data.turn,
      type: record.type,
      source: record.data.source,
      data: record.data.payload,
    }));

    expect(deriveJournalClearBoundaries([events[0]!], 'ms2robof-0f7be3f4')).toEqual([
      expect.objectContaining({ id: 'send:20', origin: 'journal-send', at: '2026-07-27T05:17:45.615Z' }),
    ]);
    expect(deriveJournalClearBoundaries([events[1]!], 'ms2rpbyc-6f0cb5e9')).toEqual([
      expect.objectContaining({ id: 'send:17', origin: 'journal-send', at: '2026-07-27T05:18:33.717Z' }),
    ]);
  });

  test('requires the exact command, the right session, and successful runtime disposition', () => {
    const events = [
      event(1, 'control.send', { message: '/clear now' }),
      event(2, 'control.send', { message: 'please run /clear' }),
      event(3, 'control.send', { message: ' /clear ' }, { sessionId: 'another-session' }),
      event(3, 'control.send', { message: '/clear', from: 'ms-peer', fromName: 'peer' }),
      event(3, 'control.send', { message: '/clear', fromName: 'peer' }),
      event(4, 'control.session_command', { command: 'clear', disposition: 'turn-started', harness: 'claude' }),
      event(5, 'control.session_command', { command: 'compact', disposition: 'handled-local', harness: 'codex' }),
      event(6, 'control.session_command', { command: 'clear', disposition: 'handled-local', harness: 'codex' }),
    ];
    expect(deriveJournalClearBoundaries(events, SESSION)).toEqual([
      boundary({
        id: 'command:6',
        origin: 'journal-command',
        sequence: 6,
        harness: 'codex',
      }),
    ]);
  });

  test('upgrades a native queued fallback to consumed time under one stable id', () => {
    const queuedAt = '2026-07-27T05:17:00.000Z';
    const consumedAt = '2026-07-27T05:18:00.000Z';
    const events = [
      event(7, 'control.send_queued', { queueId: 'q-clear', message: '/clear', native: true }, { time: queuedAt }),
      event(9, 'control.send_consumed', { queueId: 'q-clear', message: '/clear' }, { time: consumedAt }),
      event(10, 'control.send_queued', {
        queueId: 'peer-clear',
        message: '/clear',
        native: true,
        from: 'ms-peer',
        fromName: 'peer',
      }),
      event(11, 'control.send_consumed', { queueId: 'peer-clear', message: '/clear' }),
      event(12, 'control.send_consumed', { queueId: 'orphan-clear', message: '/clear' }),
      event(13, 'control.send_queued', {
        queueId: 'held',
        message: '/clear',
        native: false,
        queuedForRevive: true,
      }),
    ];
    expect(deriveJournalClearBoundaries(events, SESSION)).toEqual([
      boundary({ id: 'queue:q-clear', origin: 'journal-queue', at: consumedAt, sequence: 9 }),
    ]);
  });

  test('real Claude /clear marker anchors a transcript-derived boundary after its block', async () => {
    const line = await Bun.file(new URL('../../../src/fixtures/claude-clear-real.jsonl', import.meta.url)).text();
    const record = JSON.parse(line) as {
      uuid: string;
      timestamp: string;
      message: { content: string };
    };
    const info = classifySystemText(record.message.content);
    expect(info).toMatchObject({ label: 'command', summary: '/clear' });
    const marker: TranscriptBlock = {
      id: `s-${record.uuid}`,
      kind: 'system',
      info: info!,
      ts: record.timestamp,
      source: 'claude',
    };
    expect(deriveTranscriptClearBoundaries([marker])).toEqual([
      {
        id: `transcript:${marker.id}`,
        kind: 'clear',
        origin: 'transcript',
        at: record.timestamp,
        anchorBlockId: marker.id,
        harness: 'claude',
      },
    ]);
  });

  test('merges cached and freshly observed evidence by stable id, with fresh data winning', () => {
    const cached = boundary({ id: 'queue:q', origin: 'journal-queue', sequence: 4 });
    const consumed = boundary({ id: 'queue:q', origin: 'journal-queue', sequence: 8, at: '2026-07-27T05:19:00Z' });
    expect(mergeTranscriptBoundaries([cached], [consumed])).toEqual([consumed]);
  });

  test('derives long-horizon ledger evidence but rejects held and withdrawn sends', () => {
    const base = {
      acceptedAt: AT,
      attachmentIds: [],
      fate: 'accepted' as const,
      message: '/clear',
      path: 'direct' as const,
    };
    expect(
      deriveLedgerClearBoundaries([
        { ...base, sendId: 'applied' },
        { ...base, sendId: 'held', held: true },
        { ...base, sendId: 'withdrawn', withdrawn: true },
        { ...base, sendId: 'peer', from: 'ms-peer' },
        { ...base, sendId: 'peer-name', fromName: 'peer' },
        { ...base, sendId: 'near-miss', message: '/clear now' },
      ]),
    ).toEqual([
      {
        id: 'ledger:applied',
        kind: 'clear',
        origin: 'send-ledger',
        at: AT,
      },
    ]);
    expect(deriveLedgerClearBoundaries([{ ...base, sendId: 'queued-id', path: 'native-inline' }])).toEqual([
      {
        id: 'queue:queued-id',
        kind: 'clear',
        origin: 'send-ledger',
        at: AT,
      },
    ]);
  });
});

describe('clear boundary placement and projection', () => {
  const blocks = [
    assistant('before', '2026-07-27T05:17:40.000Z'),
    { id: 'tool-without-ts', kind: 'tools' as const, calls: [] },
    assistant('after', '2026-07-27T05:18:00.000Z'),
  ];

  test('exact anchor wins; journal time carries the last timestamp across a timestamp-less row', () => {
    expect(
      resolveTranscriptBoundaryIndex(
        blocks,
        boundary({ origin: 'transcript', sequence: undefined, anchorBlockId: 'before' }),
      ),
    ).toBe(1);
    expect(resolveTranscriptBoundaryIndex(blocks, boundary())).toBe(2);
  });

  test('an unresolvable boundary hides nothing', () => {
    const withoutTimes: TranscriptBlock[] = [{ id: 'notice', kind: 'notice', label: 'connected' }];
    expect(resolveTranscriptBoundaryIndex(withoutTimes, boundary())).toBeNull();
    expect(applyTranscriptBoundaries(withoutTimes, [boundary()])).toEqual({ blocks: withoutTimes, hidden: 0 });
  });

  test('hides original history above the newest clear and starts with an expandable divider', () => {
    const input = [...blocks];
    const projected = applyTranscriptBoundaries(blocks, [boundary()]);
    expect(projected.hidden).toBe(2);
    expect(projected.activeBoundary?.id).toBe('send:20');
    expect(projected.blocks[0]).toMatchObject({
      id: 'boundary:send:20',
      kind: 'system',
      info: { label: 'context cleared', divider: 'clear', summary: 'model context reset' },
    });
    expect(projected.blocks[1]?.id).toBe('after');
    expect(blocks).toEqual(input);
  });

  test('revealing the active id restores all audit rows and persists dividers', () => {
    const projected = applyTranscriptBoundaries(blocks, [boundary()], 'send:20');
    expect(projected.hidden).toBe(0);
    expect(projected.blocks.map(block => block.id)).toEqual(['before', 'tool-without-ts', 'boundary:send:20', 'after']);
  });

  test('a later clear hides again even when the prior one was revealed', () => {
    const later = boundary({ id: 'send:30', sequence: 30, at: '2026-07-27T05:18:30.000Z' });
    const extended = [...blocks, assistant('tail', '2026-07-27T05:19:00.000Z')];
    const projected = applyTranscriptBoundaries(extended, [boundary(), later], 'send:20');
    expect(projected.hidden).toBe(3);
    expect(projected.activeBoundary?.id).toBe('send:30');
    expect(projected.blocks.map(block => block.id)).toEqual(['boundary:send:30', 'tail']);
  });

  test('drops a boundary at index zero and collapses duplicate evidence at one placement', () => {
    const beforeWindow = boundary({ id: 'old', sequence: 1, at: '2020-01-01T00:00:00Z' });
    expect(applyTranscriptBoundaries(blocks, [beforeWindow]).blocks.map(block => block.id)).toEqual([
      'before',
      'tool-without-ts',
      'after',
    ]);

    const duplicate = boundary({ id: 'transcript:marker', sequence: 21 });
    const projected = applyTranscriptBoundaries(blocks, [boundary(), duplicate], 'transcript:marker');
    expect(projected.blocks.filter(block => block.kind === 'system')).toHaveLength(1);
  });
});
