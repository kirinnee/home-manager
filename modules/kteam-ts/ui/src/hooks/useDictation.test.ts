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
import { LiveTranscriptionError, LocalSegmentQueue, type SegmentTranscript } from '../lib/stt/live-transcription';

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
    expect(dictationErrorFromFailure(new LiveTranscriptionError('backlog', 'This device is falling behind.'))).toEqual({
      code: 'backlog',
      message: 'This device is falling behind.',
    });
  });

  test('logical cancellation is silent', () => {
    expect(dictationErrorFromFailure(Object.assign(new Error('cancelled'), { code: 'aborted' }))).toBeNull();
  });
});

describe('live capture orchestration', () => {
  test('observes the worklet flush tail before flushing VAD and closing the queue', async () => {
    const sampleRate = 16_000;
    const samples = (ms: number, amplitude: number) =>
      new Float32Array(Math.round((ms / 1_000) * sampleRate)).fill(amplitude);
    const order: string[] = [];
    const decoded: Float32Array[] = [];
    const transcripts: SegmentTranscript[] = [];
    const queue = new LocalSegmentQueue({
      sampleRate,
      transcribe: async pcm => {
        order.push('decode');
        decoded.push(pcm.slice());
        return 'tail kept';
      },
      onTranscript: result => transcripts.push(result),
    });
    const run: LiveAudioRun = { segmenter: null, inputSampleRate: null, queue };

    // At 340 ms this phrase is still below the product's 360 ms voiced floor.
    // The final 40 ms lives only in capture's flush tail; closing the VAD first
    // would drop the whole phrase and this regression would fail.
    observeLiveSamples(run, samples(180, 0), sampleRate);
    observeLiveSamples(run, samples(340, 0.1), sampleRate);
    const capture = {
      async stop() {
        order.push('capture-stop');
        observeLiveSamples(run, samples(40, 0.1), sampleRate);
        order.push('capture-tail');
        return new Float32Array(0);
      },
    };

    await finishLiveAudioRun(capture, run);

    expect(order).toEqual(['capture-stop', 'capture-tail', 'decode']);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.filter(sample => sample > 0.09).length).toBe(samples(380, 0.1).length);
    expect(transcripts).toEqual([{ id: 0, text: 'tail kept', attempts: 1 }]);
  });

  test('rejects a sample-rate transition instead of corrupting segment timing', () => {
    const queue = new LocalSegmentQueue({ transcribe: async () => 'unused', onTranscript: () => {} });
    const run: LiveAudioRun = { segmenter: null, inputSampleRate: null, queue };
    observeLiveSamples(run, new Float32Array(320), 16_000);
    expect(() => observeLiveSamples(run, new Float32Array(320), 48_000)).toThrow(/sample rate changed/i);
    queue.cancel();
  });
});
