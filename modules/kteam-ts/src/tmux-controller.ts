import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { interactiveHarnessArgs } from './core';
import { now, run } from './io';
import type { KTeamPaths } from './paths';
import { sessionDir } from './paths';
import type { SessionConfig, SessionState } from './types';

export interface PaneState {
  alive: boolean;
  dead: boolean;
  exitCode?: number;
  promptReady: boolean;
  pane: string;
  visiblePane: string;
  cursorX?: number;
  cursorY?: number;
  paneHeight?: number;
  paneWidth?: number;
}

export interface StartupDialogAction {
  kind: 'claude-trust' | 'codex-trust' | 'permission-bypass' | 'api-key' | 'onboarding';
  keys: string[];
}

export interface PaneMetadata {
  dead: boolean;
  exitCode?: number;
  cursorX?: number;
  cursorY?: number;
  paneHeight?: number;
  paneWidth?: number;
}

const STARTUP_BLOCKERS = [
  'do you trust the contents of this directory',
  'do you trust the files',
  'quick safety check: is this a project you created or one you trust',
  'yes, i trust this folder',
  'press enter to continue',
  'choose the text style',
  'select theme',
  'yes, i accept',
  'no, exit',
  'invalid api key',
  'detected a custom api key',
  'do you want to use this api key',
  'sign in',
  'log in',
];

// NOTE: 'background terminal running' is NOT busy evidence — codex prints that
// footer line permanently WHILE IDLE whenever any background terminal exists;
// treating it as busy poisoned waitReady, inject turn-start proof, and
// interrupt gating for such sessions (2026-07-19 incident).
const BUSY_BLOCKERS = ['esc to interrupt', 'ctrl+c to interrupt'];

// Codex's post-interrupt banner: the turn is stopped and the prompt is
// editable — this screen is READY, and another interrupt keystroke would
// quit the TUI entirely.
const INTERRUPTED_BANNER = 'tell the model what to do differently';

/** Active-turn evidence in the VISIBLE pane: harness spinners, token counters,
 *  and elapsed-time indicators. Ground truth for "the harness is working" — a
 *  pane showing these must never be treated as idle, completed, or failed. */
export function paneShowsActiveWork(pane: string): boolean {
  const lower = pane.toLowerCase();
  if (BUSY_BLOCKERS.some(marker => lower.includes(marker))) return true;
  // Codex: "Working (6m52s • Esc to interrupt)" — the interrupt hint can be
  // clipped by narrow panes, so match the elapsed-time form on its own.
  if (/\bworking\s*\(\s*\d+[ms]/.test(lower)) return true;
  // Claude-family: "(12s · ⚒ 3.4k tokens" / "3.4k tokens · esc" counters.
  if (/\(\s*\d+m?s\s*[·•∙]/.test(lower)) return true;
  if (/[\d.,]+k?\s*tokens\s*[·•∙]/.test(lower)) return true;
  // Spinner glyph + animated verb ellipsis: "✻ Lollygagging…", "· Mustering…".
  if (/[✻✳✶✽∗⏺]\s*\S+…/u.test(pane)) return true;
  return false;
}

function navigationToAffirmative(pane: string): string[] {
  const options = pane.split('\n').flatMap(line => {
    const match = line.match(/^\s*([>›❯])?\s*(\d+)[.)]\s+(.+)$/u);
    return match ? [{ selected: Boolean(match[1]), label: match[3]!.trim().toLowerCase() }] : [];
  });
  const affirmative = options.findIndex(option => /\b(yes|accept|continue|trust)\b/.test(option.label));
  const selected = options.findIndex(option => option.selected);
  if (affirmative < 0) return [];
  if (selected < 0) return affirmative === 0 ? ['Enter'] : [];
  const direction = affirmative > selected ? 'Down' : 'Up';
  return [...Array(Math.abs(affirmative - selected)).fill(direction), 'Enter'];
}

/** Return keystrokes only for startup dialogs whose affirmative path is known. */
export function startupDialogAction(pane: string): StartupDialogAction | undefined {
  const lower = pane.toLowerCase();
  let kind: StartupDialogAction['kind'] | undefined;
  if (lower.includes('do you trust the contents of this directory')) {
    kind = 'codex-trust';
  } else if (
    (lower.includes('quick safety check') && lower.includes('yes, i trust this folder')) ||
    lower.includes('do you trust the files')
  ) {
    kind = 'claude-trust';
  } else if (lower.includes('yes, i accept') && lower.includes('no, exit')) {
    kind = 'permission-bypass';
  } else if (lower.includes('do you want to use this api key')) {
    // Claude Code's "Detected a custom API key" confirmation defaults to No;
    // kteam wrappers export their key on purpose, so always accept it.
    kind = 'api-key';
  } else if (lower.includes('choose the text style') || lower.includes('select theme')) {
    return { kind: 'onboarding', keys: ['Enter'] };
  }
  if (!kind) return undefined;
  const keys = navigationToAffirmative(pane);
  return keys.length > 0 ? { kind, keys } : undefined;
}

/** Context-window usage (percent USED, 0-100+) from a TUI statusline, or
 *  undefined when no context indicator is visible. Handles both harnesses:
 *  Codex renders "Context N% used", Claude Code renders "N% context left" /
 *  "context left until auto-compact: N%" and "N% (12k/200k)" variants. */
export function contextPercentUsed(pane: string): number | undefined {
  const lower = pane.toLowerCase();
  const used = lower.match(/context\s+(\d{1,3})%\s+used/);
  if (used) return Number(used[1]);
  const left = lower.match(/(\d{1,3})%\s*(?:context\s*)?left|context\s*left[^0-9]{0,25}(\d{1,3})%/);
  if (left) return 100 - Number(left[1] ?? left[2]);
  const ratio = lower.match(/(\d{1,3})%\s*\(\s*[\d.,]+k?\s*\/\s*[\d.,]+k?\s*\)/);
  if (ratio) return Number(ratio[1]);
  return undefined;
}

/** The harness's own activity line from the visible pane — "✻ Lollygagging…
 *  (34s · 2.1k tokens)", "• Working (6m52s • Esc to interrupt)" — so the UI can
 *  show a received-and-thinking indicator with the harness's wording between
 *  transcript flushes. Undefined when no active turn is visible. */
export function paneActivityLine(pane: string): string | undefined {
  for (const line of pane.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 160) continue;
    if (
      /^[✻✳✶✽∗·•⏺]\s*\S+…/u.test(trimmed) ||
      /^\S+…\s*\(\d/u.test(trimmed) ||
      /\bworking\s*\(\s*\d+[ms]/i.test(trimmed)
    ) {
      // Strip the interrupt hint noise; keep verb + elapsed + token count.
      return trimmed.replace(/\s*[·•∙]?\s*(esc|ctrl\+c) to interrupt.*$/i, '').trim();
    }
  }
  return undefined;
}

export function parsePaneMetadata(value: string): PaneMetadata {
  const [dead, exit, cursorX, cursorY, paneHeight, paneWidth] = value.replace(/\n$/, '').split('|');
  const optionalNumber = (field?: string) =>
    field !== undefined && field !== '' && Number.isFinite(Number(field)) ? Number(field) : undefined;
  return {
    dead: dead === '1',
    exitCode: optionalNumber(exit),
    cursorX: optionalNumber(cursorX),
    cursorY: optionalNumber(cursorY),
    paneHeight: optionalNumber(paneHeight),
    paneWidth: optionalNumber(paneWidth),
  };
}

export class TmuxController {
  constructor(
    private readonly paths: KTeamPaths,
    private readonly daemonUrl: string,
  ) {}

  async alive(name: string): Promise<boolean> {
    return (await run(['tmux', 'has-session', '-t', name])).code === 0;
  }

  async capture(name: string): Promise<string> {
    const result = await run(['tmux', 'capture-pane', '-p', '-S', '-', '-t', name]);
    if (result.code !== 0) return '';
    return `${result.stdout.replace(/\s+$/, '')}\n`;
  }

  async captureVisible(name: string): Promise<string> {
    const result = await run(['tmux', 'capture-pane', '-p', '-t', name]);
    return result.code === 0 ? result.stdout : '';
  }

  promptReady(pane: string, cursorY?: number, cursorX?: number): boolean {
    const lower = pane.toLowerCase();
    if (STARTUP_BLOCKERS.some(marker => lower.includes(marker))) return false;
    // Spinners/token counters can render ABOVE an idle-looking input box (slow
    // models mid-turn) — an actively-working pane is never prompt-ready.
    if (paneShowsActiveWork(pane)) return false;
    // The codex interrupted banner means the turn is stopped and the prompt is
    // editable — ready, regardless of how the input row renders around it.
    if (lower.includes(INTERRUPTED_BANNER)) return true;
    const lines = pane.split('\n');
    if (cursorY !== undefined && cursorY >= 0 && cursorY < lines.length) {
      const cursorLine = lines[cursorY]!;
      if (/^\s*[│|]?\s*[>›❯]\s*\d+[.)]/u.test(cursorLine)) return false;
      return (cursorX === undefined || cursorX <= 2) && /^\s*[│|]?\s*[>›❯](?:[\s\u00a0].*)?$/u.test(cursorLine);
    }

    const tail = lines.slice(-30);
    const promptIndex = tail.findLastIndex(line => /^\s*[│|]?\s*[>›❯](?:[\s\u00a0].*)?$/u.test(line));
    if (promptIndex < 0) return false;
    return tail.slice(promptIndex + 1).every(line => {
      const value = line.trim().toLowerCase();
      return (
        value === '' ||
        /^[─━═_┄┅┈┉┊┋│|╭╰╮╯┌┐└┘]+$/.test(value) ||
        /^(\?|shift\+tab|tab |esc |ctrl\+|\/ for|[0-9]+% context|context left)/.test(value)
      );
    });
  }

  async state(name: string): Promise<PaneState> {
    if (!(await this.alive(name))) return { alive: false, dead: true, promptReady: false, pane: '', visiblePane: '' };
    const [status, pane, visiblePane] = await Promise.all([
      run([
        'tmux',
        'display-message',
        '-p',
        '-t',
        name,
        '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}',
      ]),
      this.capture(name),
      this.captureVisible(name),
    ]);
    const metadata = parsePaneMetadata(status.stdout);
    return {
      alive: true,
      dead: metadata.dead,
      exitCode: metadata.exitCode,
      promptReady: this.promptReady(visiblePane, metadata.cursorY, metadata.cursorX),
      pane,
      visiblePane,
      cursorX: metadata.cursorX,
      cursorY: metadata.cursorY,
      paneHeight: metadata.paneHeight,
      paneWidth: metadata.paneWidth,
    };
  }

  async launch(config: SessionConfig): Promise<void> {
    if (await this.alive(config.tmuxSession)) throw new Error(`tmux session already exists: ${config.tmuxSession}`);
    // Forward the daemon's environment into the pane. `tmux new-session`
    // attaches to a possibly pre-existing tmux server whose global env lacks
    // the wrapper secrets (MINIMAX_API_KEY, ANTHROPIC_*, ...); without this a
    // token-based wrapper exports an EMPTY auth token and the TUI silently
    // boots logged-out while `kteam status` keeps saying "running".
    // The env travels via a generated launcher script, NOT `-e` flags: a full
    // environment as tmux arguments exceeds the server's command length limit
    // ("failed to launch tmux: command too long") on real machines.
    const managedEnv = new Set([
      'CLAUDECODE',
      'TMUX',
      'TMUX_PANE',
      'TERM',
      'TERM_PROGRAM',
      'TERM_PROGRAM_VERSION',
      'TERM_SESSION_ID',
      'PWD',
      'OLDPWD',
      'SHLVL',
      '_',
    ]);
    const pane: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || managedEnv.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      pane[key] = value;
    }
    pane.KTEAM_HOME = this.paths.home;
    pane.KTEAM_SESSION_ID = config.id;
    pane.KTEAM_URL = this.daemonUrl;
    pane.PATH = process.env.PATH ?? '';
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const launcher = path.join(sessionDir(this.paths, config.id), 'launch.sh');
    await mkdir(path.dirname(launcher), { recursive: true, mode: 0o700 });
    await writeFile(
      launcher,
      [
        '#!/bin/sh',
        '# generated by kteamd: pane environment + harness invocation',
        ...Object.entries(pane).map(([key, value]) => `export ${key}=${quote(value)}`),
        // A service-managed daemon (launchd/systemd) never sources the user's
        // shell secrets, so its env lacks the wrapper API keys entirely and
        // token wrappers boot login-walled. Source them fresh at pane start —
        // after the daemon env (fresh file beats a stale daemon copy), before
        // the KTEAM_*/PATH pins below.
        '[ -e "$HOME/.secrets" ] && . "$HOME/.secrets"',
        ...['KTEAM_HOME', 'KTEAM_SESSION_ID', 'KTEAM_URL', 'PATH'].map(key => `export ${key}=${quote(pane[key]!)}`),
        'unset CLAUDECODE',
        `exec ${[config.binary, ...interactiveHarnessArgs(config)].map(quote).join(' ')}`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const result = await run([
      'tmux',
      'new-session',
      '-d',
      '-s',
      config.tmuxSession,
      '-c',
      config.cwd,
      '-x',
      '160',
      '-y',
      '50',
      launcher,
    ]);
    if (result.code !== 0) throw new Error(`failed to launch tmux: ${result.stderr.trim()}`);
    await run(['tmux', 'set-option', '-t', config.tmuxSession, 'remain-on-exit', 'on']);
    await this.waitReady(config.tmuxSession, 90_000, true);
  }

  async waitReady(name: string, timeoutMs = 45_000, handleStartupDialogs = false): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    let lastState: PaneState | undefined;
    const dialogAttempts = new Map<StartupDialogAction['kind'], number>();
    await Bun.sleep(500);
    while (Date.now() < deadline) {
      const current = await this.state(name);
      lastState = current;
      if (!current.alive || current.dead)
        throw new Error(`interactive harness exited (${current.exitCode ?? 'unknown'})`);
      const action = handleStartupDialogs ? startupDialogAction(current.visiblePane) : undefined;
      if (action) {
        const attempts = (dialogAttempts.get(action.kind) ?? 0) + 1;
        dialogAttempts.set(action.kind, attempts);
        if (attempts > 3) throw new Error(`startup dialog ${action.kind} did not close after 3 attempts`);
        for (const key of action.keys) {
          const sent = await run(['tmux', 'send-keys', '-t', name, key]);
          if (sent.code !== 0) throw new Error(sent.stderr.trim() || `failed to handle ${action.kind} dialog`);
          await Bun.sleep(150);
        }
        stable = 0;
        await Bun.sleep(1_000);
        continue;
      }
      // Stabilize the semantic state, not the rendered frame: both harnesses
      // repaint status text and rotate placeholder copy while remaining idle.
      if (current.promptReady) stable++;
      else stable = 0;
      if (stable >= 2) return;
      await Bun.sleep(750);
    }
    const diagnostic = lastState
      ? `; last frame: promptReady=${lastState.promptReady}, cursor=${lastState.cursorX ?? '?'}:${lastState.cursorY ?? '?'}`
      : '';
    throw new Error(`interactive harness did not become ready within ${Math.round(timeoutMs / 1000)}s${diagnostic}`);
  }

  async inject(name: string, text: string): Promise<void> {
    const normalize = (value: string) => value.replace(/\s+/g, '');
    const probe = normalize(text).slice(0, 50);
    // The turn STARTED only with positive busy evidence (spinner/token counter)
    // or a demonstrably non-idle pane. A probe that merely vanished from an
    // otherwise idle input box is a swallowed prompt, NOT an instant turn —
    // that misread caused the systemic "typed but vanished, session idle"
    // stalls across Claude wrappers.
    const turnStarted = (current: PaneState): boolean =>
      !current.alive || current.dead || paneShowsActiveWork(current.visiblePane) || !current.promptReady;
    let everLanded = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await run(['tmux', 'send-keys', '-t', name, 'C-u']);
        await Bun.sleep(200 * attempt);
      }
      const sent = await run(['tmux', 'send-keys', '-t', name, '-l', text]);
      if (sent.code !== 0) throw new Error(sent.stderr.trim() || 'tmux send failed');
      await Bun.sleep(400);
      if (!normalize(await this.captureVisible(name)).includes(probe)) continue;
      everLanded = true;
      // Enter can be swallowed while the TUI repaints; press again while the
      // typed text is still sitting unsubmitted in the input box.
      submits: for (let submit = 0; submit < 3; submit++) {
        const enter = await run(['tmux', 'send-keys', '-t', name, 'Enter']);
        if (enter.code !== 0) throw new Error(enter.stderr.trim() || 'tmux submit failed');
        for (let poll = 0; poll < 12; poll++) {
          await Bun.sleep(500);
          const current = await this.state(name);
          if (turnStarted(current)) return;
          if (!normalize(current.visiblePane).includes(probe)) {
            // Text left the input box without busy evidence yet. Slow models
            // take a beat to render the spinner — grant a short grace, then
            // treat it as swallowed and retype from scratch.
            for (let grace = 0; grace < 8; grace++) {
              await Bun.sleep(500);
              if (turnStarted(await this.state(name))) return;
            }
            break submits;
          }
        }
      }
      // Fall through to retype (C-u clears any stale residue first).
    }
    throw new Error(
      everLanded
        ? 'the prompt was typed but the harness never started the turn'
        : 'text did not land in the interactive input box',
    );
  }

  async send(config: SessionConfig, text: string): Promise<void> {
    // Startup dialogs (trust prompts, api-key confirmation) can surface late,
    // after launch()'s readiness gate — answer them here too so the injected
    // prompt is never queued behind a modal.
    await this.waitReady(config.tmuxSession, 30_000, true);
    await this.inject(config.tmuxSession, text);
  }

  async interrupt(config: SessionConfig): Promise<void> {
    const name = config.tmuxSession;
    const before = await this.state(name);
    if (!before.alive || before.dead) throw new Error('session pane is dead; use resume');
    // Idempotent: an idle pane (or the codex interrupted banner) has nothing
    // to stop — sending another keystroke is what QUITS a codex TUI.
    if (!paneShowsActiveWork(before.visiblePane)) return;
    // Escape is the safe stop-current-turn key in BOTH harness TUIs; C-c is
    // the quit path (codex exits on C-c at an idle prompt). Exactly one
    // keystroke per call — no internal retries.
    const result = await run(['tmux', 'send-keys', '-t', name, 'Escape']);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux interrupt failed');
    await this.waitReady(name, 30_000);
  }

  async answerQuestion(
    config: SessionConfig,
    state: SessionState,
    labels: string[],
    other?: string,
    responses?: string[],
  ): Promise<void> {
    const pending = state.pendingQuestion;
    if (!pending) throw new Error('session has no pending structured question');
    if (other && pending.questions.length !== 1)
      throw new Error('use one --response per question when multiple questions are pending');
    if (responses && responses.length !== pending.questions.length)
      throw new Error(`expected ${pending.questions.length} --response values`);
    for (let questionIndex = 0; questionIndex < pending.questions.length; questionIndex++) {
      const question = pending.questions[questionIndex]!;
      const current = await this.state(config.tmuxSession);
      const pane = current.visiblePane;
      const normalizedPane = pane.replace(/\s+/g, '').toLowerCase();
      const options = question.options ?? [];
      const response = responses?.[questionIndex];
      const selected =
        response === undefined
          ? labels.filter(label => options.some(option => option.label === label))
          : options.some(option => option.label === response)
            ? [response]
            : [];
      const freeform = response !== undefined && selected.length === 0 ? response : other;
      const questionProbe = question.question.replace(/\s+/g, '').toLowerCase().slice(0, 40);
      const selectedVisible = selected.every(label => normalizedPane.includes(label.replace(/\s+/g, '').toLowerCase()));
      if (!questionProbe || !normalizedPane.includes(questionProbe) || !selectedVisible || current.promptReady) {
        throw new Error('the structured question is not visible in the interactive tmux pane; snapshot and retry');
      }
      if (selected.length === 0 && !freeform) throw new Error(`no supplied selection matches: ${question.question}`);
      if (freeform) {
        for (let cursor = 0; cursor < options.length; cursor++)
          await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Down']);
        await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Enter']);
        await Bun.sleep(300);
        await run(['tmux', 'send-keys', '-t', config.tmuxSession, '-l', freeform]);
        await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Enter']);
        continue;
      }
      if (question.multiSelect) {
        for (let index = 0; index < options.length; index++) {
          if (selected.includes(options[index]!.label))
            await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Space']);
          if (index < options.length - 1) await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Down']);
        }
      } else {
        const index = options.findIndex(option => option.label === selected[0]);
        for (let cursor = 0; cursor < index; cursor++)
          await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Down']);
      }
      await run(['tmux', 'send-keys', '-t', config.tmuxSession, 'Enter']);
      await Bun.sleep(300);
    }
  }

  async snapshot(config: SessionConfig, final = false): Promise<string> {
    const pane = await this.capture(config.tmuxSession);
    if (!pane.trim()) return '';
    const dir = path.join(sessionDir(this.paths, config.id), 'snapshots');
    await mkdir(dir, { recursive: true });
    const stamp = now().replace(/[:.]/g, '-');
    const snapshotFile = path.join(dir, `${stamp}${final ? '-final' : ''}.txt`);
    await Promise.all([
      writeFile(snapshotFile, pane, { mode: 0o600 }),
      writeFile(path.join(sessionDir(this.paths, config.id), 'last-snapshot.txt'), pane, { mode: 0o600 }),
    ]);
    const snapshots = (await readdir(dir)).filter(name => name.endsWith('.txt')).sort();
    const excess = snapshots.slice(0, Math.max(0, snapshots.length - config.maxSnapshots));
    await Promise.all(excess.map(name => rm(path.join(dir, name), { force: true })));
    return pane;
  }

  async stop(name: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await this.alive(name))) return;
      const result = await run(['tmux', 'kill-session', '-t', name]);
      await Bun.sleep(100 * (attempt + 1));
      if (!(await this.alive(name))) return;
      if (attempt === 2) throw new Error(result.stderr.trim() || `tmux session ${name} survived kill-session`);
    }
  }
}
