import * as fs from 'fs/promises';
import * as path from 'path';
import type { StallConfig } from '../types';

// ============================================================================
// Implementer stall detection (real incident, 2026-07-05: an implementer sat
// frozen on Claude Code's "Dangerous rm … Do you want to proceed?" confirm
// dialog — which fires even with bypass-permissions — for 2.5h while `kloop
// status` showed "running — loop 2 impl", because events.jsonl only records
// phase transitions and a hung agent emits no event).
//
// The monitor runs BESIDE the implementer (started/stopped by the loop runner
// around runImplementer) and samples activity every checkIntervalSec:
//   1. mtimes of the implementer dir (log, prompt.md, …) and evidence logs;
//   2. a hash of the tmux pane tail — the pane changes while the agent
//      streams/thinks even when the JSONL log is quiet for 10+ minutes
//      (observed: 9+ min of "thinking" with zero log writes), so long quiet
//      generation does NOT false-alarm.
//
// Past idleThresholdSec with no signal, it captures the pane and classifies:
//   confirm-dialog — known interactive blockers (Do you want to proceed? /
//                    ❯ 1. Yes / Esc to cancel / plan-mode & permission prompts)
//   idle           — no known dialog, but nothing is moving (incl. a bare ❯
//                    prompt with no change)
// and emits implementer_stall / implementer_stall_end events — `kloop wait`
// parks on events.jsonl, so a stall MUST produce an event; silence is
// indistinguishable from progress. With autoAnswer=safe it may answer a
// confirm dialog by sending "1" (logged as implementer_stall_autoanswered,
// with the dialog text, so the run record shows the intervention).
//
// Non-goals: never kills/restarts the implementer (max-iter + impl-retry own
// lifecycle); no TUI parsing beyond the known prompt patterns.
// ============================================================================

type StallReason = 'confirm-dialog' | 'idle';

/** Known interactive-blocker shapes (Claude Code TUI). Matched on the pane tail. */
const CONFIRM_DIALOG_PATTERNS: RegExp[] = [
  /do you want to proceed\?/i,
  /❯\s*1\.\s*yes/i,
  /esc to cancel/i,
  /would you like to proceed\?/i,
  // Plan-mode / permission prompts
  /ready to code\?/i,
  /do you want to make this edit/i,
  /grant permission/i,
];

/** How many pane lines participate in the activity hash / dialog match. */
const PANE_TAIL_LINES = 25;

/** Classify a captured pane: a known confirm dialog, or generic idleness. */
export function classifyPane(pane: string): StallReason {
  const tail = pane.trimEnd().split('\n').slice(-PANE_TAIL_LINES).join('\n');
  if (CONFIRM_DIALOG_PATTERNS.some(p => p.test(tail))) return 'confirm-dialog';
  return 'idle';
}

/** FNV-1a over the pane tail — cheap change detector, no crypto needed. */
export function paneHash(pane: string): string {
  const tail = pane.trimEnd().split('\n').slice(-PANE_TAIL_LINES).join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < tail.length; i++) {
    h ^= tail.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Max newest-mtime (ms) across a file and every file in the given dirs. 0 when nothing exists. */
async function newestMtimeMs(files: string[], dirs: string[]): Promise<number> {
  let newest = 0;
  for (const f of files) {
    try {
      const s = await fs.stat(f);
      newest = Math.max(newest, s.mtimeMs);
    } catch {
      /* absent — fine */
    }
  }
  for (const d of dirs) {
    try {
      for (const entry of await fs.readdir(d)) {
        try {
          const s = await fs.stat(path.join(d, entry));
          newest = Math.max(newest, s.mtimeMs);
        } catch {
          /* raced — fine */
        }
      }
    } catch {
      /* dir absent — fine */
    }
  }
  return newest;
}

interface StallMonitorParams {
  runId: string;
  loop: number;
  /** The implementer's tmux session (kloop-<runId>-<loop>-impl). */
  tmuxSession: string;
  /** Files/dirs whose mtimes count as activity (implementer dir + evidence dir). */
  activityFiles: string[];
  activityDirs: string[];
  config: StallConfig;
  /** Appends to events.jsonl — same writer the loop runner uses. */
  writeEvent: (event: Record<string, unknown>) => Promise<void>;
  /** Injectable for tests. Defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Watches one implementer run. `start()` arms a periodic check; `stop()`
 * disarms it (and closes an open stall as resolution=agent-exit). All errors
 * are swallowed — stall detection must never break a run.
 */
export class StallMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: number;
  private lastPaneHash = '';
  private lastMtime = 0;
  private stalledSince: number | null = null;
  private ticking = false;
  private tickPromise: Promise<void> | null = null;
  private disposed = false;
  private readonly spawn: typeof Bun.spawn;
  private readonly now: () => number;

  constructor(private readonly p: StallMonitorParams) {
    this.spawn = p.spawn ?? Bun.spawn.bind(Bun);
    this.now = p.now ?? Date.now;
    this.lastActivityAt = this.now();
  }

  start(): void {
    if (!this.p.config.enabled || this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      // Serialize ticks; a slow capture must not stack.
      if (this.ticking || this.disposed) return;
      this.ticking = true;
      this.tickPromise = this.tick()
        .catch(() => {
          /* never break the run */
        })
        .finally(() => {
          this.ticking = false;
          this.tickPromise = null;
        });
    }, this.p.config.checkIntervalSec * 1000);
    // Don't hold the process open if the implementer finishes.
    this.timer.unref?.();
  }

  /**
   * Stop watching. Awaits an in-flight tick first — otherwise a tick paused on
   * capture-pane could write implementer_stall AFTER the runner's
   * implementer_end, leaving status stalled through the review phase. If a
   * stall is open, close it as agent-exit (the implementer returned).
   */
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tickPromise) {
      await this.tickPromise;
    }
    if (this.stalledSince != null) {
      await this.emitStallEnd('agent-exit');
    }
  }

  /** One check — exposed for tests (drive it directly instead of waiting on the interval). */
  async tick(): Promise<void> {
    const now = this.now();

    // --- activity sampling -----------------------------------------------------
    const mtime = await newestMtimeMs(this.p.activityFiles, this.p.activityDirs);
    const pane = await this.capturePane();
    const hash = pane != null ? paneHash(pane) : this.lastPaneHash;

    const logActive = mtime > this.lastMtime;
    const paneActive = pane != null && hash !== this.lastPaneHash;
    if (mtime > this.lastMtime) this.lastMtime = mtime;
    if (pane != null) this.lastPaneHash = hash;

    if (logActive || paneActive) {
      this.lastActivityAt = now;
      if (this.stalledSince != null) {
        await this.emitStallEnd('activity');
      }
      return;
    }

    // --- idle past threshold? ----------------------------------------------------
    const idleMs = now - this.lastActivityAt;
    if (idleMs < this.p.config.idleThresholdSec * 1000) return;
    if (this.stalledSince != null) {
      // Already flagged — never re-fire while the stall is open. It clears via
      // activity resuming, auto-answer, or stop() (agent-exit). A failed
      // auto-answer re-detects after the stall clears and idles again.
      return;
    }

    // Capture (full pane for the record) and classify.
    const fullPane = (await this.capturePane(true)) ?? '';
    const reason = classifyPane(fullPane);
    const dialogText = extractDialogText(fullPane);
    this.stalledSince = now;
    await this.safeWrite({
      type: 'implementer_stall',
      timestamp: new Date(now).toISOString(),
      loop: this.p.loop,
      reason,
      idleMs,
      ...(dialogText ? { dialogText } : {}),
    });

    // --- optional auto-answer -----------------------------------------------------
    const mode = this.p.config.autoAnswer;
    if (mode === 'off') return;
    const isDialog = reason === 'confirm-dialog';
    const isGenericPrompt = reason === 'idle' && endsAtPrompt(fullPane);
    if (isDialog && (mode === 'safe' || mode === 'all')) {
      await this.sendKeys(['1'], true);
      await this.safeWrite({
        type: 'implementer_stall_autoanswered',
        timestamp: new Date(this.now()).toISOString(),
        loop: this.p.loop,
        answer: '1',
        dialogText: dialogText ?? fullPane.trimEnd().split('\n').slice(-PANE_TAIL_LINES).join('\n'),
      });
      await this.emitStallEnd('autoanswer');
      this.lastActivityAt = this.now();
    } else if (isGenericPrompt && mode === 'all') {
      await this.sendKeys(['Enter']);
      await this.safeWrite({
        type: 'implementer_stall_autoanswered',
        timestamp: new Date(this.now()).toISOString(),
        loop: this.p.loop,
        answer: 'Enter',
        dialogText: fullPane.trimEnd().split('\n').slice(-PANE_TAIL_LINES).join('\n'),
      });
      await this.emitStallEnd('autoanswer');
      this.lastActivityAt = this.now();
    }
  }

  private async emitStallEnd(resolution: 'activity' | 'autoanswer' | 'agent-exit'): Promise<void> {
    const since = this.stalledSince;
    this.stalledSince = null;
    await this.safeWrite({
      type: 'implementer_stall_end',
      timestamp: new Date(this.now()).toISOString(),
      loop: this.p.loop,
      resolution,
      stalledForMs: since != null ? this.now() - since : 0,
    });
  }

  private async safeWrite(event: Record<string, unknown>): Promise<void> {
    try {
      await this.p.writeEvent(event);
    } catch {
      /* never break the run */
    }
  }

  /** Capture the implementer pane (visible, or full scrollback). Null if the session is gone. */
  private async capturePane(full = false): Promise<string | null> {
    try {
      const cmd = full
        ? ['tmux', 'capture-pane', '-p', '-S', '-', '-t', this.p.tmuxSession]
        : ['tmux', 'capture-pane', '-p', '-t', this.p.tmuxSession];
      const proc = this.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
      if ((await proc.exited) !== 0) return null;
      return await new Response(proc.stdout).text();
    } catch {
      return null;
    }
  }

  private async sendKeys(keys: string[], literal = false): Promise<void> {
    try {
      const cmd = literal
        ? ['tmux', 'send-keys', '-t', this.p.tmuxSession, '-l', ...keys]
        : ['tmux', 'send-keys', '-t', this.p.tmuxSession, ...keys];
      const proc = this.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
      await proc.exited;
      // Literal text needs a submitting Enter.
      if (literal) {
        const enter = this.spawn(['tmux', 'send-keys', '-t', this.p.tmuxSession, 'Enter'], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        await enter.exited;
      }
    } catch {
      /* never break the run */
    }
  }
}

/** The dialog block: the last chunk of non-empty pane lines (max the tail window). */
export function extractDialogText(pane: string): string | undefined {
  const lines = pane.trimEnd().split('\n');
  const tail = lines.slice(-PANE_TAIL_LINES).filter(l => l.trim().length > 0);
  return tail.length ? tail.join('\n') : undefined;
}

/** Generic "waiting at a prompt": the last non-empty line ends with ❯ (or > box glyph). */
export function endsAtPrompt(pane: string): boolean {
  const lines = pane
    .trimEnd()
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? '';
  return /[❯>]\s*$/.test(last);
}
