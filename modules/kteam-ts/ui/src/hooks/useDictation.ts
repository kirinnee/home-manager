// The dictation controller — one local engine, silence-aligned live segments,
// and exactly one way for text to leave it.
//
// THE ONLY OUTPUTS ARE EDIT EVENTS. `onTranscriptEvent` publishes ordered local
// segments into the editable dictation panel; `onDraft` remains the fallback
// for a caller without that panel. There is no `onSubmit`, no `onSend`, and no
// path from a model result to a message send.
//
// TAP CONTROL. `start()` is called synchronously from the mic button so the
// permission prompt is attributable to that gesture; `stop()` is the panel's
// separate Stop action. The lower-level requesting-phase stop is still safe for
// programmatic controls: when the stream finally opens it is closed immediately
// rather than turning on after a stop was already requested.
//
// Every async boundary checks `UtteranceLatch`'s generation. Local ONNX work
// cannot be interrupted physically, so cancellation aborts queued calls and
// suppresses any result already inside WASM. The latch still owns the one live
// capture, so limit + release can flush only once and a backgrounded recording
// can publish nothing afterwards.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { ChatRecord } from '../types';
import {
  TARGET_SAMPLE_RATE,
  captureErrorFrom,
  hasMicrophoneApi,
  resample,
  startCapture,
  type CaptureMonitor,
} from '../lib/stt/audio-capture';
import { UtteranceLatch, type CaptureLike } from '../lib/stt/utterance';
import { readSttCapabilities } from '../lib/stt/capabilities';
import { insertTranscript, readSelection, type SelectionLike } from '../lib/stt/draft';
import { enhance } from '../lib/stt/enhancement';
import {
  LiveTranscriptionError,
  LocalSegmentQueue,
  appendTranscriptSegment,
  type LiveTranscriptEvent,
} from '../lib/stt/live-transcription';
import { SilenceSegmenter, type SpeechSegment } from '../lib/stt/silence-segmenter';
import { verifyWordOnly } from '../lib/stt/word-only-verifier';
import { sttDictionary, useSttSettings, type SttSettings } from '../lib/stt/stt-settings';

export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

export interface DictationError {
  code: string;
  message: string;
}

/** How many chat records to ask for when mining vocabulary. Larger than the
 *  5–10 messages actually used, because the page is full of tool calls and
 *  thinking blocks and only a fraction of any window is user/assistant text. */
export const CONTEXT_FETCH_LIMIT = 60;
export const MIN_CONTEXT_MESSAGES = 5;
export const MAX_CONTEXT_MESSAGES = 10;

/** The last 5–10 user/assistant TEXT messages, oldest first.
 *
 *  Tool calls, tool results, thinking and reasoning are excluded on purpose:
 *  they are full of paths, JSON and identifiers that would flood the fuzzy
 *  vocabulary with near-misses for ordinary words. Pure and exported so the
 *  extraction is tested without a network. */
export function extractContextMessages(records: readonly ChatRecord[] | undefined): string[] {
  if (!Array.isArray(records)) return [];
  const texts: string[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const type = (record as { type?: unknown }).type;
    if (type !== 'chat.user' && type !== 'chat.assistant.text') continue;
    const data = (record as { data?: { text?: unknown } }).data;
    const text = data?.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    texts.push(text);
  }
  return texts.slice(-MAX_CONTEXT_MESSAGES);
}

/** True when there is enough recent conversation to be worth mining. Below the
 *  floor the enhancer still runs — the dictionary alone is useful — it just has
 *  no conversational vocabulary to work with. */
export function hasUsableContext(messages: readonly string[]): boolean {
  return messages.length >= MIN_CONTEXT_MESSAGES;
}

export interface DictationDraftResult {
  /** The complete next draft value — not the transcript on its own. */
  text: string;
  /** Where the caret should sit afterwards. */
  caret: number;
}

export interface UseDictationOptions {
  /** Used only to fetch enhancement context. Dictation works without it. */
  sessionId?: string;
  /** Current draft, read at commit time rather than captured at start, so text
   *  typed DURING the utterance is not thrown away. */
  draft: string;
  /** The live textarea, for the caret. Optional: without it the transcript is
   *  appended at the end, which is the right fallback. */
  selectionRef?: { current: SelectionLike | null };
  onDraft: (result: DictationDraftResult) => void;
  /** Ordered local transcript events for an editable live panel. When present,
   * this consumer owns reconciliation and `onDraft` is not called: only its
   * explicit Insert may touch the composer. */
  onTranscriptEvent?: (event: LiveTranscriptEvent) => void;
  disabled?: boolean;
  /** Injected in tests. */
  settings?: SttSettings;
}

export interface DictationHandle {
  /** False when this browser has no microphone API at all. The control is
   *  HIDDEN in that case, not disabled: the API is absent (insecure context),
   *  not denied, and a disabled button would imply "not right now". */
  supported: boolean;
  phase: DictationPhase;
  /** True while the mic is actually open. Drives `aria-pressed`. */
  recording: boolean;
  /** Read-only analyser factory for the recorder's own stream/audio graph. */
  inputMonitor: CaptureMonitor | null;
  error: DictationError | null;
  /** Non-null while a transcript is being produced, for the status line. */
  busy: boolean;
  /** Local utterances waiting for or currently inside the one model decode. */
  pendingSegments: number;
  /** Call SYNCHRONOUSLY from a pointerdown/keydown handler. */
  start: () => void;
  /** Call from pointerup/keyup. Safe at any phase. */
  stop: () => void;
  /** Throw away whatever is in flight. Safe at any phase. */
  cancel: () => void;
  dismissError: () => void;
}

export interface LiveAudioRun {
  segmenter: SilenceSegmenter | null;
  inputSampleRate: number | null;
  queue: LocalSegmentQueue;
}

interface ActiveLiveRun extends LiveAudioRun {
  token: number;
  transcripts: string[];
  usesLiveConsumer: boolean;
  failed: boolean;
}

function enqueueSpeechSegments(run: LiveAudioRun, segments: readonly SpeechSegment[]): void {
  const inputRate = run.inputSampleRate;
  if (inputRate === null) return;
  for (const segment of segments) {
    const samples =
      inputRate === TARGET_SAMPLE_RATE ? segment.samples : resample(segment.samples, inputRate, TARGET_SAMPLE_RATE);
    run.queue.enqueue({ id: segment.id, samples });
  }
}

/** Feed the exact copied PCM accepted by capture into one rate-stable VAD.
 * Exported because this seam and `finishLiveAudioRun` are the critical hook
 * wiring: the final capture tail must pass here before the queue is closed. */
export function observeLiveSamples(run: LiveAudioRun, samples: Float32Array, inputSampleRate: number): void {
  if (run.segmenter === null) {
    run.inputSampleRate = inputSampleRate;
    run.segmenter = new SilenceSegmenter({ sampleRate: inputSampleRate });
  } else if (run.inputSampleRate !== inputSampleRate) {
    throw new Error('The microphone sample rate changed during recording.');
  }
  enqueueSpeechSegments(run, run.segmenter.push(samples));
}

/** Finish capture first (which synchronously observes its worklet flush tail),
 * then flush the VAD, then wait for the one serialized decode queue. Keeping
 * this ordering in one tested helper prevents a refactor from clipping the last
 * word or closing the queue before it is enqueued. */
export async function finishLiveAudioRun(capture: Pick<CaptureLike, 'stop'>, run: LiveAudioRun): Promise<void> {
  await capture.stop();
  if (run.segmenter) enqueueSpeechSegments(run, run.segmenter.flush());
  await run.queue.finish();
}

/** Local model/queue failures use stable codes just like capture failures. */
export function dictationErrorFromFailure(failure: unknown): DictationError | null {
  const code = (failure as { code?: unknown } | null)?.code;
  if (code === 'aborted') return null;
  if (failure instanceof LiveTranscriptionError) return { code: failure.code, message: failure.message };
  const message =
    failure instanceof Error ? failure.message : 'Local transcription failed before the phrase could be kept.';
  if (code === 'not-prepared') return { code: 'not-prepared', message };
  return { code: typeof code === 'string' ? code : 'unknown', message };
}

export function useDictation(options: UseDictationOptions): DictationHandle {
  const { sessionId, disabled } = options;
  const settingsHandle = useSttSettings();
  const settings = options.settings ?? settingsHandle.settings;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<DictationError | null>(null);
  // One transition when capture opens and one when it closes. The waveform
  // itself never updates React state; it paints its canvas behind a ref.
  const [inputMonitor, setInputMonitor] = useState<CaptureMonitor | null>(null);
  const [pendingSegments, setPendingSegments] = useState(0);

  // Refs, not state, for everything the async paths read: state would be a
  // stale closure by the time a local decode or context lookup resolves.
  //
  // The generation counter and the single-owner claim over the live capture
  // both live in `UtteranceLatch` — extracted so the races they exist to
  // prevent (limit + release, background + release) have real tests rather
  // than a comment. See `lib/stt/utterance.ts`.
  const latchRef = useRef<UtteranceLatch | null>(null);
  if (latchRef.current === null) latchRef.current = new UtteranceLatch();
  const latch = latchRef.current;

  const runRef = useRef<ActiveLiveRun | null>(null);
  const releaseRequested = useRef(false);
  const draftRef = useRef(options.draft);
  const optionsRef = useRef(options);
  draftRef.current = options.draft;
  optionsRef.current = options;

  const supported = useMemo(() => hasMicrophoneApi(), []);
  const capabilities = useMemo(() => readSttCapabilities(), []);

  /** Drop the current utterance entirely. An in-flight ONNX call may finish on
   * the CPU, but the queue and generation make it unable to publish. */
  const teardown = useCallback(
    (updateState = true) => {
      const run = runRef.current;
      runRef.current = null;
      run?.segmenter?.reset();
      // Invalidate first so the queue's pending callback is suppressed. This is
      // important during unmount, where even a harmless setState is teardown work
      // React should never receive.
      latch.cancel();
      run?.queue.cancel();
      releaseRequested.current = false;
      if (updateState) setPendingSegments(0);
    },
    [latch],
  );

  // Unmount and disable must both release the microphone. A recording
  // indicator that outlives the component is the fastest way to lose trust.
  useEffect(() => {
    return () => teardown(false);
  }, [teardown]);

  useEffect(() => {
    if (!disabled) return;
    teardown();
    setInputMonitor(null);
    setError(null);
    setPhase('idle');
  }, [disabled, teardown]);

  const commit = useCallback((transcript: string) => {
    const spoken = transcript.trim();
    if (spoken.length === 0) return;
    const current = optionsRef.current;
    const draft = draftRef.current;
    const [start, end] = readSelection(current.selectionRef?.current, draft);
    const result = insertTranscript(draft, start, end, spoken);
    // THE ONLY OUTPUT.
    current.onDraft(result);
  }, []);

  const enhanceTranscript = useCallback(
    async (raw: string, token: number): Promise<string> => {
      if (!settings.enhancement) return raw;
      const { entries } = sttDictionary(settings);
      let context: string[] = [];
      if (sessionId) {
        try {
          const page = await api.chatHistory(sessionId, undefined, CONTEXT_FETCH_LIMIT);
          const recent = extractContextMessages(page?.records);
          // The declared window is the LAST 5–10 messages. Below the floor
          // there is no window, so there is no mined vocabulary — the
          // dictionary still applies. Mining two messages would build a fuzzy
          // vocabulary out of whatever happened to be said first, which is
          // exactly the sparse-evidence guess this feature abstains from
          // everywhere else.
          context = hasUsableContext(recent) ? recent : [];
        } catch {
          // Enhancement context is a nicety. A failed history fetch must never
          // cost the reader their transcript, so it degrades to the dictionary
          // alone rather than surfacing an error.
          context = [];
        }
      }
      if (!latch.isCurrent(token)) return raw;
      const candidate = enhance({ text: raw, dictionary: entries, context, userContext: settings.userContext });
      if (candidate.text === raw) return raw;
      // THE VERIFIER IS NOT OPTIONAL AND NOT ADVISORY. If it refuses — for any
      // reason — the reader gets the model's own words, unmodified. Enhancement
      // can improve a transcript; it can never cost one.
      const verdict = verifyWordOnly(raw, candidate.text);
      return verdict.ok ? candidate.text : raw;
    },
    [latch, sessionId, settings],
  );

  const reportRunFailure = useCallback(
    (run: ActiveLiveRun, failure: unknown) => {
      if (run.failed || !latch.isCurrent(run.token)) return;
      const nextError = dictationErrorFromFailure(failure);
      if (nextError === null) return;
      run.failed = true;
      run.segmenter?.reset();
      run.queue.cancel();
      latch.abort(run.token);
      releaseRequested.current = false;
      setPendingSegments(0);
      setInputMonitor(null);
      setError(nextError);
      setPhase('error');
    },
    [latch],
  );

  /** Claim and finish this generation exactly once. The capture's flush first
   * delivers its final PCM through `onSamples`; only then do we flush the VAD
   * and close the SAME queue. A second whole-recording decode would duplicate
   * speech and could replace reader edits, so there is intentionally none. */
  const finish = useCallback(
    async (token: number): Promise<void> => {
      const capture = latch.claim(token);
      if (capture === null) return;
      const run = runRef.current;
      if (!run || run.token !== token) {
        capture.cancel();
        latch.settle(capture);
        return;
      }
      setInputMonitor(null);
      setPhase('transcribing');
      try {
        await finishLiveAudioRun(
          {
            stop: async () => {
              try {
                return await capture.stop();
              } catch (failure) {
                throw captureErrorFrom(failure);
              }
            },
          },
          run,
        );
        if (!latch.isCurrent(token) || run.failed) return;

        if (!latch.isCurrent(token) || run.failed) return;

        const current = optionsRef.current;
        if (run.usesLiveConsumer) {
          current.onTranscriptEvent?.({ type: 'complete', generation: token });
        } else {
          const complete = run.transcripts.reduce(appendTranscriptSegment, '');
          commit(complete);
        }
        setPendingSegments(0);
        setPhase('idle');
      } catch (failure) {
        if (latch.isCurrent(token)) reportRunFailure(run, failure);
      } finally {
        latch.settle(capture);
      }
    },
    [commit, latch, reportRunFailure],
  );

  const start = useCallback(() => {
    if (!supported || disabled) return;
    if (phase === 'requesting' || phase === 'recording') return;

    const previous = runRef.current;
    previous?.segmenter?.reset();
    previous?.queue.cancel();
    const token = latch.begin();
    let localEnginePromise: Promise<typeof import('../lib/stt/local-engine')> | null = null;
    let run!: ActiveLiveRun;
    const queue = new LocalSegmentQueue({
      transcribe: async (samples, signal) => {
        const engine = await (localEnginePromise ??= import('../lib/stt/local-engine'));
        const raw = await engine.transcribeLocal(samples, { capabilities, signal });
        if (raw.trim().length === 0) return raw;
        return enhanceTranscript(raw, token);
      },
      onTranscript: result => {
        if (!latch.isCurrent(token) || run.failed) return;
        run.transcripts.push(result.text);
        optionsRef.current.onTranscriptEvent?.({
          type: 'segment',
          generation: token,
          id: result.id,
          text: result.text,
        });
      },
      onPendingChange: pending => {
        if (latch.isCurrent(token) && !run.failed) setPendingSegments(pending);
      },
      onError: failure => reportRunFailure(run, failure),
    });
    run = {
      token,
      segmenter: null,
      inputSampleRate: null,
      queue,
      transcripts: [],
      usesLiveConsumer: typeof optionsRef.current.onTranscriptEvent === 'function',
      failed: false,
    };
    runRef.current = run;
    releaseRequested.current = false;
    setInputMonitor(null);
    setPendingSegments(0);
    setError(null);
    setPhase('requesting');
    optionsRef.current.onTranscriptEvent?.({ type: 'reset', generation: token });

    // NO await between here and `startCapture` — see the file header.
    const capturePromise = startCapture({
      onLimit: () => void finish(token),
      onSamples: (samples, inputSampleRate) => {
        if (!latch.isCurrent(token) || run.failed) return;
        try {
          observeLiveSamples(run, samples, inputSampleRate);
        } catch (failure) {
          reportRunFailure(run, failure);
        }
      },
      onAbort: () => {
        // The tab went to the background and the microphone closed underneath
        // us. Treat it as a cancellation: invalidate the generation so nothing
        // already in flight can commit, drop the request, and return the
        // control to idle — otherwise the button stays pressed-looking and the
        // next `start()` is refused for an utterance that no longer exists.
        if (!latch.abort(token)) return;
        run.segmenter?.reset();
        run.queue.cancel();
        releaseRequested.current = false;
        setPendingSegments(0);
        setInputMonitor(null);
        setError(null);
        setPhase('idle');
        optionsRef.current.onTranscriptEvent?.({ type: 'reset', generation: latch.generation });
      },
    });

    // Capture has already requested permission from the gesture. Warm the
    // prepared local model while the reader begins speaking so the first pause
    // does not also pay the full load delay. This never downloads: the loader's
    // readiness gate rejects an unprepared/evicted cache.
    localEnginePromise = import('../lib/stt/local-engine');
    void localEnginePromise
      .then(engine => engine.loadLocalEngine({ capabilities }))
      .catch(failure => reportRunFailure(run, failure));

    capturePromise
      .then(active => {
        // `attach` refuses a stale token, which is the case where a cancel or a
        // background abort landed while the permission prompt was still up.
        if (!latch.attach(token, active)) {
          active.cancel();
          return;
        }
        if (releaseRequested.current) {
          // The reader let go while the permission prompt was still up. Honour
          // the release rather than starting a recording nobody asked for.
          releaseRequested.current = false;
          void finish(token);
          return;
        }
        setInputMonitor(active.monitor);
        setPhase('recording');
      })
      .catch(failure => {
        if (!latch.isCurrent(token)) return;
        run.failed = true;
        run.segmenter?.reset();
        run.queue.cancel();
        const captureFailure = captureErrorFrom(failure);
        setPendingSegments(0);
        setInputMonitor(null);
        setError({ code: captureFailure.code, message: captureFailure.message });
        setPhase('error');
      });
  }, [capabilities, disabled, enhanceTranscript, finish, latch, phase, reportRunFailure, supported]);

  const stop = useCallback(() => {
    if (latch.liveCapture === null) {
      // Either the device has not opened yet — remember the release rather than
      // ignoring it — or something else already claimed this utterance (the
      // 120-second limit, a cancel, a background abort), in which case there is
      // nothing here to finish.
      if (phase === 'requesting') releaseRequested.current = true;
      return;
    }
    if (phase !== 'recording' && phase !== 'requesting') return;
    void finish(latch.generation);
  }, [finish, latch, phase]);

  const cancel = useCallback(() => {
    teardown();
    optionsRef.current.onTranscriptEvent?.({ type: 'reset', generation: latch.generation });
    setInputMonitor(null);
    setPendingSegments(0);
    setError(null);
    setPhase('idle');
  }, [latch, teardown]);

  const dismissError = useCallback(() => {
    setError(null);
    setPhase(current => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    supported,
    phase,
    recording: phase === 'recording',
    inputMonitor,
    busy: phase === 'transcribing' || pendingSegments > 0,
    pendingSegments,
    error,
    start,
    stop,
    cancel,
    dismissError,
  };
}
