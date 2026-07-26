import { describe, expect, test } from 'bun:test';
import type { ChatRecord, KTeamEvent, PendingQuestion, SessionStatus, SessionView } from '../types';
import { buildSendIndex, buildTranscript } from '../lib/transcript';
import { blockConfirmsPending, hasOpenQuestion, recordConfirmsPending } from './SessionChatPage';
import type { TranscriptBlock } from '../lib/transcript';

const SENT_AT = Date.parse('2026-07-25T12:00:00.000Z');
const SAME_TEXT = 'ship the focused change';

function chatUser(text: string, timestamp = '2026-07-25T12:00:01.000Z'): ChatRecord {
  return { source: 'claude', type: 'chat.user', timestamp, data: { text } };
}

describe('optimistic human-message reaper', () => {
  test('a genuine later human record confirms the pending send', () => {
    expect(recordConfirmsPending(chatUser(SAME_TEXT), { text: SAME_TEXT, at: SENT_AT })).toBe(true);
  });

  test('a peer banner with identical body neither reaps nor becomes a human bubble', () => {
    const peer = chatUser(`[peer message from teammate jessica (session ms025va9-977d024b) — not from the human lead]
No reply is required; jessica has carried on.

${SAME_TEXT}`);
    expect(recordConfirmsPending(peer, { text: SAME_TEXT, at: SENT_AT })).toBe(false);
    const block = buildTranscript([peer])[0];
    expect(block?.kind).toBe('user');
    expect(block?.kind === 'user' ? block.from?.name : undefined).toBe('jessica');
  });

  test('a common classified phrase still confirms delivery without becoming a human bubble', () => {
    const text = 'Continue from where you left off.';
    const system = chatUser(text);
    expect(recordConfirmsPending(system, { text, at: SENT_AT })).toBe(true);
    expect(buildTranscript([system])[0]?.kind).toBe('system');
  });

  test('an identical turn prompt likewise confirms delivery while remaining a system row', () => {
    const text =
      'Read the file /home/kirin/.kteam/ms0abc/turns/turn-014.md now, then carefully follow every instruction inside it. This is your complete task for this turn.';
    const system = chatUser(text);
    expect(recordConfirmsPending(system, { text, at: SENT_AT })).toBe(true);
    expect(buildTranscript([system])[0]?.kind).toBe('system');
  });
});

describe('visible-block optimistic reaper', () => {
  const attachmentId = `att_${'a'.repeat(64)}`;
  const image = {
    kind: 'attachment' as const,
    sessionId: 'ms1images-12345678',
    attachmentId,
    filename: 'probe.png',
  };

  function userBlock(overrides: Partial<Extract<TranscriptBlock, { kind: 'user' }>> = {}): TranscriptBlock {
    return {
      id: 'u-visible',
      kind: 'user',
      text: SAME_TEXT,
      ts: '2026-07-25T12:00:01.000Z',
      source: 'claude',
      ...overrides,
    };
  }

  test('a merged long-message block confirms what its turn prompt record could not', () => {
    expect(blockConfirmsPending(userBlock(), { text: SAME_TEXT, at: SENT_AT, attachmentIds: [] })).toBe(true);
  });

  test('attachment-only sends match on ids without treating empty text as universal', () => {
    expect(
      blockConfirmsPending(userBlock({ text: '', attachments: [image] }), {
        text: '',
        at: SENT_AT,
        attachmentIds: [attachmentId],
      }),
    ).toBe(true);
    expect(blockConfirmsPending(userBlock({ text: '' }), { text: '', at: SENT_AT, attachmentIds: [] })).toBe(false);
  });

  test('peers, older blocks, and mismatched attachment sets never confirm', () => {
    expect(
      blockConfirmsPending(userBlock({ from: { name: 'jessica', replyExpected: false } }), {
        text: SAME_TEXT,
        at: SENT_AT,
      }),
    ).toBe(false);
    expect(blockConfirmsPending(userBlock({ ts: '2026-07-25T11:59:00.000Z' }), { text: SAME_TEXT, at: SENT_AT })).toBe(
      false,
    );
    expect(
      blockConfirmsPending(userBlock({ attachments: [image] }), {
        text: SAME_TEXT,
        at: SENT_AT,
        attachmentIds: [`att_${'b'.repeat(64)}`],
      }),
    ).toBe(false);
  });
});

describe('inline native-queue send reaping (the "queued forever" regression)', () => {
  // A short send to a BUSY session is journalled ONLY as a non-file-backed
  // control.send_queued: no chat.user, no send_consumed (verified on
  // ms1lhymf-c4051f31, turns 36→37). Before the fix the optimistic chip had no
  // block to match, so it read "queued for next turn" forever. buildTranscript
  // now synthesizes the delivered row once the turn closes, and THAT row reaps.
  const SESSION = 'ms1lhymf-c4051f31';
  const queuedEvent: KTeamEvent = {
    sequence: 613,
    time: '2026-07-26T23:04:14.112Z',
    sessionId: SESSION,
    turn: 36,
    type: 'control.send_queued',
    source: 'client',
    data: { queueId: '0309e44e', message: SAME_TEXT, attachmentIds: [], native: true },
  };
  const pending = { text: SAME_TEXT, at: Date.parse('2026-07-26T23:04:13.500Z'), attachmentIds: [] as string[] };

  function reaps(currentTurn: number | undefined): boolean {
    const blocks = buildTranscript([], buildSendIndex([queuedEvent], SESSION), SESSION, currentTurn);
    return blocks.some(block => blockConfirmsPending(block, pending));
  }

  test('does not reap while the queued turn is still open (genuinely queued)', () => {
    expect(reaps(36)).toBe(false);
    expect(reaps(undefined)).toBe(false);
  });

  test('reaps once the turn has advanced past the one it was queued in (delivered)', () => {
    expect(reaps(37)).toBe(true);
  });
});

describe('hasOpenQuestion — the authoritative show/hide predicate', () => {
  const question: PendingQuestion = {
    toolUseId: 'toolu_open',
    questions: [{ question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
  };

  function viewWith(status: SessionStatus, pendingQuestion: PendingQuestion | null = null): SessionView {
    return { state: { id: 's', status, turn: 0, pendingQuestion } } as unknown as SessionView;
  }

  test('no view yet ⇒ never shows a form', () => {
    expect(hasOpenQuestion(undefined)).toBe(false);
  });

  test('awaiting_question status alone opens the form', () => {
    expect(hasOpenQuestion(viewWith('awaiting_question'))).toBe(true);
  });

  test('a pendingQuestion on a still-running session opens the form before status propagates', () => {
    // This is the race Fix 2 targets: the live `interaction.question` push set
    // `pendingQuestion` but left `status` on 'running'. The form must surface.
    expect(hasOpenQuestion(viewWith('running', question))).toBe(true);
  });

  test('a running session with no question does not open the form', () => {
    expect(hasOpenQuestion(viewWith('running'))).toBe(false);
  });

  test('a terminal session never opens the form, even with a lingering pendingQuestion', () => {
    // A stale/answered question must never be resurrected for a finished session.
    for (const status of ['completed', 'failed', 'stalled', 'stopped', 'kill_failed'] as const) {
      expect(hasOpenQuestion(viewWith(status, question))).toBe(false);
    }
  });
});
