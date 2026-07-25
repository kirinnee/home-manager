// Theme state: a FAMILY (which look) plus a MODE PREFERENCE (system / light /
// dark). Both live under the single `kteam-theme` localStorage key, and the
// resolved pair is published as ONE root attribute:
//
//     <html data-theme="<family>-<mode>">     // mode already resolved
//
// The same resolution runs pre-paint in `index.html` as a tiny inline script so
// there is no flash of the wrong theme. THE TWO MUST AGREE — same key, same
// legacy handling, same family list, same attribute shape. Change one, change
// the other (index.html points back here).
//
// Legacy: the key used to hold the bare strings 'light' / 'dark'. Those are
// read as "Studio, with that mode pinned" and rewritten in the new shape on the
// first explicit change.

import { useCallback, useEffect, useMemo, useState } from 'react';

const KEY = 'kteam-theme';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedMode = 'light' | 'dark';
export type ThemeFamilyId = 'studio' | 'mission' | 'neo' | 'ember' | 'contrast';

export interface ThemeFamily {
  id: ThemeFamilyId;
  /** Picker label. */
  label: string;
  /** One line on what the family is FOR, not what colour it is. */
  blurb: string;
}

/** Metadata for the picker. Order is the order shown. */
export const THEME_FAMILIES: readonly ThemeFamily[] = [
  { id: 'studio', label: 'Studio', blurb: 'The house look — indigo on cool zinc.' },
  { id: 'mission', label: 'Mission Control', blurb: 'Condensed telemetry, cyan hairlines, scanlines.' },
  { id: 'neo', label: 'Neo-Brutalism', blurb: 'Hard rules, flat offset shadows, AA-checked.' },
  { id: 'ember', label: 'Ember', blurb: 'Warm low-blue-light paper for long evenings.' },
  { id: 'contrast', label: 'High Contrast', blurb: 'Maximum legibility, AAA-targeted, no effects.' },
];

const FAMILY_IDS: readonly string[] = THEME_FAMILIES.map(f => f.id);
const MODES: readonly string[] = ['system', 'light', 'dark'];
const DEFAULT_FAMILY: ThemeFamilyId = 'studio';

export interface ThemePref {
  family: ThemeFamilyId;
  mode: ThemeMode;
}

/**
 * Parse whatever is in storage into a valid preference. Accepts, in order:
 * the current JSON shape, a legacy bare mode ('light' | 'dark' | 'system'),
 * and a bare resolved attribute ('mission-dark') in case one was ever written
 * by hand. Anything unrecognised falls back to Studio + system.
 */
export function parseThemePref(raw: string | null): ThemePref {
  const fallback: ThemePref = { family: DEFAULT_FAMILY, mode: 'system' };
  if (!raw) return fallback;
  const text = raw.trim();
  if (!text) return fallback;

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Partial<ThemePref> | null;
      return {
        family:
          parsed && FAMILY_IDS.includes(parsed.family as string) ? (parsed.family as ThemeFamilyId) : DEFAULT_FAMILY,
        mode: parsed && MODES.includes(parsed.mode as string) ? (parsed.mode as ThemeMode) : 'system',
      };
    } catch {
      return fallback;
    }
  }

  // Legacy `kteam-theme: 'dark'` — keep the user's mode, adopt Studio.
  if (MODES.includes(text)) return { family: DEFAULT_FAMILY, mode: text as ThemeMode };

  const cut = text.lastIndexOf('-');
  if (cut > 0) {
    const family = text.slice(0, cut);
    const mode = text.slice(cut + 1);
    if (FAMILY_IDS.includes(family) && (mode === 'light' || mode === 'dark')) {
      return { family: family as ThemeFamilyId, mode };
    }
  }
  return fallback;
}

function read(): ThemePref {
  if (typeof window === 'undefined') return { family: DEFAULT_FAMILY, mode: 'system' };
  try {
    return parseThemePref(localStorage.getItem(KEY));
  } catch {
    // Private mode / blocked storage.
    return { family: DEFAULT_FAMILY, mode: 'system' };
  }
}

function osPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export interface ThemeState extends ThemePref {
  /** The mode actually in force — never 'system'. */
  resolved: ResolvedMode;
  /** The value on `<html data-theme>`, e.g. 'mission-dark'. */
  attr: string;
  families: readonly ThemeFamily[];
  setFamily: (family: ThemeFamilyId) => void;
  setMode: (mode: ThemeMode) => void;
}

export function useTheme(): ThemeState {
  const [pref, setPref] = useState<ThemePref>(read);
  const [systemDark, setSystemDark] = useState<boolean>(osPrefersDark);

  // Follow the OS live. Subscribed unconditionally (it is one listener and the
  // user can flip to 'system' at any moment) — the value only *matters* when
  // the preference is 'system'.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // A second tab changing the theme should not leave this one stale.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPref(parseThemePref(e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const resolved: ResolvedMode = pref.mode === 'system' ? (systemDark ? 'dark' : 'light') : pref.mode;
  const attr = `${pref.family}-${resolved}`;

  // Publish + persist. The inline bootstrap already set the same attribute for
  // the first paint; this keeps it true for every change afterwards.
  useEffect(() => {
    document.documentElement.dataset.theme = attr;
  }, [attr]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(pref));
    } catch {
      /* private mode etc. */
    }
  }, [pref]);

  const setFamily = useCallback((family: ThemeFamilyId) => setPref(p => ({ ...p, family })), []);
  const setMode = useCallback((mode: ThemeMode) => setPref(p => ({ ...p, mode })), []);

  return useMemo(
    () => ({
      family: pref.family,
      mode: pref.mode,
      resolved,
      attr,
      families: THEME_FAMILIES,
      setFamily,
      setMode,
    }),
    [pref.family, pref.mode, resolved, attr, setFamily, setMode],
  );
}
