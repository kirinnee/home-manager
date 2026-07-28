import path from 'node:path';
import { isSafeSessionId } from './pins-store';
import type { TerminalOutputAttachment, TerminalRuntime, TerminalRuntimeRecord } from './terminal-runtime';
import { TmuxTerminalRuntime } from './terminal-runtime';
import type { KTeamPaths } from './paths';
import {
  TERMINAL_DEFAULT_SIZE,
  TERMINAL_IDLE_TIMEOUT_MS,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
  TERMINAL_SCROLLBACK_LINES,
  TerminalError,
  isTerminalId,
  normalizeTerminalSize,
  normalizeTerminalTitle,
  type TerminalListView,
  type TerminalSize,
  type TerminalView,
} from './terminal-types';

export interface TerminalSessionIdentity {
  id: string;
  cwd: string;
}

export interface TerminalSessionRegistry {
  /** Resolve an id or teammate alias to the canonical session and its cwd. */
  resolve(sessionRef: string): Promise<TerminalSessionIdentity | undefined>;
}

export interface TerminalServiceClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TerminalServiceOptions {
  runtime?: TerminalRuntime;
  clock?: TerminalServiceClock;
  maximumPerSession?: number;
  maximumGlobal?: number;
  idleTimeoutMs?: number;
}

export interface TerminalViewerTerminal {
  code: number;
  reason: string;
}

export interface TerminalViewerAttachment {
  id: string;
  detach(): void;
}

interface TerminalViewer {
  ready: boolean;
  pending: Uint8Array[];
  pendingBytes: number;
  onData(bytes: Uint8Array): void;
  onTerminal?(terminal: TerminalViewerTerminal): void;
}

interface ManagedTerminal {
  record: TerminalRuntimeRecord;
  lastActivityAt: number;
  viewers: Map<string, TerminalViewer>;
  relay?: TerminalOutputAttachment;
  relayStarting?: Promise<void>;
  closing: boolean;
}

interface UntrustedTerminal {
  record: TerminalRuntimeRecord;
  /** First observation without a matching canonical session/root this boot. */
  firstSeenAt: number;
}

const MAX_ATTACH_PENDING_BYTES = 2 * 1024 * 1024;
const ATTACH_SNAPSHOT_RETRIES = 4;

const systemClock: TerminalServiceClock = {
  now: () => Date.now(),
  setInterval: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

function entryKey(owner: string, id: string): string {
  return `${owner}\n${id}`;
}

function safeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Daemon-owned lifecycle for independent shell terminals.
 *
 * tmux owns the shell process, so a viewer disconnect or daemon restart never
 * kills it. The service owns caps, idle reaping, transient relays, and explicit
 * close. close() intentionally detaches relays only; tmux sessions survive.
 */
export class TerminalService {
  private readonly entries = new Map<string, ManagedTerminal>();
  /** Inaccessible survivors still count globally and are eventually reaped. */
  private readonly untrusted = new Map<string, UntrustedTerminal>();
  private readonly runtime: TerminalRuntime;
  private readonly clock: TerminalServiceClock;
  private readonly maximumPerSession: number;
  private readonly maximumGlobal: number;
  private readonly idleTimeoutMs: number;
  private readonly sweepTimer: unknown;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    paths: KTeamPaths,
    private readonly sessions: TerminalSessionRegistry,
    options: TerminalServiceOptions = {},
  ) {
    this.runtime = options.runtime ?? new TmuxTerminalRuntime(paths);
    this.clock = options.clock ?? systemClock;
    this.maximumPerSession = options.maximumPerSession ?? TERMINAL_MAX_PER_SESSION;
    this.maximumGlobal = options.maximumGlobal ?? TERMINAL_MAX_GLOBAL;
    this.idleTimeoutMs = options.idleTimeoutMs ?? TERMINAL_IDLE_TIMEOUT_MS;
    this.sweepTimer = this.clock.setInterval(
      () => void this.sweepIdle().catch(() => undefined),
      Math.min(60_000, this.idleTimeoutMs),
    );
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new TerminalError('unavailable', 'terminal service is shutting down', 503);
  }

  async resolveSession(sessionRef: string): Promise<TerminalSessionIdentity> {
    const identity = await this.sessions.resolve(sessionRef);
    if (!identity || !isSafeSessionId(identity.id)) {
      throw new TerminalError('not_found', `unknown kteam session: ${sessionRef}`, 404);
    }
    if (!path.isAbsolute(identity.cwd)) {
      throw new TerminalError('unavailable', 'session cwd is unavailable', 503);
    }
    return identity;
  }

  private terminateViewers(entry: ManagedTerminal, terminal: TerminalViewerTerminal): void {
    const viewers = [...entry.viewers.values()];
    entry.viewers.clear();
    for (const viewer of viewers) {
      try {
        viewer.onTerminal?.(terminal);
      } catch {
        // One dead WebSocket must never interrupt shell/process cleanup.
      }
    }
  }

  private runningGlobal(): number {
    return [...this.entries.values()].filter(entry => !entry.closing).length + this.untrusted.size;
  }

  private async discover(now = this.clock.now()): Promise<number> {
    const records: TerminalRuntimeRecord[] = [];
    const observedUntrusted = new Set<string>();
    let reapedUntrusted = 0;
    for (const record of await this.runtime.list()) {
      // tmux user options are persistence metadata, not session authority. A
      // survivor is attachable only while its canonical owner still exists and
      // its immutable creation root still matches that owner's configured cwd.
      // (Processes under this same Unix user can already read the admin token;
      // this check protects the daemon's own trust boundary and stale metadata,
      // rather than pretending tmux options are a cross-user security secret.)
      const identity = isSafeSessionId(record.owner)
        ? await this.sessions.resolve(record.owner).catch(() => undefined)
        : undefined;
      const trusted =
        isTerminalId(record.id) &&
        identity !== undefined &&
        identity.id === record.owner &&
        isSafeSessionId(identity.id) &&
        path.isAbsolute(identity.cwd) &&
        path.isAbsolute(record.root) &&
        path.resolve(identity.cwd) === path.resolve(record.root);
      if (!trusted) {
        const prior = this.untrusted.get(record.tmuxSession);
        const candidate: UntrustedTerminal = {
          record,
          firstSeenAt: prior?.firstSeenAt ?? now,
        };
        // A missing registry entry can be a cold-bootstrap race. Never destroy
        // a survivor on first sight: require a full idle timeout both since its
        // last tmux activity and since this daemon first found it untrusted.
        if (now - candidate.firstSeenAt >= this.idleTimeoutMs && now - record.lastActivityAt >= this.idleTimeoutMs) {
          try {
            await this.runtime.kill(record);
            this.untrusted.delete(record.tmuxSession);
            reapedUntrusted++;
            continue;
          } catch {
            // Keep counting an unreaped shell against the global ceiling.
          }
        }
        this.untrusted.set(record.tmuxSession, candidate);
        observedUntrusted.add(record.tmuxSession);
        continue;
      }
      this.untrusted.delete(record.tmuxSession);
      records.push(record);
    }
    for (const key of [...this.untrusted.keys()]) {
      if (!observedUntrusted.has(key)) this.untrusted.delete(key);
    }
    const live = new Set<string>();
    for (const record of records) {
      const key = entryKey(record.owner, record.id);
      live.add(key);
      const existing = this.entries.get(key);
      if (existing) {
        existing.record = record;
        existing.lastActivityAt = Math.max(existing.lastActivityAt, record.lastActivityAt);
      } else {
        this.entries.set(key, {
          record,
          lastActivityAt: record.lastActivityAt,
          viewers: new Map(),
          closing: false,
        });
      }
    }
    for (const [key, entry] of [...this.entries]) {
      if (live.has(key) || entry.closing) continue;
      entry.closing = true;
      this.entries.delete(key);
      this.terminateViewers(entry, { code: 1001, reason: 'terminal process exited' });
      const relay = entry.relay;
      entry.relay = undefined;
      await Promise.allSettled([
        ...(relay ? [relay.detach()] : []),
        ...(entry.relayStarting ? [entry.relayStarting] : []),
      ]);
    }
    return reapedUntrusted;
  }

  private view(entry: ManagedTerminal): TerminalView {
    const lastActivityAt = Math.max(entry.lastActivityAt, entry.record.lastActivityAt);
    return {
      id: entry.record.id,
      sessionId: entry.record.owner,
      title: entry.record.title,
      state: 'running',
      cols: entry.record.cols,
      rows: entry.record.rows,
      viewers: entry.viewers.size,
      createdAt: new Date(entry.record.createdAt).toISOString(),
      lastActivityAt: new Date(lastActivityAt).toISOString(),
      ...(entry.viewers.size === 0
        ? { idleDeadline: new Date(lastActivityAt + this.idleTimeoutMs).toISOString() }
        : {}),
    };
  }

  private listView(sessionId: string): TerminalListView {
    const terminals = [...this.entries.values()]
      .filter(entry => entry.record.owner === sessionId && !entry.closing)
      .sort((a, b) => a.record.createdAt - b.record.createdAt)
      .map(entry => this.view(entry));
    return {
      sessionId,
      terminals,
      limits: {
        perSession: this.maximumPerSession,
        global: this.maximumGlobal,
        runningGlobal: this.runningGlobal(),
        idleTimeoutSeconds: Math.round(this.idleTimeoutMs / 1_000),
        scrollbackLines: TERMINAL_SCROLLBACK_LINES,
      },
    };
  }

  async list(sessionRef: string): Promise<TerminalListView> {
    const { id } = await this.resolveSession(sessionRef);
    return await this.exclusive(async () => {
      await this.discover();
      return this.listView(id);
    });
  }

  private nextTitle(owner: string): string {
    const used = new Set(
      [...this.entries.values()].filter(entry => entry.record.owner === owner).map(entry => entry.record.title),
    );
    for (let index = 1; index <= this.maximumPerSession + 1; index++) {
      const title = `Terminal ${index}`;
      if (!used.has(title)) return title;
    }
    return 'Terminal';
  }

  async create(
    sessionRef: string,
    options: { title?: unknown; cols?: number; rows?: number } = {},
  ): Promise<TerminalView> {
    this.assertOpen();
    const identity = await this.resolveSession(sessionRef);
    this.assertOpen();
    return await this.exclusive(async () => {
      this.assertOpen();
      await this.discover();
      const owned = [...this.entries.values()].filter(
        entry => entry.record.owner === identity.id && !entry.closing,
      ).length;
      if (owned >= this.maximumPerSession) {
        throw new TerminalError(
          'capacity',
          `terminal capacity reached for this session (${this.maximumPerSession})`,
          429,
        );
      }
      const global = this.runningGlobal();
      if (global >= this.maximumGlobal) {
        throw new TerminalError('capacity', `global terminal capacity reached (${this.maximumGlobal})`, 429);
      }
      const size = normalizeTerminalSize(
        options.cols ?? TERMINAL_DEFAULT_SIZE.cols,
        options.rows ?? TERMINAL_DEFAULT_SIZE.rows,
      );
      const title = options.title === undefined ? this.nextTitle(identity.id) : normalizeTerminalTitle(options.title);
      let id: string;
      do id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      while (this.entries.has(entryKey(identity.id, id)));
      const record = await this.runtime.create(identity.id, id, title, identity.cwd, size);
      const entry: ManagedTerminal = {
        record,
        lastActivityAt: this.clock.now(),
        viewers: new Map(),
        closing: false,
      };
      this.entries.set(entryKey(identity.id, id), entry);
      return this.view(entry);
    });
  }

  private async entry(sessionRef: string, terminalId: string): Promise<ManagedTerminal> {
    if (!isTerminalId(terminalId)) throw new TerminalError('not_found', 'terminal not found', 404);
    const { id } = await this.resolveSession(sessionRef);
    return await this.exclusive(async () => {
      let entry = this.entries.get(entryKey(id, terminalId));
      if (!entry) {
        await this.discover();
        entry = this.entries.get(entryKey(id, terminalId));
      }
      if (!entry || entry.closing) throw new TerminalError('not_found', 'terminal not found', 404);
      return entry;
    });
  }

  async get(sessionRef: string, terminalId: string): Promise<TerminalView> {
    return this.view(await this.entry(sessionRef, terminalId));
  }

  async rename(sessionRef: string, terminalId: string, value: unknown): Promise<TerminalView> {
    const title = normalizeTerminalTitle(value);
    const entry = await this.entry(sessionRef, terminalId);
    await this.runtime.rename(entry.record, title);
    entry.record.title = title;
    return this.view(entry);
  }

  async resize(sessionRef: string, terminalId: string, cols: number, rows: number): Promise<TerminalSize> {
    const size = normalizeTerminalSize(cols, rows);
    const entry = await this.entry(sessionRef, terminalId);
    await this.runtime.resize(entry.record, size);
    entry.record.cols = size.cols;
    entry.record.rows = size.rows;
    entry.lastActivityAt = this.clock.now();
    return size;
  }

  async write(sessionRef: string, terminalId: string, bytes: Uint8Array): Promise<void> {
    const entry = await this.entry(sessionRef, terminalId);
    await this.runtime.write(entry.record, bytes);
    entry.lastActivityAt = this.clock.now();
  }

  async snapshot(sessionRef: string, terminalId: string): Promise<Uint8Array> {
    const entry = await this.entry(sessionRef, terminalId);
    return await this.runtime.capture(entry.record);
  }

  private relayData(entry: ManagedTerminal, bytes: Uint8Array): void {
    entry.lastActivityAt = this.clock.now();
    for (const viewer of [...entry.viewers.values()]) {
      if (viewer.ready) {
        try {
          viewer.onData(bytes);
        } catch {
          // WebSocket lifecycle owns detachment; isolate sibling viewers.
        }
        continue;
      }
      if (viewer.pendingBytes + bytes.byteLength > MAX_ATTACH_PENDING_BYTES) {
        viewer.pending = [];
        viewer.pendingBytes = 0;
        continue;
      }
      const copy = bytes.slice();
      viewer.pending.push(copy);
      viewer.pendingBytes += copy.byteLength;
    }
  }

  private async ensureRelay(entry: ManagedTerminal): Promise<void> {
    if (entry.relay) return;
    if (entry.relayStarting) return await entry.relayStarting;
    const start = this.runtime
      .attachOutput(
        entry.record,
        bytes => this.relayData(entry, bytes),
        error => {
          entry.relay = undefined;
          entry.relayStarting = undefined;
          if (!entry.closing && !this.closed) {
            this.terminateViewers(entry, {
              code: error ? 1011 : 1000,
              reason: error ? 'terminal output relay failed' : 'terminal process exited',
            });
          }
        },
      )
      .then(async relay => {
        if (entry.closing || this.closed) {
          await relay.detach().catch(() => undefined);
          return;
        }
        entry.relay = relay;
      });
    entry.relayStarting = start.finally(() => {
      entry.relayStarting = undefined;
    });
    return await entry.relayStarting;
  }

  private stopRelayIfUnused(entry: ManagedTerminal): void {
    if (entry.viewers.size > 0 || !entry.relay) return;
    const relay = entry.relay;
    entry.relay = undefined;
    void relay.detach().catch(() => undefined);
  }

  async attachViewer(
    sessionRef: string,
    terminalId: string,
    onData: (bytes: Uint8Array) => void,
    onTerminal?: (terminal: TerminalViewerTerminal) => void,
  ): Promise<TerminalViewerAttachment> {
    this.assertOpen();
    const entry = await this.entry(sessionRef, terminalId);
    this.assertOpen();
    await this.ensureRelay(entry);
    this.assertOpen();
    if (entry.closing) throw new TerminalError('not_found', 'terminal not found', 404);
    const id = crypto.randomUUID();
    const viewer: TerminalViewer = { ready: false, pending: [], pendingBytes: 0, onData, onTerminal };
    entry.viewers.set(id, viewer);
    entry.lastActivityAt = this.clock.now();
    try {
      let snapshot: Uint8Array | undefined;
      for (let attempt = 0; attempt < ATTACH_SNAPSHOT_RETRIES; attempt += 1) {
        viewer.pending = [];
        viewer.pendingBytes = 0;
        snapshot = await this.runtime.capture(entry.record);
        // A relay delta observed while capture was in flight may already be in
        // the full pane image. Recapture across observed overlap to avoid the
        // ordinary duplicate. tmux capture and FIFO delivery have no formal
        // acknowledgement boundary, so attachment remains at-least-once under
        // a very narrow delayed-delivery race. A continuously writing pane also
        // falls back below rather than losing terminal state or hanging forever.
        if (viewer.pending.length === 0) break;
      }
      onData(snapshot!);
      viewer.ready = true;
      const pending = viewer.pending;
      viewer.pending = [];
      viewer.pendingBytes = 0;
      for (const bytes of pending) onData(bytes);
    } catch (error) {
      entry.viewers.delete(id);
      this.stopRelayIfUnused(entry);
      throw error;
    }
    let attached = true;
    return {
      id,
      detach: () => {
        if (!attached) return;
        attached = false;
        entry.viewers.delete(id);
        this.stopRelayIfUnused(entry);
      },
    };
  }

  async closeTerminal(sessionRef: string, terminalId: string): Promise<void> {
    if (!isTerminalId(terminalId)) throw new TerminalError('not_found', 'terminal not found', 404);
    const { id } = await this.resolveSession(sessionRef);
    await this.exclusive(async () => {
      await this.discover();
      const key = entryKey(id, terminalId);
      const entry = this.entries.get(key);
      if (!entry || entry.closing) throw new TerminalError('not_found', 'terminal not found', 404);
      entry.closing = true;
      this.terminateViewers(entry, { code: 1000, reason: 'terminal closed' });
      const relay = entry.relay;
      entry.relay = undefined;
      if (relay) await relay.detach().catch(() => undefined);
      try {
        await this.runtime.kill(entry.record);
      } finally {
        this.entries.delete(key);
      }
    });
  }

  /** Worktree cleanup can refuse while a shell rooted inside it is alive. */
  async terminalsUnder(root: string): Promise<TerminalView[]> {
    const boundary = path.resolve(root);
    return await this.exclusive(async () => {
      await this.discover();
      return [...this.entries.values()]
        .filter(entry => {
          const candidate = path.resolve(entry.record.root);
          return candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`);
        })
        .map(entry => this.view(entry));
    });
  }

  async sweepIdle(now = this.clock.now()): Promise<number> {
    if (this.closed) return 0;
    return await this.exclusive(async () => {
      const reapedUntrusted = await this.discover(now);
      const expired = [...this.entries.entries()].filter(([, entry]) => {
        const lastActivity = Math.max(entry.lastActivityAt, entry.record.lastActivityAt);
        return !entry.closing && entry.viewers.size === 0 && now - lastActivity >= this.idleTimeoutMs;
      });
      for (const [key, entry] of expired) {
        entry.closing = true;
        const relay = entry.relay;
        entry.relay = undefined;
        if (relay) await relay.detach().catch(() => undefined);
        await this.runtime.kill(entry.record).catch(() => undefined);
        this.entries.delete(key);
      }
      return reapedUntrusted + expired.length;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clock.clearInterval(this.sweepTimer);
    await this.serial.catch(() => undefined);
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      entry.closing = true;
      this.terminateViewers(entry, { code: 1001, reason: 'terminal service restarting' });
    }
    await Promise.allSettled(
      entries.map(async entry => {
        await entry.relayStarting?.catch(() => undefined);
        const relay = entry.relay;
        entry.relay = undefined;
        if (relay) await relay.detach();
      }),
    );
    // Deliberately do not kill tmux sessions: daemon restart is a detach, not
    // terminal destruction. Discovery reconnects them after the next boot.
    this.entries.clear();
    this.untrusted.clear();
  }
}
