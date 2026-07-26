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
        stable legacy `public/favicon.ico` is byte-identical to it ON DISK,
        not merely according to two recorded manifest fields;
     6. the CURRENT `brand/kteam-mark.svg` still hashes to both recorded
        provenance values, so a committed art change without regenerated icons
        fails instead of shipping icons that do not match their source;
     7. every icon URL referenced by a generated manifest or by index.html
        resolves to a file present in `icons.gen.json`.

   ── WHY 5 AND 6 HASH REAL BYTES ───────────────────────────────────────────
   An audit found both of these were false negatives. The legacy check compared
   `manifest.legacyIco.sha256` with `icon.sha256` — two numbers from the same
   generation run, which agree by construction and keep agreeing after someone
   edits the actual file. And `sourceBlob`/`sourceSha256` were declared in the
   type but never compared to anything. In an isolated copy, flipping a byte in
   `favicon.ico` still returned zero problems.

   The HTTP cache policy is irrelevant here: `/favicon.ico` being served
   `immutable` means a BROWSER may hold a stale copy, which is intended. It says
   nothing about whether the bytes in the repo match their provenance, and this
   is a source-tree verifier.
   ============================================================================ */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitBlobHash, sha256 } from './hash';
import { decodePng, icoFrames, pixelAt } from './png';

const HERE = dirname(new URL(import.meta.url).pathname);
export const UI_ROOT = join(HERE, '..');
export const PUBLIC_DIR = join(UI_ROOT, 'public');
export const ICON_DIR = join(PUBLIC_DIR, 'icons');
export const ICONS_MANIFEST = join(ICON_DIR, 'icons.gen.json');
/** The art the committed icons are rendered from. Hashed on every verify so a
    changed mark without a regenerated set is a failure, not a silent drift. */
export const SOURCE_SVG = join(UI_ROOT, 'brand', 'kteam-mark.svg');

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

export type IconsManifest = {
  generatorVersion: string;
  /** Path of the source art, relative to the ui package. Optional so an older
      manifest still parses; the verifier falls back to the canonical path. */
  sourceFile?: string;
  sourceBlob: string;
  sourceSha256: string;
  icons: IconEntry[];
  legacyIco: {
    file: string;
    /** Served URL. Optional for older manifests; when present it must be the
        root path, since a nested legacy copy answers no browser probe. */
    url?: string;
    sha256: string;
    identicalTo: string;
  };
};

export function readIconsManifest(path: string = ICONS_MANIFEST): IconsManifest {
  if (!existsSync(path)) {
    throw new Error(`missing ${path} — run \`bun run gen:icons\` and commit the result`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as IconsManifest;
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

/** Re-hash the CURRENT source mark and compare against both recorded
    provenance values. This is what makes "the committed icons were rendered
    from the committed art" a checked fact. Both hashes are compared, not just
    one, because they are recorded independently and a disagreement between them
    means the provenance file itself is corrupt. */
export function sourceProvenanceProblems(manifest: IconsManifest, sourceSvg: string = SOURCE_SVG): Problem[] {
  const rel = manifest.sourceFile ?? 'brand/kteam-mark.svg';
  if (!existsSync(sourceSvg)) {
    return [`${rel}: icon source art is missing, but icons.gen.json records hashes for it`];
  }
  const problems: Problem[] = [];
  const buf = readFileSync(sourceSvg);
  const actualSha = sha256(buf);
  const actualBlob = gitBlobHash(buf);
  if (actualSha !== manifest.sourceSha256) {
    problems.push(
      `${rel}: sha256 ${actualSha.slice(0, 12)}… does not match icons.gen.json ` +
        `(${manifest.sourceSha256.slice(0, 12)}…) — run \`bun run gen:icons\` and commit the regenerated set`,
    );
  }
  if (actualBlob !== manifest.sourceBlob) {
    problems.push(
      `${rel}: git blob ${actualBlob.slice(0, 12)}… does not match icons.gen.json ` +
        `(${manifest.sourceBlob.slice(0, 12)}…) — run \`bun run gen:icons\` and commit the regenerated set`,
    );
  }
  return problems;
}

/** Verify the unlinked root legacy fallback against the fingerprinted ICO's
    ACTUAL bytes. `publicDir` is the directory the file lives in — `public/`,
    not `public/icons/`, because the whole point is the root URL. */
export function legacyIcoProblems(
  manifest: IconsManifest,
  fingerprintedIco: Buffer | undefined,
  publicDir: string = PUBLIC_DIR,
): Problem[] {
  const { legacyIco } = manifest;
  const path = join(publicDir, legacyIco.file);
  const problems: Problem[] = [];

  // The served URL must be the well-known root path, or the fallback answers
  // nothing: a browser probing /favicon.ico would get the SPA shell instead.
  const expectedUrl = `/${legacyIco.file}`;
  if (legacyIco.url !== undefined && legacyIco.url !== expectedUrl) {
    problems.push(`icons.gen.json: legacyIco.url is ${legacyIco.url}, expected ${expectedUrl}`);
  }
  if (legacyIco.file.includes('/')) {
    problems.push(
      `icons.gen.json: legacyIco.file is ${legacyIco.file}; the legacy fallback must sit at the public root ` +
        `so it is served as /favicon.ico`,
    );
  }

  if (!existsSync(path)) {
    problems.push(`${legacyIco.file}: legacy fallback copy is missing from the public root`);
    return problems;
  }

  // Hash the REAL bytes. Comparing the two recorded fields to each other (the
  // previous behaviour) can never fail, because generation wrote both.
  const buf = readFileSync(path);
  const actual = sha256(buf);
  if (actual !== legacyIco.sha256) {
    problems.push(
      `${legacyIco.file}: sha256 does not match icons.gen.json (the file has been modified since generation)`,
    );
  }
  if (fingerprintedIco !== undefined && !buf.equals(fingerprintedIco)) {
    problems.push(
      `${legacyIco.file}: not byte-identical to the fingerprinted ${legacyIco.identicalTo} — ` +
        `the legacy fallback must be an exact copy`,
    );
  }
  return problems;
}

/** Core icon-set verification. Returns a list of human-readable problems;
    empty means the committed set is coherent. */
export function verifyIcons(
  iconDir: string = ICON_DIR,
  manifestPath: string = ICONS_MANIFEST,
  options: { publicDir?: string; sourceSvg?: string } = {},
): Problem[] {
  const manifest = readIconsManifest(manifestPath);
  const problems: Problem[] = [];
  const byName = new Map(manifest.icons.map(i => [i.name, i]));
  // `public/` is the parent of `icons/` unless a test points them elsewhere.
  const publicDir = options.publicDir ?? dirname(iconDir);

  for (const required of REQUIRED_ICONS) {
    if (!byName.has(required)) problems.push(`icons.gen.json is missing required icon "${required}"`);
  }

  problems.push(...sourceProvenanceProblems(manifest, options.sourceSvg ?? SOURCE_SVG));

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

  // ICO frames, and the legacy copy measured against these real bytes.
  const icoEntry = byName.get('favicon-ico');
  let fingerprintedIco: Buffer | undefined;
  if (icoEntry && existsSync(join(iconDir, icoEntry.file))) {
    const buf = readFileSync(join(iconDir, icoEntry.file));
    fingerprintedIco = buf;
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
    if (manifest.legacyIco.identicalTo !== icoEntry.file) {
      problems.push(
        `icons.gen.json: legacyIco.identicalTo is ${manifest.legacyIco.identicalTo}, ` +
          `but the fingerprinted ICO is ${icoEntry.file}`,
      );
    }
  }
  // Runs even when the fingerprinted ICO is missing, so "both ICOs absent" is
  // still reported rather than silently skipped.
  problems.push(...legacyIcoProblems(manifest, fingerprintedIco, publicDir));

  // Orphans: generated-looking files on disk that icons.gen.json does not know
  // about would be shipped by Vite's public copy without any provenance. The
  // legacy ICO is NOT expected here any more — it lives at the public root.
  const known = new Set([...manifest.icons.map(i => i.file), 'icons.gen.json']);
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
    if (file === 'icons.gen.json') continue;
    if (!known.has(file)) problems.push(`${source}: references /icons/${file}, which is not in icons.gen.json`);
  }
  // The root legacy fallback exists for user agents that probe `/favicon.ico`
  // on their own. Linking it would opt real page loads into an intentionally
  // immutable, potentially year-stale icon — the fingerprinted ICO is the
  // primary (C3). Matched with a boundary so `/favicon.1e0c791b41.ico` and
  // `/icons/favicon.ico` do not trip it.
  const legacyUrl = manifest.legacyIco.url ?? `/${manifest.legacyIco.file}`;
  const legacyLink = new RegExp(`(^|[^/\\w.])${legacyUrl.replace(/[.]/g, '\\.')}(?![\\w.])`);
  if (legacyLink.test(text)) {
    problems.push(`${source}: links the stable legacy ${legacyUrl}, which must never be linked (C3)`);
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
  console.log(
    `verify-icons: OK — ${manifest.icons.length} icons, source provenance, ` +
      `and the unlinked root ${manifest.legacyIco.url ?? '/favicon.ico'} verified`,
  );
}
