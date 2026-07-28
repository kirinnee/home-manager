import { describe, expect, test } from 'bun:test';
import {
  LocalAgreementTranscriber,
  completeTranscriptText,
  emptyLiveTranscript,
  longestCommonWordPrefix,
  normalizeAgreementWord,
  padTrailingSilence,
  peakFrameRms,
  reduceLiveTranscript,
  unreadableTranscriptReason,
  type LiveTranscriptSnapshot,
  type TimedTranscriptWord,
  type TranscriptHypothesis,
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
const tone = (milliseconds: number, amplitude = 0.1) => new Float32Array(milliseconds).fill(amplitude);

function words(...items: Array<string | [string, number]>): TimedTranscriptWord[] {
  return items.map((item, index) => {
    const [text, confidence] = Array.isArray(item) ? item : [item, 0.9];
    return {
      text,
      startTime: index * 0.2,
      endTime: index * 0.2 + 0.16,
      confidence,
    };
  });
}

function hypothesis(items: Array<string | [string, number]>, processingMs = 5): TranscriptHypothesis {
  const timed = words(...items);
  return {
    text: timed.map(word => word.text).join(' '),
    words: timed,
    confidence: timed.reduce((total, word) => total + (word.confidence ?? 0), 0) / Math.max(1, timed.length),
    processingMs,
  };
}

function make(
  transcribe: (samples: Float32Array, signal: AbortSignal) => Promise<TranscriptHypothesis>,
  updates: LiveTranscriptSnapshot[],
  overrides: Partial<ConstructorParameters<typeof LocalAgreementTranscriber>[0]> = {},
) {
  return new LocalAgreementTranscriber({
    sampleRate: 1_000,
    intervalMs: 1_000,
    maxBufferMs: 4_000,
    contextMs: 0,
    edgeGuardMs: 0,
    paddingMs: 0,
    minAudioMs: 100,
    minPeakRms: 0.001,
    minPassConfidence: 0.15,
    minWordConfidence: 0.15,
    minStableWords: 2,
    transcribe,
    onUpdate: update => updates.push(update),
    ...overrides,
  });
}

describe('hypothesis quality', () => {
  test('uses concrete empty, gibberish, confidence, and timestamp rules', () => {
    expect(unreadableTranscriptReason({ text: '', words: [], confidence: null })).toBe('empty');
    expect(unreadableTranscriptReason({ text: '........', words: [], confidence: null })).toBe('gibberish');
    expect(unreadableTranscriptReason({ text: 'aaaaaaaa', words: words('aaaaaaaa'), confidence: 0.9 })).toBe(
      'gibberish',
    );
    expect(unreadableTranscriptReason({ text: 'hello', words: words('hello'), confidence: 0.1 })).toBe(
      'low-confidence',
    );
    expect(unreadableTranscriptReason({ text: 'hello', words: [], confidence: 0.9 })).toBe('missing-timestamps');
    expect(
      unreadableTranscriptReason({
        text: 'hello',
        words: [{ text: 'hello', startTime: 2, endTime: 1, confidence: 0.9 }],
        confidence: 0.9,
      }),
    ).toBe('invalid-timestamps');
    expect(
      unreadableTranscriptReason({
        text: 'hello world',
        words: words('hello'),
        timestampsValid: false,
        confidence: 0.9,
      }),
    ).toBe('invalid-timestamps');
  });

  test('a final batch result may be readable without timestamps', () => {
    expect(
      unreadableTranscriptReason({ text: 'hello there', words: [], confidence: null }, { requireTimestamps: false }),
    ).toBeNull();
  });
});

describe('word agreement primitives', () => {
  test('normalizes casing/Unicode but keeps punctuation provisional', () => {
    expect(normalizeAgreementWord('  HéLLo  ')).toBe('héllo');
    expect(longestCommonWordPrefix(words('Hello', 'world,'), words('hello', 'world.'))).toBe(1);
  });

  test('finds only the consecutive shared prefix', () => {
    expect(longestCommonWordPrefix(words('one', 'two', 'three'), words('one', 'two', 'changed'))).toBe(2);
    expect(longestCommonWordPrefix(words('one'), words('changed', 'one'))).toBe(0);
  });
});

describe('audio helpers', () => {
  test('trailing padding preserves the live samples exactly', () => {
    const padded = padTrailingSilence(new Float32Array([0.25, -0.5]), 1_000, 2);
    expect([...padded]).toEqual([0.25, -0.5, 0, 0]);
  });

  test('peak-frame RMS still sees a short word inside a long quiet buffer', () => {
    const audio = new Float32Array(1_000);
    audio.fill(0.1, 400, 420);
    expect(peakFrameRms(audio, 1_000)).toBeCloseTo(0.1, 6);
  });
});

describe('LocalAgreementTranscriber', () => {
  test('publishes while speech is continuous; no pause or VAD endpoint is involved', async () => {
    const updates: LiveTranscriptSnapshot[] = [];
    const stream = make(async () => hypothesis(['hello', 'world']), updates);
    stream.push(tone(1_000));
    await tick();
    expect(updates.at(-1)?.text).toBe('hello world');
    expect(updates.at(-1)?.stats.firstVisibleAudioMs).toBe(1_000);
    stream.cancel();
  });

  test('never publishes a word that begins wholly inside synthetic padding', async () => {
    const updates: LiveTranscriptSnapshot[] = [];
    const stream = make(
      async samples => ({
        text: 'real hallucination',
        words: [
          { text: 'real', startTime: 0.2, endTime: 0.5, confidence: 0.9 },
          { text: 'hallucination', startTime: 1.1, endTime: 1.3, confidence: 0.9 },
        ],
        confidence: 0.9,
        audioMs: samples.length,
      }),
      updates,
      { paddingMs: 500 },
    );

    stream.push(tone(1_000));
    await tick();

    expect(updates.at(-1)?.text).toBe('real');
    stream.cancel();
  });

  test('LocalAgreement-2 commits a stable prefix and freely back-edits only the tail', async () => {
    const passes = [
      hypothesis(['hello', 'how', 'ar']),
      hypothesis(['hello', 'how', 'are', 'you']),
      hypothesis(['are', 'they']),
    ];
    const updates: LiveTranscriptSnapshot[] = [];
    let call = 0;
    const stream = make(async () => passes[call++]!, updates);

    stream.push(tone(1_000));
    await tick();
    stream.push(tone(1_000));
    await tick();
    expect(updates.at(-1)).toMatchObject({ committed: 'hello how', provisional: 'are you' });

    stream.push(tone(1_000));
    await tick();
    expect(updates.at(-1)).toMatchObject({ committed: 'hello how', provisional: 'are they' });
    expect(updates.at(-1)?.stats.committedRevisionCount).toBe(0);
    expect(updates.at(-1)?.stats.provisionalRewriteCount).toBeGreaterThan(0);
    stream.cancel();
  });

  test('coalesces every stale cadence boundary into one newest snapshot', async () => {
    const blocked = deferred<TranscriptHypothesis>();
    const updates: LiveTranscriptSnapshot[] = [];
    const lengths: number[] = [];
    let call = 0;
    const stream = make(
      async samples => {
        lengths.push(samples.length);
        call += 1;
        return call === 1 ? blocked.promise : hypothesis(['newest', 'audio']);
      },
      updates,
      { maxBufferMs: 8_000 },
    );

    stream.push(tone(1_000));
    await tick();
    stream.push(tone(1_000));
    stream.push(tone(1_000));
    stream.push(tone(1_000));
    stream.push(tone(1_000));
    expect(lengths).toEqual([1_000]);

    blocked.resolve(hypothesis(['first', 'pass']));
    await tick();
    await tick();
    expect(lengths).toEqual([1_000, 5_000]);
    stream.cancel();
  });

  test('discards bad passes without killing the stream', async () => {
    const passes: TranscriptHypothesis[] = [
      { text: '', words: [], confidence: null },
      hypothesis([['uncertain', 0.05]]),
      hypothesis(['clear', 'speech']),
    ];
    const updates: LiveTranscriptSnapshot[] = [];
    const discarded: string[] = [];
    let call = 0;
    const stream = make(async () => passes[call++]!, updates, { onDiscard: reason => discarded.push(reason) });

    for (let index = 0; index < 3; index += 1) {
      stream.push(tone(1_000));
      await tick();
    }
    expect(discarded).toEqual(['empty', 'low-confidence']);
    expect(updates.at(-1)?.text).toBe('clear speech');
    expect(updates.at(-1)?.stats.discardedPasses).toBe(2);
    stream.cancel();
  });

  test('hard-bounds per-iteration audio when nothing ever stabilizes', async () => {
    const updates: LiveTranscriptSnapshot[] = [];
    let call = 0;
    const stream = make(async () => hypothesis([`word-${call++}`, 'tail']), updates, {
      intervalMs: 500,
      maxBufferMs: 2_000,
    });
    for (let index = 0; index < 16; index += 1) {
      stream.push(tone(500));
      await tick();
    }
    const snapshot = stream.snapshot();
    expect(snapshot.stats.decodeCount).toBeGreaterThan(8);
    expect(Math.max(...snapshot.stats.iterationAudioMs)).toBeLessThanOrEqual(2_000);
    expect(snapshot.stats.maxDecodedAudioMs).toBeLessThanOrEqual(2_000);
    expect(snapshot.stats.maxModelInputAudioMs).toBeLessThanOrEqual(2_000);
    expect(snapshot.stats.forcedAudioDropMs).toBeGreaterThan(0);
    stream.cancel();
  });

  test('finish decodes a short final tail once and marks the result complete', async () => {
    const updates: LiveTranscriptSnapshot[] = [];
    const stream = make(async () => hypothesis(['short', 'tail']), updates, { intervalMs: 2_000 });
    stream.push(tone(500));
    const final = await stream.finish();
    expect(final).toMatchObject({ text: 'short tail', committed: 'short tail', provisional: '', complete: true });
  });

  test('logical cancellation suppresses a late non-abortable model result', async () => {
    const blocked = deferred<TranscriptHypothesis>();
    const updates: LiveTranscriptSnapshot[] = [];
    const stream = make(() => blocked.promise, updates);
    stream.push(tone(1_000));
    await tick();
    stream.cancel();
    blocked.resolve(hypothesis(['too', 'late']));
    await tick();
    expect(updates).toEqual([]);
    expect(stream.pendingDecodes).toBe(0);
  });
});

describe('read-only preview reducer', () => {
  test('replaces only the model-owned hypothesis and ignores stale generations', () => {
    let state = reduceLiveTranscript(emptyLiveTranscript(), { type: 'reset', generation: 7 });
    state = reduceLiveTranscript(state, {
      type: 'hypothesis',
      generation: 7,
      committed: 'hello',
      provisional: 'how ar',
    });
    expect(completeTranscriptText(state)).toBe('hello how ar');
    const current = state;
    expect(
      reduceLiveTranscript(state, {
        type: 'hypothesis',
        generation: 6,
        committed: 'old',
        provisional: 'result',
      }),
    ).toBe(current);

    state = reduceLiveTranscript(state, { type: 'complete', generation: 7, text: 'Hello, how are you?' });
    expect(state).toMatchObject({ committed: 'Hello, how are you?', provisional: '', complete: true });
    expect(
      reduceLiveTranscript(state, {
        type: 'hypothesis',
        generation: 7,
        committed: 'cannot',
        provisional: 'overwrite',
      }),
    ).toBe(state);
  });
});
