// The microphone AudioWorklet — as SOURCE TEXT, deliberately.
//
// WHY THIS FILE HOLDS A STRING INSTEAD OF A CLASS.
//
// `audioWorklet.addModule(url)` fetches a URL and evaluates it inside
// AudioWorkletGlobalScope — a separate realm with no DOM, no bundler and no
// TypeScript. There are three ways to get a URL for a source file in this app
// and each of the file-based ones is broken here:
//
//   - `import url from './pcm16-worklet.ts?url'` — Vite copies the file
//     VERBATIM into the build output. The browser would receive TypeScript.
//   - `?raw` has the same problem one step later: the raw text is TypeScript.
//   - The realm has no `AudioWorkletProcessor`, `registerProcessor` or
//     `sampleRate` in `lib.dom`, so the file needs `declare` statements to
//     typecheck — and `declare class …` is not valid JavaScript, which is
//     exactly what a verbatim copy would ship.
//
// A Blob URL sidesteps all three, works identically in `vite dev` and in a
// production build, needs NO build-config patch and NO precache-manifest entry,
// and keeps the worklet out of the app-shell closure. The cost is that the
// processor is a string, so it gets a syntax test (`new Function(SOURCE)`) and
// a contract test instead of a type check.
//
// WHAT THE PROCESSOR DOES, and why any of it is on this thread at all:
// downsampling and Int16 conversion for a 30-second utterance is a few million
// operations. On the main thread that is jank in the middle of the composer;
// here it is invisible. The processor posts Float32 frames at the CONTEXT's
// sample rate and the main thread resamples once at the end — resampling in
// 128-sample blocks would need cross-block filter state for no benefit, since
// nothing consumes the audio until the reader lets go of the button.

/** The processor's registered name, shared with `audio-capture.ts`. */
export const PCM16_WORKLET_NAME = 'kteam-pcm16-capture';

/** Frames per posted message. 128-sample render quanta posted individually
 *  would be ~375 messages a second; batching to ~0.25 s keeps the message rate
 *  at four a second and the copy cost negligible. */
export const WORKLET_BATCH_FRAMES = 4096;

/** The worklet source, as plain ES2020 JavaScript.
 *
 *  Kept as a template literal with no interpolation of anything caller-supplied
 *  — this string is evaluated as code, so nothing dynamic is ever spliced into
 *  it. The two constants below are the only substitutions and both are
 *  compile-time literals from this module. */
export const PCM16_WORKLET_SOURCE = `
class KteamPcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batch = new Float32Array(${WORKLET_BATCH_FRAMES});
    this._filled = 0;
    this._stopped = false;
    this.port.onmessage = event => {
      const data = event && event.data;
      if (!data) return;
      if (data.type !== 'flush' && data.type !== 'stop') return;
      // Flush FIRST, acknowledge SECOND. Port messages arrive in order, so the
      // main thread is guaranteed to have taken the final partial batch before
      // it sees the acknowledgement — which is what lets it stop accepting
      // audio at a known point instead of guessing with a timer.
      this._flush();
      this.port.postMessage({ type: 'flushed' });
      if (data.type === 'stop') this._stopped = true;
    };
  }

  _flush() {
    if (this._filled === 0) return;
    const chunk = this._batch.slice(0, this._filled);
    this._filled = 0;
    this.port.postMessage({ type: 'audio', samples: chunk, sampleRate: sampleRate }, [chunk.buffer]);
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // Mono by contract: the capture constraints request one channel, and if the
    // browser hands us more we take the first rather than mixing, because a
    // silent second channel would halve the level of everything.
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this._batch[this._filled] = channel[i];
      this._filled += 1;
      if (this._filled === this._batch.length) this._flush();
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(PCM16_WORKLET_NAME)}, KteamPcm16Capture);
`;

/** Mint a Blob URL for the processor. The caller MUST revoke it once
 *  `addModule` has resolved — a leaked blob URL pins its bytes for the life of
 *  the document, and this one is minted per capture session. */
export function createPcm16WorkletUrl(): string {
  const blob = new Blob([PCM16_WORKLET_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
