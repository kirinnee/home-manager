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

/* ---------- PWA manifest + window colour (plan §4.3, audit M4) -------------
   Ten generated manifests exist per release, one per family+mode, differing ONLY
   in `theme_color`/`background_color`. The active one is selected by rewriting
   the href of the SINGLE `<link id="kteam-manifest">` that index.html created —
   never by appending another link, which is what M4 flagged: browsers take the
   first manifest link and the extra ones are dead weight that make the DOM lie
   about which manifest is in force.
   -------------------------------------------------------------------------- */

export const MANIFEST_LINK_ID = 'kteam-manifest';

/** Matches the family+mode segment of a generated manifest filename. Anchored on
 *  the `manifest-` prefix and the following `.` so it cannot touch the release
 *  hash or the extension — the release must survive the swap untouched, since it
 *  names the generation this bundle belongs to. */
const MANIFEST_THEME_RE = /manifest-[a-z]+-[a-z]+\./;

/** Repoint a manifest href at a different family+mode, preserving the release.
 *
 *  Pure and exported because it is the one piece of this that can be wrong in a
 *  way nothing would notice at runtime: a bad swap yields a 404 the browser
 *  reports only in an install prompt nobody is watching. Returns the input
 *  unchanged if it does not look like a generated manifest name (a dev server,
 *  or a hand-edited href) rather than fabricating a URL.
 *
 *  The inline bootstrap in index.html applies the SAME rule pre-paint — keep the
 *  two in step. */
export function manifestHrefFor(currentHref: string, family: ThemeFamilyId, resolved: ResolvedMode): string {
  if (!MANIFEST_THEME_RE.test(currentHref)) return currentHref;
  return currentHref.replace(MANIFEST_THEME_RE, `manifest-${family}-${resolved}.`);
}

/** The live window colour for the OS chrome (Android address bar, Chromium
 *  title bar, iOS status-bar tint in standalone).
 *
 *  READ FROM THE COMPUTED STYLE, never from a colour map in TS. themes.css is
 *  the only place a theme's `--bg` is defined; the build-time manifests parse
 *  that same file. A second copy in TypeScript would be a third source of truth
 *  and would drift the first time a token is retuned (audit M4). Reading it
 *  computed also means the value is correct for whatever `data-theme` is
 *  actually applied, including a value this code does not know about. */
export function themeColorFromComputedStyle(root: Element): string {
  return getComputedStyle(root).getPropertyValue('--bg').trim();
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
  //
  // The manifest href and the window colour are updated in the SAME effect,
  // after the attribute is set, because the colour is read back from the
  // computed style and that read is only correct once `data-theme` is applied.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = attr;

    const link = document.getElementById(MANIFEST_LINK_ID);
    if (link) {
      const current = link.getAttribute('href') ?? '';
      const next = manifestHrefFor(current, pref.family, resolved);
      // Only on a real change: assigning the same href re-fetches the manifest
      // in some browsers, and this effect runs on every mode flip.
      if (next !== current) link.setAttribute('href', next);
    }

    // ONE identified meta element, created on demand. index.html deliberately
    // ships without a theme-color: a static one would be wrong for four of the
    // five families, and briefly painting the wrong colour is worse than
    // painting none.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    const color = themeColorFromComputedStyle(root);
    if (color && meta.content !== color) meta.content = color;
  }, [attr, pref.family, resolved]);

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
