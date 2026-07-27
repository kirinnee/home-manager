// Teammate naming: window, normalisation and draw logic. The pool itself
// (~10,000 names) lives in names-pool.ts to keep this file readable.
// Names are NOT globally unique — a name only has to be unique among sessions
// created in the resolution window (5 days), which this pool cannot exhaust in
// normal use. Resolution: most recent session wins.

import { TEAMMATE_NAME_POOL } from './names-pool';

export const NAME_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/** Longest a teammate callsign may be. The pool names are short; a title-length
 *  string belongs in `--name` (the task), not here. */
export const MAX_TEAMMATE_NAME_LENGTH = 32;

/** Normalise a caller-supplied teammate name to the shape the pool uses:
 *  trimmed, lowercased, a leading letter then letters/digits/hyphens, at most
 *  MAX_TEAMMATE_NAME_LENGTH chars. Returns null when the input cannot be a valid
 *  slug — the daemon rejects that LOUDLY rather than rewriting it, because the
 *  caller is about to embed the name in a session title and a silent rename
 *  would make `[Foo] …` point at teammate `bar`. */
export function normalizeTeammateName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!name || name.length > MAX_TEAMMATE_NAME_LENGTH) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  return name;
}

export const TEAMMATE_NAMES: string[] = TEAMMATE_NAME_POOL;

/** Pick a teammate name: uniform-random among names unused in the window; if the
 *  whole pool is somehow used, fall back to the least-recently-used name. */
export function pickTeammateName(recentlyUsed: Iterable<string>, lastUsedAt?: Map<string, number>): string {
  const used = new Set<string>();
  for (const name of recentlyUsed) used.add(name.toLowerCase());
  const available = TEAMMATE_NAMES.filter(name => !used.has(name));
  if (available.length > 0) return available[Math.floor(Math.random() * available.length)]!;
  let best = TEAMMATE_NAMES[0]!;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const name of TEAMMATE_NAMES) {
    const time = lastUsedAt?.get(name) ?? 0;
    if (time < bestTime) {
      bestTime = time;
      best = name;
    }
  }
  return best;
}

/** The stored form of a session's human TITLE (`config.name`). It is displayed
 *  verbatim in `ps` and the dashboard, so it PRESERVES the caller's text —
 *  including the `[Teammate] Task Title` convention — and only flattens control
 *  characters / runs of whitespace and caps the length.
 *
 *  It used to slugify (`[^a-zA-Z0-9_-] -> '-'`, cap 48), which turned
 *  `[Hayden] Fix Transcript` into `-Hayden--Fix-Transcript` and made the
 *  bracket convention impossible. That slug was never load-bearing: session
 *  directories are keyed by session id and tmux names by shellSafeSessionName(id),
 *  so nothing downstream needs a filesystem-safe token here. A client that has
 *  to look up a session it started must still compare against THIS shape (the
 *  daemon stores exactly what this returns). */
export function displayName(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, ' ') // flatten control chars (newlines, tabs, etc.)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
