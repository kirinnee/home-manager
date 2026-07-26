/* ============================================================================
   Content hashing shared by the icon generator and the icon verifier.

   These two must agree byte-for-byte on how provenance is computed, or the
   verifier's "does the committed source still match the recorded hashes?" check
   silently becomes "do two different hash functions disagree?". One definition,
   imported by both.
   ============================================================================ */

import { createHash } from 'node:crypto';

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** First 10 hex chars of the sha256 — the fingerprint embedded in icon
    filenames. Long enough that a collision is not a practical concern for a
    handful of icons, short enough to keep the URLs readable. */
export function fingerprint(buf: Uint8Array): string {
  return sha256(buf).slice(0, 10);
}

/** `git hash-object`-compatible blob id, computed locally so neither the
    generator nor the verifier needs to shell out to git (and both work in a
    checkout without one). Recorded alongside the sha256 so a provenance
    mismatch can be traced with ordinary git tooling. */
export function gitBlobHash(buf: Uint8Array): string {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([header, Buffer.from(buf)]))
    .digest('hex');
}
