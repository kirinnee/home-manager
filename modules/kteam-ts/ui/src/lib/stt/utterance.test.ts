import { describe, expect, test } from 'bun:test';
import { UtteranceLatch, finishUtterance, type CaptureLike, type FinishDeps, type FinishPhase } from './utterance';
import { TARGET_SAMPLE_RATE } from './audio-capture';
import { SttRequestError } from './daemon-engine';

/** A capture whose flush can be held open, so both callers of a race can be in
 *  flight at the same instant — which is the whole point of these tests. */
class FakeCapture implements CaptureLike {
  stopCalls = 0;
  cancelCalls = 0;
  private release!: (samples: Float32Array) => void;
  private pending: Promise<Float32Array>;

  constructor(private readonly samples: Float32Array) {
    this.pending = new Promise<Float32Array>(resolve => {
      this.release = resolve;
    });
  }

  stop(): Promise<Float32Array> {
    this.stopCalls += 1;
    return this.pending;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.release(new Float32Array(0));
  }

  /** Let the flush resolve. */
  flush(): void {
    this.release(this.samples);
  }
}

/** Two seconds of audio — comfortably over the mis-tap floor. */
function speech(): Float32Array {
  return new Float32Array(TARGET_SAMPLE_RATE * 2).fill(0.2);
}

interface Recorder {
  deps: FinishDeps;
  transcribeCalls: number;
  commits: string[];
  phases: FinishPhase[];
  errors: Array<{ code: string; message: string }>;
  controllers: Array<AbortController | null>;
}

function recorder(latch: UtteranceLatch, overrides: Partial<Pick<FinishDeps, 'transcribe' | 'refine'>> = {}): Recorder {
  const state: Recorder = {
    transcribeCalls: 0,
    commits: [],
    phases: [],
    errors: [],
    controllers: [],
    deps: undefined as unknown as FinishDeps,
  };
  state.deps = {
    latch,
    // Counting happens in ONE place — the wrapper below — so every test can
    // assert "exactly one engine call" the same way whether or not it supplied
    // its own engine.
    transcribe: overrides.transcribe ?? (async () => 'hello there'),
    refine: overrides.refine ?? (async raw => raw),
    commit: text => state.commits.push(text),
    setPhase: phase => state.phases.push(phase),
    setError: error => state.errors.push(error),
    onController: controller => state.controllers.push(controller),
  };
  const inner = state.deps.transcribe;
  state.deps.transcribe = async (samples, signal) => {
    state.transcribeCalls += 1;
    return inner(samples, signal);
  };
  return state;
}

describe('UtteranceLatch — one owner per capture', () => {
  test('claims a capture exactly once', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    expect(latch.attach(token, capture)).toBe(true);

    expect(latch.claim(token)).toBe(capture);
    // The second caller — whichever of onLimit and stop() lost the race.
    expect(latch.claim(token)).toBeNull();
    expect(latch.claim(token)).toBeNull();
  });

  test('a stale token can neither attach nor claim', () => {
    const latch = new UtteranceLatch();
    const stale = latch.begin();
    const capture = new FakeCapture(speech());
    latch.begin(); // a second utterance started

    expect(latch.attach(stale, capture)).toBe(false);
    expect(latch.claim(stale)).toBeNull();
  });

  test('claiming moves the capture out of the live slot but keeps it reachable', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);

    latch.claim(token);
    expect(latch.liveCapture).toBeNull();
    // Still held, so a cancel can reach it — a claimed capture that became
    // unreachable would leave its microphone open.
    expect(latch.ownedCapture).toBe(capture);

    latch.cancel();
    expect(capture.cancelCalls).toBe(1);
  });

  test('settle releases only the capture that was claimed', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    latch.claim(token);

    latch.settle(new FakeCapture(speech()));
    expect(latch.ownedCapture).toBe(capture);
    latch.settle(capture);
    expect(latch.ownedCapture).toBeNull();
  });

  test('cancel and begin both close the microphone and invalidate the generation', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);

    latch.begin();
    expect(capture.cancelCalls).toBe(1);
    expect(latch.isCurrent(token)).toBe(false);
  });

  test('a capture that throws from cancel does not break teardown', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const hostile: CaptureLike = {
      stop: async () => new Float32Array(0),
      cancel: () => {
        throw new Error('already gone');
      },
    };
    latch.attach(token, hostile);
    expect(() => latch.cancel()).not.toThrow();
    expect(latch.liveCapture).toBeNull();
  });
});

describe('UtteranceLatch — background abort', () => {
  test('invalidates the generation and cancels the capture', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);

    expect(latch.abort(token)).toBe(true);
    expect(capture.cancelCalls).toBe(1);
    expect(latch.isCurrent(token)).toBe(false);
    expect(latch.liveCapture).toBeNull();
  });

  test('a late or duplicated abort is a no-op, not a second invalidation', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture(speech()));
    expect(latch.abort(token)).toBe(true);

    const after = latch.generation;
    expect(latch.abort(token)).toBe(false);
    expect(latch.generation).toBe(after);
  });

  test('a NEW utterance starts cleanly after an abort — the foreground case', () => {
    const latch = new UtteranceLatch();
    const first = latch.begin();
    latch.attach(first, new FakeCapture(speech()));
    latch.abort(first);

    const second = latch.begin();
    const capture = new FakeCapture(speech());
    expect(latch.attach(second, capture)).toBe(true);
    expect(latch.claim(second)).toBe(capture);
  });
});

describe('finishUtterance — the limit and the release cannot both commit', () => {
  test('ONE engine call and ONE draft edit when both fire before the flush resolves', async () => {
    // THE REGRESSION. `CaptureSession.stop()` already shared its flush, but each
    // CALLER continued past it with its own request and its own commit, so the
    // reader said one sentence and got it twice.
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch);

    // onLimit fires, then the pointer comes up — both while the worklet flush
    // is still outstanding.
    const fromLimit = finishUtterance(token, state.deps);
    const fromRelease = finishUtterance(token, state.deps);
    capture.flush();
    await Promise.all([fromLimit, fromRelease]);

    expect(state.transcribeCalls).toBe(1);
    expect(state.commits).toEqual(['hello there']);
    expect(capture.stopCalls).toBe(1);
  });

  test('holds under four simultaneous callers', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch);

    const races = [0, 1, 2, 3].map(() => finishUtterance(token, state.deps));
    capture.flush();
    await Promise.all(races);

    expect(state.transcribeCalls).toBe(1);
    expect(state.commits).toHaveLength(1);
  });

  test('a second finish is refused even after the first has fully settled', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch);

    const first = finishUtterance(token, state.deps);
    capture.flush();
    await first;
    await finishUtterance(token, state.deps);

    expect(state.transcribeCalls).toBe(1);
    expect(state.commits).toHaveLength(1);
  });
});

describe('finishUtterance — a backgrounded capture is never transcribed', () => {
  test('an abort during the flush stops the utterance dead', async () => {
    // Background + pointer-up: the tab hid, and the reader then let go.
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch);

    const pending = finishUtterance(token, state.deps);
    latch.abort(token); // capture.cancel() resolves the flush with nothing
    await pending;

    expect(state.transcribeCalls).toBe(0);
    expect(state.commits).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test('an abort during transcription discards the result rather than committing it', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);

    let releaseEngine!: (text: string) => void;
    const engine = new Promise<string>(resolve => {
      releaseEngine = resolve;
    });
    const state = recorder(latch, { transcribe: () => engine });

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await Promise.resolve();
    await Promise.resolve();

    latch.abort(token);
    releaseEngine('text from an abandoned recording');
    await pending;

    expect(state.commits).toEqual([]);
  });

  test('a stale finish never even claims, so the capture stays untouched', async () => {
    const latch = new UtteranceLatch();
    const stale = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(stale, capture);
    latch.abort(stale);
    const state = recorder(latch);

    await finishUtterance(stale, state.deps);
    expect(capture.stopCalls).toBe(0);
    expect(state.phases).toEqual([]);
  });
});

describe('finishUtterance — ordinary paths still hold', () => {
  test('goes transcribing then idle, and publishes then clears its controller', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch);

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await pending;

    expect(state.phases).toEqual(['transcribing', 'idle']);
    expect(state.controllers[0]).toBeInstanceOf(AbortController);
    expect(state.controllers.at(-1)).toBeNull();
  });

  test('a mis-tap is silent: no engine call, no error, straight back to idle', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(new Float32Array(100));
    latch.attach(token, capture);
    const state = recorder(latch);

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await pending;

    expect(state.transcribeCalls).toBe(0);
    expect(state.errors).toEqual([]);
    expect(state.phases).toEqual(['idle']);
  });

  test('the refined text is what reaches the draft, never the raw text', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch, { refine: async raw => raw.replace('kteem', 'kteam') });
    state.deps.transcribe = async () => 'start kteem now';

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await pending;

    expect(state.commits).toEqual(['start kteam now']);
  });

  test('an engine failure surfaces its message and leaves the phase in error', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch, {
      transcribe: async () => {
        throw new SttRequestError('busy', 'the worker is busy', 409);
      },
    });

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await pending;

    expect(state.errors).toEqual([{ code: 'busy', message: 'the worker is busy' }]);
    expect(state.phases.at(-1)).toBe('error');
    expect(state.commits).toEqual([]);
  });

  test('an aborted request is idle, not an error the reader has to dismiss', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch, {
      transcribe: async () => {
        throw new SttRequestError('aborted', 'Transcription was cancelled.');
      },
    });

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await pending;

    expect(state.errors).toEqual([]);
    expect(state.phases.at(-1)).toBe('idle');
  });

  test('a capture that fails to stop reports a capture error, not a transcription one', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const broken: CaptureLike = {
      stop: async () => {
        throw Object.assign(new Error('gone'), { name: 'NotReadableError' });
      },
      cancel: () => undefined,
    };
    latch.attach(token, broken);
    const state = recorder(latch);

    await finishUtterance(token, state.deps);
    expect(state.errors[0]?.code).toBe('audio-unavailable');
    expect(state.transcribeCalls).toBe(0);
  });

  test('the capture is settled even when the engine throws', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(speech());
    latch.attach(token, capture);
    const state = recorder(latch, {
      transcribe: async () => {
        throw new Error('boom');
      },
    });

    const pending = finishUtterance(token, state.deps);
    capture.flush();
    await pending;
    expect(latch.ownedCapture).toBeNull();
  });
});
