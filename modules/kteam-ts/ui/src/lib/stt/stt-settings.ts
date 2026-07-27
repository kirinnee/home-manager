// SOLE OWNER of the `kteam-stt-v1` localStorage key.
//
// This codebase keeps ONE owner per storage key (`kteam-theme`,
// `kteam-drafts-v1`, `kteam-ui-controls-v1`). This is dictation's key and
// nothing else reads or writes it.
//
// The rules this file exists to hold:
//   - VERSIONED. A shape change bumps the version and the old payload is
//     discarded rather than half-read. That is a clean migration point instead
//     of a crash on a shape this build has never seen.
//   - DEFENSIVE AND CAPPED. Any malformed, wrong-version, oversized or
//     hostile payload degrades to the defaults. Parsing never throws.
//   - STORAGE DENIAL IS NORMAL. Private windows, disabled storage and quota
//     exhaustion all throw from `localStorage`. Every access here is wrapped;
//     a failed write returns `false` and the app carries on with in-memory
//     settings rather than losing the reader's session to a settings save.
//   - SAME-TAB SUBSCRIPTION. The browser's `storage` event fires in OTHER tabs
//     only, so a settings page and a composer in the SAME tab would not see
//     each other's changes. This file broadcasts its own event as well, and
//     `useSttSettings` listens to both.
//
// DEFAULTS: browser-local transcription, enhancement ON, empty dictionary. Version 2 is
// the local-only migration: v1's daemon/local choice is accepted so a reader's
// dictionary and context survive, but it is normalised to local and is never
// used to route microphone audio to the daemon.

import { useCallback, useSyncExternalStore } from 'react';
import { MAX_USER_CONTEXT_CHARS, parseDictionary, type DictionaryEntry, type DictionaryParse } from './enhancement';

export const STT_SETTINGS_KEY = 'kteam-stt-v1';
export const STT_SETTINGS_VERSION = 2;

/** Same-tab change notification. `storage` only crosses tabs. */
export const STT_SETTINGS_EVENT = 'kteam:stt-settings';

/** Dictionary caps, mirrored from `enhancement.ts` so the textarea can refuse
 *  before the parser has to. */
export const MAX_DICTIONARY_LINES = 200;
export const MAX_DICTIONARY_LINE_LENGTH = 160;

/** The free-text context cap, re-exported so the settings textarea can carry
 *  the same `maxLength` the parser enforces on the way back in. */
export { MAX_USER_CONTEXT_CHARS };

export interface SttSettings {
  v: typeof STT_SETTINGS_VERSION;
  /** Word-only enhancement. On by default: it only ever swaps whole words, and
   *  a verifier throws the whole result away if it did anything else. */
  enhancement: boolean;
  /** One term per line, exactly as the reader typed it. Parsed on use, not on
   *  save, so a half-typed line is never destroyed by a round trip. */
  dictionary: string[];
  /** Free text mined for extra vocabulary — project jargon, names, a pasted
   *  glossary. Stored verbatim; extraction happens on use. */
  userContext: string;
}

export const DEFAULT_STT_SETTINGS: SttSettings = Object.freeze({
  v: STT_SETTINGS_VERSION,
  enhancement: true,
  dictionary: [] as string[],
  userContext: '',
});

/** Defensive parse. Never throws, always returns a usable object. */
export function parseSttSettings(raw: string | null | undefined): SttSettings {
  if (!raw) return { ...DEFAULT_STT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_STT_SETTINGS };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_STT_SETTINGS };
  const obj = parsed as Record<string, unknown>;
  // v1 is migrated explicitly below. Unknown/future payloads are still a clean
  // reset, but removing the execution choice must not discard someone's jargon.
  if (obj['v'] !== STT_SETTINGS_VERSION && obj['v'] !== 1) return { ...DEFAULT_STT_SETTINGS };

  const enhancement = typeof obj['enhancement'] === 'boolean' ? obj['enhancement'] : DEFAULT_STT_SETTINGS.enhancement;

  const dictionaryRaw = obj['dictionary'];
  const dictionary: string[] = [];
  if (Array.isArray(dictionaryRaw)) {
    for (const line of dictionaryRaw) {
      if (typeof line !== 'string') continue;
      if (dictionary.length >= MAX_DICTIONARY_LINES) break;
      dictionary.push(line.slice(0, MAX_DICTIONARY_LINE_LENGTH));
    }
  }

  const userContext = typeof obj['userContext'] === 'string' ? obj['userContext'].slice(0, MAX_USER_CONTEXT_CHARS) : '';

  // v1's `mode` and `language`, plus either field injected into v2, are ignored:
  // there is one local engine and parakeet.js exposes no language input.
  return { v: STT_SETTINGS_VERSION, enhancement, dictionary, userContext };
}

/** Normalise before writing, so a caller cannot persist an out-of-range shape
 *  that only the parser would have caught on the way back in. */
export function normaliseSttSettings(next: SttSettings): SttSettings {
  return parseSttSettings(JSON.stringify(next));
}

/** The storage surface actually used. Injectable so tests never touch a real
 *  `localStorage` and so a denied/absent one is an ordinary code path. */
export interface SttStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SttStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: SttStorage }).localStorage;
    if (!candidate || typeof candidate.getItem !== 'function') return null;
    return candidate;
  } catch {
    // Accessing `localStorage` itself throws when storage is blocked.
    return null;
  }
}

export function loadSttSettings(storage: SttStorage | null = defaultStorage()): SttSettings {
  if (!storage) return { ...DEFAULT_STT_SETTINGS };
  try {
    return parseSttSettings(storage.getItem(STT_SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_STT_SETTINGS };
  }
}

/** Returns whether the write landed. A `false` is not an error the reader needs
 *  to see mid-sentence — the setting simply will not survive a reload. */
export function saveSttSettings(next: SttSettings, storage: SttStorage | null = defaultStorage()): boolean {
  const value = normaliseSttSettings(next);
  cached = value;
  notify(value);
  if (!storage) return false;
  try {
    storage.setItem(STT_SETTINGS_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------- subscription ---------------------------------------------------

   `useSyncExternalStore` requires a snapshot that is IDENTITY-STABLE between
   real changes; returning a freshly parsed object on every render would spin
   React forever. So the parsed value is memoised here and invalidated only by
   a write (this tab) or a `storage` event (another tab).                     */

let cached: SttSettings | null = null;
const listeners = new Set<() => void>();

function notify(value: SttSettings): void {
  cached = value;
  for (const listener of [...listeners]) listener();
  try {
    const target = globalThis as { dispatchEvent?: (event: Event) => boolean };
    if (typeof target.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      target.dispatchEvent(new CustomEvent(STT_SETTINGS_EVENT, { detail: value }));
    }
  } catch {
    // A missing event target is not a reason to fail a settings change.
  }
}

/** Current settings, memoised. */
export function currentSttSettings(): SttSettings {
  if (cached === null) cached = loadSttSettings();
  return cached;
}

/** Drop the memo — used by tests, and by the `storage` listener below. */
export function invalidateSttSettings(): void {
  cached = null;
  for (const listener of [...listeners]) listener();
}

/** Subscribe to settings changes from THIS tab and any other. Returns the
 *  unsubscribe. Safe to call where `window` does not exist. */
export function subscribeSttSettings(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: Event): void => {
    const key = (event as StorageEvent).key;
    // `key === null` is a whole-storage clear, which affects us too.
    if (key === null || key === STT_SETTINGS_KEY) invalidateSttSettings();
  };
  const target = typeof window === 'undefined' ? null : window;
  target?.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    target?.removeEventListener('storage', onStorage);
  };
}

export interface SttSettingsHandle {
  settings: SttSettings;
  /** Partial update; unspecified fields keep their current value. */
  update(patch: Partial<Omit<SttSettings, 'v'>>): void;
  /** `false` once a write has been refused by storage, so the settings page can
   *  say so instead of pretending the choice was saved. */
  persisted: boolean;
}

let lastWritePersisted = true;

/** React binding. SSR-safe: `getServerSnapshot` returns the frozen local-only
 *  defaults, so `renderToStaticMarkup` needs no storage access. */
export function useSttSettings(): SttSettingsHandle {
  const settings = useSyncExternalStore(subscribeSttSettings, currentSttSettings, () => DEFAULT_STT_SETTINGS);
  const update = useCallback((patch: Partial<Omit<SttSettings, 'v'>>) => {
    lastWritePersisted = saveSttSettings({ ...currentSttSettings(), ...patch, v: STT_SETTINGS_VERSION });
  }, []);
  return { settings, update, persisted: lastWritePersisted };
}

/** Parse the reader's dictionary lines into enhancer entries. Re-exported here
 *  so callers need only this module to go from storage to a usable dictionary. */
export function sttDictionary(settings: SttSettings): DictionaryParse {
  return parseDictionary(settings.dictionary);
}

export type { DictionaryEntry, DictionaryParse };
