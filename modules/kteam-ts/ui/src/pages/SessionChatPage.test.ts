import { describe, expect, test } from 'bun:test';
import type { ChatRecord } from '../types';
import { buildTranscript } from '../lib/transcript';
import { recordConfirmsPending } from './SessionChatPage';

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

  test('classified system text with identical body neither reaps nor becomes a human bubble', () => {
    const text =
      'Read the file /home/kirin/.kteam/ms0abc/turns/turn-014.md now, then carefully follow every instruction inside it. This is your complete task for this turn.';
    const system = chatUser(text);
    expect(recordConfirmsPending(system, { text, at: SENT_AT })).toBe(false);
    expect(buildTranscript([system])[0]?.kind).toBe('system');
  });
});
