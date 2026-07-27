import { describe, expect, test } from 'bun:test';
import {
  SttAudioError,
  decodeRawPcm16le,
  decodeSttAudio,
  decodeWavPcm16le,
  encodeCanonicalWav,
  float32ToPcm16le,
  pcm16leToFloat32,
} from './stt-audio';
import { STT_MAX_PCM_BYTES, STT_MAX_SAMPLES, STT_SAMPLE_RATE } from './stt-types';

function audioError(error: unknown): string | undefined {
  return error instanceof SttAudioError ? error.code : undefined;
}

function expectBad(bytes: Uint8Array): void {
  expect(audioError(catchError(() => decodeWavPcm16le(bytes)))).toBe('bad_audio');
}

function catchError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

interface Chunk {
  id: string;
  bytes: Uint8Array;
}

function chunkedWav(chunks: Chunk[]): Uint8Array {
  const size = 12 + chunks.reduce((total, chunk) => total + 8 + chunk.bytes.length + (chunk.bytes.length % 2), 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  text(8, 'WAVE');
  let offset = 12;
  for (const chunk of chunks) {
    text(offset, chunk.id);
    view.setUint32(offset + 4, chunk.bytes.length, true);
    bytes.set(chunk.bytes, offset + 8);
    offset += 8 + chunk.bytes.length + (chunk.bytes.length % 2);
  }
  return bytes;
}

function formatChunk(
  overrides: Partial<{
    format: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bits: number;
  }> = {},
): Uint8Array {
  const values = {
    format: 1,
    channels: 1,
    sampleRate: STT_SAMPLE_RATE,
    byteRate: STT_SAMPLE_RATE * 2,
    blockAlign: 2,
    bits: 16,
    ...overrides,
  };
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, values.format, true);
  view.setUint16(2, values.channels, true);
  view.setUint32(4, values.sampleRate, true);
  view.setUint32(8, values.byteRate, true);
  view.setUint16(12, values.blockAlign, true);
  view.setUint16(14, values.bits, true);
  return bytes;
}

describe('PCM16LE audio', () => {
  test('converts signed little-endian boundary samples', () => {
    const samples = pcm16leToFloat32(Uint8Array.from([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]));
    expect(samples).toBeInstanceOf(Float32Array);
    expect(Array.from(samples)).toEqual([-1, 0, 32_767 / 32_768]);
    expect(decodeRawPcm16le(Uint8Array.from([0x00, 0x00, 0x01, 0x00]))).toMatchObject({
      sampleRate: STT_SAMPLE_RATE,
      channels: 1,
      durationMs: 0.125,
      source: 'pcm16le',
    });
  });

  test('encodes with clipping, finite validation, and little-endian order', () => {
    expect(Array.from(float32ToPcm16le(Float32Array.from([-2, -1, 0, 1, 2])))).toEqual([
      0x00, 0x80, 0x00, 0x80, 0x00, 0x00, 0xff, 0x7f, 0xff, 0x7f,
    ]);
    expect(audioError(catchError(() => float32ToPcm16le(Float32Array.from([Number.NaN]))))).toBe('bad_audio');
  });

  test('rejects empty, odd-length, and over-duration input at the exact boundary', () => {
    expect(audioError(catchError(() => pcm16leToFloat32(new Uint8Array())))).toBe('bad_audio');
    expect(audioError(catchError(() => pcm16leToFloat32(Uint8Array.of(1))))).toBe('bad_audio');
    expect(pcm16leToFloat32(new Uint8Array(STT_MAX_PCM_BYTES))).toHaveLength(STT_MAX_SAMPLES);
    expect(audioError(catchError(() => pcm16leToFloat32(new Uint8Array(STT_MAX_PCM_BYTES + 2))))).toBe('too_long');
  });
});

describe('WAV audio', () => {
  test('round-trips a canonical mono 16 kHz PCM16 WAV', () => {
    const wav = encodeCanonicalWav(Float32Array.from([-1, -0.5, 0, 0.5, 1]));
    const decoded = decodeWavPcm16le(wav);
    expect(decoded.source).toBe('wav');
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples[0]).toBe(-1);
    expect(decoded.samples[2]).toBe(0);
    expect(decoded.samples[4]).toBe(32_767 / 32_768);
  });

  test('accepts unknown chunks and odd-length RIFF padding before data', () => {
    const wav = chunkedWav([
      { id: 'JUNK', bytes: Uint8Array.of(1, 2, 3) },
      { id: 'fmt ', bytes: formatChunk() },
      { id: 'LIST', bytes: Uint8Array.of(9, 8, 7, 6) },
      { id: 'data', bytes: Uint8Array.of(0x00, 0x80, 0xff, 0x7f) },
    ]);
    expect(Array.from(decodeWavPcm16le(wav).samples)).toEqual([-1, 32_767 / 32_768]);
  });

  test('rejects bad container boundaries, missing chunks, and duplicate chunks', () => {
    expectBad(new Uint8Array());
    expectBad(new TextEncoder().encode('not a wav file'));

    const canonical = encodeCanonicalWav(Float32Array.of(0));
    const wrongRiffSize = canonical.slice();
    new DataView(wrongRiffSize.buffer).setUint32(4, canonical.length, true);
    expectBad(wrongRiffSize);
    expectBad(canonical.subarray(0, canonical.length - 1));
    expectBad(chunkedWav([{ id: 'data', bytes: Uint8Array.of(0, 0) }]));
    expectBad(chunkedWav([{ id: 'fmt ', bytes: formatChunk() }]));
    expectBad(
      chunkedWav([
        { id: 'fmt ', bytes: formatChunk() },
        { id: 'fmt ', bytes: formatChunk() },
        { id: 'data', bytes: Uint8Array.of(0, 0) },
      ]),
    );
    expectBad(
      chunkedWav([
        { id: 'fmt ', bytes: formatChunk() },
        { id: 'data', bytes: Uint8Array.of(0, 0) },
        { id: 'data', bytes: Uint8Array.of(0, 0) },
      ]),
    );
  });

  test('rejects unsupported PCM format fields individually', () => {
    const invalidFormats = [
      formatChunk({ format: 3 }),
      formatChunk({ channels: 2, blockAlign: 4, byteRate: 64_000 }),
      formatChunk({ sampleRate: 8_000, byteRate: 16_000 }),
      formatChunk({ bits: 8, blockAlign: 1, byteRate: 16_000 }),
      formatChunk({ blockAlign: 4 }),
      formatChunk({ byteRate: 123 }),
    ];
    for (const format of invalidFormats) {
      expectBad(
        chunkedWav([
          { id: 'fmt ', bytes: format },
          { id: 'data', bytes: Uint8Array.of(0, 0) },
        ]),
      );
    }
  });

  test('rejects empty, odd, truncated, and over-duration data chunks', () => {
    expectBad(
      chunkedWav([
        { id: 'fmt ', bytes: formatChunk() },
        { id: 'data', bytes: new Uint8Array() },
      ]),
    );
    expectBad(
      chunkedWav([
        { id: 'fmt ', bytes: formatChunk() },
        { id: 'data', bytes: Uint8Array.of(1) },
      ]),
    );

    const over = chunkedWav([
      { id: 'fmt ', bytes: formatChunk() },
      { id: 'data', bytes: new Uint8Array(STT_MAX_PCM_BYTES + 2) },
    ]);
    expect(audioError(catchError(() => decodeWavPcm16le(over)))).toBe('too_long');

    const chunkOverflow = chunkedWav([
      { id: 'fmt ', bytes: formatChunk() },
      { id: 'data', bytes: Uint8Array.of(0, 0) },
    ]);
    new DataView(chunkOverflow.buffer).setUint32(40, 1000, true);
    expectBad(chunkOverflow);
  });
});

describe('content-type dispatch', () => {
  test('accepts the explicit raw PCM and WAV contracts', () => {
    const pcm = Uint8Array.of(0, 0);
    expect(decodeSttAudio(pcm, 'audio/L16; channels=1; rate=16000').source).toBe('pcm16le');
    expect(decodeSttAudio(encodeCanonicalWav(Float32Array.of(0)), 'audio/wav').source).toBe('wav');
  });

  test('rejects wrong PCM metadata and unsupported content types', () => {
    const pcm = Uint8Array.of(0, 0);
    expect(audioError(catchError(() => decodeSttAudio(pcm, 'audio/L16; rate=8000; channels=1')))).toBe('bad_audio');
    expect(audioError(catchError(() => decodeSttAudio(pcm, 'audio/L16; rate=16000; channels=2')))).toBe('bad_audio');
    expect(audioError(catchError(() => decodeSttAudio(pcm, 'application/octet-stream')))).toBe('bad_audio');
  });
});
