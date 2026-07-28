import { describe, expect, test } from 'bun:test';
import type { ChatRecord, KTeamEvent, PendingQuestion, SessionStatus, SessionView } from '../types';
import { buildSendIndex, buildTranscript } from '../lib/transcript';
import {
  blockConfirmsPending,
  hasOpenQuestion,
  questionSurfaceRecord,
  recordConfirmsPending,
  requestIdForLedgerResend,
} from './SessionChatPage';
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

// WHY THESE TESTS NO LONGER DESCRIBE PAGE BEHAVIOUR.
//
// `blockConfirmsPending` used to drive a `useEffect` that DELETED pending rows from
// state whenever any chat.user block matched on text + time + attachments. That reaper
// is gone. These tests are kept because they pin down exactly what the helper does and,
// below, exactly why content matching is not safe to retire a send — but the page no
// longer calls it. Local retirement is owned by the exact `requestId → sendId` ledger
// handover in `reconcileLocalSends` (lib/sends.ts), which is identity-based and
// non-destructive. Do not wire this helper back into a reaping effect.
describe('blockConfirmsPending — content matching, and why it cannot own retirement', () => {
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

  test('THE HAZARD: a QUOTED send and a second identical send both "confirm"', () => {
    // This is why the reaper had to go, not just be tightened. A later message that
    // merely repeats or quotes an earlier send satisfies every check the helper makes,
    // because text is not identity. When this drove a destructive `setPending` filter,
    // such a row could retire an ACCEPTED or UNACCOUNTED send that it was not — and
    // since the row was deleted from state, nothing could bring it back.
    const laterIdentical = userBlock({ ts: '2026-07-25T12:30:00.000Z' });
    expect(blockConfirmsPending(laterIdentical, { text: SAME_TEXT, at: SENT_AT, attachmentIds: [] })).toBe(true);

    // A row is a "confirmation" purely by resembling the text, with no reference to
    // which harness record the daemon actually cited as proof. Exact identity lives in
    // the block's `proofKeys` and is compared against `SendEvidence.key` by
    // `selectLedgerChips`; this helper cannot see either.
    expect('proofKeys' in laterIdentical).toBe(false);
  });
});

describe('inline native-queue sends are never reaped by the turn counter', () => {
  // WHAT THIS SUITE USED TO ASSERT, AND WHY IT IS NOW INVERTED.
  //
  // It used to prove that an inline queued send becomes a DELIVERED row — and so
  // reaps its optimistic chip — once `currentTurn` passed the turn it was queued
  // in. A corpus audit of 1,826 Claude transcripts killed the premise: the
  // harness drains queued text MID-turn, and drains several messages into a
  // single turn, so a turn advance is not evidence about any one message. The old
  // assertion was a bug with a test built around it.
  //
  // Fate now comes only from the backend send ledger (lib/sends.ts), which matches
  // real harness records. The transcript synthesizes nothing.
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

  test('no block is produced for it, so nothing can reap the chip on an assumption', () => {
    const blocks = buildTranscript([], buildSendIndex([queuedEvent], SESSION), SESSION);
    expect(blocks).toEqual([]);
    expect(blocks.some(block => blockConfirmsPending(block, pending))).toBe(false);
  });

  test('a REAL harness record becomes a row that carries its PROOF IDENTITY', () => {
    // The genuine drain, via Claude's queued_command adapter. What matters is not that
    // the row resembles the send — it is that the row exposes the harness record's own
    // uuid, which is verbatim what the daemon writes into `SendEvidence.key`. That id,
    // and nothing about the text, is what lets `selectLedgerChips` retire the chip.
    const uuid = 'b7f1c2d3-4e5a-6789-abcd-ef0123456789';
    const drained = {
      source: 'claude',
      type: 'chat.user',
      timestamp: '2026-07-26T23:06:00.000Z',
      recordUuid: uuid,
      data: { text: SAME_TEXT, nativeQueuedHuman: true },
    } as ChatRecord;
    const blocks = buildTranscript([drained], buildSendIndex([queuedEvent], SESSION), SESSION);
    const row = blocks.find(block => block.kind === 'user');
    expect(row?.kind === 'user' ? row.proofKeys : undefined).toEqual([uuid]);
  });
});

describe('ledger resend identity', () => {
  test('always creates a new send id instead of mutating/reusing the audit row', () => {
    expect(requestIdForLedgerResend('old-send', () => 'new-send')).toBe('new-send');
    const minted = ['old-send', 'new-after-collision'];
    expect(requestIdForLedgerResend('old-send', () => minted.shift()!)).toBe('new-after-collision');
  });

  test('refuses a broken mint that would reuse the original twice', () => {
    expect(() => requestIdForLedgerResend('old-send', () => 'old-send')).toThrow(/new send identity/);
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
    const view = viewWith('awaiting_question');
    expect(hasOpenQuestion(view)).toBe(true);
    expect(questionSurfaceRecord(view, undefined)?.data).toEqual({
      question: 'Question details have not loaded yet.',
    });
  });

  test('the real pending record wins over the status-only recovery record', () => {
    const record = {
      source: 'claude',
      type: 'interaction.question',
      data: { toolUseId: 'toolu_open', questions: question.questions },
    } as ChatRecord;
    expect(questionSurfaceRecord(viewWith('awaiting_question'), record)).toBe(record);
    expect(questionSurfaceRecord(viewWith('running'), undefined)).toBeUndefined();
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
