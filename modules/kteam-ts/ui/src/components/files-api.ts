// Viewer-local client for the daemon's read-only session filesystem routes.
//
// WHY NOT `lib/api.ts`: that module is owned elsewhere in this change and its
// `request()` mints an `x-kteam-request-id` per mutation and swallows response
// shapes this viewer needs (a `text/plain` diff, an abortable read). So the
// four fs routes get a small local fetch that follows the SAME conventions —
// the bearer token and `ApiError` are IMPORTED from `lib/api` rather than
// re-derived, so there is still exactly one token source and one error type in
// the app.
//
// Contract (frozen in the phase-1 design, daemon-side):
//   GET :id/fs?path=<rel>              → listing, one directory, no recursion
//   GET :id/fs/file?path=<rel>&rev=head → file bytes or a refusal reason
//   GET :id/fs/changes                  → git status, cwd-filtered
//   GET :id/fs/diff?path=<rel>          → text/plain unified diff
//
// Every "is this file safe to serve" decision — containment, the secrets
// denylist, the gitignore gate, the size/binary caps — is the daemon's. This
// module only renders the verdicts it is given (`denied`, `ignored`, `escapes`,
// `binary`, `tooLarge`).

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ApiError, HAS_TOKEN, TOKEN } from '../lib/api';

export type FsEntryType = 'file' | 'dir' | 'symlink';

export interface FsEntry {
  name: string;
  type: FsEntryType;
  size?: number;
  mtime?: number | string;
  /** Gitignored: listed, greyed, content refused. */
  ignored?: boolean;
  /** Denylisted basename (`.env`, `*.pem`, `.git/`, …) — never served. */
  denied?: boolean;
  /** Symlink that resolves outside the session root. */
  escapes?: boolean;
}

export interface FsListing {
  root?: string;
  path?: string;
  entries: FsEntry[];
  truncated?: boolean;
}

export interface FsChange {
  path: string;
  /** Porcelain XY pair, or a word — `statusChip` accepts both. */
  status: string;
  /** Rename/copy origin. */
  from?: string;
}

export interface FsChanges {
  repo: boolean;
  branch?: string;
  changes: FsChange[];
  /** git's own status output hit the daemon's byte cap, so this list is a
   *  PREFIX of the real one. The tab has to say so: a silently short list reads
   *  as "that is everything the agent touched", which is the one thing the
   *  Changes pane exists to answer. */
  truncated?: boolean;
}

export interface FsFile {
  path: string;
  size?: number;
  mtime?: number | string;
  lang?: string;
  binary?: boolean;
  tooLarge?: boolean;
  denied?: boolean;
  ignored?: boolean;
  content?: string;
}

/* ---- fetch --------------------------------------------------------------- */

function fallbackMessage(status: number): string {
  if (status === 401)
    return HAS_TOKEN
      ? 'unauthorized — the daemon rejected this page’s credentials'
      : 'unauthorized — this origin was served without a daemon token (read-only)';
  if (status === 403) return 'forbidden — this token may not read session files';
  if (status === 404) return 'not found';
  return `HTTP ${status}`;
}

async function fsRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const headers = new Headers();
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  const res = await fetch(path, { headers, signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, body.error ?? fallbackMessage(res.status), body.code);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const base = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/fs`;

export function listUrl(sessionId: string, path: string): string {
  const qs = path ? `?${new URLSearchParams({ path })}` : '';
  return `${base(sessionId)}${qs}`;
}

export function fileUrl(sessionId: string, path: string, rev?: 'head'): string {
  const qs = new URLSearchParams({ path });
  if (rev) qs.set('rev', rev);
  return `${base(sessionId)}/file?${qs}`;
}

export function changesUrl(sessionId: string): string {
  return `${base(sessionId)}/changes`;
}

export function diffUrl(sessionId: string, path: string): string {
  return `${base(sessionId)}/diff?${new URLSearchParams({ path })}`;
}

export const fsApi = {
  list: (sessionId: string, path: string, signal?: AbortSignal) =>
    fsRequest<FsListing>(listUrl(sessionId, path), signal),
  file: (sessionId: string, path: string, rev?: 'head', signal?: AbortSignal) =>
    fsRequest<FsFile>(fileUrl(sessionId, path, rev), signal),
  changes: (sessionId: string, signal?: AbortSignal) => fsRequest<FsChanges>(changesUrl(sessionId), signal),
  diff: (sessionId: string, path: string, signal?: AbortSignal) => fsRequest<string>(diffUrl(sessionId, path), signal),
};

/** The version-skew signal: a daemon that predates the fs routes answers 404
 *  with `{code:'unknown_route'}` (api-server.ts). That — and ONLY that — hides
 *  the Files tab. A 404 for a missing session, a 403, a 500 or an offline
 *  daemon are ordinary failures the tab must report, not reasons to pretend the
 *  feature does not exist. */
export function isUnknownRoute(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'unknown_route';
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string })?.name === 'AbortError';
}

/** One readable sentence for any failure this client can produce. */
export function describeFsError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'could not reach the daemon';
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ---- capability probe + changes cache ------------------------------------
   `fs/changes` is both the capability probe and the Changes list's data, so it
   is fetched ONCE per session and shared: SessionChatPage reads it to decide
   whether the Files tab exists at all, and the tab itself reads the same record
   instead of issuing a second identical request on mount. */

export type FsProbeState = 'probing' | 'ready' | 'absent' | 'error';

export interface FsProbeSnapshot {
  state: FsProbeState;
  changes: FsChanges | null;
  error: string | null;
  /** A refresh over an already-loaded list: keep showing the list, mark it busy. */
  refreshing: boolean;
}

interface ProbeRecord {
  snapshot: FsProbeSnapshot;
  listeners: Set<() => void>;
  /** Monotonic id of the newest issued request; older ones are ignored on
   *  arrival so a slow first probe can never overwrite a fresh refresh. */
  seq: number;
  inflight: boolean;
}

const INITIAL: FsProbeSnapshot = { state: 'probing', changes: null, error: null, refreshing: false };
const probes = new Map<string, ProbeRecord>();

function recordFor(sessionId: string): ProbeRecord {
  let record = probes.get(sessionId);
  if (!record) {
    record = { snapshot: INITIAL, listeners: new Set(), seq: 0, inflight: false };
    probes.set(sessionId, record);
  }
  return record;
}

function publish(record: ProbeRecord, next: Partial<FsProbeSnapshot>): void {
  record.snapshot = { ...record.snapshot, ...next };
  for (const listener of record.listeners) listener();
}

/** Fetch (or re-fetch) the session's changes. Safe to call redundantly: a
 *  probe already in flight is not duplicated unless `force` says so. */
export async function loadFsChanges(sessionId: string, force = false): Promise<void> {
  const record = recordFor(sessionId);
  if (record.inflight && !force) return;
  // Already answered: the probe is once per session by design, so a second
  // reader (the tab mounting after the page probed) costs nothing. `force` is
  // the reader asking for fresh bytes; an errored record retries on its own,
  // since that state exists precisely to be recovered from.
  if (!force && (record.snapshot.state === 'ready' || record.snapshot.state === 'absent')) return;
  const seq = ++record.seq;
  record.inflight = true;
  publish(record, record.snapshot.changes ? { refreshing: true, error: null } : { state: 'probing', error: null });
  try {
    const changes = await fsApi.changes(sessionId);
    if (record.seq !== seq) return;
    publish(record, { state: 'ready', changes, error: null, refreshing: false });
  } catch (error) {
    if (record.seq !== seq) return;
    if (isUnknownRoute(error)) {
      publish(record, { state: 'absent', changes: null, error: null, refreshing: false });
      return;
    }
    publish(record, { state: 'error', error: describeFsError(error), refreshing: false });
  } finally {
    if (record.seq === seq) record.inflight = false;
  }
}

/** The current record for a session, without subscribing. This is what
 *  `useFsProbe` hands `useSyncExternalStore`, so it is also the honest way for a
 *  test to read the outcome of a probe. */
export function readFsProbe(sessionId: string): FsProbeSnapshot {
  return recordFor(sessionId).snapshot;
}

/** Test seam — the cache is module state, so a test that asserts probe
 *  behaviour has to be able to start from nothing. */
export function resetFsProbes(): void {
  probes.clear();
}

/** Does a probe in this state justify showing the Files tab? Everything except
 *  "still asking" and "this daemon has no such route" does: an error is
 *  reported inside the tab, never by silently removing it. */
export function fsTabAvailable(state: FsProbeState): boolean {
  return state === 'ready' || state === 'error';
}

export interface FsProbe extends FsProbeSnapshot {
  refresh: () => void;
}

export function useFsProbe(sessionId: string): FsProbe {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const record = recordFor(sessionId);
      record.listeners.add(onChange);
      return () => {
        record.listeners.delete(onChange);
      };
    },
    [sessionId],
  );
  // Both the client and the server snapshot are the cached object itself, which
  // only changes identity when the record changes — required by
  // useSyncExternalStore, and what keeps a render from looping.
  const getSnapshot = useCallback(() => recordFor(sessionId).snapshot, [sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const record = recordFor(sessionId);
    if (record.snapshot.state === 'probing' && !record.inflight) void loadFsChanges(sessionId);
  }, [sessionId]);

  const refresh = useCallback(() => void loadFsChanges(sessionId, true), [sessionId]);
  return { ...snapshot, refresh };
}
