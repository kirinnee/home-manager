/** Portrait lock. The manifest already declares `"orientation": "portrait"`,
 * which binds the INSTALLED PWA on platforms that honor it (Android). In a
 * plain browser tab the manifest is ignored, so we also ask the Screen
 * Orientation API. Browsers gate `lock()` behind conditions we cannot control
 * (Android: often fullscreen/standalone only; iOS Safari: no API at all), so
 * every attempt is best-effort and silent — a platform that refuses keeps its
 * native behaviour rather than getting a broken half-lock. */

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

/** Try at startup, and once more on the first user gesture — some browsers
 * only honor lock() after interaction. Stops listening after one success. */
export function installPortraitLock(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): void {
  void attemptPortraitLock().then(locked => {
    if (locked) return;
    const retry = (): void => {
      target.removeEventListener('pointerdown', retry);
      void attemptPortraitLock();
    };
    target.addEventListener('pointerdown', retry, { once: true });
  });
}
