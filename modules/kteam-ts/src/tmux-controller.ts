import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { interactiveHarnessArgs } from './core';
import { now, run } from './io';
import type { KTeamPaths } from './paths';
import { sessionDir } from './paths';
import type { SessionConfig, SessionState } from './types';
import { WARDEN_LABEL } from './warden-detect';

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
  kind: 'claude-trust' | 'codex-trust' | 'permission-bypass' | 'api-key' | 'onboarding' | 'resume-menu';
  keys: string[];
}

export interface StartupDialogOptions {
  /** How to answer Claude Code's large-session resume gate ("Resume from
   *  summary (recommended) / Resume full session as-is / Don't ask me
   *  again"). 'full' keeps fidelity (kteam default); 'summary' saves quota.
   *  Option 3 is NEVER selected — it mutates global account state. */
  resumeMenuChoice?: 'full' | 'summary';
}

export interface PaneMetadata {
  dead: boolean;
  exitCode?: number;
  cursorX?: number;
  cursorY?: number;
  paneHeight?: number;
  paneWidth?: number;
}

interface ProcessRecord {
  pid: number;
  ppid: number;
  stat?: string;
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
  // Claude-family elapsed counters: "(12s · ⚒ 3.4k tokens", "(5m 45s · ↓
  // 17.2k tokens" — minutes and seconds may be space-separated.
  if (/\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\s*[·•∙]/.test(lower)) return true;
  if (/[\d.,]+k?\s*tokens\s*[·•∙]/.test(lower)) return true;
  // Spinner glyph + animated verb ellipsis: "✻ Lollygagging…", "✢ Fixing A6
  // stall detection…" — the verb phrase can span several words, but only for
  // glyphs the spinner animation owns exclusively. ⏺ also prefixes tool-result
  // lines whose truncation ellipses must not read as busy, so it keeps the
  // strict single-word form.
  if (/[✻✳✶✽✢∗][^\n…]{1,120}…/u.test(pane)) return true;
  if (/⏺\s*\S+…/u.test(pane)) return true;
  return false;
}

/** Above this many characters — or on any embedded newline — a payload is
 *  delivered as a BRACKETED PASTE rather than literal keystrokes. Both TUIs
 *  treat a large burst of literal keys as a paste anyway (and then collapse it),
 *  so making the paste explicit is the difference between one deterministic
 *  paste event and a race with the harness's own burst heuristic. */
const PASTE_TRANSPORT_CHARS = 240;

/** Which kind of evidence proved a payload reached the composer. `placeholder`
 *  means the harness collapsed it and shows no characters — the caller must
 *  never "clear and retype" that. */
export type LandingEvidence = 'chars' | 'placeholder';

/** Collapsed-paste placeholders. BOTH harnesses replace a large or multi-line
 *  paste with a placeholder and render NONE of the characters:
 *    claude 2.1.219: `[Pasted text #1 +16 lines]` / `[Pasted text #1]`, plus
 *      `[Image #1]`, `[Audio #1]`, `[...Truncated text …]`
 *    codex 0.145.0:  `[Pasted Content …]`
 *  Both forms are taken from the shipped binaries' own format strings, not
 *  guessed. The capture group is the placeholder's counter, so a SECOND paste
 *  ("#2") is recognizable as new even when the frame still shows the first. */
const PASTE_PLACEHOLDER =
  /\[(?:Pasted text|Pasted Content|Image|Audio|\.{3}Truncated text)(?:[^\]\n]*?#(\d+))?[^\]\n]*\]/gi;

export interface ComposerEvidence {
  /** Occurrences of the payload's character probe in the frame. */
  chars: number;
  /** Collapsed-paste placeholders in the frame. */
  placeholders: number;
  /** Highest placeholder counter seen (`#3` ⇒ 3); 0 when none carry one. */
  maxPlaceholderIndex: number;
}

/** What a frame says about a payload we typed: character echo AND collapsed-paste
 *  placeholders. The probe is the normalized first 50 characters — the COMPOSER
 *  must have received it, not merely "the text is somewhere on screen" (a payload
 *  like `continue` is routinely present in output), so callers compare counts
 *  before/after typing rather than testing presence. */
export function composerEvidence(frame: string, text: string): ComposerEvidence {
  const normalize = (value: string) => value.replace(/\s+/g, '');
  const probe = normalize(text).slice(0, 50);
  let chars = 0;
  if (probe) {
    const haystack = normalize(frame);
    for (let index = haystack.indexOf(probe); index >= 0; index = haystack.indexOf(probe, index + 1)) chars++;
  }
  let placeholders = 0;
  let maxPlaceholderIndex = 0;
  for (const match of frame.matchAll(PASTE_PLACEHOLDER)) {
    placeholders++;
    const counter = Number(match[1] ?? 0);
    if (Number.isFinite(counter) && counter > maxPlaceholderIndex) maxPlaceholderIndex = counter;
  }
  return { chars, placeholders, maxPlaceholderIndex };
}

/** True while the frame still shows the payload we typed — as characters or as
 *  the placeholder the harness collapsed it into. Used to tell "still sitting in
 *  the composer / echoed as a queued line" from "gone" without caring which
 *  display form the harness chose. */
export function composerHolds(frame: string, text: string, evidence: LandingEvidence): boolean {
  const seen = composerEvidence(frame, text);
  return evidence === 'placeholder' ? seen.placeholders > 0 : seen.chars > 0;
}

export interface PaneWorkCounters {
  elapsedSeconds?: number;
  tokens?: number;
}

/** Elapsed-time / token counters from an ACTIVE-work frame ("✢ Fixing…
 *  (5m 45s · ↓ 17.2k tokens)", "Working (6m52s"). Undefined when the pane
 *  shows no active-work indicator at all — a bare number elsewhere on screen
 *  must not read as work progress. */
export function paneWorkCounters(pane: string): PaneWorkCounters | undefined {
  if (!paneShowsActiveWork(pane)) return undefined;
  const counters: PaneWorkCounters = {};
  const elapsed = pane.match(/\(\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(\d+)\s*s\b/);
  if (elapsed) {
    counters.elapsedSeconds = Number(elapsed[1] ?? 0) * 3600 + Number(elapsed[2] ?? 0) * 60 + Number(elapsed[3]);
  }
  const tokens = pane.toLowerCase().match(/([\d.,]+)\s*(k?)\s*tokens/);
  if (tokens) {
    const scale = tokens[2] === 'k' ? 1000 : 1;
    counters.tokens = Math.round(Number.parseFloat(tokens[1]!.replaceAll(',', '')) * scale);
  }
  return counters.elapsedSeconds !== undefined || counters.tokens !== undefined ? counters : undefined;
}

/** True when a later frame's work counters PROVE the harness advanced: the
 *  elapsed clock or the token count strictly increased. Equal counters are a
 *  frozen spinner (wedged TUI repainting cosmetics) and earn no credit; a
 *  decrease is a new turn's counter restarting and also earns none. */
export function workCountersAdvanced(previous: PaneWorkCounters | undefined, current: PaneWorkCounters): boolean {
  if (!previous) return false;
  const elapsedAdvanced =
    previous.elapsedSeconds !== undefined &&
    current.elapsedSeconds !== undefined &&
    current.elapsedSeconds > previous.elapsedSeconds;
  const tokensAdvanced =
    previous.tokens !== undefined && current.tokens !== undefined && current.tokens > previous.tokens;
  return elapsedAdvanced || tokensAdvanced;
}

/** Codex footer: "1 background terminal running" / "2 background terminals
 *  running" — rendered permanently while any background terminal exists.
 *  Feeds the subprocess ledger clock for harnesses whose children aren't
 *  visible under the pane pid. */
export function backgroundTerminalCount(pane: string): number {
  const match = pane.toLowerCase().match(/(\d+)\s+background\s+terminals?\s+running/);
  return match ? Number(match[1]) : 0;
}

export interface StallLivenessState {
  /** Counters from the last frame that showed a recognized work indicator. */
  lastWorkCounters?: PaneWorkCounters;
  /** Wall-clock ms of the last PROVEN advance (elapsed clock or token count
   *  strictly increased). */
  lastWorkAdvanceAt: number;
  /** Wall-clock ms of the last TOKEN advance specifically — certain progress
   *  (claude renders a token counter; codex has none, so this never moves
   *  there and the sus classifier treats the session as token-blind). */
  lastTokenAdvanceAt?: number;
}

/** A6 counter-advance fold: feed each poll's visible frame; when the frame
 *  shows recognized work vocabulary whose counters strictly advanced since the
 *  last recognized frame, `lastWorkAdvanceAt` moves to now — and
 *  `lastTokenAdvanceAt` too when the TOKEN count specifically climbed (the
 *  token exemption: climbing tokens = certain progress, never sus). A
 *  repainting frame WITHOUT advancing counters moves nothing, so a wedged TUI
 *  still goes stale. Pure so fixture-pair tests drive it. */
export function foldStallLiveness(state: StallLivenessState, visiblePane: string, nowMs: number): StallLivenessState {
  const counters = paneWorkCounters(visiblePane);
  if (!counters) return state;
  const tokensAdvanced =
    state.lastWorkCounters?.tokens !== undefined &&
    counters.tokens !== undefined &&
    counters.tokens > state.lastWorkCounters.tokens;
  return {
    lastWorkCounters: counters,
    lastWorkAdvanceAt: workCountersAdvanced(state.lastWorkCounters, counters) ? nowMs : state.lastWorkAdvanceAt,
    lastTokenAdvanceAt: tokensAdvanced ? nowMs : state.lastTokenAdvanceAt,
  };
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

/** Claude Code's large-session resume gate (fixture claude-resume-menu.txt:
 *  "This session is 2h 45m old and 382k tokens… ❯ 1. Resume from summary
 *  (recommended) / 2. Resume full session as-is / 3. Don't ask me again").
 *  Deterministically wedged every resume of a big session until answered
 *  (lacey, 2026-07-23). Returns the keystrokes for the CONFIGURED choice;
 *  never option 3 (it mutates global account state). */
export function resumeMenuAction(pane: string, choice: 'full' | 'summary'): StartupDialogAction | undefined {
  const lower = pane.toLowerCase();
  if (!lower.includes('resume from summary') || !lower.includes('resume full session')) return undefined;
  const options = pane.split('\n').flatMap(line => {
    const match = line.match(/^\s*([>›❯»])?\s*(\d+)[.)]\s+(.+)$/u);
    return match ? [{ selected: Boolean(match[1]), label: match[3]!.trim().toLowerCase() }] : [];
  });
  const wanted = options.findIndex(option =>
    choice === 'summary' ? option.label.startsWith('resume from summary') : option.label.startsWith('resume full'),
  );
  const selected = options.findIndex(option => option.selected);
  if (wanted < 0 || selected < 0) return undefined;
  const direction = wanted > selected ? 'Down' : 'Up';
  return { kind: 'resume-menu', keys: [...Array(Math.abs(wanted - selected)).fill(direction), 'Enter'] };
}

/** Return keystrokes only for startup dialogs whose affirmative path is known. */
export function startupDialogAction(pane: string, options: StartupDialogOptions = {}): StartupDialogAction | undefined {
  const resumeMenu = resumeMenuAction(pane, options.resumeMenuChoice ?? 'full');
  if (resumeMenu) return resumeMenu;
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
  // Accepts k AND m unit suffixes: 1M-context sessions render "(735k/1M)",
  // which the k-only pattern silently missed (context showed empty fleet-wide
  // right after the 1M rollout).
  const ratio = lower.match(/(\d{1,3})%\s*\(\s*[\d.,]+[km]?\s*\/\s*[\d.,]+[km]?\s*\)/);
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

  /** One fleet inventory for boot recovery. A 707-session warm boot used to
   *  fork `tmux has-session` once for every terminal session (3.36 s total),
   *  even though virtually none had a pane. Active sessions still get a fresh
   *  state probe in SessionManager, so launch/readoption races stay safe. */
  async listSessions(): Promise<Set<string>> {
    const result = await run(['tmux', 'list-sessions', '-F', '#{session_name}']);
    if (result.code !== 0) return new Set();
    return new Set(
      result.stdout
        .split('\n')
        .map(name => name.trim())
        .filter(Boolean),
    );
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
      if (/^\s*[│|]?\s*[>›❯»]\s*\d+[.)]/u.test(cursorLine)) return false;
      return (cursorX === undefined || cursorX <= 2) && /^\s*[│|]?\s*[>›❯»](?:[\s\u00a0].*)?$/u.test(cursorLine);
    }

    // A full-height visible capture carries dozens of blank rows below the
    // composer; drop them so the 30-line window actually covers the prompt.
    let lastContent = lines.length - 1;
    while (lastContent >= 0 && lines[lastContent]!.trim() === '') lastContent--;
    const tail = lines.slice(0, lastContent + 1).slice(-30);
    const promptIndex = tail.findLastIndex(line => /^\s*[│|]?\s*[>›❯»](?:[\s\u00a0].*)?$/u.test(line));
    if (promptIndex < 0) return false;
    return tail.slice(promptIndex + 1).every(line => {
      const value = line.trim().toLowerCase();
      return (
        value === '' ||
        /^[─━═_┄┅┈┉┊┋│|╭╰╮╯┌┐└┘]+$/.test(value) ||
        /^(\?|shift\+tab|tab |esc |ctrl\+|\/ for|[0-9]+% context|context left)/.test(value) ||
        // Codex footer statusline: "gpt-5.6-sol ultra · Context 0% used · /tmp"
        /context [0-9]+% used/.test(value)
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

  protected async panePid(name: string): Promise<number | undefined> {
    const result = await run(['tmux', 'display-message', '-p', '-t', name, '#{pane_pid}']);
    const panePid = Number(result.stdout.trim());
    return result.code === 0 && Number.isFinite(panePid) && panePid > 1 ? panePid : undefined;
  }

  protected async processTable(): Promise<ProcessRecord[]> {
    const ps = await run(['ps', '-Ao', 'pid=,ppid=,stat=']);
    if (ps.code !== 0) throw new Error(ps.stderr.trim() || 'could not read the process table');
    const records: ProcessRecord[] = [];
    for (const line of ps.stdout.split('\n')) {
      const [pidText, ppidText, stat] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const ppid = Number(ppidText);
      if (Number.isFinite(pid) && pid > 1 && Number.isFinite(ppid)) records.push({ pid, ppid, stat });
    }
    return records;
  }

  private processTreePids(rootPid: number, records: readonly ProcessRecord[]): number[] {
    const childrenOf = new Map<number, number[]>();
    for (const { pid, ppid } of records) {
      const list = childrenOf.get(ppid);
      if (list) list.push(pid);
      else childrenOf.set(ppid, [pid]);
    }
    const tree = [rootPid];
    const seen = new Set(tree);
    for (let index = 0; index < tree.length; index++) {
      for (const child of childrenOf.get(tree[index]!) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        tree.push(child);
      }
    }
    return tree;
  }

  /** A6 subprocess life-sign: true when the pane's harness process has at
   *  least one live descendant (a running tool subprocess). The pane launcher
   *  `exec`s the harness, so the pane pid IS the harness and its descendants
   *  are tool processes. */
  async subprocessAlive(name: string): Promise<boolean> {
    const panePid = await this.panePid(name);
    if (panePid === undefined) return false;
    const records = await this.processTable().catch(() => undefined);
    if (records === undefined) return false;
    const live = new Set(records.filter(record => !record.stat?.startsWith('Z')).map(record => record.pid));
    return this.processTreePids(panePid, records)
      .slice(1)
      .some(pid => live.has(pid));
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
      // A daemon started from INSIDE a Claude pane (a dev/test daemon, or a
      // teammate bringing one up) carries that session's own markers. Copied
      // into a teammate's pane they do real damage:
      //   CLAUDE_CODE_CHILD_SESSION => "Transcript saving is off", so the
      //     harness writes NO transcript — and kteam's chat history, turn
      //     correlation and context accounting are all derived from it;
      //   ANTHROPIC_* (key, auth token, base URL, default-model overrides) =>
      //     the launching session's ACCOUNT leaks into a different wrapper's
      //     pane. Wrappers that export their own values override it, but ones
      //     that authenticate from CLAUDE_CONFIG_DIR credentials (the personal
      //     accounts) inherit a foreign base URL and boot "Not logged in".
      // The wrapper is the single source of truth for account/model env, so
      // dropping the whole family here is both safe and the fix.
      'CLAUDE_CODE_CHILD_SESSION',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      // Never copy a bearer token out of the daemon's own env into a pane —
      // the pane's KTEAM_TOKEN is set explicitly below (scoped for wardens,
      // unset otherwise so the CLI reads the admin token file as before).
      'KTEAM_TOKEN',
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
    // Warden panes run under the capability-scoped token (api-client prefers
    // $KTEAM_TOKEN over the admin token file). If the scoped token is missing we
    // FAIL rather than silently fall back to the admin file — a warden must never
    // launch with full privileges. (A determined prompt-injection could still
    // read the admin token off disk; that residual risk is documented in
    // daemon-config.ts — the scoped token is an authorization/audit boundary,
    // not OS isolation.)
    if (config.label === WARDEN_LABEL) {
      const scoped = (await readFile(this.paths.wardenToken, 'utf8').catch(() => '')).trim();
      if (!scoped) throw new Error('warden-scoped token is missing; cannot launch a warden pane un-scoped');
      pane.KTEAM_TOKEN = scoped;
      // Assigned wardens additionally carry their per-assignment stop
      // capability — the ONLY credential the api-server accepts for
      // `stop <assigned target>` (shared-token spoofing defense).
      if (config.stopCapability) pane.KTEAM_STOP_CAPABILITY = config.stopCapability;
    }
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
        ...['KTEAM_HOME', 'KTEAM_SESSION_ID', 'KTEAM_URL', 'PATH', ...(pane.KTEAM_TOKEN ? ['KTEAM_TOKEN'] : [])].map(
          key => `export ${key}=${quote(pane[key]!)}`,
        ),
        // Excluding these from the exports above is not enough: `tmux
        // new-session` inherits the tmux SERVER's environment, so a server that
        // was itself started from a polluted shell would hand them to the pane
        // anyway. Unset them in the pane, right before exec'ing the wrapper.
        `unset CLAUDECODE ${[...managedEnv].filter(key => key.startsWith('CLAUDE_') || key.startsWith('ANTHROPIC_')).join(' ')}`,
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
    await this.waitReady(config.tmuxSession, 90_000, true, { resumeMenuChoice: config.resumeMenuChoice });
  }

  async waitReady(
    name: string,
    timeoutMs = 45_000,
    handleStartupDialogs = false,
    dialogOptions: StartupDialogOptions = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    let lastState: PaneState | undefined;
    const dialogAttempts = new Map<StartupDialogAction['kind'], number>();
    await Bun.sleep(500);
    while (Date.now() < deadline) {
      const current = await this.state(name);
      lastState = current;
      if (!current.alive || current.dead)
        throw new Error(
          current.exitCode === undefined
            ? 'interactive harness exited; exit code unavailable (single-probe)'
            : `interactive harness exited (${current.exitCode})`,
        );
      const action = handleStartupDialogs ? startupDialogAction(current.visiblePane, dialogOptions) : undefined;
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
    // The turn STARTED only with positive busy evidence (spinner/token counter)
    // or a demonstrably non-idle pane. A payload that merely vanished from an
    // otherwise idle input box is a swallowed prompt, NOT an instant turn —
    // that misread caused the systemic "typed but vanished, session idle"
    // stalls across Claude wrappers.
    const turnStarted = (current: PaneState): boolean =>
      !current.alive || current.dead || paneShowsActiveWork(current.visiblePane) || !current.promptReady;
    let everLanded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const evidence = await this.fillComposer(name, text).catch(() => undefined);
      if (!evidence) continue;
      everLanded = true;
      // Enter can be swallowed while the TUI repaints; press again while the
      // payload is still sitting unsubmitted in the input box.
      submits: for (let submit = 0; submit < 3; submit++) {
        const enter = await this.keys(name, 'Enter');
        if (enter.code !== 0) throw new Error(enter.stderr.trim() || 'tmux submit failed');
        for (let poll = 0; poll < 12; poll++) {
          await Bun.sleep(500);
          const current = await this.state(name);
          if (turnStarted(current)) return;
          if (!composerHolds(current.visiblePane, text, evidence)) {
            // The payload left the input box without busy evidence yet. Slow
            // models take a beat to render the spinner — grant a short grace,
            // then treat it as swallowed and retype from scratch.
            for (let grace = 0; grace < 8; grace++) {
              await Bun.sleep(500);
              if (turnStarted(await this.state(name))) return;
            }
            break submits;
          }
        }
      }
      // Fall through to retype: the composer is demonstrably empty (the payload
      // left it without starting a turn), so nothing can be destroyed.
    }
    throw new Error(
      everLanded
        ? 'the prompt was typed but the harness never started the turn'
        : 'text did not land in the interactive input box',
    );
  }

  /** Get `text` into the pane's composer and PROVE it landed, returning which
   *  kind of evidence proved it.
   *
   *  Transport is chosen by size: a bracketed paste for multi-line or large
   *  payloads (one atomic paste event, which is also what both TUIs are built to
   *  accept), literal `send-keys -l` for short single lines, which the TUIs echo
   *  character-for-character.
   *
   *  Landing evidence, either of:
   *   1. a NEW collapsed-paste placeholder (`[Pasted text #2 +40 lines]`) — the
   *      harness stating it took a paste it will NOT display; or
   *   2. a NEW occurrence of the character probe (short text only).
   *
   *  Why this exists: verification used to require (2) alone. Both harnesses
   *  collapse a large paste into a placeholder and render none of the characters,
   *  so a ~1.2k multi-line message reported "text did not land" — and each retry
   *  pressed C-u first, DESTROYING a message that had in fact landed, before
   *  failing on a delivery that had worked. Hence the invariant enforced below:
   *  while a placeholder is present we never clear the composer. */
  protected async fillComposer(name: string, text: string): Promise<LandingEvidence> {
    const paste = text.includes('\n') || text.length > PASTE_TRANSPORT_CHARS;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // Only reachable when NOTHING landed (the placeholder guard below
        // returns first otherwise), so clearing cannot destroy a delivery.
        await this.keys(name, 'C-u');
        await Bun.sleep(this.composerPollMs * attempt);
      }
      const before = composerEvidence(await this.captureVisible(name), text);
      const sent = paste ? await this.pasteText(name, text) : await this.keys(name, '-l', text);
      if (sent.code !== 0) throw new Error(sent.stderr.trim() || 'tmux type failed');
      // Repaints can transiently hide a correctly-filled composer: poll a few
      // frames for evidence instead of judging one snapshot.
      for (let poll = 0; poll < 6; poll++) {
        await Bun.sleep(this.composerPollMs);
        const after = composerEvidence(await this.captureVisible(name), text);
        if (after.placeholders > before.placeholders || after.maxPlaceholderIndex > before.maxPlaceholderIndex)
          return 'placeholder';
        if (after.chars > before.chars) return 'chars';
      }
      // No NEW evidence. If the composer nonetheless holds a placeholder, a
      // paste of ours is sitting in it (a repaint can hide the counter bump, and
      // a re-paste of identical text may not move the count): submitting that is
      // correct, and retyping would duplicate or destroy it.
      if (composerEvidence(await this.captureVisible(name), text).placeholders > 0) return 'placeholder';
    }
    throw new Error('text did not land in the composer');
  }

  async send(config: SessionConfig, text: string): Promise<void> {
    // Startup dialogs (trust prompts, api-key confirmation) can surface late,
    // after launch()'s readiness gate — answer them here too so the injected
    // prompt is never queued behind a modal.
    const interactive = config.mode === 'interactive';
    await this.waitReady(config.tmuxSession, interactive ? 10_000 : 30_000, true, {
      resumeMenuChoice: config.resumeMenuChoice,
    }).catch(async error => {
      // INTERACTIVE panes have a second reason to never report a ready prompt:
      // a human (at the pane, or through the harness's own remote-control
      // surface) left text sitting in the composer. `promptReady` is false for
      // as long as that draft is there, so waiting cannot help — a UI send used
      // to burn the full timeout and then fail with "did not become ready",
      // which reads as "kteam refused to type". The composer belongs to whoever
      // is driving; the UI IS driving, so clear the stale draft and type.
      if (!interactive) throw error;
      const state = await this.state(config.tmuxSession);
      if (!state.alive || state.dead) throw error;
      // Genuinely mid-turn is a different case with a different answer (the
      // caller's native-queue path) — never type over live work.
      if (paneShowsActiveWork(state.visiblePane)) throw error;
      await this.keys(config.tmuxSession, 'C-u');
      await Bun.sleep(200);
    });
    await this.inject(config.tmuxSession, text);
  }

  /** Type text into a BUSY pane's composer and submit it into the harness's
   *  NATIVE queue (both TUIs hold text typed mid-turn and auto-submit it at
   *  the next turn boundary — verified empirically 2026-07-23, fixtures
   *  claude/codex-native-queue.txt). No readiness gate on purpose: the pane
   *  is expected to be mid-turn. Verifies the text landed (echoed in the
   *  composer/queue area) before submitting; multi-line payloads are sent as
   *  a bracketed paste so the TUI treats them as one message. */
  async typeIntoQueue(name: string, text: string): Promise<void> {
    // Landing verification (including the collapsed-paste case) lives in
    // fillComposer; this method owns only the SUBMIT semantics of a busy pane.
    const evidence = await this.fillComposer(name, text);
    const enter = await this.keys(name, 'Enter');
    if (enter.code !== 0) throw new Error(enter.stderr.trim() || 'tmux submit failed');
    await Bun.sleep(500);
    // Codex mid-turn: Enter does NOT submit; the composer keeps the text
    // and renders a "tab to queue message" hint — press Tab to move it into
    // the explicit queue (verified live, fixture codex-native-queue.txt).
    // Tolerant match (whitespace/wording drift) but anchored to the hint
    // words so a stale unrelated frame doesn't trigger a blind Tab.
    const afterEnter = await this.captureVisible(name);
    if (/tab to queue/i.test(afterEnter) && composerHolds(afterEnter, text, evidence)) {
      await this.keys(name, 'Tab');
      await Bun.sleep(300);
    }
    // Post-acceptance proof: the payload must still be visible (claude echoes
    // the queued line "❯ <text>", or its placeholder; codex keeps it in the
    // composer/queue) OR the pane must show active work about to consume it. A
    // frame with neither means the submit landed on an idle prompt or was
    // swallowed — report failure so the caller can re-decide rather than assume
    // the message is queued.
    const finalFrame = await this.captureVisible(name);
    if (composerHolds(finalFrame, text, evidence) || paneShowsActiveWork(finalFrame)) return;
    throw new Error('the message left the composer without queue evidence (pane may have gone idle mid-type)');
  }

  /** Frame cadence while waiting for landing evidence. A field, not a constant,
   *  so tests can run the real verification loop without real waits. */
  protected readonly composerPollMs: number = 300;

  /** The composer path's ONLY keystroke primitive. A single seam so landing
   *  verification (which must never press C-u over a delivered paste) can be
   *  tested against recorded frames instead of a live tmux server. */
  protected async keys(name: string, ...keys: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return await run(['tmux', 'send-keys', '-t', name, ...keys]);
  }

  protected async pasteText(name: string, text: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const buffer = `kteam-q-${crypto.randomUUID().slice(0, 8)}`;
    const proc = Bun.spawn(['tmux', 'load-buffer', '-b', buffer, '-'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(text);
    await proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) return { code, stdout: '', stderr: await new Response(proc.stderr).text() };
    const paste = await run(['tmux', 'paste-buffer', '-p', '-d', '-b', buffer, '-t', name]);
    return paste;
  }

  async interrupt(config: SessionConfig): Promise<void> {
    const name = config.tmuxSession;
    const before = await this.state(name);
    if (!before.alive || before.dead) throw new Error('session pane is dead; use resume');
    const working = paneShowsActiveWork(before.visiblePane);
    // Escape is the safe stop-current-turn key in BOTH harness TUIs; C-c is
    // the quit path (codex exits on C-c at an idle prompt). Exactly one
    // keystroke per call — no internal retries.
    //
    // When there is no active turn the key is normally SUPPRESSED (idempotence:
    // for codex, keystrokes at an idle prompt are how the TUI gets quit). The
    // exception is an interactive CLAUDE pane: the UI's stop button is the
    // human's Escape key, and Escape at an idle claude prompt is harmless — it
    // clears a half-typed composer or closes a menu, which is exactly what the
    // human pressing "stop" is asking for. Refusing to send it made the control
    // feel dead whenever kteam's status lagged the pane by a tick.
    if (!working && !(config.mode === 'interactive' && config.harness === 'claude')) return;
    const result = await this.keys(name, 'Escape');
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux interrupt failed');
    // Nothing was running, so there is no turn to wind down: skip the readiness
    // wait (30 s of polling for a state the pane is already in).
    if (!working) return;
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

  protected async killSession(name: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return await run(['tmux', 'kill-session', '-t', name]);
  }

  protected async stopSleep(ms: number): Promise<void> {
    await Bun.sleep(ms);
  }

  protected async signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    process.kill(pid, signal);
  }

  private async survivingProcessPids(rootPid: number, trackedPids: readonly number[]): Promise<number[]> {
    const records = await this.processTable();
    // Zombies have exited and cannot be killed; treating a short-lived zombie
    // as a surviving harness would make every successful teardown look like a
    // ghost. Their parent still has to reap them, but they are not executing.
    const live = new Set(records.filter(record => !record.stat?.startsWith('Z')).map(record => record.pid));
    // Captured descendants remain tracked after the root dies and the kernel
    // reparents them to pid 1. Also include any descendant spawned between
    // the initial capture and teardown while the root is still present.
    const candidates = [...new Set([...trackedPids, ...this.processTreePids(rootPid, records)])];
    return candidates.filter(pid => live.has(pid));
  }

  private async signalProcessTree(pids: readonly number[], signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    // Children first: stop tool subprocesses before their harness parent, while
    // retaining the captured pid list so reparenting cannot hide a ghost.
    for (const pid of [...pids].reverse()) {
      try {
        await this.signalProcess(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }

  async stop(name: string): Promise<void> {
    if (!(await this.alive(name))) return;
    const panePid = await this.panePid(name).catch(() => undefined);
    let trackedPids = panePid === undefined ? [] : [panePid];
    let captureProblem = panePid === undefined ? 'pane pid was unavailable before tmux teardown' : undefined;
    if (panePid !== undefined) {
      try {
        const records = await this.processTable();
        if (records.some(record => record.pid === panePid)) trackedPids = this.processTreePids(panePid, records);
        else captureProblem = `pane pid ${panePid} was absent from the process table before tmux teardown`;
      } catch (error) {
        captureProblem = `process tree capture failed before tmux teardown: ${String(error)}`;
      }
    }
    let stopped = false;
    let lastResult = { code: 0, stdout: '', stderr: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      lastResult = await this.killSession(name);
      await this.stopSleep(100 * (attempt + 1));
      if (!(await this.alive(name))) {
        stopped = true;
        break;
      }
    }
    if (!stopped)
      throw new Error(lastResult.stderr.trim() || `tmux session ${name} survived three kill-session attempts`);
    if (panePid === undefined)
      throw new Error(
        `tmux session ${name} stopped, but harness process death could not be confirmed: ${captureProblem}`,
      );

    let survivors = await this.survivingProcessPids(panePid, trackedPids).catch(error => {
      throw new Error(
        `tmux session ${name} stopped, but harness process death could not be confirmed: ${String(error)}`,
      );
    });
    if (survivors.length > 0) {
      await this.signalProcessTree(survivors, 'SIGTERM');
      await this.stopSleep(500);
      survivors = await this.survivingProcessPids(panePid, trackedPids);
    }
    if (survivors.length > 0) {
      await this.signalProcessTree(survivors, 'SIGKILL');
      await this.stopSleep(250);
      survivors = await this.survivingProcessPids(panePid, trackedPids);
    }
    if (survivors.length > 0)
      throw new Error(
        `harness process tree for tmux session ${name} survived SIGKILL; surviving pids: ${survivors.join(', ')}`,
      );
    if (captureProblem)
      throw new Error(
        `tmux session ${name} stopped, but harness process death could not be confirmed: ${captureProblem}`,
      );
  }
}
