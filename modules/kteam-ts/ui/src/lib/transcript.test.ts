import { describe, expect, test } from 'bun:test';
import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRecord, KTeamEvent } from '../types';
import { TranscriptRow } from '../components/TranscriptRow';
import {
  buildSendIndex,
  buildTranscript,
  isInformativeTurnBoundary,
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

describe('inline native-queue synthesis', () => {
  // The regression: a short send to a BUSY session leaves NO chat.user record
  // and no send_consumed — only a non-file-backed control.send_queued. It must
  // still become a visible, reapable row once its turn has closed.
  function inlineQueued(seq: number, message: string, turn: number, over: Record<string, unknown> = {}): KTeamEvent {
    return journal(
      seq,
      'control.send_queued',
      { queueId: `q-${seq}`, message, attachmentIds: [], native: true, ...over },
      turn,
    );
  }

  test('collected on the queued list, never on byQueueId or byTurn', () => {
    const index = buildSendIndex([inlineQueued(2, 'remember 42', 14)], SESSION);
    expect(index.queued).toHaveLength(1);
    expect(index.queued[0]?.turn).toBe(14);
    expect(index.byQueueId.size).toBe(0);
    expect(index.byTurn.size).toBe(0);
  });

  test('stays invisible until its turn closes, then surfaces as a user row', () => {
    const index = buildSendIndex([inlineQueued(2, 'remember 42', 14)], SESSION);
    // Turn unknown ⇒ never assume delivery.
    expect(buildTranscript([], index, SESSION, undefined)).toEqual([]);
    // Still the queued turn ⇒ possibly still in the composer, do not fabricate.
    expect(buildTranscript([], index, SESSION, 14)).toEqual([]);
    // Turn advanced ⇒ delivered ⇒ a real user block.
    const blocks = buildTranscript([], index, SESSION, 15);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('user');
    expect(blocks[0]?.kind === 'user' ? blocks[0].text : '').toBe('remember 42');
    expect(blocks[0]?.kind === 'user' ? blocks[0].from : 'x').toBeUndefined();
  });

  test('never double-renders a message already present as a real chat.user row', () => {
    const index = buildSendIndex([inlineQueued(2, 'remember 42', 14)], SESSION);
    const blocks = buildTranscript([user('remember 42', '2026-07-25T12:05:00.000Z')], index, SESSION, 15);
    expect(blocks.filter(b => b.kind === 'user')).toHaveLength(1);
  });

  test('is woven in at its chronological position by send time', () => {
    // Queued at 12:00:02 (turn 14); the direct turn-15 reply lands at 12:05:00.
    // The synthesized row must sit BEFORE that reply, not tacked on at the end.
    const index = buildSendIndex([inlineQueued(2, 'mid-turn ping', 14)], SESSION);
    const later = user('later direct message', '2026-07-25T12:05:00.000Z');
    const texts = buildTranscript([later], index, SESSION, 15).map(b => (b.kind === 'user' ? b.text : b.kind));
    expect(texts).toEqual(['mid-turn ping', 'later direct message']);
  });

  test('a peer inline queue send keeps its sender chip and stripped body', () => {
    const peerMessage = `[peer message from teammate jessica (session mspeer-12345678) — not from the human lead]\nNo reply is required; jessica has carried on.\n\npeer queued body`;
    const index = buildSendIndex([inlineQueued(2, peerMessage, 14, { from: 'mspeer', fromName: 'jessica' })], SESSION);
    const block = buildTranscript([], index, SESSION, 15)[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.text : '').toBe('peer queued body');
    expect(block?.kind === 'user' ? block.from?.name : undefined).toBe('jessica');
  });

  test('file-backed queue sends are excluded from synthesis (they own a chat.user row)', () => {
    const index = buildSendIndex([inlineQueued(2, 'long payload', 14, { fileBacked: true })], SESSION);
    expect(index.queued).toHaveLength(0);
    expect(index.byQueueId.size).toBe(1);
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
