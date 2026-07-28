// Bounded, pause-independent browser-local transcription.
//
// Parakeet TDT v3 is an offline encoder in this browser build. Waiting for a
// VAD endpoint made its output reliable, but it also meant continuous speech
// produced no text. This controller follows the LocalAgreement pattern used by
// whisper_streaming and VoiceInk's Parakeet v2/v3 path instead:
//
//   1. Snapshot the newest audio every ~1.5 s, whether or not speech paused.
//   2. Re-decode the bounded unconfirmed tail with word timestamps.
//   3. Commit the longest prefix shared by two consecutive hypotheses.
//   4. Trim audio behind the commit timestamp, retaining a little context.
//
// Only one decode can exist at once. If inference is slower than capture, all
// intermediate ticks coalesce into the newest snapshot; latency cannot grow as
// a queue of stale windows. A hard rolling-window backstop bounds model input
// even when noise never produces a stable prefix. Empty, low-confidence, or
// malformed passes are discarded without ending the long-running stream.

import { concatFloat32 } from './audio-capture';

export const LIVE_TRANSCRIPTION_INTERVAL_MS = 1_500;
export const LIVE_TRANSCRIPTION_MAX_BUFFER_MS = 8_000;
export const LIVE_TRANSCRIPTION_CONTEXT_MS = 500;
export const LIVE_TRANSCRIPTION_EDGE_GUARD_MS = 320;
export const LIVE_TRANSCRIPTION_PADDING_MS = 240;
export const LIVE_TRANSCRIPTION_MIN_AUDIO_MS = 450;
export const LIVE_TRANSCRIPTION_MIN_PASS_CONFIDENCE = 0.15;
export const LIVE_TRANSCRIPTION_MIN_WORD_CONFIDENCE = 0.15;
export const LIVE_TRANSCRIPTION_MIN_STABLE_WORDS = 2;
export const LIVE_TRANSCRIPTION_MIN_PEAK_RMS = 0.002;

export interface TimedTranscriptWord {
  text: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

export interface TranscriptHypothesis {
  text: string;
  words: readonly TimedTranscriptWord[];
  /** Adapter-level all-or-nothing timing validation. `false` forbids trimming
   * even if some individually valid words survived parsing. */
  timestampsValid?: boolean | null;
  confidence: number | null;
  audioMs?: number;
  processingMs?: number;
}

export type HypothesisDiscardReason =
  | 'silence'
  | 'empty'
  | 'missing-timestamps'
  | 'invalid-timestamps'
  | 'gibberish'
  | 'low-confidence';

export interface TranscriptQualityOptions {
  requireTimestamps?: boolean;
  audioMs?: number;
  minConfidence?: number;
}

/** A deliberately small set of high-precision rejection rules. Confidence is
 * not calibrated as a WER estimate, so only the same conservative 0.15 pass
 * floor VoiceInk uses is applied; LocalAgreement handles ordinary uncertainty. */
export function unreadableTranscriptReason(
  hypothesis: TranscriptHypothesis,
  options: TranscriptQualityOptions = {},
): HypothesisDiscardReason | null {
  const text = hypothesis.text.trim();
  if (!text) return 'empty';
  if (!/[\p{L}\p{N}]/u.test(text)) return 'gibberish';
  if (/([\p{L}\p{N}])\1{7,}/iu.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return 'gibberish';
  }

  const minimum = options.minConfidence ?? LIVE_TRANSCRIPTION_MIN_PASS_CONFIDENCE;
  if (hypothesis.confidence !== null && Number.isFinite(hypothesis.confidence) && hypothesis.confidence < minimum) {
    return 'low-confidence';
  }

  if (!(options.requireTimestamps ?? true)) return null;
  if (hypothesis.timestampsValid === false) return 'invalid-timestamps';
  if (hypothesis.words.length === 0) return 'missing-timestamps';

  const durationSeconds = Math.max(0, (options.audioMs ?? hypothesis.audioMs ?? 0) / 1_000);
  let previousStart = -Infinity;
  let previousEnd = -Infinity;
  for (const word of hypothesis.words) {
    if (!word.text.trim()) return 'invalid-timestamps';
    if (!Number.isFinite(word.startTime) || !Number.isFinite(word.endTime)) return 'invalid-timestamps';
    if (word.startTime < 0 || word.endTime < word.startTime) return 'invalid-timestamps';
    // TDT token spans may overlap slightly, but a word cannot jump backwards
    // by an arbitrary amount or land well after the supplied audio.
    if (word.startTime + 0.25 < previousStart) return 'invalid-timestamps';
    if (word.endTime + 0.25 < previousEnd) return 'invalid-timestamps';
    if (durationSeconds > 0 && word.endTime > durationSeconds + 0.75) return 'invalid-timestamps';
    previousStart = word.startTime;
    previousEnd = word.endTime;
  }
  return null;
}

/** Agreement ignores casing/Unicode representation but deliberately KEEPS
 * punctuation. A comma that is still changing stays provisional instead of
 * being frozen under the reader. */
export function normalizeAgreementWord(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function longestCommonWordPrefix(
  previous: readonly Pick<TimedTranscriptWord, 'text'>[],
  current: readonly Pick<TimedTranscriptWord, 'text'>[],
): number {
  const count = Math.min(previous.length, current.length);
  let index = 0;
  while (
    index < count &&
    normalizeAgreementWord(previous[index]!.text) === normalizeAgreementWord(current[index]!.text)
  ) {
    index += 1;
  }
  return index;
}

/** Highest 20-ms frame RMS. Whole-window RMS would classify a short word in a
 * long quiet tail as silence; the peak frame asks the question we actually
 * care about: did this rolling window contain speech-like energy at all? */
export function peakFrameRms(samples: Float32Array, sampleRate = 16_000): number {
  if (samples.length === 0) return 0;
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  let peak = 0;
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const end = Math.min(samples.length, offset + frameSamples);
    let energy = 0;
    for (let index = offset; index < end; index += 1) {
      const value = samples[index] as number;
      energy += value * value;
    }
    peak = Math.max(peak, Math.sqrt(energy / Math.max(1, end - offset)));
  }
  return peak;
}

export function padTrailingSilence(samples: Float32Array, sampleRate = 16_000, paddingMs = 240): Float32Array {
  const count = Math.max(0, Math.round((Math.max(0, paddingMs) / 1_000) * sampleRate));
  const padded = new Float32Array(samples.length + count);
  padded.set(samples);
  return padded;
}

/** Conservative word-boundary join used both for preview and final insertion. */
export function appendTranscriptSegment(current: string, segment: string): string {
  const before = current.trimEnd();
  const next = segment.trim();
  if (!next) return before;
  if (!before) return next;
  if (/^[,.;:!?%)\]}”’]/u.test(next) || /[(\[{“‘]$/u.test(before)) return `${before}${next}`;
  return `${before} ${next}`;
}

function wordsText(words: readonly Pick<TimedTranscriptWord, 'text'>[]): string {
  return words.reduce((text, word) => appendTranscriptSegment(text, word.text), '');
}

interface AbsoluteWord extends TimedTranscriptWord {
  startSample: number;
  endSample: number;
}

export interface LiveTranscriptionStats {
  decodeCount: number;
  discardedPasses: number;
  forcedAudioDropMs: number;
  /** Retained real microphone audio, before decoder-only silence padding. */
  maxDecodedAudioMs: number;
  /** Exact largest PCM duration handed to the model, including padding. */
  maxModelInputAudioMs: number;
  firstVisibleAudioMs: number | null;
  firstVisibleProcessingMs: number | null;
  /** Committed words are append-only by construction. */
  committedRevisionCount: 0;
  provisionalRewriteCount: number;
  iterationAudioMs: number[];
  iterationModelInputAudioMs: number[];
  iterationProcessingMs: number[];
}

export interface LiveTranscriptSnapshot {
  committed: string;
  provisional: string;
  text: string;
  complete: boolean;
  stats: LiveTranscriptionStats;
}

export interface LocalAgreementTranscriberOptions {
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<TranscriptHypothesis>;
  onUpdate(snapshot: LiveTranscriptSnapshot): void;
  onPendingChange?(pending: number): void;
  onDiscard?(reason: HypothesisDiscardReason): void;
  onError?(error: unknown): void;
  sampleRate?: number;
  intervalMs?: number;
  maxBufferMs?: number;
  contextMs?: number;
  edgeGuardMs?: number;
  paddingMs?: number;
  minAudioMs?: number;
  minPassConfidence?: number;
  minWordConfidence?: number;
  minStableWords?: number;
  minPeakRms?: number;
}

type Waiter = { resolve(snapshot: LiveTranscriptSnapshot): void; reject(error: unknown): void };

/** One capture generation. It owns no browser globals and is deterministic
 * under an injected transcriber, so timing/trim/coalescing are unit-testable. */
export class LocalAgreementTranscriber {
  private readonly options: LocalAgreementTranscriberOptions;
  private readonly sampleRate: number;
  private readonly intervalSamples: number;
  private readonly maxBufferSamples: number;
  private readonly contextSamples: number;
  private readonly edgeGuardSamples: number;
  private readonly paddingMs: number;
  private readonly minAudioSamples: number;
  private readonly minPassConfidence: number;
  private readonly minWordConfidence: number;
  private readonly minStableWords: number;
  private readonly minPeakRms: number;
  private readonly controller = new AbortController();
  private readonly waiters: Waiter[] = [];

  private buffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private bufferStartSample = 0;
  private totalSamples = 0;
  private lastSnapshotEndSample = 0;
  private committedThroughSample = 0;
  private committedWords: AbsoluteWord[] = [];
  private provisionalWords: AbsoluteWord[] = [];
  private previousWords: AbsoluteWord[] | null = null;
  private previousSnapshotEndSample = 0;

  private accepting = true;
  private requested = false;
  private processing = false;
  private finishing = false;
  private cancelled = false;
  private completed = false;
  private failure: unknown = null;
  private pending = 0;

  private readonly stats: LiveTranscriptionStats = {
    decodeCount: 0,
    discardedPasses: 0,
    forcedAudioDropMs: 0,
    maxDecodedAudioMs: 0,
    maxModelInputAudioMs: 0,
    firstVisibleAudioMs: null,
    firstVisibleProcessingMs: null,
    committedRevisionCount: 0,
    provisionalRewriteCount: 0,
    iterationAudioMs: [],
    iterationModelInputAudioMs: [],
    iterationProcessingMs: [],
  };

  constructor(options: LocalAgreementTranscriberOptions) {
    this.options = options;
    this.sampleRate = finitePositive(options.sampleRate, 16_000);
    this.intervalSamples = millisecondsToSamples(options.intervalMs, LIVE_TRANSCRIPTION_INTERVAL_MS, this.sampleRate);
    this.maxBufferSamples = millisecondsToSamples(
      options.maxBufferMs,
      LIVE_TRANSCRIPTION_MAX_BUFFER_MS,
      this.sampleRate,
    );
    this.contextSamples = millisecondsToSamples(
      options.contextMs,
      LIVE_TRANSCRIPTION_CONTEXT_MS,
      this.sampleRate,
      true,
    );
    this.edgeGuardSamples = millisecondsToSamples(
      options.edgeGuardMs,
      LIVE_TRANSCRIPTION_EDGE_GUARD_MS,
      this.sampleRate,
      true,
    );
    this.paddingMs = finiteNonNegative(options.paddingMs, LIVE_TRANSCRIPTION_PADDING_MS);
    this.minAudioSamples = millisecondsToSamples(options.minAudioMs, LIVE_TRANSCRIPTION_MIN_AUDIO_MS, this.sampleRate);
    this.minPassConfidence = finiteNonNegative(options.minPassConfidence, LIVE_TRANSCRIPTION_MIN_PASS_CONFIDENCE);
    this.minWordConfidence = finiteNonNegative(options.minWordConfidence, LIVE_TRANSCRIPTION_MIN_WORD_CONFIDENCE);
    this.minStableWords =
      Number.isSafeInteger(options.minStableWords) && (options.minStableWords ?? 0) > 0
        ? (options.minStableWords as number)
        : LIVE_TRANSCRIPTION_MIN_STABLE_WORDS;
    this.minPeakRms = finiteNonNegative(options.minPeakRms, LIVE_TRANSCRIPTION_MIN_PEAK_RMS);
  }

  get pendingDecodes(): number {
    return this.pending;
  }

  push(samples: Float32Array): void {
    if (!this.accepting || this.cancelled || this.completed || samples.length === 0) return;
    this.buffer = concatFloat32([this.buffer, samples]);
    this.totalSamples += samples.length;
    if (this.totalSamples - this.lastSnapshotEndSample >= this.intervalSamples) this.requestDecode();
  }

  /** Complete using the newest bounded live hypothesis. Product dictation uses
   * `stop()` followed by a clean full-recording batch pass, but this terminal
   * operation keeps the controller complete and independently reusable. */
  finish(): Promise<LiveTranscriptSnapshot> {
    this.accepting = false;
    this.finishing = true;
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.completed) return Promise.resolve(this.snapshot());
    if (this.cancelled) return Promise.resolve(this.snapshot());
    const promise = new Promise<LiveTranscriptSnapshot>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.requestDecode();
    return promise;
  }

  /** Logical stop for the product's final batch handoff. The active WASM call
   * may finish physically, but no late preview can publish over the final text. */
  stop(): LiveTranscriptSnapshot {
    if (!this.cancelled && !this.completed) {
      this.accepting = false;
      this.cancelled = true;
      this.requested = false;
      this.controller.abort();
      this.setPending(0);
      this.settleWaiters();
    }
    return this.snapshot();
  }

  cancel(): void {
    this.stop();
  }

  snapshot(): LiveTranscriptSnapshot {
    const committed = wordsText(this.committedWords);
    const provisional = wordsText(this.provisionalWords);
    return {
      committed,
      provisional,
      text: appendTranscriptSegment(committed, provisional),
      complete: this.completed,
      stats: {
        ...this.stats,
        iterationAudioMs: [...this.stats.iterationAudioMs],
        iterationModelInputAudioMs: [...this.stats.iterationModelInputAudioMs],
        iterationProcessingMs: [...this.stats.iterationProcessingMs],
      },
    };
  }

  private requestDecode(): void {
    if (this.cancelled || this.completed || this.failure !== null) return;
    this.requested = true;
    if (!this.processing) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.processing || this.cancelled || this.completed || this.failure !== null) return;
    this.processing = true;
    try {
      while (!this.cancelled && !this.completed && this.failure === null && this.requested) {
        this.requested = false;
        this.enforceBufferBound();

        const audio = this.buffer.slice();
        const snapshotStartSample = this.bufferStartSample;
        const snapshotEndSample = snapshotStartSample + audio.length;
        this.lastSnapshotEndSample = snapshotEndSample;

        if (audio.length >= this.minAudioSamples) {
          if (peakFrameRms(audio, this.sampleRate) < this.minPeakRms) {
            this.discard('silence');
          } else {
            const modelAudio = padTrailingSilence(audio, this.sampleRate, this.paddingMs);
            this.stats.decodeCount += 1;
            const audioMs = (audio.length / this.sampleRate) * 1_000;
            const modelInputAudioMs = (modelAudio.length / this.sampleRate) * 1_000;
            this.stats.iterationAudioMs.push(audioMs);
            this.stats.iterationModelInputAudioMs.push(modelInputAudioMs);
            this.stats.maxDecodedAudioMs = Math.max(this.stats.maxDecodedAudioMs, audioMs);
            this.stats.maxModelInputAudioMs = Math.max(this.stats.maxModelInputAudioMs, modelInputAudioMs);
            this.setPending(1);
            let hypothesis: TranscriptHypothesis;
            try {
              hypothesis = await this.options.transcribe(modelAudio, this.controller.signal);
            } finally {
              this.setPending(0);
            }
            if (this.cancelled) return;
            const processingMs = Math.max(0, hypothesis.processingMs ?? 0);
            this.stats.iterationProcessingMs.push(processingMs);
            this.applyHypothesis(hypothesis, snapshotStartSample, snapshotEndSample, audio.length);
          }
        }

        if (this.finishing) {
          if (this.totalSamples > snapshotEndSample) {
            this.requested = true;
            continue;
          }
          this.completeCurrentHypothesis();
          break;
        }

        // Audio may have arrived while the WASM call was running. Skip every
        // stale cadence boundary and immediately decode only the newest state.
        if (this.totalSamples - this.lastSnapshotEndSample >= this.intervalSamples) this.requested = true;
      }
    } catch (error) {
      if (!this.cancelled) {
        this.failure = error;
        this.accepting = false;
        this.requested = false;
        this.options.onError?.(error);
      }
    } finally {
      this.processing = false;
      this.setPending(0);
      this.settleWaiters();
      if (this.requested && !this.cancelled && !this.completed && this.failure === null) void this.pump();
    }
  }

  private applyHypothesis(
    hypothesis: TranscriptHypothesis,
    snapshotStartSample: number,
    snapshotEndSample: number,
    actualAudioSamples: number,
  ): void {
    const reason = unreadableTranscriptReason(hypothesis, {
      requireTimestamps: true,
      audioMs:
        ((actualAudioSamples + Math.round((this.paddingMs / 1_000) * this.sampleRate)) / this.sampleRate) * 1_000,
      minConfidence: this.minPassConfidence,
    });
    if (reason !== null) {
      this.discard(reason);
      return;
    }

    let candidate = hypothesis.words
      // Do not publish a hallucinated token whose timestamp begins wholly in
      // the synthetic trailing silence.
      .filter(word => word.startTime * this.sampleRate < actualAudioSamples)
      .map<AbsoluteWord>(word => ({
        ...word,
        startSample: snapshotStartSample + Math.round(word.startTime * this.sampleRate),
        endSample: snapshotStartSample + Math.round(word.endTime * this.sampleRate),
      }))
      .filter(word => word.endSample > this.committedThroughSample + Math.round(this.sampleRate * 0.08));

    candidate = this.dropCommittedOverlap(candidate);
    if (candidate.length === 0) {
      this.discard('empty');
      return;
    }

    const before = wordsText(this.provisionalWords);
    const agreed = this.previousWords === null ? 0 : longestCommonWordPrefix(this.previousWords, candidate);
    let commitCount = 0;
    if (agreed >= this.minStableWords) {
      const previousSafeEnd = this.previousSnapshotEndSample - this.edgeGuardSamples;
      for (let index = 0; index < agreed; index += 1) {
        const word = candidate[index]!;
        if (word.endSample > previousSafeEnd) break;
        if (word.confidence !== undefined && word.confidence < this.minWordConfidence) break;
        commitCount = index + 1;
      }
      if (commitCount < this.minStableWords) commitCount = 0;
    }

    if (commitCount > 0) {
      const newlyCommitted = candidate.slice(0, commitCount);
      this.committedWords.push(...newlyCommitted);
      this.committedThroughSample = Math.max(
        this.committedThroughSample,
        newlyCommitted.at(-1)?.endSample ?? this.committedThroughSample,
      );
      candidate = candidate.slice(commitCount);
      this.trimCommittedAudio();
    }

    this.provisionalWords = candidate;
    this.previousWords = candidate;
    this.previousSnapshotEndSample = snapshotEndSample;
    const after = wordsText(candidate);
    if (before && before !== after) this.stats.provisionalRewriteCount += 1;

    const snapshot = this.snapshot();
    if (snapshot.text && this.stats.firstVisibleAudioMs === null) {
      this.stats.firstVisibleAudioMs = (snapshotEndSample / this.sampleRate) * 1_000;
      this.stats.firstVisibleProcessingMs = Math.max(0, hypothesis.processingMs ?? 0);
    }
    this.options.onUpdate(this.snapshot());
  }

  /** Timestamp overlap is deliberately kept for encoder context. Remove the
   * longest (up to five words) committed-suffix/candidate-prefix match, the
   * same defensive n-gram boundary strategy used by whisper_streaming. */
  private dropCommittedOverlap(words: AbsoluteWord[]): AbsoluteWord[] {
    if (this.committedWords.length === 0 || words.length === 0) return words;
    if (words[0]!.startSample > this.committedThroughSample + this.contextSamples + this.edgeGuardSamples) return words;
    const limit = Math.min(5, this.committedWords.length, words.length);
    let matched = 0;
    for (let count = 1; count <= limit; count += 1) {
      const committed = this.committedWords.slice(-count);
      const candidate = words.slice(0, count);
      if (
        committed.every(
          (word, index) => normalizeAgreementWord(word.text) === normalizeAgreementWord(candidate[index]!.text),
        )
      ) {
        matched = count;
      }
    }
    return matched === 0 ? words : words.slice(matched);
  }

  private trimCommittedAudio(): void {
    const trimThrough = Math.max(this.bufferStartSample, this.committedThroughSample - this.contextSamples);
    this.trimBufferTo(trimThrough, false);
  }

  private enforceBufferBound(): void {
    if (this.buffer.length <= this.maxBufferSamples) return;
    const excess = this.buffer.length - this.maxBufferSamples;
    this.trimBufferTo(this.bufferStartSample + excess, true);
    // A rolling-window jump breaks the "same prefix" premise. The next pass is
    // visible immediately but must earn a fresh second agreeing pass.
    this.previousWords = null;
    this.previousSnapshotEndSample = 0;
  }

  private trimBufferTo(absoluteSample: number, forced: boolean): void {
    const count = Math.min(this.buffer.length, Math.max(0, Math.round(absoluteSample - this.bufferStartSample)));
    if (count === 0) return;
    this.buffer = this.buffer.slice(count);
    this.bufferStartSample += count;
    if (forced) this.stats.forcedAudioDropMs += (count / this.sampleRate) * 1_000;
  }

  private discard(reason: HypothesisDiscardReason): void {
    this.stats.discardedPasses += 1;
    this.previousWords = null;
    this.previousSnapshotEndSample = 0;
    this.options.onDiscard?.(reason);
  }

  private completeCurrentHypothesis(): void {
    if (this.completed) return;
    this.committedWords.push(...this.provisionalWords);
    this.provisionalWords = [];
    this.previousWords = null;
    this.completed = true;
    this.accepting = false;
    this.options.onUpdate(this.snapshot());
  }

  private setPending(next: number): void {
    if (this.pending === next) return;
    this.pending = next;
    this.options.onPendingChange?.(next);
  }

  private settleWaiters(): void {
    if (!this.completed && this.failure === null && !this.cancelled) return;
    const waiters = this.waiters.splice(0);
    const snapshot = this.snapshot();
    for (const waiter of waiters) {
      if (this.failure !== null) waiter.reject(this.failure);
      else waiter.resolve(snapshot);
    }
  }
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function millisecondsToSamples(
  value: number | undefined,
  fallback: number,
  sampleRate: number,
  allowZero = false,
): number {
  const milliseconds = allowZero ? finiteNonNegative(value, fallback) : finitePositive(value, fallback);
  return Math.max(allowZero ? 0 : 1, Math.round((milliseconds / 1_000) * sampleRate));
}

/* ---------- read-only live preview reducer ------------------------------- */

export interface LiveTranscriptState {
  generation: number;
  committed: string;
  provisional: string;
  complete: boolean;
}

export type LiveTranscriptEvent =
  | { type: 'reset'; generation: number }
  | {
      type: 'hypothesis';
      generation: number;
      committed: string;
      provisional: string;
    }
  | { type: 'complete'; generation: number; text: string };

export function emptyLiveTranscript(generation = 0): LiveTranscriptState {
  return { generation, committed: '', provisional: '', complete: false };
}

export function reduceLiveTranscript(state: LiveTranscriptState, event: LiveTranscriptEvent): LiveTranscriptState {
  if (event.type === 'reset') return emptyLiveTranscript(event.generation);
  if (event.generation !== state.generation) return state;
  if (event.type === 'complete') {
    return { generation: state.generation, committed: event.text.trim(), provisional: '', complete: true };
  }
  if (state.complete) return state;
  return {
    ...state,
    committed: event.committed.trim(),
    provisional: event.provisional.trim(),
  };
}

export function completeTranscriptText(state: LiveTranscriptState): string {
  return appendTranscriptSegment(state.committed, state.provisional);
}
