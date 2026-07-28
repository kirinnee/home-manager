import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_FETCH_LIMIT,
  MAX_CONTEXT_MESSAGES,
  MIN_CONTEXT_MESSAGES,
  dictationErrorFromFailure,
  extractContextMessages,
  finishLiveAudioRun,
  hasUsableContext,
  observeLiveSamples,
  type LiveAudioRun,
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

describe('local dictation failures', () => {
  test('names an unprepared local model and a bounded-backlog stop by stable code', () => {
    expect(
      dictationErrorFromFailure(Object.assign(new Error('Prepare this device first.'), { code: 'not-prepared' })),
    ).toEqual({ code: 'not-prepared', message: 'Prepare this device first.' });
    expect(
      dictationErrorFromFailure(Object.assign(new Error('This device is falling behind.'), { code: 'backlog' })),
    ).toEqual({ code: 'backlog', message: 'This device is falling behind.' });
  });

  test('logical cancellation is silent', () => {
    expect(dictationErrorFromFailure(Object.assign(new Error('cancelled'), { code: 'aborted' }))).toBeNull();
  });
});

describe('live capture orchestration', () => {
  test('observes the worklet flush tail before freezing the live preview', async () => {
    const order: string[] = [];
    const pushed: number[][] = [];
    const run: LiveAudioRun = {
      inputSampleRate: null,
      transcriber: {
        push(samples) {
          order.push('preview-push');
          pushed.push(Array.from(samples));
        },
        stop() {
          order.push('preview-stop');
          return {
            committed: 'hello',
            provisional: 'there',
            text: 'hello there',
            complete: false,
            stats: {
              decodeCount: 1,
              discardedPasses: 0,
              forcedAudioDropMs: 0,
              maxDecodedAudioMs: 1_500,
              maxModelInputAudioMs: 1_740,
              firstVisibleAudioMs: 1_500,
              firstVisibleProcessingMs: 12,
              committedRevisionCount: 0,
              provisionalRewriteCount: 0,
              iterationAudioMs: [1_500],
              iterationModelInputAudioMs: [1_740],
              iterationProcessingMs: [12],
            },
          };
        },
      },
    };

    observeLiveSamples(run, new Float32Array([0.1, 0.2]), 16_000);
    const capture = {
      async stop() {
        order.push('capture-stop');
        // `CaptureSession.stop()` flushes this last worklet batch through the
        // normal callback before it returns the exact full utterance.
        observeLiveSamples(run, new Float32Array([0.3, 0.4]), 16_000);
        order.push('capture-tail');
        return new Float32Array([0.1, 0.2, 0.3, 0.4]);
      },
    };

    const finished = await finishLiveAudioRun(capture, run);

    expect(order).toEqual(['preview-push', 'capture-stop', 'preview-push', 'capture-tail', 'preview-stop']);
    expect(pushed).toEqual([
      [0.10000000149011612, 0.20000000298023224],
      [0.30000001192092896, 0.4000000059604645],
    ]);
    expect(Array.from(finished.samples)).toEqual([
      0.10000000149011612, 0.20000000298023224, 0.30000001192092896, 0.4000000059604645,
    ]);
    expect(finished.preview.text).toBe('hello there');
  });

  test('rejects a sample-rate transition instead of corrupting segment timing', () => {
    const run: LiveAudioRun = {
      inputSampleRate: null,
      transcriber: {
        push() {},
        stop() {
          throw new Error('unused');
        },
      },
    };
    observeLiveSamples(run, new Float32Array(320), 16_000);
    expect(() => observeLiveSamples(run, new Float32Array(320), 48_000)).toThrow(/sample rate changed/i);
  });
});
