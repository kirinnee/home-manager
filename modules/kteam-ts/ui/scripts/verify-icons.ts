/* ============================================================================
   Icon verification — the gate that keeps the COMMITTED icon set honest.

   Exported as pure functions so `scripts/verify-icons.test.ts` can run it on
   the `bun test` path (§4.2: "cheap, runs in bun test CI path"); also runnable
   directly:

       bun run verify:icons

   It never invokes sharp — it decodes the committed PNG/ICO bytes itself (see
   scripts/png.ts). A gate that can fail because a native module could not
   dlopen is not a gate.

   Checks:
     1. every icon in `icons.gen.json` exists, and its bytes hash to the
        recorded sha256 (so a hand-edited or truncated icon is caught);
     2. PNG dimensions match the declared size for every variant;
     3. `apple-touch-icon` is fully opaque (iOS ignores alpha and would
        composite the transparent parts onto black);
     4. maskable variants keep all ink inside the 80% safe zone — measured by
        sampling the border band OUTSIDE the safe circle and asserting every
        sample equals the background field, not by trusting the SVG's comment;
     5. the fingerprinted ICO carries exactly the 16 and 32 frames, and the
        stable legacy `favicon.ico` is byte-identical to it *at generation
        time* (its recorded hash — the file itself is intentionally excluded
        from freshness gates because the api-server serves it `immutable`);
     6. every icon URL referenced by a generated manifest or by index.html
        resolves to a file present in `icons.gen.json`.
   ============================================================================ */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodePng, icoFrames, pixelAt } from './png';

const HERE = dirname(new URL(import.meta.url).pathname);
export const UI_ROOT = join(HERE, '..');
export const ICON_DIR = join(UI_ROOT, 'public', 'icons');
export const ICONS_MANIFEST = join(ICON_DIR, 'icons.gen.json');

type IconEntry = {
  name: string;
  file: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  mime: string;
  purpose?: string;
};

type IconsManifest = {
  generatorVersion: string;
  sourceBlob: string;
  sourceSha256: string;
  icons: IconEntry[];
  legacyIco: { file: string; sha256: string; identicalTo: string };
};

export function readIconsManifest(path: string = ICONS_MANIFEST): IconsManifest {
  if (!existsSync(path)) {
    throw new Error(`missing ${path} — run \`bun run gen:icons\` and commit the result`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as IconsManifest;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Every logical icon the rest of the build is entitled to reference. */
export const REQUIRED_ICONS = [
  'icon-192',
  'icon-512',
  'maskable-192',
  'maskable-512',
  'apple-touch-icon',
  'favicon-svg',
  'favicon-ico',
] as const;

export type Problem = string;

/** Sample the band outside the maskable safe zone. A maskable icon's ink must
    live inside the centred circle of radius 40% of the canvas; the platform is
    free to crop anything beyond it. We check the strictest reading — every
    pixel whose distance from the centre exceeds the safe radius must still be
    the background field. */
function maskableSafeZoneProblems(file: string, buf: Buffer): Problem[] {
  const image = decodePng(buf);
  const problems: Problem[] = [];
  const cx = (image.width - 1) / 2;
  const cy = (image.height - 1) / 2;
  const safeRadius = image.width * 0.4;
  const background = pixelAt(image, 0, 0);
  const differs = (x: number, y: number): boolean => {
    const p = pixelAt(image, x, y);
    // Tolerance absorbs PNG/libvips resampling noise at the raster edges; real
    // ink in this mark is ~70 levels away from the field on every channel.
    return (
      Math.abs(p.r - background.r) > 12 ||
      Math.abs(p.g - background.g) > 12 ||
      Math.abs(p.b - background.b) > 12 ||
      Math.abs(p.a - background.a) > 12
    );
  };
  let outside = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (Math.hypot(dx, dy) <= safeRadius) continue;
      outside++;
      if (differs(x, y)) {
        problems.push(`${file}: ink at (${x},${y}) lies outside the 80% maskable safe zone`);
        // One coordinate is enough to act on; keep the output readable.
        return problems;
      }
    }
  }
  if (outside === 0) problems.push(`${file}: safe-zone check sampled no pixels (bad geometry assumption)`);
  return problems;
}

function opacityProblems(file: string, buf: Buffer): Problem[] {
  const image = decodePng(buf);
  if (image.channels === 3) return []; // no alpha channel at all — opaque by construction
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (pixelAt(image, x, y).a !== 255) {
        return [`${file}: apple-touch-icon must be fully opaque, but (${x},${y}) has alpha ${pixelAt(image, x, y).a}`];
      }
    }
  }
  return [];
}

/** Core icon-set verification. Returns a list of human-readable problems;
    empty means the committed set is coherent. */
export function verifyIcons(iconDir: string = ICON_DIR, manifestPath: string = ICONS_MANIFEST): Problem[] {
  const manifest = readIconsManifest(manifestPath);
  const problems: Problem[] = [];
  const byName = new Map(manifest.icons.map(i => [i.name, i]));

  for (const required of REQUIRED_ICONS) {
    if (!byName.has(required)) problems.push(`icons.gen.json is missing required icon "${required}"`);
  }

  for (const icon of manifest.icons) {
    const path = join(iconDir, icon.file);
    if (!existsSync(path)) {
      problems.push(`${icon.file}: referenced by icons.gen.json but not on disk`);
      continue;
    }
    const buf = readFileSync(path);
    if (buf.length !== icon.bytes) problems.push(`${icon.file}: ${buf.length} bytes on disk, ${icon.bytes} recorded`);
    if (sha256(buf) !== icon.sha256) problems.push(`${icon.file}: sha256 does not match icons.gen.json`);

    if (icon.mime === 'image/png') {
      let decoded;
      try {
        decoded = decodePng(buf);
      } catch (error) {
        problems.push(`${icon.file}: ${(error as Error).message}`);
        continue;
      }
      if (icon.width !== undefined && (decoded.width !== icon.width || decoded.height !== icon.height)) {
        problems.push(
          `${icon.file}: ${decoded.width}x${decoded.height} on disk, ${icon.width}x${icon.height} declared`,
        );
      }
      if (icon.purpose === 'maskable') problems.push(...maskableSafeZoneProblems(icon.file, buf));
      if (icon.name === 'apple-touch-icon') problems.push(...opacityProblems(icon.file, buf));
    }
  }

  // ICO frames.
  const icoEntry = byName.get('favicon-ico');
  if (icoEntry && existsSync(join(iconDir, icoEntry.file))) {
    const buf = readFileSync(join(iconDir, icoEntry.file));
    let frames: ReturnType<typeof icoFrames> = [];
    try {
      frames = icoFrames(buf);
    } catch (error) {
      problems.push(`${icoEntry.file}: ${(error as Error).message}`);
    }
    const sizes = frames.map(f => f.width).sort((a, b) => a - b);
    if (sizes.join(',') !== '16,32') {
      problems.push(`${icoEntry.file}: expected 16+32 frames, found [${sizes.join(', ')}]`);
    }
    for (const frame of frames) {
      if (frame.offset + frame.bytes > buf.length) {
        problems.push(`${icoEntry.file}: frame ${frame.width} runs past end of file`);
      }
    }
    // The stable legacy copy must have been byte-identical WHEN GENERATED. We
    // compare recorded hashes, not the file on disk: `/favicon.ico` is served
    // `immutable` and is deliberately allowed to go stale (§4.2/C3).
    if (manifest.legacyIco.sha256 !== icoEntry.sha256 || manifest.legacyIco.identicalTo !== icoEntry.file) {
      problems.push('icons.gen.json: legacy favicon.ico was not byte-identical to the fingerprinted ICO at generation');
    }
    if (!existsSync(join(iconDir, manifest.legacyIco.file))) {
      problems.push(`${manifest.legacyIco.file}: legacy fallback copy is missing`);
    }
  }

  // Orphans: generated-looking files on disk that icons.gen.json does not know
  // about would be shipped by Vite's public copy without any provenance.
  const known = new Set([...manifest.icons.map(i => i.file), manifest.legacyIco.file, 'icons.gen.json']);
  for (const name of readdirSync(iconDir)) {
    if (!known.has(name)) problems.push(`${name}: present in public/icons but absent from icons.gen.json`);
  }

  return problems;
}

/** Cross-check that every icon URL a *reference* file mentions resolves to a
    file recorded in `icons.gen.json`. Used for the generated manifests and for
    index.html (§4.2 — "every manifest/HTML reference resolves"). */
export function verifyIconReferences(text: string, source: string, manifestPath: string = ICONS_MANIFEST): Problem[] {
  const manifest = readIconsManifest(manifestPath);
  const known = new Set(manifest.icons.map(i => i.file));
  const problems: Problem[] = [];
  for (const match of text.matchAll(/\/icons\/([A-Za-z0-9._-]+)/g)) {
    const file = match[1]!;
    if (file === manifest.legacyIco.file) {
      problems.push(`${source}: references the stable legacy /icons/favicon.ico, which must never be linked (C3)`);
      continue;
    }
    if (file === 'icons.gen.json') continue;
    if (!known.has(file)) problems.push(`${source}: references /icons/${file}, which is not in icons.gen.json`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyIcons();
  const indexHtml = join(UI_ROOT, 'index.html');
  if (existsSync(indexHtml)) {
    problems.push(...verifyIconReferences(readFileSync(indexHtml, 'utf8'), 'index.html'));
  }
  if (problems.length > 0) {
    console.error(`verify-icons: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const manifest = readIconsManifest();
  console.log(`verify-icons: OK — ${manifest.icons.length} icons + legacy favicon.ico verified`);
}
