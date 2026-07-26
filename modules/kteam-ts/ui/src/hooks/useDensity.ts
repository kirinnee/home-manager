import { useCallback, useEffect, useState } from 'react';
import { useUiControls, type Density } from '../lib/store';

export interface DensityOption {
  id: Density;
  label: string;
  description: string;
}

export const DENSITY_OPTIONS: readonly DensityOption[] = [
  { id: 'full', label: 'Full', description: 'All runtime, activity, and signal details.' },
  { id: 'compact', label: 'Compact', description: 'Name, task, status, and attention flags.' },
  { id: 'minimal', label: 'Minimal', description: 'Name and task only.' },
];

/** The approved implicit default: compact for a coarse, no-hover primary
 * pointer; full everywhere else. It is sampled once per hook mount and is not
 * written to storage, so resizing or rotating cannot turn an implicit choice
 * into a persisted one. */
export function implicitDensity(touchPrimary: boolean): Density {
  return touchPrimary ? 'compact' : 'full';
}

let firstLoadDefault: Density | undefined;

export function readImplicitDensity(): Density {
  if (firstLoadDefault) return firstLoadDefault;
  if (typeof window === 'undefined' || !window.matchMedia) return (firstLoadDefault = 'full');
  try {
    return (firstLoadDefault = implicitDensity(window.matchMedia('(pointer: coarse) and (hover: none)').matches));
  } catch {
    return (firstLoadDefault = 'full');
  }
}

export interface DensityState {
  density: Density;
  /** null means the current value is the device default, not a stored choice. */
  explicit: Density | null;
  setDensity: (density: Density) => void;
}

export function useDensity(): DensityState {
  const [controls, setControls] = useUiControls();
  const [fallback] = useState(readImplicitDensity);
  const density = controls.density ?? fallback;

  // Useful to browser gates and any future density-aware shell treatment. The
  // dashboard still renders fields component-by-component; this attribute is
  // metadata, not CSS hiding.
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((next: Density) => setControls({ density: next }), [setControls]);

  return { density, explicit: controls.density, setDensity };
}
