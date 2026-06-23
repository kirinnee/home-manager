import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { TmuxService } from '../deps';
import * as commands from './commands';
import { getDirHash } from '../deps';

// ============================================================================
// TmuxService class (IO edge)
// ============================================================================

class TmuxServiceImpl implements TmuxService {
  private statusDir = path.join(os.tmpdir(), 'kloop', 'status');

  constructor(private spawn: typeof Bun.spawn = Bun.spawn.bind(Bun)) {}

  async isAvailable(): Promise<boolean> {
    try {
      const proc = this.spawn(['tmux', '-V'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async isSessionAlive(sessionName: string): Promise<boolean> {
    const cmd = commands.buildHasSessionCommand(sessionName);
    const proc = this.spawn(cmd, {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }

  async listSessions(): Promise<string[]> {
    const cmd = commands.buildListSessionsCommand();
    const proc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return []; // No server running
    }

    const output = await new Response(proc.stdout).text();
    return output
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.startsWith('kloop-') || s.startsWith('devloop-'));
  }

  async killSession(sessionName: string): Promise<boolean> {
    const cmd = commands.buildKillSessionCommand(sessionName);
    const proc = this.spawn(cmd, {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }

  async killAllSessions(): Promise<number> {
    const sessions = await this.listSessions();
    let killed = 0;

    for (const session of sessions) {
      if (await this.killSession(session)) {
        killed++;
      }
    }

    return killed;
  }

  async runInSession(params: {
    sessionName: string;
    command: string;
    cwd: string;
    timeoutMins: number;
  }): Promise<{ exitCode: number; durationMs: number; timedOut: boolean }> {
    await this.ensureStatusDir();

    const startTime = Date.now();
    const statusFile = this.getStatusFilePath(params.sessionName);

    // Clean up any stale status file
    try {
      await fs.unlink(statusFile);
    } catch {}

    // Write initial "running" marker
    await fs.writeFile(statusFile, 'RUNNING', { mode: 0o600 });

    // Wrap command with timeout
    const wrappedCommand = `${commands.buildTimeoutCommand(params.command, params.timeoutMins)}; echo $? > "${statusFile}"`;

    // Create tmux session
    const cmd = commands.buildNewSessionCommand({
      sessionName: params.sessionName,
      cwd: params.cwd,
      command: wrappedCommand,
    });

    // Create environment without CLAUDECODE to prevent nested sessions from inheriting it
    const { CLAUDECODE: _, ...envWithoutClaudeCode } = process.env;

    const createProc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: envWithoutClaudeCode,
    });

    const createExitCode = await createProc.exited;
    if (createExitCode !== 0) {
      const stderr = await new Response(createProc.stderr).text();
      throw new Error(`Failed to create tmux session: ${stderr.trim() || `exit code ${createExitCode}`}`);
    }

    // Poll for session completion
    const maxPollTime = (params.timeoutMins + 2) * 60 * 1000;
    const pollStart = Date.now();

    while (true) {
      const alive = await this.isSessionAlive(params.sessionName);
      if (!alive) break;

      if (Date.now() - pollStart > maxPollTime) {
        await this.killSession(params.sessionName);
        break;
      }

      await Bun.sleep(2000);
    }

    const durationMs = Date.now() - startTime;

    // Read exit code from status file
    let exitCode = 1;
    let timedOut = false;

    try {
      const statusContent = await fs.readFile(statusFile, 'utf-8');
      const trimmed = statusContent.trim();

      if (trimmed === 'RUNNING') {
        exitCode = 1;
        timedOut = true;
      } else {
        const parsed = parseInt(trimmed, 10);
        if (Number.isFinite(parsed)) {
          exitCode = parsed;
          timedOut = exitCode === 124; // timeout command's exit code
        }
      }
    } catch {}

    // Clean up status file
    try {
      await fs.unlink(statusFile);
    } catch {}

    return { exitCode, durationMs, timedOut };
  }

  async runInteractiveSession(params: {
    sessionName: string;
    binary: string;
    promptFile: string;
    sessionId: string;
    cwd: string;
    timeoutMins: number;
    sentinelFile: string;
    logFile: string;
  }): Promise<{ exitCode: number; durationMs: number; timedOut: boolean }> {
    const { sessionName, binary, promptFile, sessionId, cwd, timeoutMins, sentinelFile, logFile } = params;
    const startTime = Date.now();

    // Stale marker from a re-entered run must never be read as this attempt's completion.
    try {
      await fs.unlink(sentinelFile);
    } catch {}

    // A prior attempt may have left logFile as a SYMLINK to Claude's own session transcript
    // (see updateInteractiveLog). The pane-snapshot writes below use fs.writeFile, which
    // follows symlinks — so without removing it first we'd write pane scrollback THROUGH the
    // link and corrupt an unrelated Claude session JSONL. Remove any stale link/file now.
    await fs.rm(logFile, { force: true });

    // writeLogFile writes to a sibling temp then renames over logFile. If the controller was
    // killed (SIGKILL/crash) between write and rename on a prior attempt, that temp is orphaned
    // and never cleaned (the catch only removes it on rename FAILURE). Sweep stale temps now so
    // they don't accumulate in the agent dir across crashed/retried interactive runs.
    try {
      const dir = path.dirname(logFile);
      const base = `${path.basename(logFile)}.tmp.`;
      for (const entry of await fs.readdir(dir)) {
        if (entry.startsWith(base)) await fs.rm(path.join(dir, entry), { force: true });
      }
    } catch {}

    // Launch the TUI detached. Scrub CLAUDECODE like the print-mode launcher.
    const { CLAUDECODE: _, ...envWithoutClaudeCode } = process.env;
    const launchCmd = commands.buildInteractiveLaunchCommand({ sessionName, cwd, binary, sessionId });
    const createProc = this.spawn(launchCmd, { stdout: 'pipe', stderr: 'pipe', env: envWithoutClaudeCode });
    const createExitCode = await createProc.exited;
    if (createExitCode !== 0) {
      const stderr = await new Response(createProc.stderr).text();
      throw new Error(`Failed to create interactive tmux session: ${stderr.trim() || `exit code ${createExitCode}`}`);
    }

    // Everything after the launch can throw (capturePane/spawn failures, writeLogFile rename
    // errors). The interactive TUI never self-terminates (unlike print-mode's `timeout Nm`), so
    // an unwound throw would orphan the detached session forever, holding a real Claude session
    // and burning quota. Guard the whole body with try/finally: the finally is the backstop that
    // always kills the session; the graceful /exit stays in the try as the normal path.
    try {
      // Wait for the TUI to be ready to accept input (pane non-empty and stable). This also
      // snapshots the pane to the log file every tick, so a failed launch (auth prompt, bad
      // binary, crash before any input) is visible via `kloop view` instead of looking hung.
      await this.waitForPaneReady(sessionName, logFile, 45_000);

      // Inject the prompt. Pasting the full multiline prompt directly is fragile (the TUI's
      // bracketed-paste handling is unreliable across versions), so instead we type a single
      // unambiguous LINE that points the agent at the full prompt file already on disk — a
      // one-liner has no newline-submits-early hazard and send-keys delivery is reliable.
      const bootstrap = `Read the file ${promptFile} now, then carefully follow every instruction inside it exactly. That file is your complete task.`;
      const landed = await this.injectLine(sessionName, bootstrap, promptFile);

      // If the bootstrap line never landed, the pane is stuck on a blocking screen (login /
      // invalid api key / trust prompt) that waitForPaneReady gave up on — that screen does NOT
      // exit on its own, so the poll loop's death branch would never fire and we'd burn the
      // ENTIRE configured timeout (and trigger retries). Bail immediately with a crash exit so a
      // reviewer retries fast, and persist the blocking pane so `kloop view` shows what's wrong.
      if (!landed) {
        await this.snapshotPane(sessionName, logFile);
        return { exitCode: 1, durationMs: Date.now() - startTime, timedOut: false };
      }

      // Start the working-time clock only once input is actually delivered. The print-mode path
      // wraps just the agent command with `timeout Nm`, so it gets the full configured minutes;
      // measuring the deadline from startTime would silently dock the agent the up-to-45s
      // readiness wait + inject time. durationMs (for reporting) still uses startTime.
      const workStart = Date.now();

      // Poll: sentinel (done) | session death (crash) | timeout. Each tick updates the live
      // log. Preferred source is Claude's OWN session transcript (~/.claude*/projects/*/
      // <sessionId>.jsonl) — same stream-json shape `kloop view` already renders. Once found,
      // we COPY its bytes into the real `log` file each tick (Claude only appends, so the copy
      // is append-only too, keeping `view -f` byte-tailing valid). We deliberately do NOT
      // symlink: the web server's safeKloopPath() rejects any log whose realpath escapes the
      // kloop home, and the transcript lives outside it — a link would make every interactive
      // log invisible in the dashboard. Until the transcript appears (or if it never does, e.g.
      // a non-default config dir), fall back to a pane snapshot so there's always *something* live.
      const timeoutMs = timeoutMins * 60 * 1000;
      let exitCode = 1;
      let timedOut = false;
      let copyingSession = false;
      // Bytes of Claude's transcript already copied into logFile this run. Local (not instance)
      // state: parallel interactive sessions each have their own offset, so one session's tick
      // can't slice another's transcript against the wrong offset.
      let copyOffset = 0;
      while (true) {
        ({ copying: copyingSession, offset: copyOffset } = await this.updateInteractiveLog(
          sessionName,
          sessionId,
          logFile,
          copyingSession,
          copyOffset,
        ));
        if (await this.fileExists(sentinelFile)) {
          exitCode = 0;
          break;
        }
        if (!(await this.isSessionAlive(sessionName))) {
          // Exited before signalling done — re-check the marker to avoid a race, else crash.
          exitCode = (await this.fileExists(sentinelFile)) ? 0 : 1;
          break;
        }
        if (Date.now() - workStart > timeoutMs) {
          timedOut = true;
          exitCode = 124;
          break;
        }
        await Bun.sleep(2000);
      }

      // Persist the final frame. If we're copying the session transcript, do one last copy to
      // capture its final lines; otherwise snapshot the pane.
      if (copyingSession) await this.updateInteractiveLog(sessionName, sessionId, logFile, true, copyOffset);
      else await this.snapshotPane(sessionName, logFile);

      // Graceful /exit, then force-kill if it lingers.
      if (await this.isSessionAlive(sessionName)) {
        try {
          await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['Escape']));
          await Bun.sleep(300);
          await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['/exit'], true));
          await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['Enter']));
        } catch {}
        const graceStart = Date.now();
        while (Date.now() - graceStart < 5000) {
          if (!(await this.isSessionAlive(sessionName))) break;
          await Bun.sleep(500);
        }
      }

      return { exitCode, durationMs: Date.now() - startTime, timedOut };
    } finally {
      // Backstop: whatever happened above (normal return, !landed bail, or a thrown error),
      // never leave the detached session running — it would linger forever otherwise.
      if (await this.isSessionAlive(sessionName)) await this.killSession(sessionName);
    }
  }

  generateSessionName(params: {
    dirHash: string;
    runId: string;
    iteration: number;
    role: 'impl' | 'rev';
    reviewerIndex?: number;
  }): string {
    return commands.generateSessionName(params);
  }

  parseSessionName(sessionName: string): {
    dirHash: string;
    runId: string;
    iteration: number;
    role: 'impl' | 'rev';
    reviewerIndex?: number;
  } | null {
    return commands.parseSessionName(sessionName);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async ensureStatusDir(): Promise<void> {
    await fs.mkdir(this.statusDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Type a single line into the session and submit it. Confirms the line actually landed
   * in the input (the pane shows part of it) before pressing Enter, retrying a few times —
   * this absorbs the race where the TUI isn't quite ready for keystrokes yet. `token` is a
   * distinctive substring expected to appear in the pane (defaults to the whole line). Returns
   * true if the line was confirmed present (probe matched) before Enter; false if it never
   * landed across all attempts (e.g. a blocking gate is swallowing keystrokes) — the caller
   * uses this to bail instead of waiting out the full timeout on a dead screen.
   */
  private async injectLine(sessionName: string, line: string, token = line): Promise<boolean> {
    // The TUI wraps long input across pane lines (inserting newlines + indentation), so
    // compare with all whitespace removed — otherwise a contiguous substring never matches
    // and we'd re-send the line every iteration, stacking duplicate copies.
    const norm = (s: string) => s.replace(/\s+/g, '');
    const probe = norm(token).slice(0, 50);
    let landed = false;
    for (let i = 0; i < 4; i++) {
      // Clear any partial input from a prior failed attempt BEFORE re-sending. Doing the
      // clear at the start (rather than after a non-match) guarantees the line is present —
      // not freshly cleared — when the final Enter fires, so we never submit an empty prompt.
      if (i > 0) {
        await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['C-u']));
        await Bun.sleep(300);
      }
      await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, [line], true));
      await Bun.sleep(600);
      if (norm(await this.capturePane(sessionName)).includes(probe)) {
        landed = true;
        break;
      }
    }
    // Only submit if the line actually landed; pressing Enter into a blocking gate is useless
    // and the caller would otherwise wait out the full timeout on a screen that never exits.
    if (landed) await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['Enter']));
    return landed;
  }

  /** Run a tmux command, ignoring its output. */
  private async runTmuxQuiet(cmd: string[]): Promise<void> {
    const proc = this.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  }

  /** Capture a session's pane as text (visible, or full scrollback with `full`). */
  private async capturePane(sessionName: string, full = false): Promise<string> {
    const proc = this.spawn(commands.buildCapturePaneCommand(sessionName, full), {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    await proc.exited;
    return await new Response(proc.stdout).text();
  }

  /** Overwrite a log file with the session's full pane scrollback (best-effort). */
  private async snapshotPane(sessionName: string, logFile: string): Promise<void> {
    try {
      const pane = await this.capturePane(sessionName, true);
      if (pane) await this.writeLogFile(logFile, pane);
    } catch {}
  }

  /**
   * Write text to the log file, never following a symlink. A prior tick (or a re-entered run)
   * may have left logFile pointing at Claude's own session transcript; fs.writeFile would
   * follow that link and clobber the real transcript. Write to a sibling temp file then
   * atomically rename over logFile: rename replaces the symlink/file in one step (so it
   * never follows a stale link) AND leaves no window where logFile is absent — a follower
   * (`kloop view -f`) polling this path can never catch a missing file and re-read from 0.
   */
  private async writeLogFile(logFile: string, text: string | Uint8Array): Promise<void> {
    const tmp = `${logFile}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    try {
      await fs.rename(tmp, logFile);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }

  /**
   * Locate Claude Code's own session transcript for `sessionId`. It lives under a
   * `.claude*` config dir, at `projects/<encoded-cwd>/<sessionId>.jsonl`. The glob spans
   * `.claude*` so account-switching wrappers that set a non-default CLAUDE_CONFIG_DIR
   * (e.g. ~/.claude-zai) are still found, and the unique session id disambiguates across
   * projects. Returns the first match, or null if none exists yet.
   */
  private async findClaudeSessionFile(sessionId: string): Promise<string | null> {
    try {
      const glob = new Bun.Glob(`.claude*/projects/*/${sessionId}.jsonl`);
      for await (const match of glob.scan({ cwd: os.homedir(), absolute: true, dot: true, onlyFiles: true })) {
        return match;
      }
    } catch {}
    return null;
  }

  /**
   * Update the interactive live log for one poll tick. Prefers Claude's session transcript:
   * once found, its bytes are COPIED into the real `log` file (kept a regular file inside the
   * kloop home, so the web server's symlink-escape sandbox still serves it — a symlink to the
   * out-of-tree transcript would be rejected). Claude only appends, so the copy stays
   * append-only and `kloop view -f` byte-tailing remains valid. Until the transcript is found,
   * falls back to a pane snapshot. `wasCopying` carries forward that we already located the
   * transcript on a prior tick. `copyOffset` is the bytes of the transcript already copied this
   * run (caller-held, per-session local state — never shared across concurrent sessions).
   * Returns whether the log is now sourced from the session file plus the updated copy offset.
   */
  private async updateInteractiveLog(
    sessionName: string,
    sessionId: string,
    logFile: string,
    wasCopying: boolean,
    copyOffset: number,
  ): Promise<{ copying: boolean; offset: number }> {
    const sessionFile = await this.findClaudeSessionFile(sessionId);
    if (sessionFile) {
      try {
        // The transcript is append-only and can reach many MB on a long run; rewriting the
        // whole copy every 2s tick is O(n) per tick (O(n^2) over the run). So append only the
        // bytes past what we've already copied. The FIRST copy (or a transcript that shrank,
        // i.e. was rotated/replaced) does a full atomic writeLogFile to replace the pane
        // snapshot (and to never append THROUGH a stale symlink); thereafter we append the tail.
        const size = (await fs.stat(sessionFile)).size;
        if (!wasCopying || copyOffset === 0 || size < copyOffset) {
          const data = await fs.readFile(sessionFile);
          await this.writeLogFile(logFile, data);
          return { copying: true, offset: data.byteLength };
        } else if (size > copyOffset) {
          const handle = await fs.open(sessionFile, 'r');
          try {
            const len = size - copyOffset;
            const buf = Buffer.alloc(len);
            await handle.read(buf, 0, len, copyOffset);
            await fs.appendFile(logFile, buf, { mode: 0o600 });
            return { copying: true, offset: size };
          } finally {
            await handle.close();
          }
        }
        return { copying: true, offset: copyOffset };
      } catch {
        // Read/copy failed this tick — fall through to pane snapshot, retry next tick.
      }
    }
    // Transcript not found (or copy failed) this tick. If we'd already been copying it, keep
    // the last good copy rather than clobbering it with a stale pane snapshot.
    if (wasCopying) return { copying: true, offset: copyOffset };
    await this.snapshotPane(sessionName, logFile);
    return { copying: false, offset: copyOffset };
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Block until the TUI looks ready for input: pane is non-empty, unchanged across two
   * consecutive captures, AND actually shows the input prompt (not a static onboarding /
   * trust / login / bypass-permissions screen, which are themselves stable and would
   * otherwise pass the "unchanged" check — we'd then type the bootstrap into the wrong
   * screen and the agent would hang until timeout). Returns early if the session dies (the
   * caller handles that) or the cap elapses (we paste anyway as a best effort). Each capture
   * is also written to `logFile`, so the startup phase — including a launch that errors or
   * hangs before any input — is observable via `kloop view` rather than appearing as dead air.
   */
  private async waitForPaneReady(sessionName: string, logFile: string, capMs: number): Promise<void> {
    const start = Date.now();
    // Small grace period for the process to spawn and draw its first frame.
    await Bun.sleep(2000);
    let prev = '';
    let stableCount = 0;
    let dismissedBypassGate = false;
    while (Date.now() - start < capMs) {
      if (!(await this.isSessionAlive(sessionName))) return;
      const pane = (await this.capturePane(sessionName, true)).trim();
      try {
        if (pane) await this.writeLogFile(logFile, pane);
      } catch {}
      // First-run "Bypass Permissions mode" warning on a fresh CLAUDE_CONFIG_DIR (e.g. an
      // account wrapper's own config dir). It's a static screen that passes the "unchanged"
      // check but is NOT the input prompt — without dismissing it we'd burn the whole cap and
      // then fail every retry into the same screen. The accept control is the SECOND option
      // ("Yes, I accept"); select it with Down then confirm with Enter. Do it once (it advances
      // to the input prompt, which the normal readiness check below then detects).
      if (!dismissedBypassGate && this.paneShowsBypassPermissionsGate(pane)) {
        await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['Down']));
        await Bun.sleep(200);
        await this.runTmuxQuiet(commands.buildSendKeysCommand(sessionName, ['Enter']));
        dismissedBypassGate = true;
        stableCount = 0;
        prev = '';
        await Bun.sleep(1500);
        continue;
      }
      if (pane.length > 0 && pane === prev && this.paneShowsInputPrompt(pane)) {
        if (++stableCount >= 2) return;
      } else {
        stableCount = 0;
      }
      prev = pane;
      await Bun.sleep(1500);
    }
  }

  /**
   * Heuristic: is the captured pane the one-time "Bypass Permissions mode" warning shown on a
   * fresh config dir when launched with --dangerously-skip-permissions? It presents an
   * accept/decline choice and blocks input until dismissed. Matched narrowly (the warning's
   * own wording plus a choice prompt) so we don't misfire on an in-task status line that merely
   * mentions bypassing permissions.
   */
  private paneShowsBypassPermissionsGate(pane: string): boolean {
    const lower = pane.toLowerCase();
    return lower.includes('bypass permissions') && (lower.includes('yes, i accept') || lower.includes('no, exit'));
  }

  /**
   * Heuristic: does the captured pane show Claude Code's interactive input prompt (ready for
   * keystrokes) rather than a blocking onboarding screen? Returns false for the known
   * first-run / fresh-config-dir gates (trust-folder, theme select, login/auth, one-time
   * bypass-permissions warning) so the caller keeps waiting instead of injecting into them.
   */
  private paneShowsInputPrompt(pane: string): boolean {
    const lower = pane.toLowerCase();
    // Known blocking gates that are static (so they pass the "unchanged" check) but are NOT
    // the input prompt. Any of these means the TUI is waiting on a key press, not a task.
    const onboardingMarkers = [
      'do you trust the files',
      'choose the text style', // theme selection
      'select theme',
      'accept edits',
      'log in', // auth notice
      'sign in',
      'press enter to continue',
      'invalid api key',
    ];
    if (onboardingMarkers.some(m => lower.includes(m))) return false;
    // The one-time "Bypass Permissions mode" WARNING is a blocking gate, but the bare
    // "bypass permissions" substring also appears in the persistent footer during normal
    // bypass-mode operation. Reject only the actual warning (choice-text), so the steady-state
    // footer doesn't cause readiness to never confirm.
    if (this.paneShowsBypassPermissionsGate(pane)) return false;
    // Positive signal: Claude's input box renders a leading prompt glyph ("> ") inside a
    // box-drawing border. Require at least the prompt glyph to be present.
    return /(^|\n)\s*[│|]?\s*>\s/.test(pane) || pane.includes('│ >');
  }

  private getStatusFilePath(sessionName: string): string {
    const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.statusDir, `${safeName}.status`);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createTmuxService(spawn?: typeof Bun.spawn): TmuxService {
  return new TmuxServiceImpl(spawn);
}
