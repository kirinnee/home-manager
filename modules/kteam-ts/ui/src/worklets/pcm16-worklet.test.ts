import { describe, expect, test } from 'bun:test';
import { PCM16_WORKLET_NAME, PCM16_WORKLET_SOURCE, WORKLET_BATCH_FRAMES } from './pcm16-worklet';

describe('the worklet source', () => {
  test('is syntactically valid JavaScript, not TypeScript', () => {
    // This is the test that a `.ts` file loaded via `?url` could never pass:
    // it would ship `declare class AudioWorkletProcessor` to the browser, which
    // is a syntax error. Compiling the string here proves what the AudioWorklet
    // realm will actually receive.
    expect(() => new Function(PCM16_WORKLET_SOURCE)).not.toThrow();
  });

  test('carries no import or export, because the realm parses it as a classic script', () => {
    expect(PCM16_WORKLET_SOURCE).not.toMatch(/^\s*import\s/mu);
    expect(PCM16_WORKLET_SOURCE).not.toMatch(/^\s*export\s/mu);
  });

  test('registers itself under the name the capture code asks for', () => {
    expect(PCM16_WORKLET_SOURCE).toContain(`registerProcessor(${JSON.stringify(PCM16_WORKLET_NAME)}`);
    expect(PCM16_WORKLET_NAME).toBe('kteam-pcm16-capture');
  });

  test('batches frames instead of posting every 128-sample render quantum', () => {
    // 128-sample messages would be ~375 postMessage calls a second.
    expect(WORKLET_BATCH_FRAMES).toBeGreaterThanOrEqual(1024);
    expect(PCM16_WORKLET_SOURCE).toContain(`new Float32Array(${WORKLET_BATCH_FRAMES})`);
  });

  test('transfers the sample buffer rather than copying it across the thread', () => {
    expect(PCM16_WORKLET_SOURCE).toContain('[chunk.buffer]');
  });

  test('answers both the flush and the stop control messages', () => {
    expect(PCM16_WORKLET_SOURCE).toContain("'flush'");
    expect(PCM16_WORKLET_SOURCE).toContain("'stop'");
  });

  test('flushes BEFORE it acknowledges, which is what makes the ack usable', () => {
    // The main thread stops accepting samples when the acknowledgement lands.
    // If the ack were posted first, the final partial batch would arrive after
    // the door had closed and the tail of every utterance would be lost.
    const flushAt = PCM16_WORKLET_SOURCE.indexOf('this._flush();\n      this.port.postMessage');
    expect(flushAt).toBeGreaterThan(-1);
    expect(PCM16_WORKLET_SOURCE).toContain("this.port.postMessage({ type: 'flushed' })");
    expect(PCM16_WORKLET_SOURCE.indexOf("'flushed'")).toBeGreaterThan(PCM16_WORKLET_SOURCE.indexOf('this._flush();'));
  });

  test('marks itself stopped only after the stop message has been flushed and acknowledged', () => {
    expect(PCM16_WORKLET_SOURCE.indexOf('this._stopped = true;')).toBeGreaterThan(
      PCM16_WORKLET_SOURCE.indexOf("'flushed'"),
    );
  });

  test('returns false after stop, so the node is torn down rather than left spinning', () => {
    expect(PCM16_WORKLET_SOURCE).toMatch(/if \(this\._stopped\) return false;/u);
  });

  test('interpolates nothing but its own compile-time constants', () => {
    // The string is evaluated as CODE. Nothing caller-supplied may reach it.
    const interpolations = PCM16_WORKLET_SOURCE.match(/\$\{/gu);
    expect(interpolations).toBeNull();
  });
});
