// Tiny one-shot debounced effect helper: re-runs the effect after `ms` of quiet.

import { useEffect, useRef } from 'react';

export function useDebouncedEffect(effect: () => void | (() => void), deps: ReadonlyArray<unknown>, ms: number) {
  const ref = useRef(effect);
  ref.current = effect;
  useEffect(() => {
    const t = setTimeout(() => ref.current(), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms]);
}
