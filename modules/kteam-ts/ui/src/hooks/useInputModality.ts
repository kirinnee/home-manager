import { useSyncExternalStore } from 'react';

/**
 * Input capability and recent input are deliberately separate from layout.
 * A narrow desktop still has a hardware keyboard, while a wide convertible may
 * have just been used as a tablet. Viewport width must never enter this policy.
 */
export interface InputModalityState {
  touchAffected: boolean;
  enterSends: boolean;
}

export interface InputModalitySignals {
  finePrimary: boolean | null;
  coarsePrimary: boolean | null;
  hoverPrimary: boolean | null;
  noHoverPrimary: boolean | null;
  anyCoarse: boolean | null;
  lastPointerType: string | null;
}

const CONSERVATIVE_STATE: InputModalityState = {
  touchAffected: true,
  enterSends: false,
};

const MEDIA_QUERIES = {
  finePrimary: '(pointer: fine)',
  coarsePrimary: '(pointer: coarse)',
  hoverPrimary: '(hover: hover)',
  noHoverPrimary: '(hover: none)',
  anyCoarse: '(any-pointer: coarse)',
} as const;

type MediaSignal = keyof typeof MEDIA_QUERIES;

/**
 * The pure policy is exported so the full device table can be asserted without
 * pretending a viewport size says anything about keyboard hardware.
 *
 * `touchAffected` intentionally has the conservative bias: an unknown or
 * touch-capable environment gets the explicit controls and avoids text-field
 * autofocus. `enterSends` has the stricter, independent rule: only an
 * unambiguous fine-primary + hover-primary context, last used by a mouse (or
 * not used yet at boot), may send from bare Enter.
 */
export function resolveInputModality(signals: InputModalitySignals): InputModalityState {
  const primaryIsFine = signals.finePrimary === true && signals.coarsePrimary === false;
  const primaryCanHover = signals.hoverPrimary === true && signals.noHoverPrimary === false;
  const mouseOrBoot = signals.lastPointerType === null || signals.lastPointerType === 'mouse';

  const enterSends = primaryIsFine && primaryCanHover && mouseOrBoot;
  const touchAffected =
    signals.finePrimary !== true ||
    signals.coarsePrimary !== false ||
    signals.hoverPrimary !== true ||
    signals.noHoverPrimary !== false ||
    signals.anyCoarse !== false ||
    !mouseOrBoot;

  return { touchAffected, enterSends };
}

interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

interface PointerLike {
  readonly pointerType?: string;
}

export interface InputModalitySource {
  matchMedia(query: string): MediaQueryListLike;
  addPointerListener(listener: (event: PointerLike) => void): void;
  removePointerListener(listener: (event: PointerLike) => void): void;
}

export interface InputModalityStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): InputModalityState;
  read(): InputModalityState;
  dispose(): void;
}

/**
 * One store owns every global/media listener. Hook instances only subscribe to
 * this store, so several consumers and React StrictMode's subscribe cycle never
 * multiply listeners. `dispose` exists for hermetic tests/HMR; the application
 * singleton intentionally lives for the lifetime of the page so it cannot miss
 * a restoring mouse pointerdown between consumers.
 */
export function createInputModalityStore(sourceProvider: () => InputModalitySource | null): InputModalityStore {
  const subscribers = new Set<() => void>();
  const media = new Map<MediaSignal, MediaQueryListLike>();
  const mediaCleanups: Array<() => void> = [];
  let source: InputModalitySource | null = null;
  let started = false;
  let lastPointerType: string | null = null;
  let snapshot = CONSERVATIVE_STATE;

  const readSignal = (signal: MediaSignal): boolean | null => {
    try {
      return media.get(signal)?.matches ?? null;
    } catch {
      return null;
    }
  };

  const refresh = () => {
    const next = resolveInputModality({
      finePrimary: readSignal('finePrimary'),
      coarsePrimary: readSignal('coarsePrimary'),
      hoverPrimary: readSignal('hoverPrimary'),
      noHoverPrimary: readSignal('noHoverPrimary'),
      anyCoarse: readSignal('anyCoarse'),
      lastPointerType,
    });
    if (next.touchAffected === snapshot.touchAffected && next.enterSends === snapshot.enterSends) return;
    snapshot = next;
    for (const subscriber of subscribers) subscriber();
  };

  const onMediaChange = () => refresh();
  const onPointerDown = (event: PointerLike) => {
    // Empty/synthetic and pen pointer types are ambiguity, never mouse. A real
    // mouse is the sole input allowed to restore desktop Enter semantics.
    lastPointerType = event.pointerType || 'unknown';
    refresh();
  };

  const listenToMedia = (query: MediaQueryListLike) => {
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onMediaChange);
      mediaCleanups.push(() => query.removeEventListener?.('change', onMediaChange));
      return;
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onMediaChange);
      mediaCleanups.push(() => query.removeListener?.(onMediaChange));
    }
  };

  const start = () => {
    if (started) return;
    source = sourceProvider();
    if (!source) return;
    started = true;

    for (const signal of Object.keys(MEDIA_QUERIES) as MediaSignal[]) {
      try {
        const query = source.matchMedia(MEDIA_QUERIES[signal]);
        media.set(signal, query);
        listenToMedia(query);
      } catch {
        // A failed probe stays `null`, which resolves conservatively.
      }
    }
    try {
      source.addPointerListener(onPointerDown);
    } catch {
      // Media state still provides a safe result when pointer events are absent.
    }
    refresh();
  };

  return {
    subscribe(listener) {
      subscribers.add(listener);
      start();
      return () => subscribers.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    read() {
      start();
      return snapshot;
    },
    dispose() {
      for (const cleanup of mediaCleanups.splice(0)) cleanup();
      if (started && source) {
        try {
          source.removePointerListener(onPointerDown);
        } catch {
          // A partial/test environment may not support removal; state reset is
          // still deterministic and a later start will not reuse stale media.
        }
      }
      subscribers.clear();
      media.clear();
      source = null;
      started = false;
      lastPointerType = null;
      snapshot = CONSERVATIVE_STATE;
    },
  };
}

function browserSource(): InputModalitySource | null {
  if (typeof window === 'undefined') return null;
  return {
    matchMedia(query) {
      if (typeof window.matchMedia !== 'function') throw new Error('matchMedia unavailable');
      return window.matchMedia(query);
    },
    addPointerListener(listener) {
      window.addEventListener('pointerdown', listener as EventListener, { capture: true, passive: true });
    },
    removePointerListener(listener) {
      window.removeEventListener('pointerdown', listener as EventListener, true);
    },
  };
}

const inputModalityStore = createInputModalityStore(browserSource);

// Start at module load in a browser, before the first consumer renders. This is
// what makes `lastPointerType` genuinely global: a touch that navigates into a
// Composer must not be lost merely because no Composer was mounted beforehand.
// SSR and Bun's DOM-less test process stay inert because `browserSource` is null.
inputModalityStore.read();

/** Synchronous read for safety-sensitive event handlers. */
export function readInputModality(): InputModalityState {
  return inputModalityStore.read();
}

export function useInputModality(): InputModalityState {
  return useSyncExternalStore(inputModalityStore.subscribe, inputModalityStore.getSnapshot, () => CONSERVATIVE_STATE);
}
