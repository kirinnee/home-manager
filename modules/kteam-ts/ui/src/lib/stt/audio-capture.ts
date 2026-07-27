// Microphone capture: the imperative shell.
//
// Everything in this feature that can be a pure function is one, somewhere
// else. What is left here is the part that genuinely cannot be: opening a
// device, and closing it again on every single exit path.
//
// THE ONE INVARIANT THAT MATTERS. A microphone that outlives the utterance is
// the fastest way to lose a reader's trust — the browser's recording indicator
// stays lit and there is nothing they can do about it. So `release()` is
// idempotent, it is called from `stop()`, from `cancel()`, from the error path,
// from `visibilitychange → hidden`, and from the hook's unmount cleanup, and it
// stops every track, disconnects every node, closes the AudioContext and
// revokes the worklet's blob URL. Whichever of those fires first wins; the rest
// are no-ops.
//
// AUDIO IS NEVER PERSISTED. Samples live in a JS array for the length of one
// utterance and are dropped as soon as the transcript comes back. Nothing is
// written to IndexedDB, CacheStorage, localStorage or a file, and no `Blob` of
// recorded audio is ever handed to anything that could store one.
//
// PERMISSION IS REQUESTED FROM THE GESTURE. `startCapture` calls
// `getUserMedia` as its first statement, with no `await` before it, so the call
// happens inside the pointerdown/keydown task and browsers treat it as
// user-initiated. Anything that needs to happen first must happen in the
// caller, before it calls this.

import { PCM16_WORKLET_NAME, createPcm16WorkletUrl } from '../../worklets/pcm16-worklet';

/** What the model wants, in both engines. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Hard ceiling on one utterance. 120 s of 16 kHz mono PCM16 is 3.84 MB — a
 *  sane POST body, and far longer than anyone dictates into a chat box. Capture
 *  stops itself at the limit rather than growing without bound. */
export const MAX_UTTERANCE_SECONDS = 120;

/** Below this an "utterance" is a button bounce, not speech. Returned to the
 *  caller as an empty result so it can stay silent instead of showing an
 *  error for a mis-tap. */
export const MIN_UTTERANCE_SECONDS = 0.25;

/** Backstop for the worklet's flush acknowledgement.
 *
 *  The acknowledgement normally arrives within one render quantum (~3 ms at
 *  48 kHz). This exists only so a worklet that has already crashed cannot hang
 *  `stop()` forever — it is not the mechanism, and anything that relies on it
 *  firing has already lost the tail of the utterance. */
export const FLUSH_TIMEOUT_MS = 250;

/* ---------- pure sample maths --------------------------------------------- */

/** Float32 [-1, 1] → PCM16LE.
 *
 *  The asymmetric scale (32767 up, 32768 down) is the correct one: the Int16
 *  range is not symmetric, and using 32768 in both directions clips every
 *  full-scale positive sample to -32768 — a loud click at the peak of the
 *  loudest word. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] as number;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/** PCM16LE → Float32 [-1, 1]. */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] as number;
    out[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return out;
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Resample to `to` Hz.
 *
 *  Downsampling uses a BOX AVERAGE over each output sample's input span, not
 *  nearest-neighbour decimation. Decimating 48 kHz to 16 kHz by taking every
 *  third sample folds everything above 8 kHz back down into the speech band as
 *  audible hiss, and an ASR model hears that as noise. A box filter is a crude
 *  low-pass, but it is a low-pass, and it costs one pass over the samples.
 *
 *  Upsampling (a context that runs BELOW 16 kHz — rare, but some mobile
 *  hardware does) is linear interpolation: there is no detail to recover, so
 *  anything cleverer would be theatre. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return input;
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const length = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(length);

  if (ratio > 1) {
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j += 1) {
        sum += input[j] as number;
        count += 1;
      }
      out[i] = count === 0 ? (input[Math.min(start, input.length - 1)] as number) : sum / count;
    }
    return out;
  }

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const low = Math.floor(position);
    const high = Math.min(input.length - 1, low + 1);
    const fraction = position - low;
    out[i] = (input[low] as number) * (1 - fraction) + (input[high] as number) * fraction;
  }
  return out;
}

/** Canonical 44-byte-header mono WAV around PCM16LE samples.
 *
 *  The daemon accepts raw `audio/L16` too, but WAV is what survives being
 *  saved, replayed or handed to a debugging tool without anyone having to
 *  remember the sample rate — and 44 bytes is not a size argument. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i] as number, true);
  return bytes;
}

/** Seconds of audio in a 16 kHz mono buffer. */
export function durationSeconds(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): number {
  return sampleRate > 0 ? samples.length / sampleRate : 0;
}

/* ---------- capture -------------------------------------------------------- */

export type CaptureErrorCode =
  | 'no-media-devices'
  | 'permission-denied'
  | 'no-microphone'
  | 'audio-unavailable'
  | 'capture-failed';

export class CaptureError extends Error {
  code: CaptureErrorCode;
  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

/** Map the DOMException names `getUserMedia` actually throws onto something the
 *  UI can say out loud. The names are the stable part of the contract; the
 *  messages are not. */
export function captureErrorFrom(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError('permission-denied', 'Microphone access was blocked for this site.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CaptureError('no-microphone', 'No microphone was found on this device.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new CaptureError('audio-unavailable', 'The microphone is in use by something else.');
  }
  const message = error instanceof Error ? error.message : 'Recording could not start.';
  return new CaptureError('capture-failed', message);
}

/** A visual-only branch off the recorder's already-running audio graph. */
export interface CaptureAnalyserTap {
  readonly analyser: AnalyserNode;
  /** Disconnect this branch without touching the recorder or its tracks. */
  disconnect(): void;
}

export interface CaptureMonitor {
  /** Create a tap from the recorder's exact MediaStream source and AudioContext.
   *  Returns null once capture has ended or if the browser rejects the branch. */
  createAnalyser(): CaptureAnalyserTap | null;
}

export interface CaptureSession {
  /** The exact device stream feeding this capture. Consumers may analyse it,
   *  but must never stop its tracks; this session remains the sole owner. */
  readonly stream: MediaStream;
  /** Read-only analyser factory sharing this capture's active audio graph. */
  readonly monitor: CaptureMonitor;
  /** The rate the samples were captured at, before resampling. */
  readonly inputSampleRate: number;
  /** True until the first `stop()`/`cancel()`/failure. */
  readonly active: boolean;
  /** Stop, release the device, and return the utterance as 16 kHz mono float.
   *  Idempotent: a second call returns the same buffer. */
  stop(): Promise<Float32Array>;
  /** Throw the audio away and release the device. Never rejects. */
  cancel(): void;
}

interface CaptureInternals {
  stream: MediaStream | null;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  processor: ScriptProcessorNode | null;
  blobUrl: string | null;
  onVisibility: (() => void) | null;
}

/** Why a capture ended without the caller asking it to. */
export type CaptureAbortReason = 'hidden';

export interface StartCaptureOptions {
  /** Called when the utterance hits `MAX_UTTERANCE_SECONDS` and capture stops
   *  itself. The caller should treat it exactly like the reader letting go. */
  onLimit?: () => void;
  /**
   * Called when the capture ends INVOLUNTARILY — today, only because the tab
   * went to the background and the microphone had to be closed.
   *
   * This exists because the alternative is a controller that still believes it
   * is recording: the button stays pressed-looking, a new utterance is refused,
   * and a later release hands the abandoned samples to an engine. The audio is
   * already discarded by the time this fires, so it is a notification, not a
   * decision — the caller's job is to return itself to idle.
   */
  onAbort?: (reason: CaptureAbortReason) => void;
  /** A copied view of every sample batch the recorder accepted, including the
   * worklet's final flush tail. This is the only PCM observation seam for live
   * transcription: consumers must segment it, never open a second stream or
   * stop the recorder-owned tracks. The callback is synchronous and its
   * buffer is independent, so retaining or mutating it cannot corrupt the
   * finished utterance. */
  onSamples?: (samples: Float32Array, inputSampleRate: number) => void;
  /** Injected for tests; defaults to the real one. */
  mediaDevices?: MediaDevices;
}

/** Does this browser expose a microphone API at all?
 *
 *  `navigator.mediaDevices` is UNDEFINED — not merely restricted — in an
 *  insecure context, which is the plain-HTTP tailnet case. The control is
 *  hidden rather than disabled when this is false: a disabled button implies
 *  "not right now", and this is "not on this URL, ever". */
export function hasMicrophoneApi(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === 'function';
}

export async function startCapture(options: StartCaptureOptions = {}): Promise<CaptureSession> {
  const devices = options.mediaDevices ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
  if (!devices || typeof devices.getUserMedia !== 'function') {
    throw new CaptureError('no-media-devices', 'This browser has no microphone API on this page.');
  }

  // FIRST STATEMENT, NO AWAIT ABOVE IT: the permission prompt has to be
  // attributable to the gesture that called us.
  const streamPromise = devices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const internals: CaptureInternals = {
    stream: null,
    context: null,
    source: null,
    worklet: null,
    processor: null,
    blobUrl: null,
    onVisibility: null,
  };
  const chunks: Float32Array[] = [];
  /** Visual analyser branches are independently disposable, but capture release
   *  is the final backstop so a forgotten UI cleanup cannot leak a node. */
  const monitorCleanups = new Set<() => void>();
  let captured = 0;
  let inputSampleRate = TARGET_SAMPLE_RATE;
  /** Is the microphone open, as the caller sees it. Goes false the moment the
   *  reader lets go. */
  let active = true;
  /** May `accept()` still keep samples?
   *
   *  DELIBERATELY SEPARATE FROM `active`, and the reason is a whole utterance's
   *  tail. The worklet batches ~4096 frames before posting, so at the instant
   *  of release it is holding up to 4095 unposted frames — 256 ms at 16 kHz.
   *  Those arrive in the flush that `stop()` asks for, which is AFTER the
   *  reader let go. Gating that arrival on `active` would silently drop the end
   *  of every single utterance: the last word, every time.
   *
   *  So `active` answers "is the mic open" and goes false immediately, while
   *  `accepting` stays true across the flush acknowledgement window and only
   *  then goes false. `cancel()` clears both at once, because a cancelled
   *  utterance wants no tail at all. */
  let accepting = true;
  let released = false;
  let result: Float32Array | null = null;
  /** In-flight `stop()`, so concurrent or repeated calls share one flush
   *  rather than each asking the worklet to flush again. */
  let stopping: Promise<Float32Array> | null = null;
  /** Resolves when the worklet acknowledges the flush. */
  let onFlushed: (() => void) | null = null;

  const release = (): void => {
    if (released) return;
    released = true;
    active = false;
    accepting = false;
    try {
      internals.worklet?.port.postMessage({ type: 'stop' });
    } catch {
      /* the port is already gone */
    }
    for (const cleanup of [...monitorCleanups]) cleanup();
    monitorCleanups.clear();
    internals.worklet?.disconnect();
    internals.processor?.disconnect();
    internals.source?.disconnect();
    for (const track of internals.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* a track that is already ended throws on some engines */
      }
    }
    void internals.context?.close().catch(() => undefined);
    if (internals.blobUrl) URL.revokeObjectURL(internals.blobUrl);
    if (internals.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', internals.onVisibility);
    }
    internals.stream = null;
    internals.context = null;
    internals.source = null;
    internals.worklet = null;
    internals.processor = null;
    internals.blobUrl = null;
    internals.onVisibility = null;
  };

  const maxSamples = (): number => MAX_UTTERANCE_SECONDS * inputSampleRate;

  const accept = (samples: Float32Array): void => {
    // `accepting`, NOT `active` — see the declaration. The flush that follows a
    // release arrives after the microphone is already closed, and it carries
    // the end of the utterance.
    if (!accepting || samples.length === 0) return;
    const remaining = maxSamples() - captured;
    if (remaining <= 0) return;
    const slice = samples.length <= remaining ? samples : samples.slice(0, remaining);
    chunks.push(slice);
    captured += slice.length;
    try {
      // Copy AFTER enforcing the hard ceiling, and notify BEFORE onLimit asks
      // the controller to stop. That ordering lets the live segmenter see the
      // final accepted samples exactly once. Callback failures are isolated
      // from microphone ownership; the controller's callback reports its own
      // queue/segmentation failures through state rather than throwing here.
      options.onSamples?.(slice.slice(), inputSampleRate);
    } catch {
      /* an observer must never strand the microphone */
    }
    if (captured >= maxSamples()) {
      // Stop the device immediately, then tell the caller. Waiting for the
      // caller to react would leave the mic open for another turn of the loop.
      // `accepting` stays true: the ceiling is already enforced by `remaining`
      // above, and the caller's `onLimit` handler runs the same flush as a
      // manual release.
      active = false;
      options.onLimit?.();
    }
  };

  let stream: MediaStream;
  try {
    stream = await streamPromise;
  } catch (error) {
    release();
    throw captureErrorFrom(error);
  }
  internals.stream = stream;

  try {
    // Asking the context for 16 kHz directly lets the browser do the
    // resampling in native code; when it refuses (or silently gives another
    // rate) `resample()` below picks up the difference.
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new CaptureError('audio-unavailable', 'This browser has no Web Audio support.');
    let context: AudioContext;
    try {
      context = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      context = new Ctor();
    }
    internals.context = context;
    inputSampleRate = context.sampleRate || TARGET_SAMPLE_RATE;
    // Autoplay policy can hand back a suspended context even from a gesture.
    if (context.state === 'suspended') await context.resume().catch(() => undefined);

    const source = context.createMediaStreamSource(stream);
    internals.source = source;

    if (typeof context.audioWorklet?.addModule === 'function' && typeof AudioWorkletNode === 'function') {
      const url = createPcm16WorkletUrl();
      internals.blobUrl = url;
      await context.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(context, PCM16_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = event => {
        const data = event.data as { type?: string; samples?: Float32Array } | null;
        if (data?.type === 'audio' && data.samples instanceof Float32Array) accept(data.samples);
        // The worklet flushes before it acknowledges, so by the time this
        // arrives the final partial batch is already in `chunks`.
        if (data?.type === 'flushed') {
          const resolve = onFlushed;
          onFlushed = null;
          resolve?.();
        }
      };
      internals.worklet = node;
      source.connect(node);
    } else {
      // ScriptProcessor is deprecated and runs on the main thread, which is
      // precisely why it is the FALLBACK and not the default. It is kept
      // because it is the only capture path on browsers without AudioWorklet,
      // and a silently missing microphone button would be worse than a little
      // main-thread work.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = event => {
        // Copied, not referenced: the event's buffer is reused by the engine.
        accept(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      internals.processor = processor;
      source.connect(processor);
      // A ScriptProcessor only pulls audio while it is connected to a
      // destination. A zero-gain node keeps it running without playing the
      // reader's own voice back at them.
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(context.destination);
    }

    // Backgrounding the tab must not leave the recording indicator lit.
    if (typeof document !== 'undefined') {
      const onVisibility = (): void => {
        if (document.visibilityState !== 'hidden') return;
        // Already ended — by a normal stop, a cancel, or an earlier hide. This
        // is not a second abort and must not be announced as one.
        if (released) return;
        // A backgrounded capture is ABANDONED, not paused. The samples are
        // dropped here rather than merely left unused, so that even a caller
        // that mishandles the notification cannot transcribe half an utterance
        // recorded before the reader switched away. `stop()` from now on
        // returns the empty result set below.
        active = false;
        accepting = false;
        stopping = null;
        chunks.length = 0;
        result = new Float32Array(0);
        release();
        options.onAbort?.('hidden');
      };
      internals.onVisibility = onVisibility;
      document.addEventListener('visibilitychange', onVisibility);
    }
  } catch (error) {
    release();
    throw captureErrorFrom(error);
  }

  const finish = (): Float32Array => {
    if (result) return result;
    const raw = concatFloat32(chunks);
    // Drop the references before resampling so the peak is one copy, not two.
    chunks.length = 0;
    result = resample(raw, inputSampleRate, TARGET_SAMPLE_RATE);
    return result;
  };

  const monitor: CaptureMonitor = {
    createAnalyser(): CaptureAnalyserTap | null {
      const context = internals.context;
      const source = internals.source;
      if (!active || released || !context || !source) return null;

      let analyser: AnalyserNode | null = null;
      let mute: GainNode | null = null;
      try {
        analyser = context.createAnalyser();
        mute = context.createGain();
        mute.gain.value = 0;
        source.connect(analyser);
        analyser.connect(mute);
        // Reaching a zero-gain destination keeps this branch actively pulled
        // without ever playing microphone input through the speakers.
        mute.connect(context.destination);
      } catch {
        try {
          if (analyser) source.disconnect(analyser);
        } catch {
          /* the source is already gone */
        }
        try {
          analyser?.disconnect();
        } catch {
          /* partially connected */
        }
        try {
          mute?.disconnect();
        } catch {
          /* partially connected */
        }
        return null;
      }

      let connected = true;
      const disconnect = (): void => {
        if (!connected) return;
        connected = false;
        monitorCleanups.delete(disconnect);
        try {
          source.disconnect(analyser);
        } catch {
          /* capture release may have disconnected the source first */
        }
        try {
          analyser.disconnect();
        } catch {
          /* already disconnected */
        }
        try {
          mute.disconnect();
        } catch {
          /* already disconnected */
        }
      };
      monitorCleanups.add(disconnect);
      return { analyser, disconnect };
    },
  };

  return {
    stream,
    monitor,
    get inputSampleRate() {
      return inputSampleRate;
    },
    get active() {
      return active;
    },
    async stop(): Promise<Float32Array> {
      if (result) return result;
      if (stopping) return stopping;
      // The microphone is closed to the caller from this instant. Sample
      // ACCEPTANCE stays open a moment longer — see `accepting`.
      active = false;
      stopping = (async () => {
        const worklet = internals.worklet;
        if (worklet) {
          try {
            // Wait for the worklet's own acknowledgement rather than guessing
            // with a timer: the flush carries the tail of the utterance, and a
            // timer that fires early would drop exactly the last word. The
            // timeout is a backstop for a worklet that has already died, not
            // the mechanism.
            const acknowledged = new Promise<void>(resolve => {
              onFlushed = resolve;
              setTimeout(resolve, FLUSH_TIMEOUT_MS);
            });
            worklet.port.postMessage({ type: 'flush' });
            await acknowledged;
          } catch {
            /* the port is already gone; whatever was batched is unreachable */
          } finally {
            onFlushed = null;
          }
        } else {
          // The ScriptProcessor path delivers on the main thread and buffers
          // nothing, so there is no tail to wait for — just one turn for an
          // in-flight callback to land.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        accepting = false;
        release();
        return finish();
      })();
      return stopping;
    },
    cancel(): void {
      // A cancelled utterance wants no tail at all, so acceptance closes with
      // the microphone rather than after it.
      active = false;
      accepting = false;
      stopping = null;
      chunks.length = 0;
      result = new Float32Array(0);
      release();
    },
  };
}
