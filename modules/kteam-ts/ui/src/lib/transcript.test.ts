import { describe, expect, test } from 'bun:test';
import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRecord, KTeamEvent, SendRecord } from '../types';
import { TranscriptRow } from '../components/TranscriptRow';
import {
  buildSendIndex,
  buildTranscript,
  isInformativeTurnBoundary,
  placeLedgerBlocks,
  stripAttachmentReferenceBlock,
  type TranscriptBlock,
} from './transcript';

const BASE = '2026-07-25T12:00:00.000Z';

function user(text = 'hello', timestamp = BASE): ChatRecord {
  return { source: 'claude', type: 'chat.user', timestamp, data: { text } };
}

function assistant(text = 'hi', timestamp = '2026-07-25T12:00:01.000Z'): ChatRecord {
  return { source: 'claude', type: 'chat.assistant.text', timestamp, data: { text } };
}

function turn(type: 'turn.started' | 'turn.completed' | 'turn.aborted', timestamp?: string): ChatRecord {
  return { source: 'claude', type, ...(timestamp === undefined ? {} : { timestamp }) };
}

function turnBlocks(records: ChatRecord[]): Array<Extract<TranscriptBlock, { kind: 'turn' }>> {
  return buildTranscript(records).filter(
    (block): block is Extract<TranscriptBlock, { kind: 'turn' }> => block.kind === 'turn',
  );
}

describe('informative turn boundaries', () => {
  test('drops a lone turn.started between a human message and its reply', () => {
    const blocks = buildTranscript([user(), turn('turn.started', BASE), assistant()]);
    expect(blocks.map(block => block.kind)).toEqual(['user', 'assistant']);
  });

  test('drops an opener-less closer', () => {
    const blocks = buildTranscript([user(), turn('turn.completed', BASE), assistant()]);
    expect(blocks.map(block => block.kind)).toEqual(['user', 'assistant']);
  });

  test('retains normal duration boundaries, including zero milliseconds', () => {
    const positive = turnBlocks([
      turn('turn.started', BASE),
      user(),
      turn('turn.completed', '2026-07-25T12:00:05.000Z'),
      assistant(),
    ]);
    expect(positive).toHaveLength(1);
    expect(positive[0]!.durationMs).toBe(5_000);

    const zero = turnBlocks([turn('turn.started', BASE), user(), turn('turn.completed', BASE), assistant()]);
    expect(zero).toHaveLength(1);
    expect(zero[0]!.durationMs).toBe(0);
    expect(isInformativeTurnBoundary(zero[0]!)).toBe(true);
  });

  test('retains a final abort even without a duration', () => {
    const blocks = turnBlocks([user(), turn('turn.aborted')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.aborted).toBe(true);
  });

  test('retains a collapsed run with skipped markers', () => {
    const blocks = turnBlocks([
      user(),
      turn('turn.started', BASE),
      turn('turn.completed', '2026-07-25T12:00:01.000Z'),
      turn('turn.started', '2026-07-25T12:00:02.000Z'),
      assistant(),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.skipped).toBe(1);
  });

  test('every emitted turn block satisfies the shared invariant', () => {
    const fixtures: ChatRecord[][] = [
      [user(), turn('turn.started', BASE), assistant()],
      [user(), turn('turn.completed', BASE), assistant()],
      [turn('turn.started', BASE), user(), turn('turn.completed', BASE), assistant()],
      [user(), turn('turn.aborted')],
      [
        user(),
        turn('turn.started', BASE),
        turn('turn.completed', '2026-07-25T12:00:01.000Z'),
        turn('turn.started', '2026-07-25T12:00:02.000Z'),
        assistant(),
      ],
    ];
    for (const records of fixtures) {
      for (const block of turnBlocks(records)) expect(isInformativeTurnBoundary(block)).toBe(true);
    }
  });

  test('suppression creates no wrapper and leaves message-to-message rhythm adjacent', () => {
    const uninformative: Extract<TranscriptBlock, { kind: 'turn' }> = { id: 'empty-turn', kind: 'turn' };
    const defensiveMarkup = renderToStaticMarkup(
      createElement(TranscriptRow, { block: uninformative, live: false, isLast: false }),
    );
    expect(defensiveMarkup).toBe('');

    const blocks = buildTranscript([user(), turn('turn.started', BASE), assistant()]);
    const rows = blocks.map((block, index) =>
      createElement(TranscriptRow, {
        key: block.id,
        block,
        live: false,
        isLast: index === blocks.length - 1,
        previous: blocks[index - 1],
      }),
    );
    const markup = renderToStaticMarkup(createElement(Fragment, null, ...rows));
    expect(markup.match(/class="kt-block\b/g)).toHaveLength(2);
    expect(markup).not.toContain('data-kind="chrome"');
    expect(markup).toContain('data-after="message"');
  });
});

describe('human bubble routing', () => {
  test('typed messages and interaction answers use the bubble without a literal prompt leader', () => {
    const blocks = buildTranscript([
      user('typed message'),
      {
        source: 'claude',
        type: 'interaction.answer',
        timestamp: '2026-07-25T12:00:02.000Z',
        data: { labels: ['approved'] },
      },
    ]);
    const rows = blocks.map((block, index) =>
      createElement(TranscriptRow, {
        key: block.id,
        block,
        live: false,
        isLast: index === blocks.length - 1,
        previous: blocks[index - 1],
      }),
    );
    const markup = renderToStaticMarkup(createElement(Fragment, null, ...rows));
    expect(markup.match(/kt-bubble-row/g)).toHaveLength(2);
    expect(markup.match(/You said:/g)).toHaveLength(2);
    expect(markup).not.toContain('&gt;&gt;&gt;');
  });

  test('peer cards and classified system rows never enter the human bubble shell', () => {
    const peer = user(`[peer message from teammate jessica (session ms025va9-977d024b) — not from the human lead]
No reply is required; jessica has carried on.

peer text`);
    const system = user(
      'Read the file /home/kirin/.kteam/ms0abc/turns/turn-014.md now, then carefully follow every instruction inside it. This is your complete task for this turn.',
    );
    const blocks = buildTranscript([peer, system]);
    const rows = blocks.map((block, index) =>
      createElement(TranscriptRow, {
        key: block.id,
        block,
        live: false,
        isLast: index === blocks.length - 1,
        previous: blocks[index - 1],
      }),
    );
    const markup = renderToStaticMarkup(createElement(Fragment, null, ...rows));
    expect(markup).not.toContain('kt-bubble-row');
    expect(markup).toContain('data-system-row="turn prompt"');
    expect(markup).toContain('Jessica');
  });
});

describe('durable ledger row placement', () => {
  function ledger(sendId: string, acceptedAt: string, message = 'unconfirmed body'): SendRecord {
    return { sendId, acceptedAt, message, attachmentIds: [], fate: 'unaccounted' };
  }

  test('interleaves by acceptedAt without disturbing transcript order', () => {
    const blocks = buildTranscript([
      user('before', '2026-07-25T12:00:00.000Z'),
      assistant('after', '2026-07-25T12:02:00.000Z'),
    ]);
    const placed = placeLedgerBlocks(blocks, [ledger('middle', '2026-07-25T12:01:00.000Z')], Date.parse(BASE));
    expect(placed.map(block => block.kind)).toEqual(['user', 'ledger', 'assistant']);
    const row = placed[1];
    expect(row?.kind === 'ledger' ? row.placement : undefined).toBe('chronological');
  });

  test('places every durable fate by acceptedAt, including a still-ACCEPTED row', () => {
    const blocks = buildTranscript([
      user('before', '2026-07-25T12:00:00.000Z'),
      assistant('after', '2026-07-25T12:04:00.000Z'),
    ]);
    const accepted = { ...ledger('accepted', '2026-07-25T12:01:00.000Z'), fate: 'accepted' as const };
    const unaccounted = ledger('unaccounted', '2026-07-25T12:02:00.000Z');
    const delivered = { ...ledger('delivered', '2026-07-25T12:03:00.000Z'), fate: 'delivered' as const };
    const placed = placeLedgerBlocks(blocks, [delivered, accepted, unaccounted], Date.parse(BASE));
    expect(placed.flatMap(block => (block.kind === 'ledger' ? [block.record.sendId] : []))).toEqual([
      'accepted',
      'unaccounted',
      'delivered',
    ]);
  });

  test('uses honest loaded-page boundaries instead of teleporting an old row to the tail', () => {
    const blocks = buildTranscript([
      user('loaded first', '2026-07-25T12:00:00.000Z'),
      assistant('loaded last', '2026-07-25T12:02:00.000Z'),
    ]);
    const placed = placeLedgerBlocks(
      blocks,
      [ledger('newer', '2026-07-25T13:00:00.000Z'), ledger('older', '2026-07-25T11:00:00.000Z')],
      Date.parse(BASE),
    );
    expect(placed.map(block => block.kind)).toEqual(['ledger', 'user', 'assistant', 'ledger']);
    expect(placed[0]?.kind === 'ledger' ? placed[0].record.sendId : undefined).toBe('older');
    expect(placed[0]?.kind === 'ledger' ? placed[0].placement : undefined).toBe('before-loaded');
    const last = placed.at(-1);
    expect(last?.kind === 'ledger' ? last.placement : undefined).toBe('after-loaded');
  });

  test('an unusable clock is shown at the top boundary and labelled unknown', () => {
    const blocks = buildTranscript([user('loaded')]);
    const placed = placeLedgerBlocks(blocks, [ledger('unknown', 'not-a-date')], Date.parse(BASE));
    expect(placed[0]?.kind).toBe('ledger');
    expect(placed[0]?.kind === 'ledger' ? placed[0].placement : undefined).toBe('unknown-time');
  });

  test('placement never treats identical text as proof or consumes the visible row', () => {
    const blocks = buildTranscript([user('same words', '2026-07-25T12:10:00.000Z')]);
    const placed = placeLedgerBlocks(
      blocks,
      [ledger('unconfirmed-identical', '2026-07-25T12:00:00.000Z', 'same words')],
      Date.parse(BASE),
    );
    expect(placed.map(block => block.kind)).toEqual(['ledger', 'user']);
    expect(placed[0]?.kind === 'ledger' ? placed[0].record.fate : undefined).toBe('unaccounted');
  });
});

const SESSION = 'ms1images-12345678';
const HASH = 'a'.repeat(64);
const ATTACHMENT_ID = `att_${HASH}`;

function journal(sequence: number, type: string, data: unknown, turn = 14): KTeamEvent {
  return {
    sequence,
    time: `2026-07-25T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    sessionId: SESSION,
    turn,
    type,
    source: 'client',
    data,
  };
}

function attachmentCreated(sequence = 1): KTeamEvent {
  return journal(sequence, 'attachment.created', {
    id: ATTACHMENT_ID,
    filename: 'probe.png',
    mime: 'image/png',
    size: 233,
    sha256: HASH,
    path: `/home/kirin/.kteam/${SESSION}/attachments/${HASH}/probe.png`,
    createdAt: BASE,
  });
}

function promptRecord(turnNumber = 14): ChatRecord {
  return user(
    `Read the file /home/kirin/.kteam/${SESSION}/turns/turn-${String(turnNumber).padStart(3, '0')}.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    '2026-07-25T12:00:10.000Z',
  );
}

describe('journalled sent-message merge', () => {
  test('replaces a matching turn prompt with clean text and authenticated attachment metadata', () => {
    const index = buildSendIndex(
      [
        attachmentCreated(),
        journal(2, 'control.send', { message: 'describe this', attachmentIds: [ATTACHMENT_ID] }, 14),
      ],
      SESSION,
    );
    const blocks = buildTranscript([promptRecord()], index, SESSION);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('user');
    if (blocks[0]?.kind !== 'user') throw new Error('expected user block');
    expect(blocks[0].text).toBe('describe this');
    expect(blocks[0].attachments).toEqual([
      {
        kind: 'attachment',
        sessionId: SESSION,
        attachmentId: ATTACHMENT_ID,
        filename: 'probe.png',
        mime: 'image/png',
        size: 233,
      },
    ]);
  });

  test('an unmatched prompt stays a slim system row and keeps a stable id when metadata arrives', () => {
    const record = promptRecord();
    const fallback = buildTranscript([record]);
    const merged = buildTranscript(
      [record],
      buildSendIndex([journal(2, 'control.send', { message: 'long body', attachmentIds: [] }, 14)], SESSION),
      SESSION,
    );
    expect(fallback[0]?.kind).toBe('system');
    expect(merged[0]?.kind).toBe('user');
    expect(fallback[0]?.id).toBe(merged[0]?.id);
  });

  test('direct sends and inline queued sends do not synthesize duplicate rows', () => {
    const direct = journal(2, 'control.send', { message: 'already visible', attachmentIds: [], direct: true }, 14);
    const queued = journal(3, 'control.send_queued', {
      queueId: '11111111-1111-4111-8111-111111111111',
      message: 'also visible',
      attachmentIds: [],
      native: true,
    });
    const index = buildSendIndex([direct, queued], SESSION);
    expect(index.byTurn.size).toBe(0);
    expect(index.byQueueId.size).toBe(0);
    expect(buildTranscript([user('already visible')], index, SESSION).map(block => block.kind)).toEqual(['user']);
  });

  test('replaces only the exact file-backed queue instruction', () => {
    const queueId = '11111111-1111-4111-8111-111111111111';
    const index = buildSendIndex(
      [
        journal(2, 'control.send_queued', {
          queueId,
          message: 'queued image',
          attachmentIds: [ATTACHMENT_ID],
          native: true,
          fileBacked: true,
          payloadFile: `/home/kirin/.kteam/${SESSION}/channel/queued-${queueId}.md`,
        }),
      ],
      SESSION,
    );
    const instruction = user(
      `Read the queued message file at /home/kirin/.kteam/${SESSION}/channel/queued-${queueId}.md completely now, then follow every instruction inside it.`,
    );
    const block = buildTranscript([instruction], index, SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('queued image');

    const different = user(
      `Read the queued message file at /home/kirin/.kteam/${SESSION}/channel/queued-22222222-2222-4222-8222-222222222222.md completely now, then follow every instruction inside it.`,
    );
    expect(buildTranscript([different], index, SESSION)[0]?.kind).toBe('system');
  });

  test('strips an exact inline attachment reference block and leaves near-misses untouched', () => {
    const text = `please inspect\n\nAttached image (inspect this file directly before responding):\n- /home/kirin/.kteam/${SESSION}/attachments/${HASH}/probe.png (image/png, 233 bytes, id ${ATTACHMENT_ID})`;
    expect(stripAttachmentReferenceBlock(text)).toEqual({ text: 'please inspect', attachmentIds: [ATTACHMENT_ID] });
    const block = buildTranscript([user(text)], buildSendIndex([attachmentCreated()], SESSION), SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('please inspect');
    expect(block?.kind === 'user' ? block.attachments?.[0]?.attachmentId : undefined).toBe(ATTACHMENT_ID);
    expect(stripAttachmentReferenceBlock(`${text}\ntrailing prose`)).toBeNull();
  });

  test('attachment-only and peer sends retain their correct user-row semantics', () => {
    const attachmentOnly = buildTranscript(
      [promptRecord()],
      buildSendIndex(
        [attachmentCreated(), journal(2, 'control.send', { attachmentIds: [ATTACHMENT_ID] }, 14)],
        SESSION,
      ),
      SESSION,
    )[0];
    expect(attachmentOnly?.kind).toBe('user');
    expect(attachmentOnly?.kind === 'user' ? attachmentOnly.text : 'wrong').toBe('');
    expect(attachmentOnly?.kind === 'user' ? attachmentOnly.attachments : []).toHaveLength(1);

    const peerMessage = `[peer message from teammate jessica (session mspeer-12345678) — not from the human lead]\nNo reply is required; jessica has carried on.\n\npeer body`;
    const peer = buildTranscript(
      [promptRecord()],
      buildSendIndex(
        [
          journal(
            2,
            'control.send',
            { message: peerMessage, attachmentIds: [], from: 'mspeer', fromName: 'jessica' },
            14,
          ),
        ],
        SESSION,
      ),
      SESSION,
    )[0];
    expect(peer?.kind).toBe('user');
    expect(peer?.kind === 'user' ? peer.text : '').toBe('peer body');
    expect(peer?.kind === 'user' ? peer.from?.name : undefined).toBe('jessica');
  });

  test('metadata events alone never become transcript rows', () => {
    expect(buildTranscript([], buildSendIndex([attachmentCreated()], SESSION), SESSION)).toEqual([]);
  });
});

describe('no fate is ever synthesized from the turn counter', () => {
  // WHAT THIS SUITE REPLACED, AND WHY.
  //
  // There used to be an `inline native-queue synthesis` suite here asserting the
  // opposite of these tests: that an inline queued send BECOMES a delivered user
  // row once `currentTurn` passes the turn it was queued in. A corpus audit
  // (1,826 Claude transcripts) showed the premise is false — the harness drains
  // queued text mid-turn, and drains several messages into a single turn — so
  // that row could assert a delivery that never happened. Those tests were
  // deleted rather than adapted: they encoded the bug.
  //
  // The rule now: a transcript block exists only where the HARNESS wrote a
  // record. An unproven send is reported by the send ledger (lib/sends.ts), which
  // is allowed to say "unconfirmed"; the transcript is not allowed to guess.
  function inlineQueued(seq: number, message: string, turn: number, over: Record<string, unknown> = {}): KTeamEvent {
    return journal(
      seq,
      'control.send_queued',
      { queueId: `q-${seq}`, message, attachmentIds: [], native: true, ...over },
      turn,
    );
  }

  test('an inline queued send earns no index entry at all', () => {
    const index = buildSendIndex([inlineQueued(2, 'remember 42', 14)], SESSION);
    // It leaves no chat.user row, so there is nothing to REPLACE — and the
    // synthesis list it used to land on no longer exists.
    expect(index.byQueueId.size).toBe(0);
    expect(index.byTurn.size).toBe(0);
    expect('queued' in index).toBe(false);
  });

  test('no user row is invented, at any turn distance', () => {
    const index = buildSendIndex([inlineQueued(2, 'remember 42', 14)], SESSION);
    // The old code produced a row for every one of these but the first two. The
    // turn counter is not evidence, so none of them may produce one now.
    expect(buildTranscript([], index, SESSION)).toEqual([]);
  });

  test('buildTranscript takes no turn argument, so no caller can reintroduce the inference', () => {
    // Structural, not behavioural: the parameter is gone, which is what stops
    // this from being re-enabled by a caller passing a turn again.
    expect(buildTranscript.length).toBe(3);
  });

  test('a real harness record still renders exactly once (no duplicate, no loss)', () => {
    // The genuine drain: Claude's queued_command adapter emits a chat.user with
    // human provenance. That row is the delivery, and it must stand alone.
    const index = buildSendIndex([inlineQueued(2, 'remember 42', 14)], SESSION);
    const drained = {
      source: 'claude',
      type: 'chat.user',
      timestamp: '2026-07-25T12:05:00.000Z',
      data: { text: 'remember 42', nativeQueuedHuman: true },
    } as ChatRecord;
    const blocks = buildTranscript([drained], index, SESSION);
    expect(blocks.filter(b => b.kind === 'user')).toHaveLength(1);
    expect(blocks[0]?.kind === 'user' ? blocks[0].text : '').toBe('remember 42');
  });

  test('file-backed queue sends keep their replacement entry (they DO own a chat.user row)', () => {
    // Unchanged behaviour, guarded: this path is a REPLACEMENT, not a synthesis.
    // The harness really did write a "Read the queued message file …" row; all the
    // index does is swap the instruction for the message it stands for.
    const index = buildSendIndex([inlineQueued(2, 'long payload', 14, { fileBacked: true })], SESSION);
    expect(index.byQueueId.size).toBe(1);
  });
});

describe('native-file queue ids use the backend SAFE-ID grammar, not UUIDs', () => {
  // Larita's blocker: `queuedFileId` matched `[0-9a-f-]{36}`, i.e. UUIDs only. Send
  // ids are now the daemon's safe-id contract `[A-Za-z0-9_-]{1,128}`, because the
  // send route promotes a validated `x-kteam-request-id` to the durable send id and
  // the native-file path embeds it in `channel/queued-<sendId>.md`. A valid non-uuid
  // id therefore failed to parse and the reader saw the raw harness instruction
  // instead of the message they sent. `request_file_1` is the backend's own fixture.
  const SAFE_ID = 'request_file_1';

  function instruction(id: string): ChatRecord {
    return user(
      `Read the queued message file at /home/kirin/.kteam/${SESSION}/channel/queued-${id}.md completely now, then follow every instruction inside it.`,
    );
  }

  test('a non-UUID send id substitutes the logical payload', () => {
    const index = buildSendIndex(
      [
        journal(2, 'control.send_queued', {
          queueId: SAFE_ID,
          message: 'the real payload',
          attachmentIds: [ATTACHMENT_ID],
          native: true,
          fileBacked: true,
        }),
        attachmentCreated(),
      ],
      SESSION,
    );
    const block = buildTranscript([instruction(SAFE_ID)], index, SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('the real payload');
    expect(block?.kind === 'user' ? block.attachments?.[0]?.attachmentId : undefined).toBe(ATTACHMENT_ID);
  });

  test('a non-UUID send id substitutes PEER metadata too', () => {
    const peerMessage = `[peer message from teammate jessica (session mspeer-12345678) — not from the human lead]\nNo reply is required; jessica has carried on.\n\nsafe-id peer body`;
    const index = buildSendIndex([], SESSION, [
      {
        sendId: SAFE_ID,
        acceptedAt: BASE,
        path: 'native-file',
        message: peerMessage,
        attachmentIds: [],
        fate: 'delivered',
        from: 'mspeer-12345678',
        fromName: 'jessica',
      },
    ]);
    const block = buildTranscript([instruction(SAFE_ID)], index, SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('safe-id peer body');
    expect(block?.kind === 'user' ? block.from?.name : undefined).toBe('jessica');
  });

  test('the whole safe-id charset parses, and a dot still terminates the capture', () => {
    for (const id of ['request_file_1', 'AbC-123_xyz', 'a', 'z'.repeat(128)]) {
      const index = buildSendIndex(
        [
          journal(2, 'control.send_queued', {
            queueId: id,
            message: `payload ${id}`,
            attachmentIds: [],
            native: true,
            fileBacked: true,
          }),
        ],
        SESSION,
      );
      const block = buildTranscript([instruction(id)], index, SESSION)[0];
      expect(block?.kind === 'user' ? block.text : `FAILED for ${id}`).toBe(`payload ${id}`);
    }
    // Over the 128 cap ⇒ NOT a recognised id. The point is that it must not
    // mis-capture a truncated prefix and then substitute some other send's payload:
    // the row degrades to the raw instruction (visible, wrong-looking, harmless)
    // rather than confidently showing the wrong message.
    const tooLong = 'z'.repeat(129);
    const overCap = buildTranscript(
      [instruction(tooLong)],
      buildSendIndex(
        [
          journal(2, 'control.send_queued', {
            queueId: 'z'.repeat(128),
            message: 'someone else’s payload',
            attachmentIds: [],
            native: true,
            fileBacked: true,
          }),
        ],
        SESSION,
      ),
      SESSION,
    )[0];
    expect(overCap?.kind === 'user' ? overCap.text : '').toContain('Read the queued message file at');
    expect(overCap?.kind === 'user' ? overCap.text : '').not.toContain('someone else');
  });

  test('an unmatched safe id degrades to a system row, never to a wrong payload', () => {
    const index = buildSendIndex(
      [
        journal(2, 'control.send_queued', {
          queueId: SAFE_ID,
          message: 'mine',
          attachmentIds: [],
          native: true,
          fileBacked: true,
        }),
      ],
      SESSION,
    );
    expect(buildTranscript([instruction('request_file_2')], index, SESSION)[0]?.kind).toBe('system');
  });
});

describe('user rows carry harness proof identity', () => {
  // The transcript is the only place that can supply the identity the send ledger
  // needs to retire a delivered chip against the row the daemon actually cited.
  // Claude writes `record.uuid` into `SendEvidence.key` verbatim and bare; Codex
  // writes `payload.id`, which the normalized historical row exposes as `itemId`.
  const UUID = 'e0801fc1-034a-45c4-aa7d-eb5b2694c0f0';

  function userWith(meta: Record<string, unknown>, text = 'hello'): ChatRecord {
    return { source: 'claude', type: 'chat.user', timestamp: BASE, data: { text }, ...meta } as ChatRecord;
  }

  function proofKeysOfFirst(records: ChatRecord[], index?: ReturnType<typeof buildSendIndex>) {
    const block = buildTranscript(records, index, SESSION)[0];
    return block?.kind === 'user' ? block.proofKeys : undefined;
  }

  test('a Claude record exposes its uuid BARE — no block-index suffix', () => {
    // The daemon's key is `record.uuid` verbatim, so a composed form would never
    // match and the chip would never retire.
    expect(proofKeysOfFirst([userWith({ recordUuid: UUID, blockIndex: 2 })])).toEqual([UUID]);
  });

  test('a Codex record exposes its itemId', () => {
    expect(proofKeysOfFirst([userWith({ itemId: 'item_abc123' })])).toEqual(['item_abc123']);
  });

  test('a record with neither id carries NO proofKeys (the honest answer)', () => {
    // This is the live-broadcast and cursor-fallback case. The ledger reads absence
    // as "identity unknown, keep the chip" rather than falling back to content.
    expect(proofKeysOfFirst([userWith({})])).toBeUndefined();
    expect(proofKeysOfFirst([userWith({ recordUuid: '' })])).toBeUndefined();
  });

  test('identity survives the turn-prompt / queue-file REPLACEMENT path', () => {
    // The replaced row's text comes from the ledger, but its identity must still be
    // the harness record's — otherwise a substituted row could never be cited.
    const index = buildSendIndex(
      [journal(2, 'control.send', { message: 'the real message', attachmentIds: [] }, 14)],
      SESSION,
    );
    const prompt = { ...promptRecord(14), recordUuid: UUID } as ChatRecord;
    const block = buildTranscript([prompt], index, SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('the real message');
    expect(block?.kind === 'user' ? block.proofKeys : undefined).toEqual([UUID]);
  });
});

describe('ledger backfill survives journal-tail eviction', () => {
  // THE REFRESH-VANISH BUG. Badge and message state used to be rebuilt from a
  // bounded −2000 journal tail, so a send older than the tail lost its metadata
  // and its row decayed to a slim "turn prompt" line on reload. The durable
  // ledger is fetched whole and bounded, so it fills exactly those gaps.
  const QUEUE_ID = '11111111-1111-4111-8111-111111111111';

  function ledgerRow(over: Partial<SendRecord> = {}): SendRecord {
    return {
      sendId: 'send-1',
      acceptedAt: '2026-07-25T12:00:02.000Z',
      message: 'the evicted message',
      attachmentIds: [],
      fate: 'delivered',
      ...over,
    };
  }

  test('a turn-file send recovers its logical message with NO journal event present', () => {
    const index = buildSendIndex([], SESSION, [ledgerRow({ path: 'turn-file', turn: 14 })]);
    const block = buildTranscript([promptRecord(14)], index, SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('the evicted message');
  });

  test('a file-backed queue send recovers via its uuid, and peer attribution survives', () => {
    const peerMessage = `[peer message from teammate jessica (session mspeer-12345678) — not from the human lead]\nNo reply is required; jessica has carried on.\n\nevicted peer body`;
    const index = buildSendIndex([], SESSION, [
      ledgerRow({ sendId: QUEUE_ID, path: 'native-file', message: peerMessage, from: 'mspeer', fromName: 'jessica' }),
    ]);
    const instruction = user(
      `Read the queued message file at /home/kirin/.kteam/${SESSION}/channel/queued-${QUEUE_ID}.md completely now, then follow every instruction inside it.`,
    );
    const block = buildTranscript([instruction], index, SESSION)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('evicted peer body');
    expect(block?.kind === 'user' ? block.from?.name : undefined).toBe('jessica');
  });

  test('the live journal wins over the ledger for the same key', () => {
    // Both sources describe the same send; the journal is the live path, so it
    // must not be overwritten by a ledger row fetched a moment later.
    const index = buildSendIndex(
      [journal(2, 'control.send', { message: 'from the journal', attachmentIds: [] }, 14)],
      SESSION,
      [ledgerRow({ path: 'turn-file', turn: 14, message: 'from the ledger' })],
    );
    expect(index.byTurn.get(14)?.message).toBe('from the journal');
  });

  test('an inline-queued ledger row is NOT turned into a replacement entry', () => {
    // It has no instruction row to replace. Indexing it would put a message on
    // screen at a position the harness never wrote it to.
    const index = buildSendIndex([], SESSION, [ledgerRow({ path: 'native-inline', turn: 14 })]);
    expect(index.byTurn.size).toBe(0);
    expect(index.byQueueId.size).toBe(0);
  });

  test('a withdrawn tombstone never rewrites anything', () => {
    // Synchronous injection failure: the caller was told and still holds the
    // message, so nothing on screen may claim it was sent.
    const index = buildSendIndex([], SESSION, [ledgerRow({ path: 'turn-file', turn: 14, withdrawn: true })]);
    expect(index.byTurn.size).toBe(0);
    expect(buildTranscript([promptRecord(14)], index, SESSION)[0]?.kind).toBe('system');
  });

  test('an UNACCOUNTED row still supplies its message text', () => {
    // Unconfirmed is not "did not happen". If the harness left an instruction row,
    // the reader should still see what the message SAID while its fate is open.
    const index = buildSendIndex([], SESSION, [
      ledgerRow({ path: 'turn-file', turn: 14, fate: 'unaccounted', unaccountedReason: 'timeout' }),
    ]);
    const block = buildTranscript([promptRecord(14)], index, SESSION)[0];
    expect(block?.kind === 'user' ? block.text : '').toBe('the evicted message');
  });
});

describe('Claude native-queue provenance', () => {
  test('a proven-human queued command bypasses system-text classification', () => {
    const record = {
      source: 'claude',
      type: 'chat.user',
      timestamp: BASE,
      data: { text: 'Continue from where you left off.', nativeQueuedHuman: true },
    } as ChatRecord;

    const block = buildTranscript([record])[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('Continue from where you left off.');
  });

  test('the same text without queued-human provenance remains a system row', () => {
    expect(buildTranscript([user('Continue from where you left off.')])[0]?.kind).toBe('system');
  });
});

function toolUse(id: string, name = 'Bash', timestamp = BASE): ChatRecord {
  return { source: 'claude', type: 'tool.use', timestamp, data: { name, input: {}, toolUseId: id } };
}

function toolResult(id: string, text = 'ok', timestamp = BASE): ChatRecord {
  return { source: 'claude', type: 'tool.result', timestamp, data: { text, toolUseId: id } };
}

function usage(timestamp = BASE): ChatRecord {
  return { source: 'claude', type: 'context.usage', timestamp, data: { tokens: 123 } };
}

function emptyThinking(timestamp = BASE): ChatRecord {
  return { source: 'claude', type: 'chat.assistant.thinking', timestamp, data: { thinking: '' } };
}

function toolsBlocks(records: ChatRecord[]): Array<Extract<TranscriptBlock, { kind: 'tools' }>> {
  return buildTranscript(records).filter(
    (block): block is Extract<TranscriptBlock, { kind: 'tools' }> => block.kind === 'tools',
  );
}

describe('tool run grouping across invisible records', () => {
  test('context.usage between tool records does not shatter the run into separate groups', () => {
    // Live sessions emit a context.usage after nearly every tool result. It
    // renders NO block, so it must bridge the run rather than break it.
    const groups = toolsBlocks([
      toolUse('a'),
      toolResult('a'),
      usage(),
      toolUse('b'),
      toolResult('b'),
      usage(),
      toolUse('c'),
      toolResult('c'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls).toHaveLength(3);
  });

  test('a context.usage split between a use and its result still pairs them (no orphan)', () => {
    const groups = toolsBlocks([toolUse('a'), usage(), toolResult('a')]);
    expect(groups).toHaveLength(1);
    const [call] = groups[0]!.calls;
    expect(call?.result).toBeTruthy();
    expect(call?.orphanResult).toBeFalsy();
  });

  test('empty thinking heartbeats bridge a run', () => {
    const groups = toolsBlocks([toolUse('a'), toolResult('a'), emptyThinking(), toolUse('b'), toolResult('b')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls).toHaveLength(2);
  });

  test('visible assistant prose keeps two separate groups so ordering stays truthful', () => {
    const groups = toolsBlocks([
      toolUse('a'),
      toolResult('a'),
      assistant('here is what I found'),
      toolUse('b'),
      toolResult('b'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.calls).toHaveLength(1);
    expect(groups[1]!.calls).toHaveLength(1);
  });

  test('real thinking content keeps groups separate', () => {
    const groups = toolsBlocks([
      toolUse('a'),
      toolResult('a'),
      { source: 'claude', type: 'chat.assistant.thinking', timestamp: BASE, data: { thinking: 'let me reconsider' } },
      toolUse('b'),
      toolResult('b'),
    ]);
    expect(groups).toHaveLength(2);
  });

  test('never leaves two adjacent tools blocks (merge invariant)', () => {
    const blocks = buildTranscript([
      toolUse('a'),
      toolResult('a'),
      usage(),
      turn('turn.completed', BASE),
      turn('turn.started', BASE),
      toolUse('b'),
      toolResult('b'),
    ]);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.kind === 'tools' && blocks[i - 1]!.kind === 'tools').toBe(false);
    }
  });
});

describe('tool images in transcript calls', () => {
  test('keeps Claude base64 bytes as inline images instead of [image]', () => {
    const blocks = buildTranscript([
      {
        source: 'claude',
        type: 'tool.result',
        timestamp: BASE,
        data: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }],
        },
      },
    ]);
    expect(blocks[0]?.kind).toBe('tools');
    expect(blocks[0]?.kind === 'tools' ? blocks[0].calls[0]?.images?.[0] : undefined).toEqual({
      kind: 'inline',
      src: 'data:image/png;base64,abc123',
      alt: 'Tool result image 1',
    });
  });

  test('derives a Codex view_image attachment id only for this session', () => {
    const path = `/home/kirin/.kteam/${SESSION}/attachments/${HASH}/probe.png`;
    const blocks = buildTranscript(
      [
        { source: 'codex', type: 'tool.use', timestamp: BASE, data: { name: 'view_image', input: { path } } },
        { source: 'codex', type: 'tool.result', timestamp: BASE, data: { text: 'ok' } },
      ],
      buildSendIndex([attachmentCreated()], SESSION),
      SESSION,
    );
    expect(blocks[0]?.kind === 'tools' ? blocks[0].calls[0]?.images?.[0] : undefined).toMatchObject({
      kind: 'attachment',
      attachmentId: ATTACHMENT_ID,
      filename: 'probe.png',
      alt: path,
    });
  });
});
