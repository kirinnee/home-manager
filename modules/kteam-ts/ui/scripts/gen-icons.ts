/* ============================================================================
   Icon generator — MANUAL, never part of a normal build.

       bun run gen:icons          # from modules/kteam-ts/ui

   Renders `brand/kteam-mark.svg` into the committed, content-fingerprinted icon
   set under `public/icons/`, and writes `public/icons/icons.gen.json` — the
   provenance manifest every other step reads instead of guessing filenames.

   ── WHY MANUAL ────────────────────────────────────────────────────────────
   `sharp` is a native binary dependency. Running it inside `bun run build`
   would put a platform-specific compile step on the critical path of every
   deploy, and would make the build's own determinism gate depend on libvips
   producing byte-identical PNGs across versions. Instead: generate once, commit
   the outputs, and let the build merely *read* them. `verify-icons.ts` (which
   needs no sharp beyond decoding, and runs in the `bun test` path) is what
   keeps the committed set honest.

   sharp is pinned to an EXACT version in package.json devDependencies — never
   fetched floatingly via `bunx`, because a floating fetch would silently change
   the renderer under a set of committed artifacts.

   ── OUTPUTS ───────────────────────────────────────────────────────────────
   * icon-192 / icon-512            — `purpose: "any"`, mark cropped to fill
   * maskable-192 / maskable-512    — `purpose: "maskable"`, full-bleed with the
                                      platform's 80% safe zone as headroom
   * apple-touch-icon (180)         — fully opaque, no alpha (iOS composites a
                                      transparent icon onto black and the mark's
                                      own dark field would vanish into it)
   * favicon.<sha>.svg              — the source mark, fingerprinted
   * favicon.<sha>.ico              — 16+32 frames, fingerprinted, and the
                                      PRIMARY linked ICO
   * favicon.ico                    — byte-identical stable copy, emitted ONLY
                                      as a legacy fallback for user agents that
                                      probe the well-known path. Under the
                                      api-server's unconditional `immutable`
                                      header this copy can stay in a browser
                                      cache for a year, so it is deliberately
                                      never linked and never part of any
                                      freshness assertion.
   ============================================================================ */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GENERATOR_VERSION = '1.0.0';

/* ---------- loading sharp inside a Nix dev shell --------------------------
   sharp ships a prebuilt native binary linked against the system libstdc++.
   Inside this repo's Nix shell there is no /usr/lib/libstdc++.so.6, so the
   dlopen fails with ERR_DLOPEN_FAILED even though the library is right there
   in the store. Rather than making every caller remember an LD_LIBRARY_PATH
   incantation (and rather than hardcoding a store path that changes on every
   toolchain bump), ask the shell's own g++ where its libstdc++ is and re-exec
   once with that directory on the loader path. The guard env var makes the
   re-exec strictly one-shot, so a genuinely broken install still fails fast
   instead of looping.
   ------------------------------------------------------------------------ */
const REEXEC_GUARD = 'KTEAM_GEN_ICONS_REEXEC';

async function loadSharp(): Promise<typeof import('sharp').default> {
  try {
    return (await import('sharp')).default;
  } catch (error) {
    const dlopenFailed = String(error).includes('ERR_DLOPEN_FAILED') || String(error).includes('libstdc++');
    if (!dlopenFailed || process.platform !== 'linux' || process.env[REEXEC_GUARD]) throw error;
    let libDir: string;
    try {
      libDir = dirname(execFileSync('g++', ['--print-file-name=libstdc++.so.6'], { encoding: 'utf8' }).trim());
    } catch {
      throw error;
    }
    if (!existsSync(join(libDir, 'libstdc++.so.6'))) throw error;
    const ldPath = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    console.log(`gen-icons: retrying with LD_LIBRARY_PATH=${libDir} (Nix shell has no system libstdc++)`);
    const child = Bun.spawnSync([process.execPath, new URL(import.meta.url).pathname, ...process.argv.slice(2)], {
      env: { ...process.env, LD_LIBRARY_PATH: ldPath, [REEXEC_GUARD]: '1' },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    process.exit(child.exitCode ?? 1);
  }
}

const sharp = await loadSharp();

const HERE = dirname(new URL(import.meta.url).pathname);
const UI_ROOT = join(HERE, '..');
const SOURCE_SVG = join(UI_ROOT, 'brand', 'kteam-mark.svg');
const ICON_DIR = join(UI_ROOT, 'public', 'icons');
const MANIFEST_PATH = join(ICON_DIR, 'icons.gen.json');

/** Padding trimmed off the "any" variants. The source keeps mask headroom; an
    `any` icon is displayed as-authored, so it should fill more of its box. */
const ANY_CROP = 56;

export type IconEntry = {
  /** Logical name every consumer refers to — never a filename. */
  name: string;
  file: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  mime: string;
  purpose?: 'any' | 'maskable';
};

export type IconsManifest = {
  generatorVersion: string;
  command: string;
  /** `git hash-object` of brand/kteam-mark.svg — ties this set to exact art. */
  sourceBlob: string;
  sourceSha256: string;
  icons: IconEntry[];
  /** Deliberately-stale legacy fallback; excluded from freshness gates. */
  legacyIco: { file: string; sha256: string; identicalTo: string };
};

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function fingerprint(buf: Uint8Array): string {
  return sha256(buf).slice(0, 10);
}

/** `git hash-object`-compatible blob id, computed locally so the generator does
    not need a git process (and works in a fresh checkout without one). */
function gitBlobHash(buf: Uint8Array): string {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([header, Buffer.from(buf)]))
    .digest('hex');
}

/* ---------- ICO container ------------------------------------------------
   Written by hand: sharp has no ICO encoder, and pulling a second native
   dependency in for a 4 KB container would be worse than 30 lines of
   DataView. Frames are stored as full PNGs, which every browser since IE11
   accepts inside an ICO.
   ------------------------------------------------------------------------ */
function buildIco(frames: { size: number; png: Buffer }[]): Buffer {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries: Buffer[] = [];
  let offset = 6 + count * 16;
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    // 256 is encoded as 0 in an ICO directory; our sizes are 16/32 so this is
    // just defensive.
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1);
    entry.writeUInt8(0, 2); // palette size (0 = truecolour)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += frame.png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...frames.map(f => f.png)]);
}

/** Deterministic PNG encoding options. `sharp` defaults can vary with build
    flags; pinning them keeps a re-run byte-stable for the same libvips. */
const PNG_OPTS = { compressionLevel: 9, effort: 10, palette: false } as const;

/** Rasterise the source at its authored 512 box. A sharp pipeline allows only
    ONE resize, so cropping then rescaling needs two passes with this in
    between. */
async function rasterise(svg: Buffer): Promise<Buffer> {
  return sharp(svg, { density: 384 }).resize(512, 512, { fit: 'fill' }).png(PNG_OPTS).toBuffer();
}

async function renderAny(size: number, base512: Buffer): Promise<Buffer> {
  return sharp(base512)
    .extract({ left: ANY_CROP, top: ANY_CROP, width: 512 - ANY_CROP * 2, height: 512 - ANY_CROP * 2 })
    .resize(size, size, { fit: 'fill' })
    .png(PNG_OPTS)
    .toBuffer();
}

async function renderMaskable(size: number, base512: Buffer): Promise<Buffer> {
  // Full-bleed, no crop: the platform mask eats the outer ~20% and the source
  // keeps all ink inside the central 80% circle for exactly this reason.
  return sharp(base512).resize(size, size, { fit: 'fill' }).png(PNG_OPTS).toBuffer();
}

async function renderApple(size: number, base512: Buffer): Promise<Buffer> {
  // Flattened onto the mark's own background so the result carries no alpha at
  // all — iOS does not honour transparency and would composite onto black.
  return sharp(base512)
    .resize(size, size, { fit: 'fill' })
    .flatten({ background: '#0b0b0d' })
    .removeAlpha()
    .png(PNG_OPTS)
    .toBuffer();
}

/** Remove previously generated icons so renames never leave orphans behind.
    Scoped to the exact generated naming schemes; anything else in `public/icons`
    is left alone. */
function cleanGenerated(): void {
  if (!existsSync(ICON_DIR)) return;
  const schemes = [
    /^icon-(192|512)\.[0-9a-f]{10}\.png$/,
    /^maskable-(192|512)\.[0-9a-f]{10}\.png$/,
    /^apple-touch-icon\.[0-9a-f]{10}\.png$/,
    /^favicon\.[0-9a-f]{10}\.(svg|ico)$/,
    /^favicon\.ico$/,
    // pre-1.0.0 stems, swept so a rename cannot leave orphans behind
    /^favicon-(svg|ico)\.[0-9a-f]{10}\.(svg|ico)$/,
    /^icons\.gen\.json$/,
  ];
  for (const name of readdirSync(ICON_DIR)) {
    if (schemes.some(re => re.test(name))) unlinkSync(join(ICON_DIR, name));
  }
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_SVG)) {
    console.error(`gen-icons: missing source ${SOURCE_SVG}`);
    process.exit(2);
  }
  const svg = readFileSync(SOURCE_SVG);
  mkdirSync(ICON_DIR, { recursive: true });
  cleanGenerated();

  const icons: IconEntry[] = [];

  /** `logical` is the stable key consumers reference; `base` is the on-disk file
      stem. They differ only for the two favicons, which share the stem
      `favicon` (per §4.2's `/favicon.<sha>.svg` + `/favicon.<sha>.ico`) but need
      distinct logical keys. */
  const emit = (logical: string, base: string, ext: string, buf: Buffer, extra: Partial<IconEntry>): IconEntry => {
    const file = `${base}.${fingerprint(buf)}.${ext}`;
    writeFileSync(join(ICON_DIR, file), buf);
    const entry: IconEntry = {
      name: logical,
      file,
      sha256: sha256(buf),
      bytes: buf.length,
      mime: ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : 'image/x-icon',
      ...extra,
    };
    icons.push(entry);
    return entry;
  };

  const base512 = await rasterise(svg);

  for (const size of [192, 512] as const) {
    emit(`icon-${size}`, `icon-${size}`, 'png', await renderAny(size, base512), {
      width: size,
      height: size,
      purpose: 'any',
    });
    emit(`maskable-${size}`, `maskable-${size}`, 'png', await renderMaskable(size, base512), {
      width: size,
      height: size,
      purpose: 'maskable',
    });
  }
  emit('apple-touch-icon', 'apple-touch-icon', 'png', await renderApple(180, base512), { width: 180, height: 180 });
  emit('favicon-svg', 'favicon', 'svg', svg, {});

  const icoFrames = await Promise.all(
    ([16, 32] as const).map(async size => ({ size, png: await renderAny(size, base512) })),
  );
  const ico = buildIco(icoFrames);
  const icoEntry = emit('favicon-ico', 'favicon', 'ico', ico, {});

  // Stable legacy copy — byte-identical, intentionally never linked (see header).
  writeFileSync(join(ICON_DIR, 'favicon.ico'), ico);

  const manifest: IconsManifest = {
    generatorVersion: GENERATOR_VERSION,
    command: 'bun run gen:icons  (cwd: modules/kteam-ts/ui)',
    sourceBlob: gitBlobHash(svg),
    sourceSha256: sha256(svg),
    icons,
    legacyIco: { file: 'favicon.ico', sha256: sha256(ico), identicalTo: icoEntry.file },
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`gen-icons: wrote ${icons.length} icons + favicon.ico + icons.gen.json into public/icons/`);
  for (const i of icons) console.log(`  ${i.name.padEnd(18)} ${i.file}`);
}

await main();
