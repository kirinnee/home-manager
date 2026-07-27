import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SEGMENTER_OPTIONS,
  SilenceSegmenter,
  frameRms,
  type SilenceSegmenterOptions,
  type SpeechSegment,
} from './silence-segmenter';

const RATE = 1_000; // one sample per millisecond keeps boundary assertions legible

function tone(ms: number, amplitude: number): Float32Array {
  return new Float32Array(ms).fill(amplitude);
}

function feed(segmenter: SilenceSegmenter, chunks: readonly Float32Array[]): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  for (const chunk of chunks) segments.push(...segmenter.push(chunk));
  return segments;
}

function make(overrides: Partial<SilenceSegmenterOptions> = {}): SilenceSegmenter {
  return new SilenceSegmenter({
    sampleRate: RATE,
    frameMs: 20,
    preRollMs: 100,
    startVoiceMs: 60,
    endSilenceMs: 200,
    minVoicedMs: 300,
    softMaxMs: 1_000,
    softCutSilenceMs: 100,
    speechRms: 0.01,
    continuingSpeechRms: 0.006,
    noiseMultiplier: 2,
    ...overrides,
  });
}

describe('frameRms', () => {
  test('reports silence and a constant-amplitude frame exactly', () => {
    expect(frameRms(tone(20, 0))).toBe(0);
    expect(frameRms(tone(20, 0.25))).toBeCloseTo(0.25, 6);
  });
});

describe('measured product defaults', () => {
  test('keeps the accepted 240 ms phrase boundary and conservative onset/floor', () => {
    expect(DEFAULT_SEGMENTER_OPTIONS).toMatchObject({
      frameMs: 20,
      preRollMs: 180,
      startVoiceMs: 80,
      endSilenceMs: 240,
      minVoicedMs: 360,
      softMaxMs: 5_000,
      softCutSilenceMs: 120,
      speechRms: 0.006,
      continuingSpeechRms: 0.004,
      noiseMultiplier: 2.8,
    });
  });
});

describe('SilenceSegmenter', () => {
  test('emits nothing for silence or a sub-minimum sound', () => {
    const silence = make();
    expect(feed(silence, [tone(500, 0), tone(500, 0)])).toEqual([]);
    expect(silence.flush()).toEqual([]);

    const clipped = make();
    expect(feed(clipped, [tone(100, 0), tone(200, 0.1), tone(400, 0)])).toEqual([]);
    expect(clipped.flush()).toEqual([]);
  });

  test('cuts only after configured silence and keeps pre-roll plus hangover', () => {
    const segmenter = make();
    const segments = feed(segmenter, [tone(160, 0), tone(420, 0.1), tone(200, 0)]);
    expect(segments).toHaveLength(1);
    const segment = segments[0] as SpeechSegment;
    expect(segment.reason).toBe('silence');
    expect(segment.voicedMs).toBe(420);
    // The 100 ms pre-roll includes the 60 ms onset-confirmation voice, leaving
    // 40 ms of leading quiet, then all 420 ms voice and 200 ms hangover.
    expect(segment.durationMs).toBe(660);
    expect(segment.samples.slice(0, 40).every(sample => sample === 0)).toBe(true);
    expect(segment.samples.slice(-200).every(sample => sample === 0)).toBe(true);
  });

  test('finds two phrases in order without overlapping or duplicating voice', () => {
    const segmenter = make({ preRollMs: 80 });
    const segments = feed(segmenter, [tone(100, 0), tone(320, 0.1), tone(260, 0), tone(340, 0.2), tone(220, 0)]);
    expect(segments.map(segment => segment.id)).toEqual([0, 1]);
    expect(segments.map(segment => segment.reason)).toEqual(['silence', 'silence']);
    expect(segments[0]?.samples.filter(sample => sample > 0.09 && sample < 0.11).length).toBe(320);
    expect(segments[1]?.samples.filter(sample => sample > 0.19 && sample < 0.21).length).toBe(340);
    expect(segments[0]?.endSample).toBeLessThanOrEqual(segments[1]?.startSample ?? 0);
  });

  test('a worklet chunk seam in the middle of a word does not become a segment seam', () => {
    const segmenter = make();
    const segments = feed(segmenter, [tone(100, 0), tone(177, 0.1), tone(243, 0.1), tone(200, 0)]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.voicedMs).toBe(420);
    expect(segments[0]?.samples.filter(sample => sample > 0.09).length).toBe(420);
  });

  test('the soft limit still waits for a sustained low-energy boundary', () => {
    const segmenter = make({ softMaxMs: 600, softCutSilenceMs: 100, endSilenceMs: 300 });
    const beforeBoundary = feed(segmenter, [tone(100, 0), tone(800, 0.1), tone(80, 0)]);
    expect(beforeBoundary).toEqual([]);
    const atBoundary = segmenter.push(tone(20, 0));
    expect(atBoundary).toHaveLength(1);
    expect(atBoundary[0]?.reason).toBe('soft-limit');
    expect(atBoundary[0]?.voicedMs).toBe(800);
  });

  test('flush keeps the final worklet tail exactly once', () => {
    const segmenter = make();
    expect(feed(segmenter, [tone(100, 0), tone(340, 0.1), tone(37, 0.1)])).toEqual([]);
    const final = segmenter.flush();
    expect(final).toHaveLength(1);
    expect(final[0]?.reason).toBe('flush');
    expect(final[0]?.samples.filter(sample => sample > 0.09).length).toBe(377);
    expect(segmenter.flush()).toEqual([]);
    expect(segmenter.push(tone(500, 0.1))).toEqual([]);
  });

  test('reset discards an abandoned phrase and starts ids over for reuse', () => {
    const segmenter = make();
    feed(segmenter, [tone(100, 0), tone(340, 0.1)]);
    expect(segmenter.bufferedDurationMs).toBeGreaterThan(0);
    segmenter.reset();
    expect(segmenter.bufferedDurationMs).toBe(0);
    const segments = feed(segmenter, [tone(100, 0), tone(320, 0.2), tone(200, 0)]);
    expect(segments.map(segment => segment.id)).toEqual([0]);
    expect(segments[0]?.samples.some(sample => sample > 0.09 && sample < 0.11)).toBe(false);
  });
});
