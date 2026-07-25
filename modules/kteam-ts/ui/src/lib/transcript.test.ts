import { describe, expect, test } from 'bun:test';
import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRecord } from '../types';
import { TranscriptRow } from '../components/TranscriptRow';
import { buildTranscript, isInformativeTurnBoundary, type TranscriptBlock } from './transcript';

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
