import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_FETCH_LIMIT,
  MAX_CONTEXT_MESSAGES,
  MIN_CONTEXT_MESSAGES,
  extractContextMessages,
  hasUsableContext,
} from './useDictation';
import type { ChatRecord } from '../types';

function user(text: string): ChatRecord {
  return { source: 'claude', type: 'chat.user', data: { text } } as ChatRecord;
}

function assistant(text: string): ChatRecord {
  return { source: 'claude', type: 'chat.assistant.text', data: { text } } as ChatRecord;
}

describe('extractContextMessages', () => {
  test('keeps user and assistant text, oldest first', () => {
    expect(extractContextMessages([user('one'), assistant('two'), user('three')])).toEqual(['one', 'two', 'three']);
  });

  test('EXCLUDES tool calls, results, thinking and reasoning', () => {
    // These are full of paths, JSON and identifiers. Mining them would flood
    // the fuzzy vocabulary with near-misses for ordinary words.
    const records = [
      user('deploy nitroso'),
      { source: 'claude', type: 'tool.use', data: { name: 'Bash', input: { command: 'ls /var/lib' } } },
      { source: 'claude', type: 'tool.result', data: { text: '/usr/bin/env node' } },
      { source: 'claude', type: 'chat.assistant.thinking', data: { thinking: 'hmm' } },
      { source: 'claude', type: 'chat.assistant.reasoning', data: { reasoning: 'because' } },
      { source: 'claude', type: 'turn.started' },
      assistant('done'),
    ] as ChatRecord[];
    expect(extractContextMessages(records)).toEqual(['deploy nitroso', 'done']);
  });

  test('takes the LAST ten and no more', () => {
    const records = Array.from({ length: 40 }, (_, i) => user(`message ${i}`));
    const extracted = extractContextMessages(records);
    expect(extracted).toHaveLength(MAX_CONTEXT_MESSAGES);
    expect(extracted[MAX_CONTEXT_MESSAGES - 1]).toBe('message 39');
  });

  test('drops empty and whitespace-only messages', () => {
    expect(extractContextMessages([user(''), user('   \n '), user('real')])).toEqual(['real']);
  });

  test('survives a malformed record rather than crashing the utterance', () => {
    const records = [null, undefined, {}, { type: 'chat.user' }, { type: 'chat.user', data: { text: 5 } }, user('ok')];
    expect(extractContextMessages(records as unknown as ChatRecord[])).toEqual(['ok']);
  });

  test('a missing page is no context, not an error', () => {
    expect(extractContextMessages(undefined)).toEqual([]);
    expect(extractContextMessages(null as unknown as ChatRecord[])).toEqual([]);
  });
});

describe('hasUsableContext', () => {
  test('the declared window is the LAST 5–10 messages, so four is not a window', () => {
    expect(hasUsableContext([])).toBe(false);
    expect(hasUsableContext(['a', 'b', 'c', 'd'])).toBe(false);
    expect(hasUsableContext(['a', 'b', 'c', 'd', 'e'])).toBe(true);
    expect(hasUsableContext(Array.from({ length: MAX_CONTEXT_MESSAGES }, () => 'x'))).toBe(true);
  });

  test('the boundaries are exactly the documented ones', () => {
    expect(MIN_CONTEXT_MESSAGES).toBe(5);
    expect(MAX_CONTEXT_MESSAGES).toBe(10);
  });
});

describe('CONTEXT_FETCH_LIMIT', () => {
  test('asks for more records than it will use, because most records are not chat text', () => {
    expect(CONTEXT_FETCH_LIMIT).toBeGreaterThan(MAX_CONTEXT_MESSAGES * 2);
  });
});
