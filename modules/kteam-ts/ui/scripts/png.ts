/* ============================================================================
   Minimal PNG reader — just enough to VERIFY the committed icons.

   `verify-icons.ts` runs on the `bun test` path, so it must not depend on
   sharp: sharp is a native module that needs a libstdc++ the Nix dev shell does
   not put on the loader path (see the re-exec dance in gen-icons.ts). Making
   the verifier able to fail for reasons unrelated to the icons would defeat its
   purpose. Decoding 8-bit non-interlaced RGB/RGBA — which is all
   `gen-icons.ts` ever writes — is 60 lines over node:zlib, so it lives here.

   Deliberately NOT a general PNG decoder: interlacing, 16-bit samples,
   palettes and greyscale are rejected loudly rather than mis-decoded, because a
   silent wrong answer in a gate is worse than no gate.
   ============================================================================ */

import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngChunk = { type: string; data: Buffer };

export function pngChunks(buf: Buffer): PngChunk[] {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data });
    at += 12 + length; // length + type + data + crc
    if (type === 'IEND') break;
  }
  return chunks;
}

export type PngHeader = {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA */
  colorType: number;
  interlace: number;
};

export function pngHeader(buf: Buffer): PngHeader {
  const ihdr = pngChunks(buf).find(c => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR');
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data.readUInt8(8),
    colorType: ihdr.data.readUInt8(9),
    interlace: ihdr.data.readUInt8(12),
  };
}

export type PngImage = PngHeader & {
  channels: number;
  /** Row-major, `channels` samples per pixel, 8 bits each. */
  pixels: Uint8Array;
};

function unfilter(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++]!;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const value = raw[at + x]!;
      const a = x >= channels ? row[x - channels]! : 0; // left
      const b = prev ? prev[x]! : 0; // up
      const c = prev && x >= channels ? prev[x - channels]! : 0; // up-left
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + a;
          break;
        case 2:
          recon = value + b;
          break;
        case 3:
          recon = value + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unsupported PNG row filter ${filter}`);
      }
      row[x] = recon & 0xff;
    }
    at += stride;
  }
  return out;
}

export function decodePng(buf: Buffer): PngImage {
  const header = pngHeader(buf);
  if (header.interlace !== 0) throw new Error('interlaced PNG not supported by this reader');
  if (header.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${header.bitDepth} (expected 8)`);
  const channels = header.colorType === 2 ? 3 : header.colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${header.colorType} (expected 2 or 6)`);
  const idat = Buffer.concat(
    pngChunks(buf)
      .filter(c => c.type === 'IDAT')
      .map(c => Buffer.from(c.data)),
  );
  if (idat.length === 0) throw new Error('PNG has no IDAT data');
  const pixels = unfilter(inflateSync(idat), header.width, header.height, channels);
  return { ...header, channels, pixels };
}

export type Rgba = { r: number; g: number; b: number; a: number };

export function pixelAt(image: PngImage, x: number, y: number): Rgba {
  const i = (y * image.width + x) * image.channels;
  const p = image.pixels;
  return {
    r: p[i]!,
    g: p[i + 1]!,
    b: p[i + 2]!,
    a: image.channels === 4 ? p[i + 3]! : 255,
  };
}

/* ---------- ICO ----------------------------------------------------------- */

export type IcoFrame = { width: number; height: number; bytes: number; offset: number };

/** Parse an ICO directory. Width/height 0 in the directory means 256. */
export function icoFrames(buf: Buffer): IcoFrame[] {
  if (buf.length < 6) throw new Error('not an ICO (too short)');
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO (bad header)');
  const count = buf.readUInt16LE(4);
  const frames: IcoFrame[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    frames.push({
      width: buf.readUInt8(at) || 256,
      height: buf.readUInt8(at + 1) || 256,
      bytes: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12),
    });
  }
  return frames;
}
