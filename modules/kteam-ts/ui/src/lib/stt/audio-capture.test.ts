import { describe, expect, test } from 'bun:test';
import type { CaptureErrorCode } from './audio-capture';
import {
  CaptureError,
  MAX_UTTERANCE_SECONDS,
  MIN_UTTERANCE_SECONDS,
  TARGET_SAMPLE_RATE,
  captureErrorFrom,
  concatFloat32,
  durationSeconds,
  encodeWav,
  floatToPcm16,
  hasMicrophoneApi,
  pcm16ToFloat,
  resample,
  startCapture,
} from './audio-capture';

describe('floatToPcm16 / pcm16ToFloat', () => {
  test('full-scale positive does NOT wrap to the negative rail', () => {
    // The bug this asserts against: scaling +1.0 by 32768 overflows Int16 and
    // becomes -32768 — a loud click at the peak of the loudest word.
    expect(floatToPcm16(new Float32Array([1]))[0]).toBe(32767);
  });

  test('full-scale negative uses the full range', () => {
    expect(floatToPcm16(new Float32Array([-1]))[0]).toBe(-32768);
  });

  test('clamps beyond the rails instead of wrapping', () => {
    expect(Array.from(floatToPcm16(new Float32Array([2, -2])))).toEqual([32767, -32768]);
  });

  test('silence stays silence', () => {
    expect(Array.from(floatToPcm16(new Float32Array([0, 0])))).toEqual([0, 0]);
  });

  test('round-trips within one quantisation step', () => {
    const source = new Float32Array([0, 0.25, -0.25, 0.5, -0.75, 1, -1]);
    const back = pcm16ToFloat(floatToPcm16(source));
    for (let i = 0; i < source.length; i += 1) {
      expect(Math.abs((back[i] as number) - (source[i] as number))).toBeLessThan(1 / 32767);
    }
  });
});

describe('concatFloat32', () => {
  test('joins in order and preserves length', () => {
    const joined = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });

  test('an empty list is an empty buffer', () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});

describe('resample', () => {
  test('is a no-op at the same rate', () => {
    const source = new Float32Array([1, 2, 3]);
    expect(resample(source, 16_000, 16_000)).toBe(source);
  });

  test('downsampling 48k → 16k produces a third of the samples', () => {
    const source = new Float32Array(48_000).fill(0.5);
    const out = resample(source, 48_000, TARGET_SAMPLE_RATE);
    expect(out.length).toBe(16_000);
  });

  test('downsampling AVERAGES rather than picking every Nth sample', () => {
    // Alternating ±1 is pure Nyquist energy. Decimation would keep it at full
    // amplitude and alias it into the speech band; a box average cancels it.
    const source = new Float32Array(48).map((_, i) => (i % 2 === 0 ? 1 : -1));
    const out = resample(source, 48_000, 16_000);
    for (const sample of out) expect(Math.abs(sample)).toBeLessThan(0.5);
  });

  test('preserves a constant signal exactly', () => {
    const out = resample(new Float32Array(300).fill(0.25), 48_000, 16_000);
    for (const sample of out) expect(sample).toBeCloseTo(0.25, 5);
  });

  test('upsampling interpolates and lengthens', () => {
    const out = resample(new Float32Array([0, 1]), 8_000, 16_000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  test('nonsense rates and empty input are returned untouched', () => {
    const source = new Float32Array([1]);
    expect(resample(source, 0, 16_000)).toBe(source);
    expect(resample(source, 16_000, Number.NaN)).toBe(source);
    expect(resample(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });
});

describe('encodeWav', () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767]);
  const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

  test('is a canonical 44-byte-header mono PCM16 file', () => {
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');
  });

  test('declares PCM, mono, 16 kHz, 16-bit', () => {
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
  });

  test('the two size fields agree with the payload', () => {
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  });

  test('writes samples little-endian, in order', () => {
    for (let i = 0; i < pcm.length; i += 1) expect(view.getInt16(44 + i * 2, true)).toBe(pcm[i] as number);
  });

  test('an empty utterance is still a valid, zero-length WAV', () => {
    const empty = encodeWav(new Int16Array(0), TARGET_SAMPLE_RATE);
    expect(empty.byteLength).toBe(44);
  });
});

describe('durationSeconds', () => {
  test('counts at the target rate', () => {
    expect(durationSeconds(new Float32Array(TARGET_SAMPLE_RATE))).toBe(1);
    expect(durationSeconds(new Float32Array(TARGET_SAMPLE_RATE * MAX_UTTERANCE_SECONDS))).toBe(MAX_UTTERANCE_SECONDS);
  });
});

describe('hasMicrophoneApi', () => {
  test('false when mediaDevices is ABSENT, which is what an insecure context looks like', () => {
    expect(hasMicrophoneApi({} as Navigator)).toBe(false);
    expect(hasMicrophoneApi(undefined)).toBe(false);
  });

  test('true only when getUserMedia is actually callable', () => {
    expect(hasMicrophoneApi({ mediaDevices: {} } as Navigator)).toBe(false);
    expect(hasMicrophoneApi({ mediaDevices: { getUserMedia: () => undefined } } as unknown as Navigator)).toBe(true);
  });
});

describe('captureErrorFrom', () => {
  const mapping: Array<[string, CaptureErrorCode]> = [
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-microphone'],
    ['OverconstrainedError', 'no-microphone'],
    ['NotReadableError', 'audio-unavailable'],
    ['AbortError', 'audio-unavailable'],
  ];

  for (const [name, code] of mapping) {
    test(`maps ${name} to ${code}`, () => {
      expect(captureErrorFrom({ name }).code).toBe(code);
    });
  }

  test('anything unrecognised becomes a generic failure with its own message', () => {
    const failure = captureErrorFrom(new Error('something odd'));
    expect(failure.code).toBe('capture-failed');
    expect(failure.message).toBe('something odd');
  });

  test('passes an existing CaptureError straight through', () => {
    const original = new CaptureError('no-media-devices', 'nope');
    expect(captureErrorFrom(original)).toBe(original);
  });
});

describe('startCapture', () => {
  test('refuses immediately, and by code, when the browser has no microphone API', async () => {
    await expect(startCapture({ mediaDevices: undefined })).rejects.toMatchObject({ code: 'no-media-devices' });
  });

  test('calls getUserMedia SYNCHRONOUSLY, so the prompt is attributable to the gesture', () => {
    // If an `await` ever creeps in above the getUserMedia call, the permission
    // prompt stops being user-initiated and browsers silently deny it. The
    // check is that the call has already happened when startCapture returns
    // its (still pending) promise.
    let called = false;
    const mediaDevices = {
      getUserMedia: () => {
        called = true;
        return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      },
    } as unknown as MediaDevices;
    const pending = startCapture({ mediaDevices });
    expect(called).toBe(true);
    return expect(pending).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('translates a denied permission and does not leave a session behind', async () => {
    const mediaDevices = {
      getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
    } as unknown as MediaDevices;
    await expect(startCapture({ mediaDevices })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('stops every microphone track when the audio graph cannot be built', async () => {
    // No AudioContext in this environment, so construction fails after the
    // stream was granted — the path where a leaked track is most likely.
    const stopped: string[] = [];
    const tracks = [{ stop: () => stopped.push('a') }, { stop: () => stopped.push('b') }];
    const mediaDevices = {
      getUserMedia: () => Promise.resolve({ getTracks: () => tracks } as unknown as MediaStream),
    } as unknown as MediaDevices;
    await expect(startCapture({ mediaDevices })).rejects.toBeDefined();
    expect(stopped).toEqual(['a', 'b']);
  });
});

/* ---------------------------------------------------------------------------
   THE END OF THE UTTERANCE.

   The worklet batches ~4096 frames before it posts, so at the instant the
   reader lets go it is holding up to 4095 unposted frames — 256 ms at 16 kHz.
   Those only reach the main thread in the flush that `stop()` asks for, which
   happens AFTER the microphone is closed. A session that stopped accepting
   samples the moment it went inactive would therefore discard the tail of
   every single utterance: the last word, every time, silently.

   These tests stand a fake Web Audio graph up so that path can be driven
   without a browser. The fake worklet behaves like the real one: it flushes a
   final partial batch and THEN acknowledges.
   --------------------------------------------------------------------------- */

class FakeWorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  received: Array<{ type?: string }> = [];
  /** What the processor is holding when the flush arrives. */
  pendingTail: Float32Array | null = null;

  postMessage(message: { type?: string }): void {
    this.received.push(message);
    if (message?.type !== 'flush' && message?.type !== 'stop') return;
    // Flush FIRST, acknowledge SECOND — the real worklet's ordering, and the
    // whole reason the acknowledgement is a usable signal.
    if (this.pendingTail) {
      const tail = this.pendingTail;
      this.pendingTail = null;
      this.emit(tail);
    }
    this.onmessage?.({ data: { type: 'flushed' } });
  }

  /** A full batch arriving mid-recording. */
  emit(samples: Float32Array): void {
    this.onmessage?.({ data: { type: 'audio', samples, sampleRate: 16_000 } });
  }

  countOf(type: string): number {
    return this.received.filter(message => message?.type === type).length;
  }
}

/** Just enough `document` for the visibility path — Bun has none. */
class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Background the tab. */
  hide(): void {
    this.visibilityState = 'hidden';
    for (const listener of [...(this.listeners.get('visibilitychange') ?? [])]) listener();
  }
}

let lastWorklet: FakeWorkletPort | null = null;
let lastSourceNode: FakeConnectableNode | null = null;
let lastAnalyserNode: FakeConnectableNode | null = null;
let lastGainNode: FakeConnectableNode | null = null;

class FakeConnectableNode {
  readonly connections: unknown[] = [];
  readonly disconnectedFrom: unknown[] = [];
  disconnected = false;
  gain = { value: 1 };
  connect(target: unknown): void {
    this.connections.push(target);
  }
  disconnect(target?: unknown): void {
    this.disconnected = true;
    if (target !== undefined) this.disconnectedFrom.push(target);
  }
}

class FakeAudioWorkletNode {
  port = new FakeWorkletPort();
  disconnected = false;
  constructor() {
    lastWorklet = this.port;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAudioContext {
  sampleRate: number;
  state = 'running';
  closed = false;
  destination = {};
  audioWorklet = { addModule: async (): Promise<void> => undefined };
  constructor(options?: { sampleRate?: number }) {
    // Honour the requested rate, as a real engine that supports it does — so
    // these tests assert sample COUNTS without a resampling step in the way.
    this.sampleRate = options?.sampleRate ?? 48_000;
  }
  createMediaStreamSource() {
    const source = new FakeConnectableNode();
    lastSourceNode = source;
    return source;
  }
  createAnalyser() {
    const analyser = new FakeConnectableNode();
    lastAnalyserNode = analyser;
    return analyser;
  }
  createGain() {
    const gain = new FakeConnectableNode();
    lastGainNode = gain;
    return gain;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('the tail of the utterance', () => {
  let stoppedTracks = 0;
  let lastGrantedStream: MediaStream | null = null;

  function install(): void {
    lastWorklet = null;
    lastSourceNode = null;
    lastAnalyserNode = null;
    lastGainNode = null;
    stoppedTracks = 0;
    lastGrantedStream = null;
    Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      value: FakeAudioWorkletNode,
      configurable: true,
      writable: true,
    });
  }

  function uninstall(): void {
    Reflect.deleteProperty(globalThis, 'AudioContext');
    Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
    lastWorklet = null;
    lastSourceNode = null;
    lastAnalyserNode = null;
    lastGainNode = null;
  }

  const mediaDevices = {
    getUserMedia: () => {
      const stream = {
        getTracks: () => [{ stop: () => (stoppedTracks += 1) }],
      } as unknown as MediaStream;
      lastGrantedStream = stream;
      return Promise.resolve(stream);
    },
  } as unknown as MediaDevices;

  async function openSession(extra: Partial<Parameters<typeof startCapture>[0]> = {}) {
    install();
    const session = await startCapture({ mediaDevices, ...extra });
    const port = lastWorklet;
    if (!port) throw new Error('the fake worklet was never constructed');
    return { session, port };
  }

  test('exposes the exact granted stream for read-only input analysis', async () => {
    const { session } = await openSession();
    try {
      const grantedStream = lastGrantedStream;
      if (!grantedStream) throw new Error('the fake media device returned no stream');
      expect(session.stream).toBe(grantedStream);
    } finally {
      session.cancel();
      uninstall();
    }
  });

  test('creates a disposable analyser branch without stopping the recorder stream', async () => {
    const { session } = await openSession();
    try {
      const tap = session.monitor.createAnalyser();
      if (!tap) throw new Error('the fake capture did not create an analyser tap');
      const source = lastSourceNode;
      const analyser = lastAnalyserNode;
      const gain = lastGainNode;
      if (!source || !analyser || !gain) throw new Error('the fake monitor graph was incomplete');

      expect(tap.analyser).toBe(analyser as unknown as AnalyserNode);
      expect(source.connections).toContain(analyser);
      expect(analyser.connections).toContain(gain);
      expect(gain.gain.value).toBe(0);
      expect(stoppedTracks).toBe(0);

      tap.disconnect();
      tap.disconnect();
      expect(source.disconnectedFrom).toEqual([analyser]);
      expect(analyser.disconnected).toBe(true);
      expect(gain.disconnected).toBe(true);
      expect(stoppedTracks).toBe(0);
    } finally {
      session.cancel();
      expect(stoppedTracks).toBe(1);
      uninstall();
    }
  });

  test('RETURNS the final partial batch the worklet was still holding', async () => {
    // THE REGRESSION. Before the fix, `stop()` marked the session inactive
    // before asking for the flush, and the guard in `accept()` threw this away.
    const { session, port } = await openSession();
    try {
      port.emit(new Float32Array(1_600).fill(0.5)); // a full batch, mid-recording
      port.pendingTail = new Float32Array(400).fill(0.25); // still unposted at release

      const samples = await session.stop();
      expect(samples.length).toBe(2_000);
      expect(samples[1_599]).toBeCloseTo(0.5, 5);
      // The tail is present, and it is the tail — not padding.
      expect(samples[1_600]).toBeCloseTo(0.25, 5);
      expect(samples[1_999]).toBeCloseTo(0.25, 5);
    } finally {
      uninstall();
    }
  });

  test('streams accepted PCM plus the flush tail in order without sharing mutable storage', async () => {
    const observed: Array<{ samples: number[]; rate: number }> = [];
    const { session, port } = await openSession({
      onSamples: (samples, rate) => {
        observed.push({ samples: [...samples], rate });
        // A live consumer is allowed to retain or mutate its own copy. Neither
        // may alter the recorder's authoritative finished utterance.
        samples.fill(0.99);
      },
    });
    try {
      port.emit(new Float32Array([0.1, 0.2]));
      port.pendingTail = new Float32Array([0.3, 0.4]);
      const finished = await session.stop();
      expect(observed).toEqual([
        { samples: [expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)], rate: 16_000 },
        { samples: [expect.closeTo(0.3, 5), expect.closeTo(0.4, 5)], rate: 16_000 },
      ]);
      expect([...finished]).toEqual([
        expect.closeTo(0.1, 5),
        expect.closeTo(0.2, 5),
        expect.closeTo(0.3, 5),
        expect.closeTo(0.4, 5),
      ]);
      port.emit(new Float32Array([0.8]));
      expect(observed).toHaveLength(2);
    } finally {
      uninstall();
    }
  });

  test('asks the worklet to flush exactly once, and waits for its acknowledgement', async () => {
    const { session, port } = await openSession();
    try {
      port.pendingTail = new Float32Array(128).fill(1);
      await session.stop();
      expect(port.countOf('flush')).toBe(1);
      // `flush` before `stop`: the tail is collected while the port is still
      // alive, and only then is the processor torn down.
      const kinds = port.received.map(message => message.type);
      expect(kinds.indexOf('flush')).toBeLessThan(kinds.indexOf('stop'));
    } finally {
      uninstall();
    }
  });

  test('reports the microphone as closed the moment stop is called, before the flush lands', async () => {
    const { session, port } = await openSession();
    try {
      port.pendingTail = new Float32Array(64).fill(1);
      const pending = session.stop();
      // `active` is the caller's "is the mic open" signal and must go false
      // immediately — acceptance outliving it is an internal detail.
      expect(session.active).toBe(false);
      await pending;
    } finally {
      uninstall();
    }
  });

  test('stops accepting once the flush is acknowledged, so a late chunk cannot land', async () => {
    const { session, port } = await openSession();
    try {
      port.emit(new Float32Array(320).fill(0.5));
      const samples = await session.stop();
      expect(samples.length).toBe(320);

      // Anything the port emits after the acknowledgement is past the end of
      // the utterance and must be ignored.
      port.emit(new Float32Array(999).fill(1));
      expect((await session.stop()).length).toBe(320);
    } finally {
      uninstall();
    }
  });

  test('is idempotent: a second stop returns the same buffer and re-flushes nothing', async () => {
    const { session, port } = await openSession();
    try {
      port.pendingTail = new Float32Array(256).fill(0.5);
      const first = await session.stop();
      const second = await session.stop();
      expect(second).toBe(first);
      expect(port.countOf('flush')).toBe(1);
    } finally {
      uninstall();
    }
  });

  test('concurrent stops share ONE flush', async () => {
    const { session, port } = await openSession();
    try {
      port.pendingTail = new Float32Array(256).fill(0.5);
      const [a, b] = await Promise.all([session.stop(), session.stop()]);
      expect(a).toBe(b);
      expect(a.length).toBe(256);
      expect(port.countOf('flush')).toBe(1);
    } finally {
      uninstall();
    }
  });

  test('cancel keeps NO tail — a cancelled utterance wants none of it', async () => {
    const { session, port } = await openSession();
    try {
      port.emit(new Float32Array(800).fill(0.5));
      port.pendingTail = new Float32Array(400).fill(0.25);
      session.cancel();
      expect(session.active).toBe(false);
      expect((await session.stop()).length).toBe(0);
    } finally {
      uninstall();
    }
  });

  test('releases the microphone and closes the context on the way out', async () => {
    const { session, port } = await openSession();
    try {
      port.emit(new Float32Array(320).fill(0.5));
      await session.stop();
      expect(stoppedTracks).toBe(1);
      expect(session.active).toBe(false);
    } finally {
      uninstall();
    }
  });

  test('backgrounding the tab ABANDONS the utterance and says so', async () => {
    // The tab going away is not a pause. The browser closes the microphone
    // underneath us, and a controller that was never told would keep claiming
    // to be recording — refusing the next utterance and, worse, later handing
    // the abandoned samples to an engine.
    const page = new FakeDocument();
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
    const reasons: string[] = [];
    try {
      const { session, port } = await openSession({ onAbort: reason => reasons.push(reason) });
      port.emit(new Float32Array(1_600).fill(0.5));
      expect(session.active).toBe(true);
      expect(page.listenerCount('visibilitychange')).toBe(1);

      page.hide();

      expect(reasons).toEqual(['hidden']);
      expect(session.active).toBe(false);
      expect(stoppedTracks).toBe(1);
      // The samples are DROPPED, not merely unused — so even a caller that
      // mishandles the notification cannot transcribe half an utterance.
      expect((await session.stop()).length).toBe(0);
      // And the listener is gone: a backgrounded capture leaves nothing behind.
      expect(page.listenerCount('visibilitychange')).toBe(0);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
      uninstall();
    }
  });

  test('a repeated hide does not announce a second abort', async () => {
    const page = new FakeDocument();
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
    const reasons: string[] = [];
    try {
      const { port } = await openSession({ onAbort: reason => reasons.push(reason) });
      port.emit(new Float32Array(320).fill(0.5));
      page.hide();
      page.hide();
      expect(reasons).toEqual(['hidden']);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
      uninstall();
    }
  });

  test('a hide AFTER a normal stop is not announced as an abort', async () => {
    const page = new FakeDocument();
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
    const reasons: string[] = [];
    try {
      const { session, port } = await openSession({ onAbort: reason => reasons.push(reason) });
      port.emit(new Float32Array(320).fill(0.5));
      const samples = await session.stop();
      expect(samples.length).toBe(320);

      page.hide();
      expect(reasons).toEqual([]);
      // The finished utterance is untouched by the tab going away.
      expect((await session.stop()).length).toBe(320);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
      uninstall();
    }
  });

  test('an utterance under the floor still returns its samples for the caller to judge', async () => {
    // `stop()` does not apply MIN_UTTERANCE_SECONDS itself — the hook does, so
    // a mis-tap is silent rather than an error. Capture just reports what it
    // heard, tail included.
    const { session, port } = await openSession();
    try {
      port.pendingTail = new Float32Array(16).fill(0.5);
      const samples = await session.stop();
      expect(samples.length).toBe(16);
      expect(durationSeconds(samples)).toBeLessThan(MIN_UTTERANCE_SECONDS);
    } finally {
      uninstall();
    }
  });
});
