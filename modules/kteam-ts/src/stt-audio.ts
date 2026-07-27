import {
  STT_BITS_PER_SAMPLE,
  STT_CHANNELS,
  STT_MAX_DURATION_SECONDS,
  STT_SAMPLE_RATE,
  type SttErrorCode,
} from './stt-types';

const BYTES_PER_SAMPLE = STT_BITS_PER_SAMPLE / 8;

export class SttAudioError extends Error {
  constructor(
    readonly code: Extract<SttErrorCode, 'bad_audio' | 'too_long'>,
    message: string,
  ) {
    super(message);
    this.name = 'SttAudioError';
  }
}

export interface DecodedSttAudio {
  samples: Float32Array;
  sampleRate: typeof STT_SAMPLE_RATE;
  channels: typeof STT_CHANNELS;
  durationMs: number;
  source: 'pcm16le' | 'wav';
}

function badAudio(message: string): never {
  throw new SttAudioError('bad_audio', message);
}

function assertDuration(sampleCount: number, maxDurationSeconds: number): void {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new RangeError('maxDurationSeconds must be a positive finite number');
  }
  if (sampleCount > Math.floor(maxDurationSeconds * STT_SAMPLE_RATE)) {
    throw new SttAudioError('too_long', `audio exceeds the ${maxDurationSeconds} second limit`);
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = offset; index < offset + length; index++) value += String.fromCharCode(bytes[index]!);
  return value;
}

function uint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Convert signed little-endian 16-bit PCM into sherpa's normalized samples. */
export function pcm16leToFloat32(bytes: Uint8Array, maxDurationSeconds = STT_MAX_DURATION_SECONDS): Float32Array {
  if (!(bytes instanceof Uint8Array)) badAudio('audio must be bytes');
  if (bytes.byteLength === 0) badAudio('audio is empty');
  if (bytes.byteLength % BYTES_PER_SAMPLE !== 0) badAudio('PCM16 audio has an incomplete sample');

  const sampleCount = bytes.byteLength / BYTES_PER_SAMPLE;
  assertDuration(sampleCount, maxDurationSeconds);
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    samples[index] = input.getInt16(index * BYTES_PER_SAMPLE, true) / 32_768;
  }
  return samples;
}

/** Encode normalized samples as little-endian signed PCM16. */
export function float32ToPcm16le(samples: Float32Array): Uint8Array {
  if (!(samples instanceof Float32Array)) badAudio('samples must be a Float32Array');
  const bytes = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const output = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index]!;
    if (!Number.isFinite(value)) badAudio('samples must be finite');
    const clipped = Math.max(-1, Math.min(1, value));
    const pcm = clipped < 0 ? Math.round(clipped * 32_768) : Math.round(clipped * 32_767);
    output.setInt16(index * BYTES_PER_SAMPLE, pcm, true);
  }
  return bytes;
}

export function decodeRawPcm16le(bytes: Uint8Array, maxDurationSeconds = STT_MAX_DURATION_SECONDS): DecodedSttAudio {
  const samples = pcm16leToFloat32(bytes, maxDurationSeconds);
  return {
    samples,
    sampleRate: STT_SAMPLE_RATE,
    channels: STT_CHANNELS,
    durationMs: (samples.length / STT_SAMPLE_RATE) * 1_000,
    source: 'pcm16le',
  };
}

/**
 * Parse RIFF/WAVE PCM. Unknown chunks and their RIFF padding are accepted, but
 * the audio format itself is intentionally narrow: PCM16LE, mono, 16 kHz.
 */
export function decodeWavPcm16le(bytes: Uint8Array, maxDurationSeconds = STT_MAX_DURATION_SECONDS): DecodedSttAudio {
  if (!(bytes instanceof Uint8Array)) badAudio('audio must be bytes');
  if (bytes.byteLength < 12) badAudio('WAV header is truncated');
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') badAudio('audio is not a RIFF/WAVE file');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = uint32(view, 4) + 8;
  if (riffEnd !== bytes.byteLength) badAudio('WAV RIFF size does not match the body');

  let offset = 12;
  let formatSeen = false;
  let dataOffset = -1;
  let dataLength = -1;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) badAudio('WAV chunk header is truncated');
    const chunkId = ascii(bytes, offset, 4);
    const chunkLength = uint32(view, offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkLength;
    if (payloadEnd > riffEnd) badAudio(`WAV ${chunkId || 'unknown'} chunk exceeds the RIFF body`);

    if (chunkId === 'fmt ') {
      if (formatSeen) badAudio('WAV has more than one format chunk');
      if (chunkLength < 16) badAudio('WAV format chunk is truncated');
      const format = view.getUint16(payloadOffset, true);
      const channels = view.getUint16(payloadOffset + 2, true);
      const sampleRate = uint32(view, payloadOffset + 4);
      const byteRate = uint32(view, payloadOffset + 8);
      const blockAlign = view.getUint16(payloadOffset + 12, true);
      const bitsPerSample = view.getUint16(payloadOffset + 14, true);
      if (format !== 1) badAudio('WAV must use integer PCM encoding');
      if (channels !== STT_CHANNELS) badAudio('WAV must be mono');
      if (sampleRate !== STT_SAMPLE_RATE) badAudio('WAV sample rate must be 16000 Hz');
      if (bitsPerSample !== STT_BITS_PER_SAMPLE) badAudio('WAV samples must be 16-bit');
      if (blockAlign !== STT_CHANNELS * BYTES_PER_SAMPLE) badAudio('WAV block alignment is invalid');
      if (byteRate !== STT_SAMPLE_RATE * blockAlign) badAudio('WAV byte rate is invalid');
      formatSeen = true;
    } else if (chunkId === 'data') {
      if (dataOffset !== -1) badAudio('WAV has more than one data chunk');
      dataOffset = payloadOffset;
      dataLength = chunkLength;
    }

    const paddedEnd = payloadEnd + (chunkLength % 2);
    if (paddedEnd > riffEnd) badAudio('WAV chunk padding is truncated');
    offset = paddedEnd;
  }

  if (!formatSeen) badAudio('WAV format chunk is missing');
  if (dataOffset === -1) badAudio('WAV data chunk is missing');
  if (dataLength === 0) badAudio('audio is empty');
  if (dataLength % BYTES_PER_SAMPLE !== 0) badAudio('WAV data has an incomplete PCM16 sample');

  const samples = pcm16leToFloat32(bytes.subarray(dataOffset, dataOffset + dataLength), maxDurationSeconds);
  return {
    samples,
    sampleRate: STT_SAMPLE_RATE,
    channels: STT_CHANNELS,
    durationMs: (samples.length / STT_SAMPLE_RATE) * 1_000,
    source: 'wav',
  };
}

function parsedContentType(contentType: string): { mime: string; parameters: Map<string, string> } {
  const [rawMime, ...rawParameters] = contentType.split(';');
  const mime = rawMime?.trim().toLowerCase() ?? '';
  const parameters = new Map<string, string>();
  for (const raw of rawParameters) {
    const separator = raw.indexOf('=');
    if (separator === -1) continue;
    parameters.set(
      raw.slice(0, separator).trim().toLowerCase(),
      raw
        .slice(separator + 1)
        .trim()
        .replace(/^"|"$/g, ''),
    );
  }
  return { mime, parameters };
}

export function decodeSttAudio(
  bytes: Uint8Array,
  contentType: string,
  maxDurationSeconds = STT_MAX_DURATION_SECONDS,
): DecodedSttAudio {
  const { mime, parameters } = parsedContentType(contentType);
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return decodeWavPcm16le(bytes, maxDurationSeconds);
  if (mime === 'audio/l16' || mime === 'audio/pcm') {
    const rate = parameters.get('rate');
    const channels = parameters.get('channels');
    if (rate !== undefined && rate !== String(STT_SAMPLE_RATE)) badAudio('PCM sample rate must be 16000 Hz');
    if (channels !== undefined && channels !== String(STT_CHANNELS)) badAudio('PCM audio must be mono');
    return decodeRawPcm16le(bytes, maxDurationSeconds);
  }
  badAudio('content-type must be audio/wav or audio/L16; rate=16000; channels=1');
}

/** Produce a canonical 44-byte-header WAV, useful for interoperability tests. */
export function encodeCanonicalWav(samples: Float32Array): Uint8Array {
  const pcm = float32ToPcm16le(samples);
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, STT_CHANNELS, true);
  view.setUint32(24, STT_SAMPLE_RATE, true);
  view.setUint32(28, STT_SAMPLE_RATE * STT_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(32, STT_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(34, STT_BITS_PER_SAMPLE, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);
  return bytes;
}
