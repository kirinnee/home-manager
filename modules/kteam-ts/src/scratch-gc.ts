// Scratch garbage collection.
//
// `~/.kteam` was 8.9 GB on the live box, and almost none of it was kteam's:
// teammates create working checkouts, temp dirs and build outputs INSIDE their
// session directory (one session held 411 MB + 377 MB of `cyanprint-tmp-*`).
// kteam's own per-session cost is the journal plus snapshots — single-digit MB.
//
// The rule: an agent's scratch expires once its session has been TERMINAL for
// longer than the TTL and nothing holds it. Then the scratch goes and the
// RECORD stays. "kteam's own" is a whitelist, never a pattern match on what
// looks like garbage — the journals are authoritative and the pointer index
// references them by byte offset, so anything kteam writes is untouchable here.

import { chmod, lstat, readdir, readlink, rm } from 'node:fs/promises';
import path from 'node:path';

/** Entries at the top level of a session directory that kteam itself owns.
 *  Derived from paths.ts + every `path.join(<session dir>, …)` in the daemon;
 *  see the scratch-gc tests, which pin this list against those writers. */
export const KTEAM_OWNED_ENTRIES: ReadonlySet<string> = new Set([
  // documents
  'config.json',
  'state.json',
  'events.jsonl',
  'chat.jsonl',
  'summary.md',
  'system.md',
  'prompt.md',
  'kill.json',
  'launch.sh',
  'liveness.yaml',
  'last-snapshot.txt',
  // directories
  'attachments',
  'channel',
  'checks',
  'logs',
  'markers',
  'raw',
  'snapshots',
  'turns',
]);

/** `state.json.tmp.1234.<uuid>` — an atomic-write temp file for a whitelisted
 *  document. Treated as kteam-owned so a write in flight is never raced. */
function isOwnedTemporary(name: string): boolean {
  const base = name.split('.tmp.')[0];
  return name.includes('.tmp.') && base !== undefined && KTEAM_OWNED_ENTRIES.has(base);
}

export function isKteamOwned(name: string): boolean {
  return KTEAM_OWNED_ENTRIES.has(name) || isOwnedTemporary(name);
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'stalled']);

export interface ScratchEligibilityInput {
  status?: string;
  /** `state.finishedAt`, when the session recorded one. */
  finishedAt?: string;
  /** Newest mtime anywhere under the session directory (ms). The fallback when
   *  `finishedAt` is missing, AND the belt-and-braces recency check. */
  newestMtimeMs?: number;
  nowMs: number;
  ttlMs: number;
  hasMonitor: boolean;
  hasLivePane: boolean;
  launching: boolean;
  wardenTarget: boolean;
}

export interface ScratchEligibility {
  eligible: boolean;
  /** Why not — surfaced by `kteam gc --dry-run` so the decision is auditable. */
  reason?: string;
}

/** Pure eligibility decision. Every guard must hold; the recency check is
 *  deliberately redundant with `finishedAt` (a session marked completed whose
 *  files are still being written is doing work nothing supervises). */
export function scratchEligibility(input: ScratchEligibilityInput): ScratchEligibility {
  if (!input.status || !TERMINAL_STATUSES.has(input.status)) return { eligible: false, reason: 'not terminal' };
  if (input.hasMonitor) return { eligible: false, reason: 'a monitor is still attached' };
  if (input.hasLivePane) return { eligible: false, reason: 'the tmux pane is still alive' };
  if (input.launching) return { eligible: false, reason: 'a launch claim is in flight' };
  if (input.wardenTarget) return { eligible: false, reason: 'a live warden is assigned to it' };

  const finishedMs = input.finishedAt ? Date.parse(input.finishedAt) : Number.NaN;
  const settledAt = Number.isFinite(finishedMs) ? finishedMs : input.newestMtimeMs;
  if (settledAt === undefined) return { eligible: false, reason: 'no finishedAt and no file mtime to age from' };
  const age = input.nowMs - settledAt;
  if (age < input.ttlMs) {
    return { eligible: false, reason: `terminal for ${Math.round(age / 3_600_000)}h, under the TTL` };
  }
  // Belt and braces: ANY file touched inside the TTL blocks the reclaim, even
  // when finishedAt is old. A long-dead session whose directory is still being
  // written to is not idle.
  if (input.newestMtimeMs !== undefined && input.nowMs - input.newestMtimeMs < input.ttlMs) {
    return { eligible: false, reason: 'a file under the session directory changed inside the TTL' };
  }
  return { eligible: true };
}

export interface ScratchEntry {
  name: string;
  bytes: number;
  kind: 'file' | 'directory' | 'symlink';
}

export interface ScratchScan {
  entries: ScratchEntry[];
  bytes: number;
  /** Newest mtime under the WHOLE session directory, kteam-owned included. */
  newestMtimeMs: number;
}

/** Recursive size, never following symlinks (a link counts as its own small
 *  entry, and its target is somebody else's data). */
async function measure(target: string): Promise<{ bytes: number; newestMtimeMs: number }> {
  const info = await lstat(target).catch(() => undefined);
  if (!info) return { bytes: 0, newestMtimeMs: 0 };
  if (!info.isDirectory()) return { bytes: info.size, newestMtimeMs: info.mtimeMs };
  let bytes = info.size;
  let newest = info.mtimeMs;
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = await measure(path.join(target, entry.name));
    bytes += child.bytes;
    newest = Math.max(newest, child.newestMtimeMs);
  }
  return { bytes, newestMtimeMs: newest };
}

/** Classify the top level of a session directory into scratch vs kteam-owned. */
export async function scanScratch(directory: string): Promise<ScratchScan> {
  const entries: ScratchEntry[] = [];
  let bytes = 0;
  let newestMtimeMs = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    const measured = await measure(target);
    newestMtimeMs = Math.max(newestMtimeMs, measured.newestMtimeMs);
    if (isKteamOwned(entry.name)) continue;
    entries.push({
      name: entry.name,
      bytes: measured.bytes,
      kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
    });
    bytes += measured.bytes;
  }
  entries.sort((left, right) => right.bytes - left.bytes);
  return { entries, bytes, newestMtimeMs };
}

/** Make a read-only tree removable. Agent scratch routinely contains
 *  mode-0444 build output (dotnet `bin/Debug/**.dll`), which `rm` refuses. */
async function relaxPermissions(target: string): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  await chmod(target, info.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (!info.isDirectory()) return;
  for (const name of await readdir(target).catch((): string[] => [])) {
    await relaxPermissions(path.join(target, name));
  }
}

export interface ReclaimResult {
  removed: string[];
  bytes: number;
  failures: Array<{ entry: string; message: string }>;
}

/** Delete the scratch entries of ONE session directory.
 *
 *  Containment is checked per entry rather than trusted: the entry name must
 *  resolve to a direct child of `directory`, and a symlink is unlinked as a
 *  link (never followed), so nothing outside the session directory is reachable
 *  from here. A failure is logged and skipped — one unremovable tree must not
 *  abort the sweep. */
export async function reclaimScratch(directory: string, entries: readonly ScratchEntry[]): Promise<ReclaimResult> {
  const result: ReclaimResult = { removed: [], bytes: 0, failures: [] };
  const root = path.resolve(directory);
  for (const entry of entries) {
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root || isKteamOwned(entry.name)) {
      result.failures.push({ entry: entry.name, message: 'refused: not a direct non-kteam child of the session' });
      continue;
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        // Unlink the LINK. Never rm -r through it: the target is outside.
        const points = await readlink(target).catch(() => '?');
        await rm(target, { force: true });
        result.removed.push(`${entry.name} -> ${points}`);
        continue;
      }
      try {
        await rm(target, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EACCES' && code !== 'EPERM') throw error;
        await relaxPermissions(target);
        await rm(target, { recursive: true, force: true });
      }
      result.removed.push(entry.name);
      result.bytes += entry.bytes;
    } catch (error) {
      result.failures.push({ entry: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Trim a session's snapshot directory to its configured retention. The writer
 *  already enforces `maxSnapshots` on every capture, so this only matters for a
 *  session that stopped capturing before the limit was lowered — i.e. every
 *  terminal session, which never writes another snapshot to trigger the trim. */
export async function trimSnapshots(directory: string, maxSnapshots: number): Promise<{ removed: number }> {
  if (!Number.isFinite(maxSnapshots) || maxSnapshots < 1) return { removed: 0 };
  const dir = path.join(directory, 'snapshots');
  const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.txt')).sort();
  const excess = names.slice(0, Math.max(0, names.length - maxSnapshots));
  for (const name of excess) await rm(path.join(dir, name), { force: true }).catch(() => undefined);
  return { removed: excess.length };
}
