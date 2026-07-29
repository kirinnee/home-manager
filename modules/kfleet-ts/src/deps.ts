// Paths & environment. Everything kfleet owns lives under ~/.kfleet so the whole
// fleet — config + base assets + generated wrappers — is controllable in one place.
import os from 'node:os';
import path from 'node:path';

export const home = os.homedir();

/** Root kfleet dir. Override with KFLEET_HOME (mainly for tests). */
export const kfleetHome = process.env.KFLEET_HOME ?? path.join(home, '.kfleet');

/** The single source-of-truth config the user edits. */
export const configPath = path.join(kfleetHome, 'config.yaml');

/** Generated wrappers land here; this dir goes on PATH. */
export const binDir = path.join(kfleetHome, 'bin');

/** Cross-account shared session-state pools live here (one subdir per kind). */
export const sharedDir = path.join(kfleetHome, 'shared');

/** Shared Codex rollout pool plus its SQLite state and prewarm lock. */
export const codexSharedDir = path.resolve(sharedDir, 'codex');
export const codexSharedSqliteDir = path.join(codexSharedDir, 'sqlite');
export const codexPrewarmLockPath = path.join(codexSharedDir, '.sqlite-prewarm-lock.sqlite3');

/** Resolve a profile asset reference (relative to ~/.kfleet, ~ expanded). */
export function resolveAsset(ref: string): string {
  if (ref.startsWith('~/')) return path.join(home, ref.slice(2));
  if (path.isAbsolute(ref)) return ref;
  return path.join(kfleetHome, ref);
}
