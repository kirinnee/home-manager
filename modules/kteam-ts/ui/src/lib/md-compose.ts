// Markdown-composer preference — the SOLE owner of the `kteam-md-compose-v1`
// localStorage key (the one-owner-per-key rule: `kteam-theme`,
// `kteam-drafts-v1`, `kteam-ui-controls-v1` each have exactly one module).
//
// A dedicated key instead of a `UiControls` field on purpose: store.tsx is
// owned by another workstream right now, and this preference has no coupling
// to the dashboard controls that live there. It follows the same defensive
// contract — a malformed payload degrades to the default, reads and writes
// never throw.
//
// DEFAULT OFF. The overlay is metric-matched and verified in Chromium, but it
// cannot be verified on real iOS Safari from this environment, and its one
// failure mode — highlight drifting from the glyphs the reader is typing —
// degrades the app's primary input surface. Off means nobody pays that risk
// without opting in; flip `MD_COMPOSE_DEFAULT` once a device pass confirms it.

import { useSyncExternalStore } from 'react';

export const MD_COMPOSE_KEY = 'kteam-md-compose-v1';

export type MdComposePref = 'on' | 'off';

export const MD_COMPOSE_DEFAULT: MdComposePref = 'off';

/** Same-tab change signal; the storage event only covers OTHER tabs. */
const CHANGE_EVENT = 'kteam:md-compose-change';

/** Same-page fallback when storage is unavailable (privacy mode/quota). */
let volatilePref: MdComposePref | null = null;

export function parseMdComposePref(raw: string | null): MdComposePref {
  return raw === 'on' || raw === 'off' ? raw : MD_COMPOSE_DEFAULT;
}

/** Access itself can throw in locked-down/privacy-mode browsers. */
function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readMdComposePref(): MdComposePref {
  // A same-page write is the newest evidence even if an old stored value is
  // still readable because setItem failed. A cross-tab storage event clears
  // this override in subscribe() before asking for a new snapshot.
  if (volatilePref !== null) return volatilePref;
  const storage = browserStorage();
  if (!storage) return MD_COMPOSE_DEFAULT;
  try {
    const raw = storage.getItem(MD_COMPOSE_KEY);
    return parseMdComposePref(raw);
  } catch {
    return MD_COMPOSE_DEFAULT;
  }
}

export function writeMdComposePref(pref: MdComposePref): void {
  volatilePref = pref;
  const storage = browserStorage();
  if (storage) {
    try {
      storage.setItem(MD_COMPOSE_KEY, pref);
    } catch {
      // Quota/privacy-mode failure: the toggle still applies for this page
      // via the change event; it just won't survive a reload.
    }
  }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // A hostile event shim must not make the setting itself fail.
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== MD_COMPOSE_KEY) return;
    // Another tab is authoritative now; discard this tab's storage-failure
    // fallback before reading the new value.
    volatilePref = null;
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Live preference. The server/static snapshot is the default, so a
 *  `renderToStaticMarkup` render (the test stack) stays deterministic. */
export function useMdComposePref(): MdComposePref {
  return useSyncExternalStore(subscribe, readMdComposePref, () => MD_COMPOSE_DEFAULT);
}
