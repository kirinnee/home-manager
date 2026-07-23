// Miscellaneous helpers.
import { clsx, type ClassValue } from 'clsx';

/** Tailwind-friendly class combiner. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
