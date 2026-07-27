import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InputWaveform,
  NO_SIGNAL_AFTER_MS,
  displayLevel,
  inputRms,
  nextNoSignalReading,
  paintInputLevel,
  startInputWaveform,
  type InputWaveformRuntime,
} from './InputWaveform';
import type { CaptureMonitor } from '../lib/stt/audio-capture';

describe('truthful input levels', () => {
  test('silence stays at zero while real sample energy rises', () => {
    expect(inputRms(new Float32Array(32))).toBe(0);
    expect(displayLevel(inputRms(new Float32Array(32)))).toBe(0);
    expect(inputRms(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(displayLevel(inputRms(new Float32Array([0.05, -0.05])))).toBeGreaterThan(0.4);
  });

  test('non-finite analyser samples cannot poison the meter', () => {
    expect(inputRms(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, 0]))).toBe(0);
    expect(displayLevel(Number.NaN)).toBe(0);
  });
});

describe('no-signal detection', () => {
  test('waits a few continuous seconds at the floor, then clears on speech', () => {
    const first = nextNoSignalReading(null, 0, 1_000);
    expect(first).toEqual({ silentSince: 1_000, noSignal: false });

    const early = nextNoSignalReading(first.silentSince, 0, 1_000 + NO_SIGNAL_AFTER_MS - 1);
    expect(early.noSignal).toBe(false);

    const due = nextNoSignalReading(early.silentSince, 0, 1_000 + NO_SIGNAL_AFTER_MS);
    expect(due.noSignal).toBe(true);

    expect(nextNoSignalReading(due.silentSince, 0.1, 5_000)).toEqual({ silentSince: null, noSignal: false });
  });
});

interface PaintLog {
  fillRects: Array<[number, number, number, number]>;
  lineTos: Array<[number, number]>;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; log: PaintLog } {
  const log: PaintLog = { fillRects: [], lineTos: [] };
  const context = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    setTransform: () => undefined,
    clearRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: (x: number, y: number) => log.lineTos.push([x, y]),
    stroke: () => undefined,
    fillRect: (x: number, y: number, width: number, height: number) => log.fillRects.push([x, y, width, height]),
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 320,
    clientHeight: 56,
    getBoundingClientRect: () => ({ width: 320, height: 56 }),
    getContext: (kind: string) => (kind === '2d' ? context : null),
  } as unknown as HTMLCanvasElement;
  return { canvas, context, log };
}

describe('drawing modes', () => {
  test('reduced motion paints a simple level bar, not a travelling waveform', () => {
    const { canvas, context, log } = fakeCanvas();
    paintInputLevel(canvas, context, {
      samples: new Float32Array([0.2, -0.2]),
      level: 0.5,
      reducedMotion: true,
      color: '#58a6ff',
      pixelRatio: 2,
    });
    expect(log.fillRects).toHaveLength(2);
    expect(log.fillRects[1]?.[2]).toBe(160);
    expect(log.lineTos).toHaveLength(0);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(112);
  });

  test('ordinary motion paints silence as a centre line and speech as a trace', () => {
    const { canvas, context, log } = fakeCanvas();
    paintInputLevel(canvas, context, {
      samples: new Float32Array(8),
      level: 0,
      reducedMotion: false,
      color: '#58a6ff',
      pixelRatio: 1,
    });
    expect(log.lineTos).toHaveLength(1);

    paintInputLevel(canvas, context, {
      samples: new Float32Array([0, 0.2, -0.2, 0.1]),
      level: 0.7,
      reducedMotion: false,
      color: '#58a6ff',
      pixelRatio: 1,
    });
    expect(log.lineTos.length).toBeGreaterThan(4);
  });
});

class FakeAnalyser {
  fftSize = 32;
  smoothingTimeConstant = 0;
  minDecibels = -100;
  maxDecibels = -30;
  sample = 0;
  reads = 0;
  getFloatTimeDomainData(target: Float32Array): void {
    this.reads += 1;
    for (let index = 0; index < target.length; index += 1) {
      target[index] = index % 2 === 0 ? this.sample : -this.sample;
    }
  }
}

class FakeMonitor implements CaptureMonitor {
  readonly analyser = new FakeAnalyser();
  creates = 0;
  disconnected = false;
  createAnalyser() {
    this.creates += 1;
    return {
      analyser: this.analyser as unknown as AnalyserNode,
      disconnect: () => {
        this.disconnected = true;
      },
    };
  }
}

function fakeRuntime(reduced = false): {
  runtime: InputWaveformRuntime;
  step(now: number): void;
  cancelled: number[];
  listenerCounts: { added: number; removed: number };
} {
  let nextHandle = 0;
  let pending: { handle: number; callback: FrameRequestCallback } | null = null;
  const cancelled: number[] = [];
  const listenerCounts = { added: 0, removed: 0 };
  const media = {
    matches: reduced,
    addEventListener: () => {
      listenerCounts.added += 1;
    },
    removeEventListener: () => {
      listenerCounts.removed += 1;
    },
  } as unknown as MediaQueryList;
  const runtime: InputWaveformRuntime = {
    requestFrame: callback => {
      const handle = ++nextHandle;
      pending = { handle, callback };
      return handle;
    },
    cancelFrame: handle => {
      cancelled.push(handle);
      if (pending?.handle === handle) pending = null;
    },
    reducedMotion: media,
    pixelRatio: 1,
    color: '#58a6ff',
  };
  return {
    runtime,
    step: now => {
      const frame = pending;
      if (!frame) throw new Error('no animation frame was pending');
      pending = null;
      frame.callback(now);
    },
    cancelled,
    listenerCounts,
  };
}

describe('analyser lifecycle', () => {
  test('reads the recorder analyser, throttles paint, reports silence, and tears down', () => {
    const monitor = new FakeMonitor();
    const frames = fakeRuntime();
    const { canvas } = fakeCanvas();
    const noSignalElement = { hidden: true } as HTMLElement;

    const stop = startInputWaveform({
      monitor,
      canvas,
      noSignalElement,
      runtime: frames.runtime,
    });

    expect(monitor.creates).toBe(1);

    frames.step(0);
    expect(monitor.analyser.reads).toBe(1);
    frames.step(10); // rAF still runs, but the expensive analyser/paint work does not.
    expect(monitor.analyser.reads).toBe(1);
    frames.step(50);
    expect(monitor.analyser.reads).toBe(2);
    frames.step(NO_SIGNAL_AFTER_MS);
    expect(noSignalElement.hidden).toBe(false);

    monitor.analyser.sample = 0.1;
    frames.step(NO_SIGNAL_AFTER_MS + 50);
    expect(noSignalElement.hidden).toBe(true);

    stop();
    stop(); // cleanup is idempotent
    expect(frames.cancelled).toHaveLength(1);
    expect(monitor.disconnected).toBe(true);
    expect(frames.listenerCounts).toEqual({ added: 1, removed: 1 });
  });

  test('supports legacy WebKit motion listeners and removes them', () => {
    const monitor = new FakeMonitor();
    const frames = fakeRuntime();
    const legacyCounts = { added: 0, removed: 0 };
    frames.runtime.reducedMotion = {
      matches: true,
      addEventListener: undefined,
      removeEventListener: undefined,
      addListener: () => {
        legacyCounts.added += 1;
      },
      removeListener: () => {
        legacyCounts.removed += 1;
      },
    } as unknown as MediaQueryList;
    const { canvas } = fakeCanvas();
    const stop = startInputWaveform({
      monitor,
      canvas,
      noSignalElement: { hidden: true } as HTMLElement,
      runtime: frames.runtime,
    });
    frames.step(0);
    stop();
    expect(legacyCounts).toEqual({ added: 1, removed: 1 });
    expect(monitor.disconnected).toBe(true);
  });

  test('closes the graph if frame scheduling fails during setup', () => {
    const monitor = new FakeMonitor();
    const frames = fakeRuntime();
    frames.runtime.requestFrame = () => {
      throw new Error('document detached');
    };
    const { canvas } = fakeCanvas();
    expect(() =>
      startInputWaveform({
        monitor,
        canvas,
        noSignalElement: { hidden: true } as HTMLElement,
        runtime: frames.runtime,
      }),
    ).toThrow('document detached');
    expect(monitor.disconnected).toBe(true);
    expect(frames.listenerCounts).toEqual({ added: 1, removed: 1 });
  });
});

describe('InputWaveform markup', () => {
  test('ships a real canvas and an initially hidden, polite no-signal state', () => {
    const html = renderToStaticMarkup(<InputWaveform monitor={null} />);
    expect(html).toContain('<canvas');
    expect(html).toContain('Microphone input level');
    expect(html).toContain('No microphone signal yet');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('hidden=""');
  });
});
