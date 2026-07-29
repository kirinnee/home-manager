import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const PWA_CONFIG_VERSION = 1 as const;
export const PWA_SHORT_NAME_LENGTH = 12;

/**
 * Per-daemon installed-app identity. The icon is an intentionally small
 * monogram rather than an image path: every daemon gets a useful icon without
 * asking the operator to create and maintain five raster sizes per machine.
 */
export interface PwaConfig {
  version: typeof PWA_CONFIG_VERSION;
  /** Installed-app label. Keep this short; `short_name` is capped at 12 code points. */
  name?: string;
  /** One or two ASCII letters/digits rendered into the generated icon. */
  icon?: string;
}

export interface PwaIdentity {
  name: string;
  shortName: string;
  icon: string;
  color: string;
  /** Public cache-buster. Changes whenever normalized identity or rendering semantics change. */
  brandVersion: string;
}

/** A partial update to the persisted PWA identity. `null` removes an explicit
 * value so the daemon returns to its hostname-derived identity. */
export interface PwaConfigPatch {
  name?: string | null;
  icon?: string | null;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const defaultPwaConfig = (): PwaConfig => ({ version: PWA_CONFIG_VERSION });

function normaliseName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || Array.from(name).length > 64 || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

function normaliseIcon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const icon = value.trim().toUpperCase();
  return /^[A-Z0-9]{1,2}$/.test(icon) ? icon : undefined;
}

/** Validate an operator-supplied PATCH strictly. Loading old config remains
 * permissive, but an invalid setting must never look as though it saved. */
export function validatePwaConfigPatch(value: unknown): PwaConfigPatch {
  if (!isRecord(value)) throw new Error('invalid PWA config: request body must be an object');
  const keys = Object.keys(value);
  if (keys.length === 0) throw new Error('invalid PWA config: pass name and/or icon');
  for (const key of keys) {
    if (key !== 'name' && key !== 'icon') throw new Error(`invalid PWA config: unknown field ${key}`);
  }
  const patch: PwaConfigPatch = {};
  if ('name' in value) {
    if (value.name === null) patch.name = null;
    else {
      const name = normaliseName(value.name);
      if (!name) throw new Error('invalid PWA config: name must be 1–64 characters and contain no control characters');
      patch.name = name;
    }
  }
  if ('icon' in value) {
    if (value.icon === null) patch.icon = null;
    else {
      const icon = normaliseIcon(value.icon);
      if (!icon) throw new Error('invalid PWA config: icon must be 1–2 ASCII letters or digits');
      patch.icon = icon;
    }
  }
  return patch;
}

export function mergePwaConfig(config: PwaConfig, patch: PwaConfigPatch): PwaConfig {
  const next: PwaConfig = { ...config, version: PWA_CONFIG_VERSION };
  if ('name' in patch) {
    if (patch.name === null) delete next.name;
    else next.name = patch.name;
  }
  if ('icon' in patch) {
    if (patch.icon === null) delete next.icon;
    else next.icon = patch.icon;
  }
  return next;
}

/**
 * Parse persisted PWA state field by field. An absent version is accepted as
 * additive v0 input; an unknown future version is ignored rather than being
 * interpreted with older semantics.
 */
export function parsePwaConfig(value: unknown): PwaConfig {
  if (!isRecord(value)) return defaultPwaConfig();
  if (value['version'] !== undefined && value['version'] !== PWA_CONFIG_VERSION) return defaultPwaConfig();

  const name = normaliseName(value['name']);
  const icon = normaliseIcon(value['icon']);
  return {
    version: PWA_CONFIG_VERSION,
    ...(name ? { name } : {}),
    ...(icon ? { icon } : {}),
  };
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  return (points.length > maximum ? points.slice(0, maximum).join('') : value).trimEnd();
}

function hostnameName(hostname: string): string {
  const shortHost = hostname.trim().split('.')[0] ?? '';
  const cleaned = shortHost.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  return truncateCodePoints(cleaned, 64) || 'Kteam';
}

function derivedIcon(name: string): string {
  const words = name.normalize('NFKD').match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return 'KT';
}

const ICON_COLORS = ['#3151A3', '#7A3E9D', '#006B70', '#8A3A51', '#76511B', '#2F6B3E', '#5A4B9B'] as const;
const ICON_RENDERER_VERSION = 1;

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function resolvePwaIdentity(config: PwaConfig, hostname: string = os.hostname()): PwaIdentity {
  const name = normaliseName(config.name) ?? hostnameName(hostname);
  const icon = normaliseIcon(config.icon) ?? derivedIcon(name);
  const color = ICON_COLORS[hashString(`${name}\n${icon}`) % ICON_COLORS.length]!;
  return {
    name,
    shortName: truncateCodePoints(name, PWA_SHORT_NAME_LENGTH),
    icon,
    color,
    brandVersion: createHash('sha256')
      .update(JSON.stringify({ version: PWA_CONFIG_VERSION, renderer: ICON_RENDERER_VERSION, name, icon, color }))
      .digest('hex')
      .slice(0, 12),
  };
}

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

function rgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return chunk;
}

/** Render an opaque PNG with no native/image-library dependency. */
export function renderPwaIcon(
  size: number,
  identity: Pick<PwaIdentity, 'icon' | 'color'>,
  purpose: 'any' | 'maskable' = 'any',
): Buffer {
  if (!Number.isInteger(size) || size < 32 || size > 1024)
    throw new Error('PWA icon size must be an integer from 32 to 1024');
  const [backgroundRed, backgroundGreen, backgroundBlue] = rgb(identity.color);
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = backgroundRed;
      raw[pixel + 1] = backgroundGreen;
      raw[pixel + 2] = backgroundBlue;
    }
  }

  // Maskable launchers may crop to the central 80% circle. The smaller grid
  // keeps every white monogram pixel inside that circle while the background
  // remains full bleed. The `any` icon can use more of the square.
  const cell = Math.max(2, Math.floor(size / (purpose === 'maskable' ? 18 : 14)));
  const gap = cell;
  const glyphWidth = cell * 5;
  const totalWidth = glyphWidth * identity.icon.length + gap * (identity.icon.length - 1);
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = Math.floor((size - cell * 7) / 2);
  for (const [index, character] of Array.from(identity.icon).entries()) {
    const glyph = GLYPHS[character] ?? GLYPHS['K']!;
    const glyphX = startX + index * (glyphWidth + gap);
    for (let rowIndex = 0; rowIndex < glyph.length; rowIndex++) {
      for (let column = 0; column < glyph[rowIndex]!.length; column++) {
        if (glyph[rowIndex]![column] !== '1') continue;
        for (let dy = 0; dy < cell; dy++) {
          for (let dx = 0; dx < cell; dx++) {
            const x = glyphX + column * cell + dx;
            const y = startY + rowIndex * cell + dy;
            const pixel = y * (stride + 1) + 1 + x * 3;
            raw[pixel] = 255;
            raw[pixel + 1] = 255;
            raw[pixel + 2] = 255;
          }
        }
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function pwaIconPaths(identity: Pick<PwaIdentity, 'brandVersion'>) {
  const root = `/pwa/icon/${identity.brandVersion}`;
  return {
    any192: `${root}/any-192.png`,
    any512: `${root}/any-512.png`,
    maskable192: `${root}/maskable-192.png`,
    maskable512: `${root}/maskable-512.png`,
    apple: `${root}/apple-touch-180.png`,
  } as const;
}

export function brandPwaManifest(manifest: unknown, identity: PwaIdentity): JsonRecord {
  if (!isRecord(manifest)) throw new Error('PWA manifest is not a JSON object');
  const paths = pwaIconPaths(identity);
  return {
    ...manifest,
    name: identity.name,
    short_name: identity.shortName,
    icons: [
      { src: paths.any192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: paths.any512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: paths.maskable192, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: paths.maskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Apply iOS's non-manifest Add-to-Home-Screen metadata to the served shell. */
export function brandPwaHtml(html: string, identity: PwaIdentity): string {
  const name = escapeHtml(identity.name);
  const shortName = escapeHtml(identity.shortName);
  const paths = pwaIconPaths(identity);
  return html
    .replace(/<link\b[^>]*\brel=(["'])apple-touch-icon\1[^>]*>/i, tag =>
      tag.replace(/\bhref=(["'])[^"']*\1/i, () => `href="${paths.apple}"`),
    )
    .replace(/<meta\b[^>]*\bname=(["'])apple-mobile-web-app-title\1[^>]*>/i, tag =>
      tag.replace(/\bcontent=(["'])[^"']*\1/i, () => `content="${shortName}"`),
    )
    .replace(/<title>[^<]*<\/title>/i, () => `<title>${name}</title>`);
}

const MANIFEST_PATH = /^\/manifest-[a-z][a-z0-9-]*-(?:light|dark)\.[0-9a-f]{12}\.json$/;

function pngResponse(bytes: Buffer): Response {
  return new Response(Uint8Array.from(bytes), {
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
      // The brand-version URL changes whenever these bytes can change.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

export class PwaRuntime {
  private identityValue: PwaIdentity;
  private iconSpecs: ReadonlyMap<string, readonly [size: number, purpose: 'any' | 'maskable']>;
  private readonly icons = new Map<string, Buffer>();
  private readonly hostname: string;

  constructor(config: PwaConfig = defaultPwaConfig(), hostname: string = os.hostname()) {
    this.hostname = hostname;
    this.identityValue = resolvePwaIdentity(config, hostname);
    this.iconSpecs = this.createIconSpecs(this.identityValue);
  }

  get identity(): PwaIdentity {
    return this.identityValue;
  }

  setConfig(config: PwaConfig): void {
    this.identityValue = resolvePwaIdentity(config, this.hostname);
    this.iconSpecs = this.createIconSpecs(this.identityValue);
    this.icons.clear();
  }

  private createIconSpecs(
    identity: PwaIdentity,
  ): ReadonlyMap<string, readonly [size: number, purpose: 'any' | 'maskable']> {
    const paths = pwaIconPaths(identity);
    // Keep daemon bind fast: icons are generated only if a client requests
    // installation metadata, then retained for this immutable brand version.
    return new Map([
      [paths.any192, [192, 'any']],
      [paths.any512, [512, 'any']],
      [paths.maskable192, [192, 'maskable']],
      [paths.maskable512, [512, 'maskable']],
      [paths.apple, [180, 'any']],
    ] as const);
  }

  html(source: string): string {
    return brandPwaHtml(source, this.identity);
  }

  /**
   * Intercept only runtime-owned PWA resources. All other paths return
   * undefined so the API server's existing static/SPA routing remains owner.
   */
  async response(pathname: string, uiDist: string): Promise<Response | undefined> {
    const iconSpec = this.iconSpecs.get(pathname);
    if (iconSpec) {
      let icon = this.icons.get(pathname);
      if (!icon) {
        const [size, purpose] = iconSpec;
        icon = renderPwaIcon(size, this.identity, purpose);
        this.icons.set(pathname, icon);
      }
      return pngResponse(icon);
    }
    // `/pwa` is reserved for runtime-owned, brand-versioned resources. A
    // stale brand URL must be a truthful 404, never the current brand's bytes.
    if (pathname === '/pwa' || pathname.startsWith('/pwa/')) {
      return new Response('PWA resource not found\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (!MANIFEST_PATH.test(pathname)) return undefined;

    const path = join(uiDist, pathname.slice(1));
    if (!existsSync(path)) {
      return new Response('PWA manifest not found\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    try {
      const manifest = brandPwaManifest(await Bun.file(path).json(), this.identity);
      return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
        headers: {
          'content-type': 'application/manifest+json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('PWA manifest is invalid\n', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  }
}
