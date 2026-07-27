// Ordered local transcription plus the user-owned live text reducer.
//
// `parakeet.js` exposes a whole-buffer `transcribe()` call with no physical
// cancellation. This queue therefore permits exactly one decode at a time,
// caps backlog instead of growing latency without bound, and treats cancel as
// LOGICAL cancellation: the current WASM call may finish, but its result can no
// longer publish. A deterministic empty result gets one silence-padded retry;
// two empties are an explicit error, never invisible lost speech.
//
// The reducer below is the other half of the safety contract. The newest model
// result is provisional. When another result arrives, the CURRENT provisional
// value — including any reader edit — is appended to the CURRENT committed
// value. No model event ever assigns over committed text.

import { insertTranscript } from './draft';

export const EMPTY_RETRY_PADDING_MS = 240;
export const MAX_LIVE_TRANSCRIPTION_BACKLOG = 3;

export type LiveTranscriptionErrorCode = 'backlog' | 'empty-segment';

export class LiveTranscriptionError extends Error {
  readonly code: LiveTranscriptionErrorCode;

  constructor(code: LiveTranscriptionErrorCode, message: string) {
    super(message);
    this.name = 'LiveTranscriptionError';
    this.code = code;
  }
}

export interface QueuedSpeechSegment {
  id: number;
  samples: Float32Array;
}

export interface SegmentTranscript {
  id: number;
  text: string;
  /** 2 means the unpadded decode was empty and the padded retry won. */
  attempts: 1 | 2;
}

export interface LocalSegmentQueueOptions {
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
  onTranscript(result: SegmentTranscript): void;
  onPendingChange?(pending: number): void;
  onError?(error: unknown): void;
  sampleRate?: number;
  retryPaddingMs?: number;
  maxPending?: number;
}

export function padWithSilence(
  samples: Float32Array,
  sampleRate = 16_000,
  paddingMs = EMPTY_RETRY_PADDING_MS,
): Float32Array {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16_000;
  const padding = Math.max(0, Math.round((Math.max(0, paddingMs) / 1_000) * rate));
  if (padding === 0) return samples.slice();
  const padded = new Float32Array(padding + samples.length + padding);
  padded.set(samples, padding);
  return padded;
}

type Waiter = { resolve(): void; reject(error: unknown): void };

export class LocalSegmentQueue {
  private readonly options: LocalSegmentQueueOptions;
  private readonly sampleRate: number;
  private readonly retryPaddingMs: number;
  private readonly maxPending: number;
  private readonly controller = new AbortController();
  private readonly queued: QueuedSpeechSegment[] = [];
  private readonly waiters: Waiter[] = [];
  private processing = false;
  private accepting = true;
  private cancelled = false;
  private failure: unknown = null;
  private pendingCount = 0;

  constructor(options: LocalSegmentQueueOptions) {
    this.options = options;
    this.sampleRate =
      Number.isFinite(options.sampleRate) && (options.sampleRate ?? 0) > 0 ? (options.sampleRate as number) : 16_000;
    this.retryPaddingMs =
      Number.isFinite(options.retryPaddingMs) && (options.retryPaddingMs ?? -1) >= 0
        ? (options.retryPaddingMs as number)
        : EMPTY_RETRY_PADDING_MS;
    this.maxPending =
      Number.isSafeInteger(options.maxPending) && (options.maxPending ?? 0) > 0
        ? (options.maxPending as number)
        : MAX_LIVE_TRANSCRIPTION_BACKLOG;
  }

  get pending(): number {
    return this.pendingCount;
  }

  enqueue(segment: QueuedSpeechSegment): void {
    if (!this.accepting || this.cancelled) return;
    if (this.pendingCount >= this.maxPending) {
      throw new LiveTranscriptionError(
        'backlog',
        'Live transcription is falling behind on this device. Recording stopped before any speech could be silently dropped.',
      );
    }
    // The segmenter owns/reuses nothing after emission, but a defensive copy
    // makes that ownership boundary explicit and keeps queue tests honest.
    this.queued.push({ id: segment.id, samples: segment.samples.slice() });
    this.pendingCount += 1;
    this.options.onPendingChange?.(this.pendingCount);
    if (!this.processing) void this.pump();
  }

  /** Stop accepting and wait for the one in-flight job plus queued jobs. */
  finish(): Promise<void> {
    this.accepting = false;
    if (this.failure !== null) return Promise.reject(this.failure);
    if (!this.processing && this.queued.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Logical cancellation. The model may still be using the CPU, but no late
   * result or error can leave this object. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.accepting = false;
    this.controller.abort();
    this.queued.length = 0;
    this.pendingCount = 0;
    this.options.onPendingChange?.(0);
    this.settleWaiters();
  }

  private async pump(): Promise<void> {
    if (this.processing || this.cancelled) return;
    this.processing = true;
    try {
      while (!this.cancelled) {
        const segment = this.queued.shift();
        if (!segment) break;
        let attempts: 1 | 2 = 1;
        let text = (await this.options.transcribe(segment.samples, this.controller.signal)).trim();
        if (this.cancelled) return;
        if (text.length === 0) {
          attempts = 2;
          const padded = padWithSilence(segment.samples, this.sampleRate, this.retryPaddingMs);
          text = (await this.options.transcribe(padded, this.controller.signal)).trim();
          if (this.cancelled) return;
        }
        if (text.length === 0) {
          throw new LiveTranscriptionError(
            'empty-segment',
            'One voiced phrase produced no text, even after a silence-padded retry. Recording stopped rather than losing it invisibly.',
          );
        }
        this.options.onTranscript({ id: segment.id, text, attempts });
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        this.options.onPendingChange?.(this.pendingCount);
      }
    } catch (error) {
      if (!this.cancelled) {
        this.failure = error;
        this.accepting = false;
        this.queued.length = 0;
        this.pendingCount = 0;
        this.options.onPendingChange?.(0);
        this.options.onError?.(error);
      }
    } finally {
      this.processing = false;
      this.settleWaiters();
    }
  }

  private settleWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      if (this.failure !== null) waiter.reject(this.failure);
      else waiter.resolve();
    }
  }
}

/* ---------- reader-owned live text --------------------------------------- */

export interface LiveTranscriptState {
  generation: number;
  committed: string;
  provisional: string;
  nextSegmentId: number;
  complete: boolean;
}

export type LiveTranscriptEvent =
  | { type: 'reset'; generation: number }
  | { type: 'segment'; generation: number; id: number; text: string }
  | { type: 'complete'; generation: number };

export function emptyLiveTranscript(generation = 0): LiveTranscriptState {
  return { generation, committed: '', provisional: '', nextSegmentId: 0, complete: false };
}

/** Append exactly one model segment without reflowing anything the reader
 * typed. `insertTranscript` contributes only the conservative word-boundary
 * space rule used by final composer insertion. */
export function appendTranscriptSegment(current: string, segment: string): string {
  return insertTranscript(current, current.length, current.length, segment).text;
}

export function reduceLiveTranscript(state: LiveTranscriptState, event: LiveTranscriptEvent): LiveTranscriptState {
  if (event.type === 'reset') return emptyLiveTranscript(event.generation);
  if (event.generation !== state.generation) return state;
  if (event.type === 'complete') {
    return {
      ...state,
      committed: appendTranscriptSegment(state.committed, state.provisional),
      provisional: '',
      complete: true,
    };
  }
  if (event.id !== state.nextSegmentId || state.complete) return state;
  return {
    ...state,
    committed: appendTranscriptSegment(state.committed, state.provisional),
    provisional: event.text.trim(),
    nextSegmentId: state.nextSegmentId + 1,
  };
}

export function editCommittedTranscript(state: LiveTranscriptState, committed: string): LiveTranscriptState {
  return { ...state, committed };
}

export function editProvisionalTranscript(state: LiveTranscriptState, provisional: string): LiveTranscriptState {
  return { ...state, provisional };
}

export function completeTranscriptText(state: LiveTranscriptState): string {
  return appendTranscriptSegment(state.committed, state.provisional);
}
