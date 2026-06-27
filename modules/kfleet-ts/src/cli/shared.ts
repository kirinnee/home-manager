import { die } from '../util/format';

/** Run a config-loading step, exiting cleanly with its message on failure. */
export function loadOrDie<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    die((e as Error).message);
  }
}
