// The dictation controller — one state machine, two engines, and exactly one
// way for text to leave it.
//
// THE ONE OUTPUT. `onDraft` is the only callback this hook ever invokes with a
// transcript. There is no `onSubmit`, no `onSend`, no "auto-send when the
// reader says 'send it'". A finished utterance becomes an edit to an editable
// draft and then the reader decides, exactly as if they had typed it. That is
// not a nicety — dictation is the one input surface where the user cannot see
// what they are about to commit until after it exists.
//
// HOLD-TO-TALK, NOT TOGGLE. `start()` must be called synchronously from a
// pointerdown/keydown handler so the permission prompt is attributable to the
// gesture; `stop()` comes from pointerup/keyup/pointercancel. The awkward case
// is real and handled: the reader can let go BEFORE the permission dialog is
// answered. `stop()` during `requesting` sets a flag, and when the stream
// finally opens it is closed again immediately with no audio — rather than the
// alternative, which is a microphone that turns itself on after the reader
// already let go.
//
// RACE SAFETY LIVES IN `lib/stt/utterance.ts`, not here — extracted so the
// three races it exists to prevent have real tests rather than a comment, since
// none of them can be reached through this app's `renderToStaticMarkup` test
// style. Every start takes a generation number and every async continuation —
// permission, capture, network, model — checks it before touching state, so a
// second utterance started while the first is still transcribing cannot have
// the first one's text land in the draft afterwards. A single-owner CLAIM over
// the live capture means the 120-second limit and a pointer release arriving
// together produce one transcription and one draft edit, not two. And a
// background abort invalidates the generation, so a capture the browser closed
// underneath us can never be transcribed afterwards. Aborting is real too: the
// daemon request carries an `AbortSignal` that `cancel()` fires.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { ChatRecord } from '../types';
import { captureErrorFrom, hasMicrophoneApi, startCapture } from '../lib/stt/audio-capture';
import { daemonTranscribe } from '../lib/stt/daemon-engine';
import { UtteranceLatch, finishUtterance } from '../lib/stt/utterance';
import { readSttCapabilities } from '../lib/stt/capabilities';
import { insertTranscript, readSelection, type SelectionLike } from '../lib/stt/draft';
import { enhance } from '../lib/stt/enhancement';
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
  error: DictationError | null;
  /** Non-null while a transcript is being produced, for the status line. */
  busy: boolean;
  /** Call SYNCHRONOUSLY from a pointerdown/keydown handler. */
  start: () => void;
  /** Call from pointerup/keyup. Safe at any phase. */
  stop: () => void;
  /** Throw away whatever is in flight. Safe at any phase. */
  cancel: () => void;
  dismissError: () => void;
}

export function useDictation(options: UseDictationOptions): DictationHandle {
  const { sessionId, disabled } = options;
  const settingsHandle = useSttSettings();
  const settings = options.settings ?? settingsHandle.settings;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<DictationError | null>(null);

  // Refs, not state, for everything the async paths read: state would be a
  // stale closure by the time a 300 ms network round trip resolves.
  //
  // The generation counter and the single-owner claim over the live capture
  // both live in `UtteranceLatch` — extracted so the races they exist to
  // prevent (limit + release, background + release) have real tests rather
  // than a comment. See `lib/stt/utterance.ts`.
  const latchRef = useRef<UtteranceLatch | null>(null);
  if (latchRef.current === null) latchRef.current = new UtteranceLatch();
  const latch = latchRef.current;

  const abort = useRef<AbortController | null>(null);
  const releaseRequested = useRef(false);
  const draftRef = useRef(options.draft);
  const optionsRef = useRef(options);
  draftRef.current = options.draft;
  optionsRef.current = options;

  const supported = useMemo(() => hasMicrophoneApi(), []);
  const capabilities = useMemo(() => readSttCapabilities(), []);

  /** Drop the current utterance entirely: cancel the capture (claimed or not),
   *  abort any in-flight request, and move to a generation no continuation can
   *  match. Idempotent. */
  const teardown = useCallback(() => {
    latch.cancel();
    abort.current?.abort();
    abort.current = null;
    releaseRequested.current = false;
  }, [latch]);

  // Unmount and disable must both release the microphone. A recording
  // indicator that outlives the component is the fastest way to lose trust.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  useEffect(() => {
    if (!disabled) return;
    teardown();
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
      const candidate = enhance({ text: raw, dictionary: entries, context });
      if (candidate.text === raw) return raw;
      // THE VERIFIER IS NOT OPTIONAL AND NOT ADVISORY. If it refuses — for any
      // reason — the reader gets the model's own words, unmodified. Enhancement
      // can improve a transcript; it can never cost one.
      const verdict = verifyWordOnly(raw, candidate.text);
      return verdict.ok ? candidate.text : raw;
    },
    [latch, sessionId, settings],
  );

  const transcribeSamples = useCallback(
    async (samples: Float32Array, signal: AbortSignal): Promise<string> => {
      if (settings.mode === 'local') {
        // Lazily imported so neither `parakeet.js` nor the ONNX Runtime is in
        // the graph of a reader who never turns local mode on.
        const { transcribeLocal } = await import('../lib/stt/local-engine');
        return transcribeLocal(samples, { capabilities });
      }
      return (await daemonTranscribe({ samples, language: settings.language, sessionId, signal })).text;
    },
    [capabilities, sessionId, settings.language, settings.mode],
  );

  /** Run the one finish this generation is allowed. `finishUtterance` claims
   *  the capture BEFORE its first await, so `onLimit` and a pointer release
   *  arriving together produce one transcription and one draft edit, not two. */
  const finish = useCallback(
    (token: number) =>
      finishUtterance(token, {
        latch,
        transcribe: transcribeSamples,
        refine: raw => enhanceTranscript(raw, token),
        commit,
        setPhase,
        setError,
        onController: controller => {
          abort.current = controller;
        },
      }),
    [commit, enhanceTranscript, latch, transcribeSamples],
  );

  const start = useCallback(() => {
    if (!supported || disabled) return;
    if (phase === 'requesting' || phase === 'recording') return;
    const token = latch.begin();
    releaseRequested.current = false;
    setError(null);
    setPhase('requesting');

    // NO await between here and `startCapture` — see the file header.
    startCapture({
      onLimit: () => void finish(token),
      onAbort: () => {
        // The tab went to the background and the microphone closed underneath
        // us. Treat it as a cancellation: invalidate the generation so nothing
        // already in flight can commit, drop the request, and return the
        // control to idle — otherwise the button stays pressed-looking and the
        // next `start()` is refused for an utterance that no longer exists.
        if (!latch.abort(token)) return;
        abort.current?.abort();
        abort.current = null;
        releaseRequested.current = false;
        setError(null);
        setPhase('idle');
      },
    })
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
        setPhase('recording');
      })
      .catch(failure => {
        if (!latch.isCurrent(token)) return;
        const captureFailure = captureErrorFrom(failure);
        setError({ code: captureFailure.code, message: captureFailure.message });
        setPhase('error');
      });
  }, [disabled, finish, latch, phase, supported]);

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
    setPhase('idle');
  }, [teardown]);

  const dismissError = useCallback(() => {
    setError(null);
    setPhase(current => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    supported,
    phase,
    recording: phase === 'recording',
    busy: phase === 'transcribing',
    error,
    start,
    stop,
    cancel,
    dismissError,
  };
}
