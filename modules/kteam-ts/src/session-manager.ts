import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { AttachmentStore, type StoredAttachment } from './attachments';
import {
  startClaudeTranscriptWatcher,
  type ClaudeNormalizedEvent,
  type ClaudeTranscriptWatcher,
} from './claude-transcript';
import {
  startCodexTranscriptWatcher,
  type CodexNormalizedEvent,
  type CodexTranscriptWatcher,
} from './codex-transcript';
import { discoverAutoAgents, inferHarness, modelHint, shellSafeSessionName } from './core';
import {
  discoverCodexSession,
  codexSessionIds,
  resolveBinary,
  wrapperHome,
  wrapperModel,
  claudeTranscriptPath,
} from './harness';
import { atomicJson, now, run } from './io';
import { NAME_WINDOW_MS, pickTeammateName } from './names';
import type { KTeamPaths } from './paths';
import { configFile, markerFile, sessionDir, stateFile, turnLog, turnPrompt } from './paths';
import type { AttachmentView, KTeamService, SessionView } from './service';
import { EventStore, type JsonValue, type SessionEvent } from './storage';
import { contextPercentUsed, paneActivityLine, paneShowsActiveWork, TmuxController } from './tmux-controller';
import type { KTeamEvent, SendRequest, SessionConfig, SessionState, SessionStatus, StartSessionRequest } from './types';

interface MonitorHandle {
  abort: AbortController;
  transcript?: ClaudeTranscriptWatcher | CodexTranscriptWatcher;
  loop?: Promise<void>;
}
interface StoredEnvelope {
  source?: KTeamEvent['source'];
  turn?: number;
  payload?: unknown;
  globalSequence?: number;
}
interface SessionManagerOptions {
  healthIntervalSeconds: number;
  quotaUrl: string;
  transcriptReconcileSeconds: number;
  publicUrl: string;
}
interface ResumeGuard {
  status: SessionStatus;
  retryAttempt?: number;
}
interface QuotaWaiter {
  abort: AbortController;
  promise: Promise<void>;
}

class ResumeCancelled extends Error {}

const terminalStatuses: SessionStatus[] = ['completed', 'failed', 'stalled', 'stopped'];
const protectedStatuses: SessionStatus[] = [...terminalStatuses, 'kill_failed'];
const waitingStatuses: SessionStatus[] = ['waiting', 'awaiting_question', 'awaiting_user', 'rate_limited'];

async function interruptibleSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class SessionManager implements KTeamService {
  private readonly tmux: TmuxController;
  private readonly attachments: AttachmentStore;
  private readonly monitors = new Map<string, MonitorHandle>();
  private readonly listeners = new Set<(event: KTeamEvent) => void>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly autoContinued = new Set<string>();
  /** One-shot flags for done-markers deferred while the pane is still working. */
  private readonly doneDeferred = new Set<string>();
  /** TUI bootstrap (launch + first inject) serialized ACROSS sessions: rapid
   *  concurrent starts race the injector — only the first survives, the rest
   *  land typed-but-never-started. */
  private bootstrapChain: Promise<void> = Promise.resolve();
  private readonly quotaWaiters = new Map<string, QuotaWaiter>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private globalSequence = 0;
  private globalEventQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly paths: KTeamPaths,
    private readonly store: EventStore,
    private readonly options: SessionManagerOptions,
  ) {
    this.tmux = new TmuxController(paths, options.publicUrl);
    this.attachments = new AttachmentStore({ rootDir: paths.home });
  }

  static async create(paths: KTeamPaths, options: SessionManagerOptions): Promise<SessionManager> {
    await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
    const store = await EventStore.open({ home: paths.home, databasePath: paths.database });
    const manager = new SessionManager(paths, store, options);
    await manager.initializeGlobalSequence();
    await manager.recover();
    return manager;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    const stopping: Promise<unknown>[] = [];
    for (const waiter of this.quotaWaiters.values()) {
      waiter.abort.abort();
      stopping.push(waiter.promise);
    }
    for (const monitor of this.monitors.values()) {
      monitor.abort.abort();
      if (monitor.transcript) stopping.push(monitor.transcript.stop());
      if (monitor.loop) stopping.push(monitor.loop);
    }
    this.monitors.clear();
    await Promise.allSettled(stopping);
    await Promise.allSettled([...this.queues.values(), this.globalEventQueue]);
    this.store.close();
  }

  async health(): Promise<Record<string, unknown>> {
    const sessions = await this.list();
    return {
      ok: true,
      version: '0.2.0',
      pid: process.pid,
      home: this.paths.home,
      sessions: sessions.length,
      running: sessions.filter(item => !terminalStatuses.includes(item.state.status)).length,
      monitors: this.monitors.size,
      time: now(),
    };
  }

  async list(): Promise<SessionView[]> {
    return this.store.listSessions().flatMap(item => {
      if (!item.config || !item.state) return [];
      return [{ config: item.config as SessionConfig, state: item.state as SessionState, directory: item.directory }];
    });
  }

  async get(id: string): Promise<SessionView> {
    id = this.resolveRef(id);
    try {
      const [config, state] = await Promise.all([
        this.store.readConfig<SessionConfig>(id),
        this.store.readState<SessionState>(id),
      ]);
      return { config, state, directory: sessionDir(this.paths, id) };
    } catch {
      throw new Error(`unknown kteam session "${id}"`);
    }
  }

  /** Canonicalize a session reference: an exact id passes through; otherwise try
   *  it as a teammate name (case-insensitive) among sessions created within the
   *  name window — most recent wins. Unknown refs pass through so the caller's
   *  own "unknown session" error fires. */
  private resolveRef(ref: string): string {
    const sessions = this.store.listSessions();
    if (sessions.some(item => (item.config as SessionConfig | undefined)?.id === ref)) return ref;
    const needle = ref.trim().toLowerCase();
    const cutoff = Date.now() - NAME_WINDOW_MS;
    const match = sessions
      .flatMap(item => {
        const config = item.config as SessionConfig | undefined;
        return config?.teammate?.toLowerCase() === needle && Date.parse(config.createdAt) >= cutoff ? [config] : [];
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return match?.id ?? ref;
  }

  /** Assign a fresh teammate callsign, avoiding names used within the window. */
  private assignTeammateName(): string {
    const recent: string[] = [];
    const lastUsedAt = new Map<string, number>();
    const cutoff = Date.now() - NAME_WINDOW_MS;
    for (const item of this.store.listSessions()) {
      const config = item.config as SessionConfig | undefined;
      if (!config?.teammate) continue;
      const name = config.teammate.toLowerCase();
      const created = Date.parse(config.createdAt) || 0;
      if (created >= cutoff) recent.push(name);
      lastUsedAt.set(name, Math.max(lastUsedAt.get(name) ?? 0, created));
    }
    return pickTeammateName(recent, lastUsedAt);
  }

  async start(request: StartSessionRequest): Promise<SessionView> {
    const prompt = request.prompt?.trim();
    if (!prompt) throw new Error('prompt is required');
    const binary = request.agent;
    const harness = inferHarness(binary);
    if (!path.basename(binary).startsWith(`${harness}-auto-`))
      throw new Error('kteam only launches auto-mode fleet wrappers');
    const wrapper = resolveBinary(binary, [this.paths.kfleetBin, process.env.PATH ?? ''].join(path.delimiter));
    if (!wrapper) throw new Error(`wrapper not found: ${binary}; run kfleet apply`);
    const requestedCwd = path.resolve(request.cwd ?? process.cwd());
    if (!(await stat(requestedCwd).catch(() => undefined))?.isDirectory())
      throw new Error(`not a directory: ${requestedCwd}`);
    // macOS exposes /tmp through /private/tmp. Store the canonical path so
    // harness trust records and transcript metadata agree with the session.
    const cwd = await realpath(requestedCwd);
    const mode = request.mode ?? 'auto';
    if (mode !== 'auto' && mode !== 'interactive') throw new Error('mode must be auto or interactive');
    const harnessHome = await wrapperHome(wrapper, harness);
    if (!harnessHome)
      throw new Error(
        `could not determine ${harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'} from ${wrapper}`,
      );
    const harnessSessionBaseline = harness === 'codex' ? await codexSessionIds(harnessHome) : undefined;
    // Parent capture: teammates starting teammates form a tree. Resolve the
    // caller-supplied parent ref (id or teammate name) to a real session; a
    // dangling ref is dropped rather than stored broken. Children inherit the
    // parent's label when none is given, so whole trees group in ps/UI.
    const parentRef = request.parent?.trim();
    const parentView = parentRef ? await this.get(parentRef).catch(() => undefined) : undefined;
    // Model resolution: explicit request wins, else the wrapper's kfleet default
    // (KTEAM_MODEL). A default is always fed in when kfleet declares one, so the
    // per-account default model can't silently drift; undefined => no --model.
    const model = request.model?.trim() || (await wrapperModel(wrapper));

    // Preflight 1 — duplicate guard: a client retrying start after a transient
    // error must not spawn a second live session for the same work. An
    // identical (binary, cwd, prompt) session started in the last 10 minutes
    // that is still live IS that earlier request succeeding server-side.
    for (const existing of await this.list()) {
      if (
        existing.config.binary === binary &&
        existing.config.cwd === cwd &&
        !terminalStatuses.includes(existing.state.status) &&
        Date.now() - Date.parse(existing.config.createdAt) < 600_000 &&
        (await readFile(existing.config.originalPromptFile, 'utf8').catch(() => '')).trim() === prompt
      ) {
        throw new Error(
          `an identical session is already live: ${existing.config.id} (${existing.state.status}); ` +
            'the earlier start succeeded — use it, or stop it first',
        );
      }
    }
    // Preflight 2 — quota/auth: launching on an exhausted or logged-out
    // account burns a session that can only no-op. Fail fast, wrapper named.
    const preflightQuota = await this.fetchQuota({ binary } as SessionConfig);
    if (preflightQuota?.atLimit === true) {
      const reset = preflightQuota.resetAt ? ` (resets ${new Date(preflightQuota.resetAt).toISOString()})` : '';
      throw new Error(`wrapper ${binary} is at its usage limit${reset}; pick another account`);
    }
    if (preflightQuota?.authOk === false) {
      throw new Error(`wrapper ${binary} is not logged in (kfleet usage reports auth failure); run kfleet login`);
    }

    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = sessionDir(this.paths, id);
    await Promise.all(
      ['markers', 'channel', 'checks', 'snapshots', 'logs', 'turns', 'raw', 'attachments'].map(name =>
        mkdir(path.join(directory, name), { recursive: true, mode: 0o700 }),
      ),
    );
    const initialAttachments: StoredAttachment[] = [];
    try {
      for (const attachment of request.initialAttachments ?? []) {
        if (attachment.base64.length > 28 * 1024 * 1024)
          throw new Error('initial image exceeds the 20 MiB decoded limit');
        const stored = await this.attachments.upload(id, Buffer.from(attachment.base64, 'base64'), {
          filename: attachment.filename,
          mime: attachment.mime,
        });
        initialAttachments.push(stored);
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const attachmentBlock = await this.attachments.buildImageReferenceBlock(
      id,
      initialAttachments.map(item => item.manifest.id),
    );
    const assignedPrompt = [prompt, attachmentBlock].filter(Boolean).join('\n\n');
    const createdAt = now();
    const config: SessionConfig = {
      id,
      name: (request.name ?? prompt.split(/\s+/).slice(0, 5).join('-')).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48),
      teammate: this.assignTeammateName(),
      label: request.label?.trim() || parentView?.config.label || undefined,
      parent: parentView?.config.id,
      binary,
      harness,
      modelHint: modelHint(binary),
      model,
      mode,
      cwd,
      createdAt,
      updatedAt: createdAt,
      turn: 1,
      harnessSessionId: harness === 'claude' ? crypto.randomUUID() : '',
      harnessHome,
      harnessSessionBaseline,
      tmuxSession: shellSafeSessionName(id, 'agent'),
      watcherSession: shellSafeSessionName(id, 'watch'),
      intervalSeconds: this.number(request.intervalSeconds, this.options.healthIntervalSeconds, 2, 'intervalSeconds'),
      stallSeconds: this.number(request.stallSeconds, 900, 10, 'stallSeconds'),
      timeoutSeconds: this.number(request.timeoutSeconds, 14_400, 30, 'timeoutSeconds'),
      maxSnapshots: this.number(request.maxSnapshots, 200, 1, 'maxSnapshots'),
      systemPromptFile: path.join(directory, 'system.md'),
      originalPromptFile: path.join(directory, 'prompt.md'),
      retry: { transientAttempts: 3, stalledAttempts: 0, waitForQuotaReset: true, allowAccountFailover: false },
    };
    config.transcriptFile = claudeTranscriptPath(config);
    const state: SessionState = {
      id,
      status: 'created',
      turn: 1,
      health: 'unknown',
      openTools: [],
      transcriptOffset: 0,
      turnCompleted: false,
    };
    const systemPrompt = this.systemPrompt(config);
    await Promise.all([
      this.store.writeConfig(id, config),
      this.store.writeState(id, state),
      writeFile(config.systemPromptFile, systemPrompt, { mode: 0o600 }),
      writeFile(config.originalPromptFile, `${assignedPrompt}\n`, { mode: 0o600 }),
      writeFile(turnPrompt(this.paths, id, 1), `${systemPrompt}\n# Assigned task\n\n${assignedPrompt}\n`, {
        mode: 0o600,
      }),
      writeFile(turnLog(this.paths, id, 1), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'chat.jsonl'), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'channel', 'inbox.jsonl'), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'channel', 'outbox.jsonl'), '', { mode: 0o600 }),
    ]);
    await this.emit(id, 'session.created', { binary, harness, mode, cwd }, 'daemon', 1);
    for (const stored of initialAttachments) {
      await this.emit(id, 'attachment.created', this.attachmentView(stored), 'client', 1);
    }
    await this.transition(id, { status: 'starting', startedAt: now(), health: 'healthy' }, 'session.starting');
    try {
      // send() re-verifies prompt readiness right before typing — launch()'s
      // readiness can go stale if a late startup splash repaints the pane,
      // and a prompt injected into a booting TUI lands as a no-op turn.
      await this.serializedBootstrap(async () => {
        await this.tmux.launch(config);
        await this.tmux.send(config, this.promptInstruction(id, 1));
      });
      await this.transition(
        id,
        {
          status: 'running',
          lastActivityAt: now(),
          promptReady: false,
          turnCompleted: false,
        },
        'session.running',
      );
      await this.startMonitor(id);
    } catch (error) {
      await this.tmux.snapshot(config, true).catch(() => '');
      let killError: unknown;
      try {
        await this.stopTmuxWithEvidence(config, 'failed initial launch cleanup');
      } catch (caught) {
        killError = caught;
      }
      if (killError) {
        const reason = `initial launch failed and tmux could not be killed: ${killError instanceof Error ? killError.message : String(killError)}`;
        await this.transition(
          id,
          { status: 'kill_failed', health: 'crashed', reason, promptReady: false },
          'session.kill_failed',
        );
        const paneState = await this.tmux.state(config.tmuxSession);
        if (paneState.alive && !paneState.dead) await this.startMonitor(id).catch(() => undefined);
        throw new AggregateError([error, killError], reason);
      }
      await this.transition(
        id,
        { status: 'failed', health: 'crashed', reason: String(error), finishedAt: now(), promptReady: false },
        'session.failed',
      );
      throw error;
    }
    return await this.get(id);
  }

  async send(id: string, request: SendRequest): Promise<SessionView> {
    id = this.resolveRef(id);
    {
      // Atomic revive+send: a finished/stopped session accepts a follow-up
      // message directly — resume() relaunches the TUI and injects it as the
      // next turn under the session lock (and if the pane turns out to be
      // alive by then, resume() delivers it as a plain send). This removes the
      // unwinnable client-side send⇄resume status ping-pong.
      const probe = await this.get(id);
      const paneProbe = await this.tmux.state(probe.config.tmuxSession);
      if (!paneProbe.alive || paneProbe.dead) {
        const message = request.message?.trim();
        const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
        const complete = [message, attachmentBlock].filter(Boolean).join('\n\n');
        if (!complete) throw new Error('message or attachment is required');
        return await this.resume(id, complete);
      }
    }
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      const paneState = await this.tmux.state(view.config.tmuxSession);
      if (!paneState.alive || paneState.dead)
        throw new Error('session stopped while sending; retry `kteam send` (it revives stopped sessions)');
      if (view.state.status === 'awaiting_question')
        throw new Error('answer the structured question with `kteam answer`');
      // promptReady means the TUI input box is demonstrably idle even when the
      // transcript-derived status lags (dropped end-of-turn records).
      if (
        !waitingStatuses.includes(view.state.status) &&
        view.state.status !== 'interrupted' &&
        view.state.promptReady !== true
      ) {
        // F5: a busy session QUEUES the message by default — the monitor
        // delivers it at the next genuine prompt-ready turn boundary through
        // the normal inject path. `--now` restores immediate-or-fail. The old
        // unconditional refusal is what pushed operators to the destructive
        // interrupt as a live-steer channel.
        if (request.now === true) throw new Error(`session is ${view.state.status}; interrupt it before sending`);
        const queuedMessage = request.message?.trim();
        if (!queuedMessage && !request.attachmentIds?.length) throw new Error('message or attachment is required');
        await appendFile(
          path.join(view.directory, 'channel', 'pending-sends.jsonl'),
          `${JSON.stringify({ id: crypto.randomUUID(), at: now(), message: queuedMessage, attachmentIds: request.attachmentIds ?? [] })}\n`,
        );
        await this.emit(
          id,
          'control.send_queued',
          { message: queuedMessage, attachmentIds: request.attachmentIds ?? [] },
          'client',
        );
        return await this.get(id);
      }
      const message = request.message?.trim();
      if (!message && !request.attachmentIds?.length) throw new Error('message or attachment is required');
      const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
      const complete = [message, attachmentBlock].filter(Boolean).join('\n\n');
      const turn = view.config.turn + 1;
      await writeFile(turnPrompt(this.paths, id, turn), `${complete}\n`, { mode: 0o600 });
      await appendFile(
        path.join(view.directory, 'channel', 'inbox.jsonl'),
        `${JSON.stringify({ at: now(), type: 'message', turn, message, attachmentIds: request.attachmentIds ?? [] })}\n`,
      );
      const config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        turn,
        updatedAt: now(),
      }));
      await rm(markerFile(this.paths, id, 'needs-help'), { force: true });
      await this.emit(id, 'control.send', { message, attachmentIds: request.attachmentIds ?? [] }, 'client', turn);
      await this.tmux.send(config, this.promptInstruction(id, turn));
      // Markers written while this injection was GATED on a busy pane belong
      // to the PREVIOUS turn (e.g. the agent's `signal done` for work that
      // finished during the wait) — clear them now that the new turn's prompt
      // has actually landed, else the monitor reports a false `completed` for
      // a turn that is just starting (observed live: geoffrey, 2026-07-21).
      await Promise.all(['done', 'needs-help'].map(name => rm(markerFile(this.paths, id, name), { force: true })));
      this.autoContinued.delete(id);
      this.doneDeferred.delete(id);
      await this.transition(
        id,
        {
          status: 'running',
          turn,
          promptReady: false,
          pendingQuestion: undefined,
          // timeoutSeconds bounds one turn of work, so every user turn restarts
          // the clock; otherwise a healthy interactive session is killed as soon
          // as its wall-clock age exceeds the timeout.
          startedAt: now(),
          reason: undefined,
          lastActivityAt: now(),
          turnCompleted: false,
        },
        'turn.started',
      );
      return await this.get(id);
    });
  }

  /** Deliver queued busy-time sends at a prompt-ready turn boundary. Entries
   *  are marked delivered BEFORE injection (at-most-once); if the session went
   *  busy again mid-delivery, send() re-queues the combined message itself. */
  private async deliverPendingSends(id: string, directory: string): Promise<boolean> {
    const file = path.join(directory, 'channel', 'pending-sends.jsonl');
    const raw = await readFile(file, 'utf8').catch(() => '');
    const entries = raw
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as { id: string; at: string; message?: string; attachmentIds?: string[] }];
        } catch {
          return [];
        }
      });
    if (entries.length === 0) return false;
    await writeFile(file, '', { mode: 0o600 });
    await appendFile(
      path.join(directory, 'channel', 'delivered-sends.jsonl'),
      `${entries.map(entry => JSON.stringify({ ...entry, deliveredAt: now() })).join('\n')}\n`,
    );
    await this.emit(id, 'control.send_dequeued', { count: entries.length }, 'daemon');
    const message = entries
      .map(entry => entry.message)
      .filter(Boolean)
      .join('\n\n---\n\n');
    const attachmentIds = entries.flatMap(entry => entry.attachmentIds ?? []);
    await this.send(id, { message, attachmentIds });
    return true;
  }

  /** F4 auto-revive guard: if a control action left the pane DEAD (e.g. a
   *  keystroke the TUI interpreted as quit), recover it once through the
   *  normal resume path and record that it happened. Runs OUTSIDE the session
   *  lock — resume() takes it itself. */
  private async withAutoRevive(
    id: string,
    action: string,
    operation: () => Promise<SessionView>,
    reviveMessage?: string,
  ): Promise<SessionView> {
    try {
      return await operation();
    } catch (error) {
      const view = await this.get(id).catch(() => undefined);
      if (view) {
        const pane = await this.tmux.state(view.config.tmuxSession);
        if (!pane.alive || pane.dead) {
          await this.emit(id, 'control.autorevive', { action, error: String(error) }, 'daemon').catch(() => undefined);
          return await this.resume(id, reviveMessage);
        }
      }
      throw error;
    }
  }

  async answer(id: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView> {
    id = this.resolveRef(id);
    return await this.withAutoRevive(id, 'answer', () =>
      this.serialized(id, async () => {
        const view = await this.get(id);
        if (view.state.status !== 'awaiting_question')
          throw new Error('session is not waiting on a structured question');
        await this.emit(
          id,
          'interaction.answer',
          { toolUseId: view.state.pendingQuestion?.toolUseId, labels, other, responses },
          'client',
        );
        await this.tmux.answerQuestion(view.config, view.state, labels, other, responses);
        await this.transition(
          id,
          {
            status: 'running',
            health: 'healthy',
            pendingQuestion: undefined,
            promptReady: false,
            startedAt: now(),
            lastActivityAt: now(),
            turnCompleted: false,
          },
          'turn.resumed',
        );
        return await this.get(id);
      }),
    );
  }

  async interrupt(id: string): Promise<SessionView> {
    id = this.resolveRef(id);
    return await this.withAutoRevive(id, 'interrupt', () =>
      this.serialized(id, async () => {
        const view = await this.get(id);
        await this.emit(id, 'control.interrupt.requested', {}, 'client');
        await this.tmux.interrupt(view.config);
        await this.transition(
          id,
          { status: 'interrupted', health: 'idle', promptReady: true, reason: 'interrupted by client' },
          'control.interrupted',
        );
        return await this.get(id);
      }),
    );
  }

  async stop(id: string, reason = 'stopped by client'): Promise<SessionView> {
    id = this.resolveRef(id);
    this.cancelRetry(id);
    void this.cancelQuotaWaiter(id);
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      await this.tmux.snapshot(view.config, true);
      await atomicJson(path.join(view.directory, 'kill.json'), {
        at: now(),
        reason,
        lastSnapshot: 'last-snapshot.txt',
      });
      await this.stopManagedSession(view.config, reason);
      await this.transition(
        id,
        { status: 'stopped', health: 'idle', reason, finishedAt: now(), promptReady: false },
        'session.stopped',
      );
      return await this.get(id);
    });
  }

  async resume(id: string, message?: string, guard?: ResumeGuard): Promise<SessionView> {
    id = this.resolveRef(id);
    if (!guard) this.cancelRetry(id);
    let startMonitorAfterUnlock = false;
    const resumed = await this.serialized(id, async () => {
      const automaticRetry = guard?.status === 'retrying';
      let view = await this.get(id);
      if (view.state.status === 'kill_failed')
        throw new Error('the previous tmux kill failed; use stop again before resume');
      if (
        guard &&
        (view.state.status !== guard.status ||
          (guard.retryAttempt !== undefined && view.state.retryAttempt !== guard.retryAttempt))
      ) {
        throw new ResumeCancelled(`resume guard changed from ${guard.status}`);
      }
      const paneState = await this.tmux.state(view.config.tmuxSession);
      if (paneState.alive && !paneState.dead) {
        if (!message) throw new Error('session is already running');
        return await this.sendUnlocked(view, message);
      }
      if (paneState.alive) await this.stopTmuxWithEvidence(view.config, 'cleanup before resume');
      if (view.config.harness === 'codex' && !view.config.harnessSessionId) {
        const found = await discoverCodexSession(view.config, await this.claimedCodexSessionIds(id));
        if (!found) throw new Error('could not identify the persisted Codex session to resume');
        view.config = await this.store.updateConfig<SessionConfig>(id, current => ({
          ...current,
          harnessSessionId: found.id,
          transcriptFile: found.file,
          updatedAt: now(),
        }));
      }
      const turn = view.config.turn + 1;
      const prompt = message?.trim() || 'Continue the assigned task from where you stopped.';
      await writeFile(
        turnPrompt(this.paths, id, turn),
        `${prompt}\n\nContinue using the same kteam completion and interaction protocol.\n`,
        { mode: 0o600 },
      );
      await Promise.all(
        ['done', 'needs-help', 'process-exit'].map(name => rm(markerFile(this.paths, id, name), { force: true })),
      );
      const config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        turn,
        updatedAt: now(),
      }));
      await this.transition(
        id,
        {
          status: 'starting',
          turn,
          startedAt: now(),
          reason: undefined,
          finishedAt: undefined,
          exitCode: undefined,
          retryAttempt: automaticRetry ? view.state.retryAttempt : 0,
          openTools: [],
          pendingQuestion: undefined,
          promptReady: false,
          turnCompleted: false,
        },
        'session.resuming',
      );
      try {
        await this.serializedBootstrap(async () => {
          await this.tmux.launch(config);
          await this.tmux.send(config, this.promptInstruction(id, turn));
        });
        this.autoContinued.delete(id);
        this.doneDeferred.delete(id);
        await this.transition(
          id,
          {
            status: 'running',
            health: 'healthy',
            promptReady: false,
            lastActivityAt: now(),
            turnCompleted: false,
          },
          'session.resumed',
        );
        // A watcher immediately replays persisted transcript bytes through the
        // same per-session queue. Starting it while this queue is held would
        // deadlock resume against its own transcript callback.
        startMonitorAfterUnlock = true;
      } catch (error) {
        await this.tmux.snapshot(config, true).catch(() => '');
        await this.stopTmuxWithEvidence(config, 'failed resume cleanup');
        const attempt = view.state.retryAttempt ?? 0;
        if (automaticRetry && attempt < (config.retry?.transientAttempts ?? 0)) {
          const nextAttempt = attempt + 1;
          await this.transition(
            id,
            {
              status: 'retrying',
              health: 'crashed',
              reason: String(error),
              retryAttempt: nextAttempt,
              promptReady: false,
            },
            'retry.scheduled',
            { attempt: nextAttempt, delaySeconds: 2 ** nextAttempt },
          );
          this.scheduleTransientRetry(id, nextAttempt);
        } else {
          await this.transition(
            id,
            {
              status: 'failed',
              health: 'crashed',
              reason: String(error),
              finishedAt: now(),
              promptReady: false,
            },
            'session.failed',
          );
        }
        throw error;
      }
      return await this.get(id);
    });
    if (startMonitorAfterUnlock) {
      await this.startMonitor(id);
      return await this.get(id);
    }
    return resumed;
  }

  async remove(id: string, purge = false, force = false): Promise<void> {
    id = this.resolveRef(id);
    if (this.deleting.has(id)) throw new Error('session deletion is already in progress');
    this.deleting.add(id);
    this.cancelRetry(id);
    let restartMonitor: SessionConfig | undefined;
    try {
      await this.cancelQuotaWaiter(id, true);
      await this.queues.get(id)?.catch(() => undefined);
      const view = await this.get(id);
      const paneState = await this.tmux.state(view.config.tmuxSession);
      const running = paneState.alive && !paneState.dead;
      if (running && !force) throw new Error('session is running; stop it first or use --force');
      await this.stopMonitor(id, true);
      if (paneState.alive) {
        await this.tmux.snapshot(view.config, true);
        try {
          await this.stopTmuxWithEvidence(view.config, 'session deletion');
        } catch (error) {
          if (running) restartMonitor = view.config;
          throw error;
        }
      }
      await this.emit(id, 'session.deleted', { purge }, 'client', undefined, true);
      if (purge) await rm(view.directory, { recursive: true, force: true });
      else {
        await mkdir(this.paths.trash, { recursive: true, mode: 0o700 });
        await rename(view.directory, path.join(this.paths.trash, `${id}-${Date.now()}`));
      }
      await this.store.rebuildIndex();
    } finally {
      this.deleting.delete(id);
      if (restartMonitor && !this.closed) await this.startMonitor(id).catch(() => undefined);
    }
  }

  async signal(id: string, kind: 'done' | 'help', message?: string): Promise<SessionView> {
    id = this.resolveRef(id);
    this.cancelRetry(id);
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      if (kind === 'done') {
        void this.cancelQuotaWaiter(id);
        if (message) await writeFile(path.join(view.directory, 'summary.md'), `${message}\n`, { mode: 0o600 });
        if (!existsSync(path.join(view.directory, 'summary.md')))
          await writeFile(
            path.join(view.directory, 'summary.md'),
            'Task completed; inspect chat and repository diff.\n',
            { mode: 0o600 },
          );
        await atomicJson(markerFile(this.paths, id, 'done'), { at: now(), type: 'done' });
        await this.tmux.snapshot(view.config, true);
        await this.stopManagedSession(view.config, 'completion');
        await this.transition(
          id,
          { status: 'completed', health: 'idle', reason: 'done marker written', finishedAt: now(), promptReady: false },
          'session.completed',
        );
      } else {
        if (!message) throw new Error('help requires a question');
        await appendFile(
          path.join(view.directory, 'channel', 'outbox.jsonl'),
          `${JSON.stringify({ at: now(), type: 'question', message })}\n`,
        );
        await atomicJson(markerFile(this.paths, id, 'needs-help'), { at: now(), type: 'question', message });
        if (view.config.mode === 'auto') {
          void this.cancelQuotaWaiter(id);
          await this.tmux.snapshot(view.config, true);
          await this.stopManagedSession(view.config, 'automode help protocol violation');
          await this.transition(
            id,
            {
              status: 'failed',
              health: 'crashed',
              reason: 'automode teammate requested user input',
              finishedAt: now(),
              promptReady: false,
            },
            'session.protocol_violation',
          );
        } else {
          await this.transition(
            id,
            { status: 'waiting', health: 'waiting', reason: message, promptReady: true },
            'interaction.help',
          );
        }
      }
      return await this.get(id);
    });
  }

  async snapshot(id: string): Promise<string> {
    id = this.resolveRef(id);
    return await this.serialized(id, async () => await this.tmux.snapshot((await this.get(id)).config, true));
  }

  async lastSnapshot(id: string): Promise<string> {
    id = this.resolveRef(id);
    // Read the monitor's last written frame straight from disk. snapshot()
    // captures live tmux UNDER THE SESSION LOCK — on a busy session that
    // queues behind monitor/injection work for tens of seconds, which is what
    // made the web UI (polling it every few seconds) feel broken.
    return await readFile(path.join(sessionDir(this.paths, id), 'last-snapshot.txt'), 'utf8').catch(() => '');
  }

  async chatHistory(
    id: string,
    before?: number,
    limit = 200,
  ): Promise<{ total: number; offset: number; records: unknown[] }> {
    id = this.resolveRef(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000');
    const raw = await readFile(path.join(sessionDir(this.paths, id), 'chat.jsonl'), 'utf8').catch(() => '');
    const records = raw
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    const end = before === undefined ? records.length : Math.max(0, Math.min(before, records.length));
    const offset = Math.max(0, end - limit);
    return { total: records.length, offset, records: records.slice(offset, end) };
  }
  async logs(id: string, turn?: number): Promise<string> {
    id = this.resolveRef(id);
    const view = await this.get(id);
    return await readFile(turnLog(this.paths, id, turn ?? view.config.turn), 'utf8').catch(() => '');
  }

  async replay(id: string | undefined, after: number, limit = 1000): Promise<KTeamEvent[]> {
    if (id !== undefined) id = this.resolveRef(id);
    // Negative `after` = tail semantics: the last |after| events. Long sessions
    // accumulate thousands of events; the UI's live view only needs the recent
    // window, not a full-history replay on every WebSocket connect.
    if (!Number.isSafeInteger(after) || after < -10_000) throw new Error('after must be a safe integer >= -10000');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('limit must be between 1 and 10000');
    const events = id
      ? this.replayCompleteJournal(id)
      : this.store.listSessions().flatMap(session => this.replayCompleteJournal(session.id));
    const ordered = events.map(event => this.fromStored(event)).sort((a, b) => a.sequence - b.sequence);
    if (after < 0) return ordered.slice(after);
    return ordered.filter(event => event.sequence > after).slice(0, limit);
  }

  private replayCompleteJournal(id: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    let localSequence = 0;
    while (true) {
      const page = this.store.replay(id, { afterSequence: localSequence, limit: 10_000 });
      events.push(...page);
      if (page.length < 10_000) return events;
      localSequence = page.at(-1)!.sequence;
    }
  }

  subscribe(listener: (event: KTeamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async addAttachment(id: string, filename: string, mime: string, bytes: Uint8Array): Promise<AttachmentView> {
    id = this.resolveRef(id);
    return await this.serialized(id, async () => {
      await this.get(id);
      const stored = await this.attachments.upload(id, bytes, { filename, mime: mime || undefined });
      const attachment = this.attachmentView(stored);
      await this.emit(id, 'attachment.created', attachment, 'client');
      return attachment;
    });
  }

  async getAttachment(id: string, attachmentId: string): Promise<{ attachment: AttachmentView; bytes: Uint8Array }> {
    id = this.resolveRef(id);
    await this.get(id);
    const stored = await this.attachments.get(id, attachmentId);
    return {
      attachment: this.attachmentView(stored),
      bytes: new Uint8Array(await Bun.file(stored.path).arrayBuffer()),
    };
  }

  private async recover(): Promise<void> {
    for (const session of await this.list()) {
      const paneState = await this.tmux.state(session.config.tmuxSession);
      if (session.state.status === 'kill_failed') {
        if (paneState.alive) {
          await this.tmux.snapshot(session.config, true);
          try {
            await this.stopTmuxWithEvidence(session.config, 'retry kill after daemon restart');
          } catch {
            if (!paneState.dead) await this.startMonitor(session.config.id);
            continue;
          }
        }
        await this.transition(
          session.config.id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'previous kill failure is no longer live',
            finishedAt: now(),
            promptReady: false,
          },
          'session.failed',
        );
        continue;
      }
      if (terminalStatuses.includes(session.state.status)) {
        if (paneState.alive) {
          await this.tmux.snapshot(session.config, true);
          await this.stopTmuxWithEvidence(session.config, 'terminal session survived daemon restart');
        }
        continue;
      }
      if (paneState.alive && !paneState.dead) {
        await this.transition(
          session.config.id,
          { status: session.state.status === 'starting' ? 'running' : session.state.status, health: 'healthy' },
          'daemon.recovered',
        );
        await this.startMonitor(session.config.id);
        if (session.state.status === 'rate_limited' && session.config.retry?.waitForQuotaReset !== false) {
          this.scheduleQuotaWaiter(session.config.id);
        }
        continue;
      }
      if (paneState.alive) {
        await this.tmux.snapshot(session.config, true);
        await this.stopTmuxWithEvidence(session.config, 'dead pane cleanup during daemon restart');
      }
      if (session.state.status === 'rate_limited' && session.config.retry?.waitForQuotaReset !== false) {
        this.scheduleQuotaWaiter(session.config.id);
      } else if (session.state.status === 'retrying' && (session.state.retryAttempt ?? 0) > 0) {
        this.scheduleTransientRetry(session.config.id, session.state.retryAttempt!);
      } else {
        await this.transition(
          session.config.id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'daemon restarted but the interactive tmux session no longer exists; use resume',
            finishedAt: now(),
            promptReady: false,
          },
          'daemon.recovery_failed',
        );
      }
    }
  }

  private async startMonitor(id: string): Promise<void> {
    await this.stopMonitor(id);
    const view = await this.get(id);
    const handle: MonitorHandle = { abort: new AbortController() };
    this.monitors.set(id, handle);
    if (view.config.harness === 'claude' && view.config.harnessHome) {
      handle.transcript = await startClaudeTranscriptWatcher({
        transcriptRoot: path.join(view.config.harnessHome, 'projects'),
        sessionId: view.config.harnessSessionId,
        initialOffset: view.state.transcriptOffset ?? 0,
        reconcileIntervalMs: this.options.transcriptReconcileSeconds * 1000,
        onDiscovered: async file => {
          await this.store.updateConfig<SessionConfig>(id, current => ({
            ...current,
            transcriptFile: file,
            updatedAt: now(),
          }));
          await this.emit(id, 'transcript.discovered', { file }, 'watcher');
        },
        onEvents: async (events, cursor) => await this.handleClaudeEvents(id, events, cursor.endOffset),
        onCheckpoint: async cursor => {
          await this.store.updateState<SessionState>(id, current => ({
            ...current,
            transcriptOffset: Math.max(current.transcriptOffset ?? 0, cursor.endOffset),
            lastTranscriptAt: now(),
          }));
        },
        onError: error => {
          void this.emit(id, 'transcript.error', { message: error.message }, 'watcher').catch(() => undefined);
        },
      });
    } else if (view.config.harness === 'codex') {
      await this.ensureCodexTranscript(id, handle);
    }
    handle.loop = this.monitorLoop(id, handle.abort.signal);
    void handle.loop.catch(() => undefined);
  }

  private async ensureCodexTranscript(id: string, handle: MonitorHandle): Promise<void> {
    if (handle.transcript || handle.abort.signal.aborted) return;
    let view = await this.get(id);
    let transcriptFile = view.config.transcriptFile;
    let harnessSessionId = view.config.harnessSessionId;
    if (!transcriptFile || !harnessSessionId) {
      const found = await discoverCodexSession(view.config, await this.claimedCodexSessionIds(id));
      if (!found) return;
      transcriptFile = found.file;
      harnessSessionId = found.id;
      const config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        harnessSessionId,
        transcriptFile,
        updatedAt: now(),
      }));
      view = { ...view, config };
    }
    const watcher = await startCodexTranscriptWatcher({
      transcriptFile,
      sessionId: harnessSessionId,
      initialOffset: view.state.transcriptOffset ?? 0,
      reconcileIntervalMs: this.options.transcriptReconcileSeconds * 1000,
      onDiscovered: async file => {
        await this.store.updateConfig<SessionConfig>(id, current => ({
          ...current,
          harnessSessionId,
          transcriptFile: file,
          updatedAt: now(),
        }));
        await this.emit(id, 'transcript.discovered', { file, harnessSessionId }, 'watcher');
      },
      onEvents: async (events, cursor) => await this.handleCodexEvents(id, events, cursor.endOffset),
      onCheckpoint: async cursor => {
        await this.store.updateState<SessionState>(id, current => ({
          ...current,
          transcriptOffset: Math.max(current.transcriptOffset ?? 0, cursor.endOffset),
          lastTranscriptAt: now(),
        }));
      },
      onError: error => {
        void this.emit(id, 'transcript.error', { message: error.message }, 'watcher').catch(() => undefined);
      },
    });
    if (handle.abort.signal.aborted) await watcher.stop();
    else handle.transcript = watcher;
  }

  private async stopMonitor(id: string, drain = false): Promise<void> {
    const monitor = this.monitors.get(id);
    if (!monitor) return;
    this.monitors.delete(id);
    monitor.abort.abort();
    const stopping = monitor.transcript?.stop();
    if (drain) {
      const pending: Promise<void>[] = [];
      if (stopping) pending.push(stopping);
      if (monitor.loop) pending.push(monitor.loop);
      await Promise.allSettled(pending);
    } else void stopping?.catch(() => undefined);
  }

  private async monitorLoop(id: string, signal: AbortSignal): Promise<void> {
    let paneHash = '';
    let diffHash = '';
    let promptStable = 0;
    let lastDurableActivity = Date.now();
    let lastQuotaCheck = 0;
    let reinjectedTurn = -1;
    // F6: the last turn whose pane visibly showed active work. A turn that
    // demonstrably RAN but produced no correlated transcript (e.g. GLM canary,
    // 2026-07-19) is a transcript-correlation gap, not a lost prompt — it must
    // not be reinjected or failed as turn-never-started.
    let activeWorkTurn = -1;
    try {
      while (!signal.aborted && !this.closed) {
        let sleepSeconds = this.options.healthIntervalSeconds;
        try {
          let view = await this.get(id);
          sleepSeconds = view.config.intervalSeconds;
          const monitor = this.monitors.get(id);
          if (view.config.harness === 'codex' && monitor && !monitor.transcript) {
            await this.ensureCodexTranscript(id, monitor);
            view = await this.get(id);
          }
          if (existsSync(markerFile(this.paths, id, 'done'))) {
            // A done marker written while the pane still shows an ACTIVE turn
            // (spinner/token counter) means the teammate declared victory
            // early — deliverables may not exist yet. Defer completion until
            // the pane actually idles; killing mid-turn produced sessions
            // marked completed whose files were never written.
            const donePane = await this.tmux.state(view.config.tmuxSession);
            if (donePane.alive && !donePane.dead && paneShowsActiveWork(donePane.visiblePane)) {
              if (!this.doneDeferred.has(id)) {
                this.doneDeferred.add(id);
                await this.emit(
                  id,
                  'session.done_deferred',
                  { reason: 'done marker present but the pane still shows an active turn; waiting for it to idle' },
                  'watcher',
                );
              }
            } else {
              this.doneDeferred.delete(id);
              await this.tmux.snapshot(view.config, true);
              await this.stopTmuxWithEvidence(view.config, 'done marker');
              await this.transition(
                id,
                {
                  status: 'completed',
                  health: 'idle',
                  reason: 'done marker written',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.completed',
              );
              return;
            }
          }
          if (existsSync(markerFile(this.paths, id, 'needs-help')) && !waitingStatuses.includes(view.state.status)) {
            const marker = (await readFile(markerFile(this.paths, id, 'needs-help'), 'utf8')
              .then(JSON.parse)
              .catch(() => ({}))) as { message?: string };
            if (view.config.mode === 'interactive') {
              await this.transition(
                id,
                { status: 'waiting', health: 'waiting', reason: marker.message ?? 'teammate requested help' },
                'interaction.help',
              );
              view = await this.get(id);
            } else {
              await this.tmux.snapshot(view.config, true);
              await this.stopTmuxWithEvidence(view.config, 'automode help protocol violation');
              await this.transition(
                id,
                {
                  status: 'failed',
                  health: 'crashed',
                  reason: 'automode teammate requested user input',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.protocol_violation',
              );
              return;
            }
          }
          const pane = await this.tmux.state(view.config.tmuxSession);
          if (!pane.alive || pane.dead) {
            if (!terminalStatuses.includes(view.state.status)) {
              await this.tmux.snapshot(view.config, true);
              const exitEvidence = { at: now(), alive: pane.alive, dead: pane.dead, exitCode: pane.exitCode };
              await Promise.all([
                atomicJson(path.join(view.directory, 'checks', 'exit.json'), exitEvidence),
                atomicJson(markerFile(this.paths, id, 'process-exit'), exitEvidence),
              ]);
              const quota = await this.fetchQuota(view.config, signal);
              // Classify from the final visible screen, not the full scrollback:
              // task text and tool output routinely mention rate limits, quotas,
              // HTTP codes, and network errors, and must not steer classification.
              const lower = (
                pane.visiblePane.trim() ? pane.visiblePane : pane.pane.split('\n').slice(-60).join('\n')
              ).toLowerCase();
              if (
                quota?.atLimit === true ||
                (quota?.atLimit !== false && /rate.?limit|usage limit|quota|out of tokens/.test(lower))
              ) {
                await this.transition(
                  id,
                  {
                    status: 'rate_limited',
                    health: 'rate_limited',
                    reason: 'account quota exhausted',
                    exitCode: pane.exitCode,
                    quota,
                  },
                  'quota.exhausted',
                  quota ?? {},
                );
                if (view.config.retry?.waitForQuotaReset !== false) this.scheduleQuotaWaiter(id);
              } else if (
                /network|connection|timed out|temporar|overloaded|\b50[234]\b/.test(lower) &&
                (view.state.retryAttempt ?? 0) < (view.config.retry?.transientAttempts ?? 0)
              ) {
                const attempt = (view.state.retryAttempt ?? 0) + 1;
                await this.transition(
                  id,
                  {
                    status: 'retrying',
                    health: 'crashed',
                    reason: 'transient harness failure',
                    exitCode: pane.exitCode,
                    retryAttempt: attempt,
                  },
                  'retry.scheduled',
                  { attempt, delaySeconds: 2 ** attempt },
                );
                this.scheduleTransientRetry(id, attempt);
              } else {
                const reason = /no conversation found|could not resume/i.test(lower)
                  ? 'persisted conversation could not be resumed'
                  : /invalid api key|unauthorized|sign in|log in/i.test(lower)
                    ? 'harness authentication failed'
                    : `interactive ${view.config.harness} exited ${pane.exitCode ?? 'unknown'}`;
                await this.transition(
                  id,
                  {
                    status: 'failed',
                    health: 'crashed',
                    reason,
                    exitCode: pane.exitCode,
                    finishedAt: now(),
                    promptReady: false,
                  },
                  'session.crashed',
                );
              }
            }
            return;
          }

          const nextPaneHash = Bun.hash(pane.pane).toString(16);
          if (nextPaneHash !== paneHash) {
            paneHash = nextPaneHash;
            await this.tmux.snapshot(view.config);
            await writeFile(turnLog(this.paths, id, view.config.turn), pane.pane, { mode: 0o600 });
            const contextPercent = contextPercentUsed(pane.visiblePane);
            const contextTurnedHigh =
              contextPercent !== undefined && contextPercent >= 85 && (view.state.contextPercent ?? 0) < 85;
            // The harness's own spinner line ("✻ Lollygagging… (34s · 2.1k
            // tokens)") — the chat UI's received-and-thinking indicator.
            const activity = paneActivityLine(pane.visiblePane);
            await this.transition(
              id,
              {
                lastActivityAt: now(),
                lastPaneAt: now(),
                promptReady: pane.promptReady,
                activity,
                ...(contextPercent !== undefined ? { contextPercent } : {}),
                health: waitingStatuses.includes(view.state.status)
                  ? 'waiting'
                  : view.state.status === 'thinking'
                    ? 'thinking'
                    : 'healthy',
              },
              'terminal.frame',
              {
                hash: paneHash,
                promptReady: pane.promptReady,
                ...(activity !== undefined ? { activity } : {}),
                ...(contextPercent !== undefined ? { contextPercent } : {}),
              },
            );
            // Sessions past ~85% context wedge silently (prompts queue, never
            // process). Surface it once so the lead can rotate the teammate.
            if (contextTurnedHigh) await this.emit(id, 'context.high', { contextPercent }, 'watcher');
            view = await this.get(id);
          }

          const diff = await this.gitFingerprint(view.config.cwd);
          const nextDiffHash = Bun.hash(diff).toString(16);
          if (nextDiffHash !== diffHash) {
            diffHash = nextDiffHash;
            await atomicJson(path.join(view.directory, 'checks', 'diff.json'), {
              at: now(),
              hash: diffHash,
              summary: diff,
            });
            await this.transition(
              id,
              {
                lastActivityAt: now(),
                lastDiffAt: now(),
                health: waitingStatuses.includes(view.state.status)
                  ? 'waiting'
                  : view.state.status === 'thinking'
                    ? 'thinking'
                    : 'healthy',
              },
              'workspace.changed',
              { hash: diffHash },
            );
            view = await this.get(id);
          }

          // F5: deliver queued busy-time sends at the turn boundary, before
          // idle handling can park the session in awaiting_user or nudge it.
          if (
            pane.promptReady &&
            !protectedStatuses.includes(view.state.status) &&
            view.state.status !== 'awaiting_question' &&
            view.state.status !== 'rate_limited' &&
            (['waiting', 'awaiting_user', 'interrupted'].includes(view.state.status) || view.state.promptReady === true)
          ) {
            const delivered = await this.deliverPendingSends(id, view.directory).catch(error =>
              this.emit(id, 'control.send_dequeue_failed', { message: String(error) }, 'daemon').then(() => false),
            );
            if (delivered) {
              promptStable = 0;
              view = await this.get(id);
            }
          }

          if (pane.promptReady) promptStable++;
          else promptStable = 0;
          const transcriptBusy =
            view.state.status === 'thinking' ||
            view.state.status === 'tool_running' ||
            (view.state.openTools?.length ?? 0) > 0 ||
            view.state.turnCompleted !== true;
          // The pane prompt is the ground truth for "the turn ended". Codex
          // rollouts frequently omit task_complete and a dropped end-of-turn
          // record must not wedge idle detection forever, so a long-stable
          // ready prompt overrides stale transcript-derived busy state.
          const paneIdleOverride = promptStable >= Math.max(4, Math.ceil(20 / view.config.intervalSeconds));
          const turnBusy = view.state.pendingQuestion !== undefined || (transcriptBusy && !paneIdleOverride);
          if (
            promptStable >= 2 &&
            !turnBusy &&
            !waitingStatuses.includes(view.state.status) &&
            !protectedStatuses.includes(view.state.status) &&
            view.state.status !== 'interrupted'
          ) {
            if (view.config.mode === 'interactive') {
              await this.transition(id, { status: 'awaiting_user', health: 'idle', promptReady: true }, 'turn.waiting');
            } else if (
              view.config.mode === 'auto' &&
              !this.autoContinued.has(id) &&
              !existsSync(markerFile(this.paths, id, 'done'))
            ) {
              this.autoContinued.add(id);
              await this.emit(
                id,
                'session.protocol_warning',
                { reason: 'automode returned to input without a done marker' },
                'watcher',
              );
              await this.tmux.send(
                view.config,
                'Automode: do not wait for user input. Make the best reasonable decision, continue the task, and write the required done marker when complete.',
              );
              await this.transition(
                id,
                {
                  status: 'running',
                  health: 'healthy',
                  promptReady: false,
                  turnCompleted: false,
                },
                'turn.auto_continued',
              );
              promptStable = 0;
            }
          }

          if (Date.now() - lastQuotaCheck > 60_000) {
            lastQuotaCheck = Date.now();
            await this.updateQuota(id, view.config, signal);
            view = await this.get(id);
          }

          const transcriptTime = view.state.lastTranscriptAt ? Date.parse(view.state.lastTranscriptAt) : 0;
          const paneTime = view.state.lastPaneAt ? Date.parse(view.state.lastPaneAt) : 0;
          lastDurableActivity = Math.max(lastDurableActivity, transcriptTime);
          const paneGraceMs = Math.min(60_000, Math.max(5_000, view.config.stallSeconds * 100));
          const effectiveActivity = Math.max(
            lastDurableActivity,
            Math.min(paneTime, lastDurableActivity + paneGraceMs),
          );
          const waiting = waitingStatuses.includes(view.state.status) || view.state.status === 'interrupted';
          const startedAt = view.state.startedAt ? Date.parse(view.state.startedAt) : Date.parse(view.config.createdAt);
          if (!waiting && Date.now() - startedAt >= view.config.timeoutSeconds * 1000) {
            await this.tmux.snapshot(view.config, true);
            await atomicJson(path.join(view.directory, 'kill.json'), {
              at: now(),
              reason: 'timeout',
              lastSnapshot: 'last-snapshot.txt',
            });
            await this.stopTmuxWithEvidence(view.config, 'timeout');
            await this.transition(
              id,
              {
                status: 'stopped',
                health: 'idle',
                reason: `exceeded timeout of ${view.config.timeoutSeconds}s`,
                finishedAt: now(),
                promptReady: false,
              },
              'session.timeout',
            );
            return;
          }
          // A healthy turn writes its first transcript record within seconds of
          // the prompt landing. Zero transcript bytes minutes into a turn means
          // the prompt was lost or the TUI booted logged-out — both previously
          // burned the full stall timer while `status` said "running". Nudge
          // once, then fail fast with a distinct reason.
          const turnStartedAt = view.state.startedAt
            ? Date.parse(view.state.startedAt)
            : Date.parse(view.config.createdAt);
          const transcriptProgress =
            view.state.lastTranscriptAt !== undefined && Date.parse(view.state.lastTranscriptAt) >= turnStartedAt;
          // promptStable gates this: a busy pane (e.g. a working Codex whose
          // rollout file hasn't been correlated yet) must never be treated as
          // a lost prompt; only an idle input box with zero transcript is.
          if (paneShowsActiveWork(pane.visiblePane)) activeWorkTurn = view.config.turn;
          if (
            !waiting &&
            !transcriptProgress &&
            promptStable >= 2 &&
            activeWorkTurn !== view.config.turn &&
            !protectedStatuses.includes(view.state.status)
          ) {
            const sinceTurnStart = Date.now() - turnStartedAt;
            if (sinceTurnStart >= 120_000 && reinjectedTurn !== view.config.turn) {
              reinjectedTurn = view.config.turn;
              await this.emit(
                id,
                'turn.reinjected',
                { reason: 'no transcript activity 120s after turn start; re-sending the prompt' },
                'watcher',
              );
              await this.tmux
                .send(view.config, this.promptInstruction(id, view.config.turn))
                .catch(error =>
                  this.emit(id, 'turn.reinject_failed', { message: String(error) }, 'watcher').catch(() => undefined),
                );
            } else if (sinceTurnStart >= 360_000) {
              const pane = await this.tmux.snapshot(view.config, true);
              const loginWalled = /not logged in|please run \/login|invalid api key|unauthorized/i.test(pane);
              await this.stopTmuxWithEvidence(view.config, 'no transcript activity after turn start');
              await this.transition(
                id,
                {
                  status: 'failed',
                  health: 'crashed',
                  reason: loginWalled
                    ? 'harness authentication failed: TUI is login-walled and produced no transcript activity'
                    : 'turn never started: no transcript activity within 360s of the prompt (lost prompt or dead harness)',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.turn_never_started',
              );
              return;
            }
          }
          if (!waiting && Date.now() - effectiveActivity >= view.config.stallSeconds * 1000) {
            await this.tmux.snapshot(view.config, true);
            await atomicJson(path.join(view.directory, 'kill.json'), {
              at: now(),
              reason: 'stalled',
              evidence: { paneHash, diffHash, lastTranscriptAt: view.state.lastTranscriptAt },
              lastSnapshot: 'last-snapshot.txt',
            });
            await this.stopTmuxWithEvidence(view.config, 'stalled');
            await this.transition(
              id,
              {
                status: 'stalled',
                health: 'stalled',
                reason: `no durable transcript progress for ${view.config.stallSeconds}s`,
                finishedAt: now(),
                promptReady: false,
              },
              'session.stalled',
            );
            return;
          }
          await atomicJson(path.join(view.directory, 'checks', 'heartbeat.json'), {
            at: now(),
            tmuxAlive: true,
            promptReady: pane.promptReady,
            paneHash,
            diffHash,
            transcriptOffset: view.state.transcriptOffset ?? 0,
            durableIdleSeconds: Math.floor((Date.now() - lastDurableActivity) / 1000),
            effectiveIdleSeconds: Math.floor((Date.now() - effectiveActivity) / 1000),
          });
        } catch (error) {
          await this.emit(
            id,
            'monitor.error',
            { message: error instanceof Error ? error.message : String(error) },
            'watcher',
          ).catch(() => undefined);
        }
        await interruptibleSleep(sleepSeconds * 1000, signal);
      }
    } finally {
      const monitor = this.monitors.get(id);
      if (monitor?.abort.signal === signal) {
        this.monitors.delete(id);
        await monitor.transcript?.stop();
      }
    }
  }

  private async handleClaudeEvents(
    id: string,
    events: readonly ClaudeNormalizedEvent[],
    offset: number,
  ): Promise<void> {
    await this.serialized(id, async () => {
      const view = await this.get(id);
      let autoQuestion = false;
      for (const event of events) {
        await appendFile(path.join(view.directory, 'chat.jsonl'), `${JSON.stringify(event)}\n`);
        await this.emit(id, event.type, event.data, 'claude', view.config.turn);
        if (event.type === 'interaction.question') {
          await appendFile(
            path.join(view.directory, 'channel', 'outbox.jsonl'),
            `${JSON.stringify({
              at: now(),
              type: 'structured_question',
              toolUseId: event.data.toolUseId,
              questions: event.data.questions,
            })}\n`,
          );
          if (view.config.mode === 'auto') {
            autoQuestion = true;
            await this.emit(
              id,
              'session.protocol_warning',
              { reason: 'AskUserQuestion attempted in automode', toolUseId: event.data.toolUseId },
              'watcher',
            );
          }
        }
      }
      await this.store.updateState<SessionState>(id, current => {
        const madeProgress = events.some(event => event.type !== 'chat.user' && event.type !== 'interaction.question');
        const openTools = new Set(current.openTools ?? []);
        let status: SessionStatus = current.status;
        let pendingQuestion = current.pendingQuestion;
        let turnCompleted = current.turnCompleted ?? false;
        let lastToolStartedAt = current.lastToolStartedAt;
        for (const event of events) {
          if (event.type === 'tool.use') {
            openTools.add(event.data.toolUseId);
            status = 'tool_running';
            turnCompleted = false;
            lastToolStartedAt = now();
          } else if (event.type === 'tool.result') {
            openTools.delete(event.data.toolUseId);
            if (pendingQuestion?.toolUseId === event.data.toolUseId) pendingQuestion = undefined;
            status = openTools.size ? 'tool_running' : 'running';
          } else if (event.type === 'interaction.question') {
            pendingQuestion = { toolUseId: event.data.toolUseId, questions: event.data.questions };
            status = view.config.mode === 'interactive' ? 'awaiting_question' : 'running';
            turnCompleted = false;
          } else if (event.type === 'chat.assistant.thinking') {
            status = 'thinking';
            turnCompleted = false;
          } else if (event.type === 'turn.completed') {
            // A completed turn cannot leave tools open; unmatched tool ids
            // (interrupted tools, harness id mismatches) must not wedge the
            // idle detector permanently in tool_running.
            openTools.clear();
            pendingQuestion = undefined;
            turnCompleted = true;
            status = 'running';
          } else if (event.type.startsWith('chat.')) {
            if (event.type === 'chat.user') turnCompleted = false;
            status = 'running';
          }
        }
        const terminal = protectedStatuses.includes(current.status);
        return {
          ...current,
          status: terminal ? current.status : status,
          health: terminal
            ? current.health
            : status === 'awaiting_question'
              ? 'waiting'
              : status === 'thinking'
                ? 'thinking'
                : 'healthy',
          openTools: [...openTools],
          pendingQuestion,
          turnCompleted,
          lastToolStartedAt,
          transcriptOffset: Math.max(current.transcriptOffset ?? 0, offset),
          retryAttempt: madeProgress ? 0 : current.retryAttempt,
          lastTranscriptAt: now(),
          lastActivityAt: now(),
          promptReady: terminal ? current.promptReady : false,
        };
      });
      if (autoQuestion) {
        await this.tmux.snapshot(view.config, true);
        await this.stopManagedSession(view.config, 'automode structured-question protocol violation');
        await this.transition(
          id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'automode teammate attempted a structured user question',
            finishedAt: now(),
            promptReady: false,
          },
          'session.protocol_violation',
        );
      }
    });
  }

  private async handleCodexEvents(id: string, events: readonly CodexNormalizedEvent[], offset: number): Promise<void> {
    await this.serialized(id, async () => {
      const view = await this.get(id);
      let autoQuestion = false;
      for (const event of events) {
        await appendFile(path.join(view.directory, 'chat.jsonl'), `${JSON.stringify(event)}\n`);
        await this.emit(id, event.type, event.data, 'codex', view.config.turn);
        if (event.type === 'interaction.question') {
          await appendFile(
            path.join(view.directory, 'channel', 'outbox.jsonl'),
            `${JSON.stringify({
              at: now(),
              type: 'structured_question',
              toolUseId: event.data.toolUseId,
              questions: event.data.questions,
            })}\n`,
          );
          if (view.config.mode === 'auto') {
            autoQuestion = true;
            await this.emit(
              id,
              'session.protocol_warning',
              { reason: 'request_user_input attempted in automode', toolUseId: event.data.toolUseId },
              'watcher',
            );
          }
        }
      }
      await this.store.updateState<SessionState>(id, current => {
        const madeProgress = events.some(event => event.type !== 'chat.user' && event.type !== 'interaction.question');
        const openTools = new Set(current.openTools ?? []);
        let status: SessionStatus = current.status;
        let pendingQuestion = current.pendingQuestion;
        let turnCompleted = current.turnCompleted ?? false;
        let lastToolStartedAt = current.lastToolStartedAt;
        for (const event of events) {
          if (event.type === 'turn.started') {
            turnCompleted = false;
            status = 'running';
          } else if (event.type === 'turn.completed' || event.type === 'turn.aborted') {
            // See the Claude handler: a finished turn must clear open tools so
            // unmatched tool ids cannot wedge the idle detector.
            openTools.clear();
            pendingQuestion = undefined;
            turnCompleted = true;
            status = 'running';
          } else if (event.type === 'tool.use') {
            openTools.add(event.data.toolUseId);
            status = 'tool_running';
            turnCompleted = false;
            lastToolStartedAt = now();
          } else if (event.type === 'tool.result') {
            openTools.delete(event.data.toolUseId);
            if (pendingQuestion?.toolUseId === event.data.toolUseId) pendingQuestion = undefined;
            status = openTools.size ? 'tool_running' : 'running';
          } else if (event.type === 'chat.assistant.reasoning') {
            status = 'thinking';
            turnCompleted = false;
          } else if (event.type === 'interaction.question') {
            pendingQuestion = { toolUseId: event.data.toolUseId, questions: event.data.questions };
            status = view.config.mode === 'interactive' ? 'awaiting_question' : 'running';
            turnCompleted = false;
          } else if (event.type.startsWith('chat.')) {
            if (event.type === 'chat.user') turnCompleted = false;
            status = 'running';
          }
        }
        const terminal = protectedStatuses.includes(current.status);
        return {
          ...current,
          status: terminal ? current.status : status,
          health: terminal
            ? current.health
            : status === 'awaiting_question'
              ? 'waiting'
              : status === 'thinking'
                ? 'thinking'
                : 'healthy',
          openTools: [...openTools],
          pendingQuestion,
          turnCompleted,
          lastToolStartedAt,
          transcriptOffset: Math.max(current.transcriptOffset ?? 0, offset),
          retryAttempt: madeProgress ? 0 : current.retryAttempt,
          lastTranscriptAt: now(),
          lastActivityAt: now(),
          promptReady: terminal ? current.promptReady : false,
        };
      });
      if (autoQuestion) {
        await this.tmux.snapshot(view.config, true);
        await this.stopManagedSession(view.config, 'automode structured-question protocol violation');
        await this.transition(
          id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'automode teammate attempted a structured user question',
            finishedAt: now(),
            promptReady: false,
          },
          'session.protocol_violation',
        );
      }
    });
  }

  private async transition(
    id: string,
    patch: Partial<SessionState>,
    eventType: string,
    eventData: Record<string, unknown> = {},
  ): Promise<void> {
    let suppressed = false;
    const state = await this.store.updateState<SessionState>(id, current => {
      const preserveTerminal = terminalStatuses.includes(current.status) && patch.status !== 'starting';
      const preserveKillFailure =
        current.status === 'kill_failed' && !(patch.status !== undefined && terminalStatuses.includes(patch.status));
      const next = { ...current, ...patch };
      if (!preserveTerminal && !preserveKillFailure) return next;
      suppressed = true;
      return current;
    });
    if (suppressed) return;
    await this.emit(id, eventType, { status: state.status, health: state.health, ...eventData }, 'daemon', state.turn);
  }

  private async emit(
    id: string,
    type: string,
    payload: unknown,
    source: KTeamEvent['source'],
    turn?: number,
    allowDeleting = false,
  ): Promise<KTeamEvent> {
    if (this.closed) throw new Error('kteam daemon is shutting down');
    if (this.deleting.has(id) && !allowDeleting) throw new Error('session deletion is in progress');
    let resolveEvent!: (event: KTeamEvent) => void;
    let rejectEvent!: (error: unknown) => void;
    const result = new Promise<KTeamEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    const operation = this.globalEventQueue
      .catch(() => undefined)
      .then(async () => {
        let resolvedTurn = turn;
        if (resolvedTurn === undefined)
          resolvedTurn = (await this.store.readState<SessionState>(id).catch(() => ({ turn: 0 }) as SessionState)).turn;
        const globalSequence = ++this.globalSequence;
        await atomicJson(path.join(this.paths.daemon, 'global-sequence.json'), { sequence: globalSequence, at: now() });
        const stored = await this.store.append(id, type, {
          source,
          turn: resolvedTurn,
          payload,
          globalSequence,
        } as unknown as JsonValue);
        const event = this.fromStored(stored);
        for (const listener of this.listeners) listener(event);
        resolveEvent(event);
      })
      .catch(rejectEvent);
    this.globalEventQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private fromStored(event: SessionEvent): KTeamEvent {
    const envelope = event.data as unknown as StoredEnvelope;
    return {
      sequence: envelope.globalSequence ?? event.sequence,
      time: event.time,
      sessionId: event.sessionId,
      turn: envelope.turn ?? 0,
      type: event.type,
      source: envelope.source ?? 'daemon',
      data: envelope.payload,
    };
  }

  private async sendUnlocked(view: SessionView, message: string): Promise<SessionView> {
    const turn = view.config.turn + 1;
    await writeFile(turnPrompt(this.paths, view.config.id, turn), `${message.trim()}\n`, { mode: 0o600 });
    const config = await this.store.updateConfig<SessionConfig>(view.config.id, current => ({
      ...current,
      turn,
      updatedAt: now(),
    }));
    await this.tmux.send(config, this.promptInstruction(config.id, turn));
    await this.transition(
      config.id,
      {
        status: 'running',
        turn,
        promptReady: false,
        startedAt: now(),
        lastActivityAt: now(),
        turnCompleted: false,
      },
      'turn.started',
    );
    return await this.get(config.id);
  }

  private async updateQuota(id: string, config: SessionConfig, signal: AbortSignal): Promise<void> {
    try {
      const quota = await this.fetchQuota(config, signal);
      if (!quota || signal.aborted) return;
      let newlyExhausted = false;
      let recoveredWithoutRetry = false;
      let readyToResume = false;
      let inactive = false;
      const state = await this.store.updateState<SessionState>(id, current => {
        if (protectedStatuses.includes(current.status)) {
          inactive = true;
          return current;
        }
        newlyExhausted = quota.atLimit === true && current.status !== 'rate_limited';
        recoveredWithoutRetry =
          quota.atLimit === false && current.status === 'rate_limited' && config.retry?.waitForQuotaReset === false;
        readyToResume =
          quota.atLimit === false && current.status === 'rate_limited' && config.retry?.waitForQuotaReset !== false;
        return {
          ...current,
          quota,
          status: quota.atLimit
            ? 'rate_limited'
            : recoveredWithoutRetry
              ? config.mode === 'interactive' && current.promptReady
                ? 'awaiting_user'
                : 'running'
              : current.status,
          health: quota.atLimit
            ? 'rate_limited'
            : recoveredWithoutRetry
              ? config.mode === 'interactive' && current.promptReady
                ? 'idle'
                : 'healthy'
              : current.health,
        };
      });
      if (inactive || signal.aborted) return;
      await atomicJson(path.join(sessionDir(this.paths, id), 'checks', 'quota.json'), { at: now(), ...quota });
      if (signal.aborted) return;
      if (newlyExhausted) await this.emit(id, 'quota.exhausted', quota, 'watcher');
      if (quota.atLimit && config.retry?.waitForQuotaReset !== false) this.scheduleQuotaWaiter(id);
      if (readyToResume) this.scheduleQuotaWaiter(id);
      if (recoveredWithoutRetry) await this.emit(id, 'quota.available', { ...quota, status: state.status }, 'watcher');
    } catch {}
  }

  private async fetchQuota(config: SessionConfig, signal?: AbortSignal): Promise<SessionState['quota'] | undefined> {
    try {
      const timeout = AbortSignal.timeout(3_000);
      const response = await fetch(this.options.quotaUrl, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as {
        accounts?: Array<{
          binary?: string;
          atLimit?: boolean;
          authOk?: boolean;
          fiveHourPercent?: number;
          weeklyPercent?: number;
          fiveHourResetAt?: number;
          weeklyResetAt?: number;
        }>;
      };
      const account = payload.accounts?.find(item => item.binary === config.binary);
      if (!account) return undefined;
      const resets = [account.fiveHourResetAt, account.weeklyResetAt].filter(
        (value): value is number => typeof value === 'number',
      );
      return {
        atLimit: account.atLimit,
        authOk: account.authOk,
        fiveHourPercent: account.fiveHourPercent,
        weeklyPercent: account.weeklyPercent,
        ...(resets.length ? { resetAt: Math.min(...resets) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async waitForQuotaAndResume(id: string, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      if (this.deleting.has(id)) return;
      const view = await this.get(id).catch(() => undefined);
      if (!view || view.state.status !== 'rate_limited') return;
      const quota = await this.fetchQuota(view.config, signal);
      if (signal.aborted || this.deleting.has(id)) return;
      if (quota && quota.atLimit === false) {
        const latest = await this.get(id).catch(() => undefined);
        if (!latest || latest.state.status !== 'rate_limited' || signal.aborted) return;
        await this.emit(id, 'quota.available', quota, 'watcher');
        await this.resume(id, 'The account quota is available again. Continue from the persisted conversation.', {
          status: 'rate_limited',
        }).catch(async error => {
          if (!(error instanceof ResumeCancelled))
            await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher');
        });
        return;
      }
      const delay = quota?.resetAt ? Math.max(5_000, Math.min(60_000, quota.resetAt - Date.now())) : 60_000;
      await interruptibleSleep(delay, signal);
    }
  }

  private scheduleQuotaWaiter(id: string): void {
    if (this.quotaWaiters.has(id) || this.closed || this.deleting.has(id)) return;
    const waiter: QuotaWaiter = { abort: new AbortController(), promise: Promise.resolve() };
    waiter.promise = this.waitForQuotaAndResume(id, waiter.abort.signal)
      .catch(async error => {
        if (!waiter.abort.signal.aborted && !this.closed && !this.deleting.has(id)) {
          await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher').catch(() => undefined);
        }
      })
      .finally(() => {
        if (this.quotaWaiters.get(id) === waiter) this.quotaWaiters.delete(id);
      });
    this.quotaWaiters.set(id, waiter);
  }

  private async cancelQuotaWaiter(id: string, drain = false): Promise<void> {
    const waiter = this.quotaWaiters.get(id);
    if (!waiter) return;
    waiter.abort.abort();
    if (drain) await waiter.promise;
  }

  private scheduleTransientRetry(id: string, attempt: number): void {
    if (this.closed || this.deleting.has(id)) return;
    this.cancelRetry(id);
    if (this.closed || this.deleting.has(id)) return;
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(id);
        if (this.closed || this.deleting.has(id)) return;
        void this.resume(id, 'The transient failure has cleared. Continue from the persisted conversation.', {
          status: 'retrying',
          retryAttempt: attempt,
        }).catch(async error => {
          if (!(error instanceof ResumeCancelled) && !this.closed && !this.deleting.has(id)) {
            await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher').catch(() => undefined);
          }
        });
      },
      2 ** attempt * 1000,
    );
    this.retryTimers.set(id, timer);
  }

  private cancelRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  private async stopManagedSession(config: SessionConfig, reason: string): Promise<void> {
    await this.stopMonitor(config.id);
    try {
      await this.stopTmuxWithEvidence(config, reason);
    } catch (error) {
      const paneState = await this.tmux.state(config.tmuxSession);
      if (paneState.alive && !paneState.dead && !this.closed && !this.deleting.has(config.id)) {
        await this.startMonitor(config.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async stopTmuxWithEvidence(config: SessionConfig, reason: string): Promise<void> {
    try {
      await this.tmux.stop(config.tmuxSession);
    } catch (error) {
      await this.tmux.snapshot(config, true).catch(() => '');
      const message = error instanceof Error ? error.message : String(error);
      await atomicJson(path.join(sessionDir(this.paths, config.id), 'kill.json'), {
        at: now(),
        reason,
        killFailed: true,
        error: message,
        tmuxSession: config.tmuxSession,
        lastSnapshot: 'last-snapshot.txt',
      });
      const state = await this.store.updateState<SessionState>(config.id, current => ({
        ...current,
        status: 'kill_failed',
        health: 'crashed',
        reason: `${reason}: ${message}`,
        finishedAt: undefined,
        promptReady: false,
      }));
      await this.emit(
        config.id,
        'session.kill_failed',
        {
          status: state.status,
          health: state.health,
          reason,
          error: message,
        },
        'daemon',
        state.turn,
        true,
      ).catch(() => undefined);
      throw error;
    }
  }

  private async gitFingerprint(cwd: string): Promise<string> {
    if ((await run(['git', '-C', cwd, 'rev-parse', '--is-inside-work-tree'])).code !== 0) return '';
    const [statusResult, statResult, worktreeDiff, indexDiff] = await Promise.all([
      run(['git', '-C', cwd, 'status', '--short']),
      run(['git', '-C', cwd, 'diff', '--stat']),
      run(['git', '-C', cwd, 'diff', '--no-ext-diff', '--binary']),
      run(['git', '-C', cwd, 'diff', '--cached', '--no-ext-diff', '--binary']),
    ]);
    const contentHash = Bun.hash(`${worktreeDiff.stdout}\0${indexDiff.stdout}`).toString(16);
    return `${statusResult.stdout}\n${statResult.stdout}\ncontent ${contentHash}`.trim();
  }

  private systemPrompt(config: SessionConfig): string {
    const directory = sessionDir(this.paths, config.id);
    const interaction =
      config.mode === 'auto'
        ? 'You are in AUTOMODE. Never ask the user a question and never wait for input. Make the best reasonable decision, continue autonomously, and document assumptions.'
        : 'You are in INTERACTIVE MODE. You may use AskUserQuestion or finish a conversational turn and wait. The daemon will relay the user response through this same interactive tmux session.';
    const helpRule =
      config.mode === 'interactive'
        ? '7. If blocked without a structured question tool, run: kteam signal help "your precise question"'
        : '7. Never signal help or wait for a reply in automode.';
    return `# kteam teammate contract\n\n${interaction}\n\nYour durable coordination directory is ${directory}.\n\nRules:\n1. Work only on the assigned task and respect repository instructions.\n2. Do not manage tmux or the daemon.\n3. Keep useful session-only artifacts under the coordination directory.\n4. When the assigned task is genuinely complete, write ${directory}/summary.md and run: kteam signal done\n5. Never claim completion without the done marker.\n6. Preserve unrelated user changes.\n${helpRule}\n`;
  }

  private promptInstruction(id: string, turn: number): string {
    return `Read the file ${turnPrompt(this.paths, id, turn)} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
  }

  private attachmentView(stored: {
    manifest: { id: string; filename: string; mime: string; size: number; hash: string; time: string };
    path: string;
  }): AttachmentView {
    return {
      id: stored.manifest.id,
      filename: stored.manifest.filename,
      mime: stored.manifest.mime,
      size: stored.manifest.size,
      sha256: stored.manifest.hash,
      path: stored.path,
      createdAt: stored.manifest.time,
    };
  }

  private number(value: number | undefined, fallback: number, minimum: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < minimum) throw new Error(`${name} must be at least ${minimum}`);
    return resolved;
  }

  private async claimedCodexSessionIds(exceptId: string): Promise<string[]> {
    return (await this.list()).flatMap(view =>
      view.config.id !== exceptId && view.config.harness === 'codex' && view.config.harnessSessionId
        ? [view.config.harnessSessionId]
        : [],
    );
  }

  /** Run a TUI bootstrap (launch + first inject) exclusively — see bootstrapChain. */
  private async serializedBootstrap<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.bootstrapChain.then(operation, operation);
    this.bootstrapChain = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.deleting.has(id)) throw new Error('session deletion is in progress');
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    }
  }

  private async initializeGlobalSequence(): Promise<void> {
    const persisted = await readFile(path.join(this.paths.daemon, 'global-sequence.json'), 'utf8')
      .then(value => JSON.parse(value) as { sequence?: number })
      .catch(() => ({}) as { sequence?: number });
    let maximum = Number.isSafeInteger(persisted.sequence) ? persisted.sequence! : 0;
    for (const session of this.store.listSessions()) {
      for (const event of this.store.replay(session.id, { afterSequence: 0, limit: 100_000 })) {
        const envelope = event.data as unknown as StoredEnvelope;
        if (typeof envelope.globalSequence === 'number') maximum = Math.max(maximum, envelope.globalSequence);
      }
    }
    this.globalSequence = maximum;
  }
}
