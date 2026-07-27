import { describe, expect, test } from 'bun:test';
import {
  LiveTranscriptionError,
  LocalSegmentQueue,
  completeTranscriptText,
  editCommittedTranscript,
  editProvisionalTranscript,
  emptyLiveTranscript,
  padWithSilence,
  reduceLiveTranscript,
  type SegmentTranscript,
} from './live-transcription';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('LocalSegmentQueue', () => {
  test('runs exactly one local decode at a time and publishes in segment order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const calls: number[] = [];
    const results: SegmentTranscript[] = [];
    const queue = new LocalSegmentQueue({
      transcribe: samples => {
        calls.push(samples[0] as number);
        return calls.length === 1 ? first.promise : second.promise;
      },
      onTranscript: result => results.push(result),
    });
    queue.enqueue({ id: 0, samples: new Float32Array([1]) });
    queue.enqueue({ id: 1, samples: new Float32Array([2]) });
    await tick();
    expect(calls).toEqual([1]);
    first.resolve('one');
    await tick();
    expect(calls).toEqual([1, 2]);
    second.resolve('two');
    await queue.finish();
    expect(results.map(result => [result.id, result.text])).toEqual([
      [0, 'one'],
      [1, 'two'],
    ]);
  });

  test('retries one empty result with leading and trailing silence', async () => {
    const lengths: number[] = [];
    const results: SegmentTranscript[] = [];
    const queue = new LocalSegmentQueue({
      sampleRate: 1_000,
      retryPaddingMs: 100,
      transcribe: async samples => {
        lengths.push(samples.length);
        return lengths.length === 1 ? '' : 'recovered';
      },
      onTranscript: result => results.push(result),
    });
    queue.enqueue({ id: 0, samples: new Float32Array(300).fill(0.2) });
    await queue.finish();
    expect(lengths).toEqual([300, 500]);
    expect(results).toEqual([{ id: 0, text: 'recovered', attempts: 2 }]);
  });

  test('two empty voiced decodes are explicit data-loss prevention, not a skipped id', async () => {
    let reported: unknown = null;
    const queue = new LocalSegmentQueue({
      transcribe: async () => '',
      onTranscript: () => {
        throw new Error('must not publish empty text');
      },
      onError: error => {
        reported = error;
      },
    });
    queue.enqueue({ id: 0, samples: new Float32Array([0.2]) });
    await expect(queue.finish()).rejects.toMatchObject({ code: 'empty-segment' });
    expect(reported).toBeInstanceOf(LiveTranscriptionError);
  });

  test('caps backlog instead of accumulating increasingly stale audio', async () => {
    const blocked = deferred<string>();
    const queue = new LocalSegmentQueue({
      maxPending: 2,
      transcribe: () => blocked.promise,
      onTranscript: () => {},
    });
    queue.enqueue({ id: 0, samples: new Float32Array([1]) });
    queue.enqueue({ id: 1, samples: new Float32Array([2]) });
    expect(() => queue.enqueue({ id: 2, samples: new Float32Array([3]) })).toThrow(
      expect.objectContaining({ code: 'backlog' }),
    );
    queue.cancel();
    blocked.resolve('late');
  });

  test('logical cancellation suppresses a late non-abortable model result', async () => {
    const blocked = deferred<string>();
    const results: SegmentTranscript[] = [];
    const queue = new LocalSegmentQueue({
      transcribe: () => blocked.promise,
      onTranscript: result => results.push(result),
    });
    queue.enqueue({ id: 0, samples: new Float32Array([1]) });
    await tick();
    queue.cancel();
    blocked.resolve('too late');
    await tick();
    expect(results).toEqual([]);
    expect(queue.pending).toBe(0);
  });
});

describe('silence padding', () => {
  test('preserves samples exactly between zero pads', () => {
    const original = new Float32Array([0.25, -0.5]);
    const padded = padWithSilence(original, 1_000, 2);
    expect([...padded]).toEqual([0, 0, 0.25, -0.5, 0, 0]);
  });
});

describe('live transcript ownership', () => {
  test('reader edits to committed and provisional text survive later segments', () => {
    let state = reduceLiveTranscript(emptyLiveTranscript(), { type: 'reset', generation: 7 });
    state = reduceLiveTranscript(state, { type: 'segment', generation: 7, id: 0, text: 'hello' });
    state = editProvisionalTranscript(state, 'Hello, Kirin');
    state = reduceLiveTranscript(state, { type: 'segment', generation: 7, id: 1, text: 'second phrase' });
    expect(state.committed).toBe('Hello, Kirin');
    expect(state.provisional).toBe('second phrase');

    state = editCommittedTranscript(state, 'Reader-owned first phrase');
    state = reduceLiveTranscript(state, { type: 'complete', generation: 7 });
    expect(state.committed).toBe('Reader-owned first phrase second phrase');
    expect(state.provisional).toBe('');
    expect(state.complete).toBe(true);
  });

  test('stale generations, skipped ids and post-completion results cannot overwrite text', () => {
    let state = reduceLiveTranscript(emptyLiveTranscript(), { type: 'reset', generation: 4 });
    const original = state;
    expect(reduceLiveTranscript(state, { type: 'segment', generation: 3, id: 0, text: 'old' })).toBe(original);
    expect(reduceLiveTranscript(state, { type: 'segment', generation: 4, id: 2, text: 'skipped' })).toBe(original);
    state = reduceLiveTranscript(state, { type: 'segment', generation: 4, id: 0, text: 'kept' });
    state = reduceLiveTranscript(state, { type: 'complete', generation: 4 });
    const completed = state;
    expect(reduceLiveTranscript(state, { type: 'segment', generation: 4, id: 1, text: 'late' })).toBe(completed);
    expect(completeTranscriptText(completed)).toBe('kept');
  });
});
