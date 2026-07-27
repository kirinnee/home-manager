// The lifecycle of ONE utterance, extracted from React so it can be tested.
//
// Two things went wrong here that a `renderToStaticMarkup` test could never
// have caught, because both are about what happens between two awaits:
//
//   1. THE 120-SECOND LIMIT AND A POINTER RELEASE CAN ARRIVE TOGETHER. Capture
//      hits its ceiling and calls `onLimit`; a fraction of a second later the
//      reader lets go and the control calls `stop()`. `CaptureSession.stop()`
//      correctly shares one flush — but each CALLER continued past it, opened
//      its own AbortController, sent its own transcription request, and
//      committed its own copy of the text. The reader said one sentence and got
//      it twice in the draft.
//
//   2. BACKGROUNDING THE TAB ENDED THE CAPTURE AND TOLD NOBODY. The audio graph
//      released and the microphone closed, but the controller still believed it
//      was recording: the button stayed pressed-looking, `start()` refused a new
//      utterance, and a later release could still hand the abandoned samples to
//      an engine.
//
// Both are the same shape of bug — a capture with more than one owner — so they
// have one answer: a LATCH. Exactly one caller may ever take ownership of a
// capture, and an involuntary end invalidates the generation so no continuation
// that was already in flight can commit anything.
//
// Nothing in this file imports React or touches the DOM.

import { MIN_UTTERANCE_SECONDS, captureErrorFrom, durationSeconds } from './audio-capture';
import { SttRequestError } from './daemon-engine';

/** The slice of `CaptureSession` this lifecycle needs. Narrow on purpose: a
 *  test supplies two methods, not a Web Audio graph. */
export interface CaptureLike {
  stop(): Promise<Float32Array>;
  cancel(): void;
}

/**
 * Generation counter plus single-owner claim over the live capture.
 *
 * A GENERATION is one utterance. Every async continuation carries the token it
 * started with and checks `isCurrent` before touching anything, so a second
 * utterance started while the first is still transcribing cannot have the
 * first one's text land in the draft afterwards.
 *
 * The CLAIM is what stops two callers finishing the same utterance. `claim()`
 * moves the capture out of the live slot, so the second caller — whichever of
 * `onLimit` and `stop()` loses the race — gets `null` and does nothing.
 */
export class UtteranceLatch {
  private token = 0;
  /** Open and recording; nobody has taken it yet. */
  private live: CaptureLike | null = null;
  /** Claimed by a finish that is now running. Held so a cancel can still reach
   *  it — otherwise a claimed capture would be unreachable and its microphone
   *  would outlive the component. */
  private owned: CaptureLike | null = null;

  get generation(): number {
    return this.token;
  }

  get liveCapture(): CaptureLike | null {
    return this.live;
  }

  get ownedCapture(): CaptureLike | null {
    return this.owned;
  }

  isCurrent(token: number): boolean {
    return token === this.token;
  }

  /** Cancel whatever is held and move to a fresh generation. The single
   *  primitive under `begin`, `abort` and `cancel` — they differ only in who
   *  calls them and what the caller does next. */
  private invalidate(): number {
    const live = this.live;
    const owned = this.owned;
    this.live = null;
    this.owned = null;
    // A capture that is already released treats this as a no-op; one that is
    // not gets its microphone closed. Either way it must not throw here.
    try {
      live?.cancel();
    } catch {
      /* already gone */
    }
    try {
      owned?.cancel();
    } catch {
      /* already gone */
    }
    this.token += 1;
    return this.token;
  }

  /** Start a new utterance and return its token. */
  begin(): number {
    return this.invalidate();
  }

  /** The capture opened. Returns false when the token is already stale — the
   *  caller MUST cancel the capture it was handed, because this latch will not
   *  be holding it. */
  attach(token: number, capture: CaptureLike): boolean {
    if (token !== this.token) return false;
    this.live = capture;
    return true;
  }

  /**
   * THE LATCH. Returns the capture to exactly one caller, ever.
   *
   * `onLimit` and a pointer release both call this. The first gets the capture
   * and owns the whole finish; the second gets `null` and returns without
   * opening a request or committing anything.
   */
  claim(token: number): CaptureLike | null {
    if (token !== this.token) return null;
    const capture = this.live;
    if (capture === null) return null;
    this.live = null;
    this.owned = capture;
    return capture;
  }

  /** The finish that claimed `capture` is done with it. */
  settle(capture: CaptureLike): void {
    if (this.owned === capture) this.owned = null;
  }

  /**
   * An INVOLUNTARY end — the tab went to the background and the browser closed
   * the microphone underneath us.
   *
   * Bumps the generation, so a finish that is already awaiting a flush or a
   * network round trip cannot commit; and cancels the capture, so its samples
   * are unreachable rather than merely unused. Returns false when the token was
   * already stale, which is how a late or duplicated notification becomes a
   * no-op.
   */
  abort(token: number): boolean {
    if (token !== this.token) return false;
    this.invalidate();
    return true;
  }

  /** Reader-initiated cancel, unmount, or the control being disabled. */
  cancel(): void {
    this.invalidate();
  }
}

export type FinishPhase = 'transcribing' | 'idle' | 'error';

export interface FinishError {
  code: string;
  message: string;
}

export interface FinishDeps {
  latch: UtteranceLatch;
  /** Raw text from whichever engine the reader selected. */
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
  /** Enhancer plus the independent verifier. Returns the raw text unchanged
   *  whenever it declines — enhancement can improve a transcript, never cost
   *  one. */
  refine(raw: string): Promise<string>;
  /** THE ONLY OUTPUT. There is no send callback anywhere in this file. */
  commit(text: string): void;
  setPhase(phase: FinishPhase): void;
  setError(error: FinishError): void;
  /** Publishes the in-flight request's controller so a cancel can abort it,
   *  and `null` once it is done. */
  onController(controller: AbortController | null): void;
  /** Below this, an "utterance" is a button bounce. */
  minSeconds?: number;
}

/**
 * Take one utterance from released microphone to committed draft text.
 *
 * Safe to call more than once for the same generation: the second call claims
 * nothing and returns immediately. That is the entire fix for the limit-plus-
 * release double commit, and it holds even when both calls arrive before the
 * worklet flush resolves — because the claim happens BEFORE the first await.
 */
export async function finishUtterance(token: number, deps: FinishDeps): Promise<void> {
  const capture = deps.latch.claim(token);
  if (capture === null) return;
  const minSeconds = deps.minSeconds ?? MIN_UTTERANCE_SECONDS;

  try {
    let samples: Float32Array;
    try {
      samples = await capture.stop();
    } catch (captureFailure) {
      if (!deps.latch.isCurrent(token)) return;
      const failure = captureErrorFrom(captureFailure);
      deps.setError({ code: failure.code, message: failure.message });
      deps.setPhase('error');
      return;
    }
    // Backgrounding, a cancel, or a new utterance may have landed during the
    // flush. Any of them invalidates this one, silently.
    if (!deps.latch.isCurrent(token)) return;

    if (durationSeconds(samples) < minSeconds) {
      // A mis-tap, not a failure. Say nothing.
      deps.setPhase('idle');
      return;
    }

    deps.setPhase('transcribing');
    const controller = new AbortController();
    deps.onController(controller);

    try {
      const raw = await deps.transcribe(samples, controller.signal);
      if (!deps.latch.isCurrent(token)) return;
      const text = await deps.refine(raw);
      if (!deps.latch.isCurrent(token)) return;
      deps.commit(text);
      deps.setPhase('idle');
    } catch (failure) {
      if (!deps.latch.isCurrent(token)) return;
      if (failure instanceof SttRequestError && failure.code === 'aborted') {
        deps.setPhase('idle');
        return;
      }
      const message =
        failure instanceof SttRequestError
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : 'Transcription failed.';
      const code = failure instanceof SttRequestError ? failure.code : 'unknown';
      deps.setError({ code, message });
      deps.setPhase('error');
    } finally {
      if (deps.latch.isCurrent(token)) deps.onController(null);
    }
  } finally {
    deps.latch.settle(capture);
  }
}
