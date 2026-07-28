// SOLE OWNER of the `kteam-side-pane-v1` localStorage key.
//
// Pane width is a reader/layout preference, not session content: every
// session should open at the same comfortable width, while the active surface
// remains session-scoped in SidePane.tsx. Keeping the key here gives it the
// same contract as the other UI preferences:
//   - explicit payload version,
//   - defensive field-by-field parsing,
//   - storage denial treated as an ordinary browser condition,
//   - one in-memory snapshot shared by retained session workspaces.

export const SIDE_PANE_PREFERENCES_KEY = 'kteam-side-pane-v1';
export const SIDE_PANE_PREFERENCES_VERSION = 1;

/** Absolute desktop bounds. The effective maximum is lower when necessary to
 * preserve SIDE_PANE_MIN_CHAT_WIDTH beside the pane. */
export const SIDE_PANE_MIN_WIDTH = 320;
export const SIDE_PANE_MAX_WIDTH = 1024;
export const SIDE_PANE_DEFAULT_WIDTH = 520;
// The pane is the reader's active surface while open. Keep enough chat visible
// for context and controls, but let a tablet/landscape reader pull the divider
// materially farther left. Portrait phones use the full-width sheet instead.
export const SIDE_PANE_MIN_CHAT_WIDTH = 280;
export const SIDE_PANE_WORKSPACE_GAP = 8;

export interface SidePanePreferences {
  v: typeof SIDE_PANE_PREFERENCES_VERSION;
  width: number;
}

export const DEFAULT_SIDE_PANE_PREFERENCES: SidePanePreferences = Object.freeze({
  v: SIDE_PANE_PREFERENCES_VERSION,
  width: SIDE_PANE_DEFAULT_WIDTH,
});

export function clampSidePaneWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDE_PANE_DEFAULT_WIDTH;
  return Math.min(SIDE_PANE_MAX_WIDTH, Math.max(SIDE_PANE_MIN_WIDTH, Math.round(width)));
}

/** Defensive parse: an unknown version or non-object is a clean reset; a bad
 * field falls back independently and unknown fields are ignored. */
export function parseSidePanePreferences(raw: string | null | undefined): SidePanePreferences {
  if (!raw) return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  }
  const fields = parsed as Record<string, unknown>;
  if (fields['v'] !== SIDE_PANE_PREFERENCES_VERSION) return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  return {
    v: SIDE_PANE_PREFERENCES_VERSION,
    width:
      typeof fields['width'] === 'number' ? clampSidePaneWidth(fields['width']) : DEFAULT_SIDE_PANE_PREFERENCES.width,
  };
}

export interface SidePanePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SidePanePreferenceStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: SidePanePreferenceStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : null;
  } catch {
    return null;
  }
}

export function loadSidePanePreferences(
  storage: SidePanePreferenceStorage | null = defaultStorage(),
): SidePanePreferences {
  if (!storage) return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  try {
    return parseSidePanePreferences(storage.getItem(SIDE_PANE_PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  }
}

/** A failed persistence write never blocks resizing; the in-memory preference
 * still applies for the rest of the tab. */
export function saveSidePanePreferences(
  preferences: SidePanePreferences,
  storage: SidePanePreferenceStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const value: SidePanePreferences = {
    v: SIDE_PANE_PREFERENCES_VERSION,
    width: clampSidePaneWidth(preferences.width),
  };
  try {
    storage.setItem(SIDE_PANE_PREFERENCES_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

type Listener = () => void;
let snapshot: SidePanePreferences | null = null;
const listeners = new Set<Listener>();

/** Identity-stable snapshot for useSyncExternalStore. */
export function getSidePanePreferences(): SidePanePreferences {
  if (snapshot === null) snapshot = loadSidePanePreferences();
  return snapshot;
}

export function subscribeSidePanePreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Commit once at the END of a pointer drag (or once per keyboard command).
 * Preview frames deliberately stay local to the active workspace. */
export function setSidePaneWidth(width: number): SidePanePreferences {
  const next: SidePanePreferences = {
    v: SIDE_PANE_PREFERENCES_VERSION,
    width: clampSidePaneWidth(width),
  };
  snapshot = next;
  saveSidePanePreferences(next);
  for (const listener of listeners) listener();
  return next;
}

/** Test seam for module state. */
export function resetSidePanePreferences(): void {
  snapshot = null;
  listeners.clear();
}
