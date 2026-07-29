/** Portrait lock, in two layers because no single mechanism works everywhere.
 *
 * 1. The manifest declares `"orientation": "portrait"`. That binds only an
 *    INSTALLED PWA, and only where the platform honors it (Android/Chrome
 *    does; iOS ignores it). A plain browser tab never sees it.
 * 2. `screen.orientation.lock()` — refused in a plain tab on Android (it wants
 *    fullscreen or standalone) and absent entirely on iOS Safari.
 *
 * So on a phone in a browser tab, neither can hold the app upright. Rather
 * than pretend, the last layer is honest: when a phone-sized viewport is
 * turned landscape we show a full-screen "rotate back" gate instead of
 * rendering a layout that was never designed for it. No CSS counter-rotation
 * hacks — those break the on-screen keyboard, hit-testing and scrolling. */

type OrientationLockCapable = ScreenOrientation & {
  lock?: (orientation: 'portrait' | 'portrait-primary') => Promise<void>;
};

/** True when the lock call was accepted by the platform. */
export async function attemptPortraitLock(screenLike: { orientation?: ScreenOrientation } = screen): Promise<boolean> {
  const orientation = screenLike.orientation as OrientationLockCapable | undefined;
  if (!orientation || typeof orientation.lock !== 'function') return false;
  try {
    await orientation.lock('portrait');
    return true;
  } catch {
    // NotSupportedError / SecurityError / AbortError: the platform said no.
    return false;
  }
}

/** A handheld held sideways: short viewport, wider than tall, touch pointer.
 * The height bound keeps laptops and tablets in landscape untouched — they
 * are legitimate landscape devices, and gating them would be obnoxious. */
export function isPhoneLandscape(view: {
  innerWidth: number;
  innerHeight: number;
  matchMedia?: typeof matchMedia;
}): boolean {
  if (view.innerWidth <= view.innerHeight) return false;
  if (view.innerHeight > 500) return false;
  const coarse = view.matchMedia?.('(pointer: coarse)');
  // Absent matchMedia (jsdom, odd embeds) is unknown, not "definitely a phone".
  return coarse ? coarse.matches : false;
}

const GATE_ID = 'kteam-portrait-gate';

/** Mounts or removes the rotate-back gate to match the current orientation. */
export function syncPortraitGate(doc: Document = document, view: Window = window): void {
  const existing = doc.getElementById(GATE_ID);
  if (!isPhoneLandscape(view)) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const gate = doc.createElement('div');
  gate.id = GATE_ID;
  gate.setAttribute('role', 'alertdialog');
  gate.setAttribute('aria-label', 'Rotate your device to portrait');
  gate.innerHTML =
    '<div class="kteam-portrait-gate__inner">' +
    '<div class="kteam-portrait-gate__icon" aria-hidden="true">&#x21bb;</div>' +
    '<p class="kteam-portrait-gate__title">Turn your phone upright</p>' +
    '<p class="kteam-portrait-gate__body">kteam is portrait-only on phones.</p>' +
    '</div>';
  doc.body.appendChild(gate);
}

/** Ask the platform to lock; retry once on the first gesture (some browsers
 * only honor lock() after interaction), and keep the gate in sync regardless
 * of whether the lock was granted. */
export function installPortraitLock(view: Window = window, doc: Document = document): void {
  const sync = (): void => syncPortraitGate(doc, view);
  void attemptPortraitLock().then(locked => {
    if (!locked) {
      const retry = (): void => {
        void attemptPortraitLock().then(sync);
      };
      view.addEventListener('pointerdown', retry, { once: true });
    }
    sync();
  });
  view.addEventListener('resize', sync);
  view.addEventListener('orientationchange', sync);
  sync();
}
