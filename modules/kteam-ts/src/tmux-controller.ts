import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { interactiveHarnessArgs } from './core';
import { now, run } from './io';
import type { KTeamPaths } from './paths';
import { sessionDir } from './paths';
import type { PendingQuestion, SessionConfig, SessionState } from './types';
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

/** Central readiness budgets. These deliberately preserve the established
 * values; naming every call-site budget prevents one path drifting when the
 * fleet's startup/readiness tuning changes. */
export const INTERACTIVE_READY_TIMEOUT_MS = 10_000;
export const AUTOMODE_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_READY_TIMEOUT_MS = 45_000;
export const LAUNCH_READY_TIMEOUT_MS = 90_000;

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

/** What happened after a proven composer delivery was submitted. A command
 *  that the TUI consumes and handles locally is successful even though no
 *  model turn (spinner/non-idle work state) follows it. */
export type InjectionOutcome = 'turn-started' | 'handled-local';

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

/** Codex's native `/model` flow is a two-stage selector, not a model turn and
 *  not an idle composer. Its frame can retain the submitted `/model` line in
 *  scrollback, so the broad composer probe alone would mistake that echo for a
 *  still-unsubmitted payload and press Enter again — selecting the highlighted
 *  model without the user choosing it. These headings are shipped by the
 *  installed Codex TUI and are positive local-handling evidence. The second
 *  alternative is deliberately an unterminated prefix: Codex appends the
 *  currently selected model name, including names added after this release. */
export function paneShowsModelSelector(frame: string): boolean {
  return /Select Model and Effort|Select Reasoning Level for/i.test(frame);
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

/** Whitespace-stripped, lowercased form used for pane/label comparisons.
 *  Strips spaces AND newlines, so a value split across two wrapped TUI lines
 *  collapses back together — but only if nothing else (box-drawing, a
 *  right-column panel) sits BETWEEN the fragments on those lines. That caveat
 *  is the whole reason a full-label contiguous match is unreliable; see
 *  `optionVisibleOnPane`. */
function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

export const STRUCTURED_ANSWER_NOT_VISIBLE =
  'the structured question is not visible in the interactive tmux pane; snapshot and retry';

/** The shortest whitespace-stripped prefix of `label` (taken up to its first
 *  '(' — the common wrap point for trailing "(Recommended)"-style suffixes)
 *  that is NOT a substring of any OTHER option's label. Seeing such a fragment
 *  on the pane proves THIS option's own identifying text is present and cannot
 *  be confused with a sibling option's text.
 *
 *  Shortest-distinctive is deliberate: a shorter fragment is less likely to be
 *  broken across a wrap or clipped by ellipsis truncation, while the
 *  no-other-option-contains-it requirement keeps it unambiguous. Returns
 *  `null` when no safe fragment exists (too short, or every candidate collides
 *  with another option) — the caller then refuses rather than guess. */
export function distinctiveOptionFragment(label: string, allOptions: string[]): string | null {
  const head = label.split('(')[0] ?? label;
  const base = normalizeForMatch(head) || normalizeForMatch(label);
  const others = allOptions.filter(option => option !== label).map(normalizeForMatch);
  const MIN_FRAGMENT = 4;
  const MAX_FRAGMENT = Math.min(base.length, 24);
  for (let length = MIN_FRAGMENT; length <= MAX_FRAGMENT; length++) {
    const fragment = base.slice(0, length);
    if (!others.some(other => other.includes(fragment))) return fragment;
  }
  return null;
}

/** Is a single option we intend to select genuinely on screen, and NOT
 *  confusable with a sibling? We match on the shortest fragment that uniquely
 *  identifies this option among the whole set (its full label when distinct;
 *  a shorter prefix when that prefix already disambiguates). This is both:
 *   - wrap/truncation robust — a short fragment survives a line wrap or an
 *     ellipsis clip that would break a full-label contiguous match; and
 *   - mis-answer proof — the fragment cannot be a substring of another
 *     option's label, so a sibling's on-screen text can never satisfy it.
 *  When no distinctive fragment exists (e.g. one label is a prefix of another)
 *  we return false so the caller refuses rather than risk the wrong option. */
export function optionVisibleOnPane(normalizedPane: string, label: string, allOptions: string[]): boolean {
  const fragment = distinctiveOptionFragment(label, allOptions);
  if (!fragment) return false;
  return normalizedPane.includes(fragment);
}

const CHECKED_MARKERS = ['☑', '☒', '●', '◉', '✓', '✔', '[x]', '[X]', '(x)', '(X)'];
const UNCHECKED_MARKERS = ['☐', '○', '◯', '[ ]', '( )', '[]', '()'];

/** The label text of a STRUCTURALLY NUMBERED menu row, or `null` when the line
 * is not one. Chrome is stripped in the order a TUI paints it: the right-hand
 * panel column, the native cursor glyph, the ordinal, then an optional checkbox
 * marker. The ordinal is MANDATORY — it is the only thing separating a real menu
 * row from a description line, a wrapped continuation, or scrollback prose that
 * happens to read exactly like an option label. Accepting an unnumbered line
 * let any of those masquerade as the live menu. */
function numberedOptionRowText(line: string): string | null {
  const left = (line.split(/[│┃]/u)[0] ?? line).trim().replace(/^[❯›>»]\s*/u, '');
  const numbered = left.match(/^\d+[.)]\s*(.*)$/);
  if (!numbered) return null;
  let rest = (numbered[1] ?? '').trim();
  const marker = [...CHECKED_MARKERS, ...UNCHECKED_MARKERS].find(candidate => rest.startsWith(candidate));
  if (marker) rest = rest.slice(marker.length).trim();
  return rest;
}

/** A whole labelled menu row is stronger evidence than a fleet-wide substring.
 * In particular, `1. Enable feature` is safe to distinguish from the sibling
 * `2. Enable feature flags` even though no prefix of the first label is unique.
 * The row must carry its ordinal: this is the strongest evidence the matcher
 * has, so it is only ever granted to a real menu row. Right-column panel content
 * is discarded before comparison; a description on the same row is accepted only
 * behind an explicit dash separator.
 *
 * SHAPE PREDICATE ONLY — it says a line looks like a menu row, NOT that the row
 * belongs to the live menu. It scans the whole capture, so scrollback satisfies
 * it. Nothing that authorizes a keystroke may call it: those paths go through
 * `liveMenuBlock` and `blockOptionRowVisible`, which are bound to one block. */
export function exactOptionRowVisible(pane: string, label: string): boolean {
  return pane.split('\n').some(line => rowTextMatchesLabel(numberedOptionRowText(line), label));
}

/** Does a parsed row's label text name `label`? A description on the same row is
 * accepted only behind an explicit dash separator. */
function rowTextMatchesLabel(text: string | null, label: string): boolean {
  const wanted = normalizeForMatch(label);
  if (!wanted || text === null) return false;
  const normalized = normalizeForMatch(text);
  return normalized === wanted || normalized.startsWith(`${wanted}—`) || normalized.startsWith(`${wanted}-`);
}

/** An exact STANDALONE header row: a whole line carrying nothing but the header
 * text, once its `?`/bullet chrome and any right-hand panel column are removed.
 * A header found merely as a substring proves nothing — descriptions and
 * scrollback quote a question's own header all the time, and a substring hit
 * there would hand a sibling ordinal's identity to the wrong question.
 *
 * SHAPE PREDICATE ONLY, exactly as `exactOptionRowVisible`: authorizing paths
 * pass a single block's text, never the whole capture. */
export function exactHeaderRowVisible(pane: string, header: string): boolean {
  const wanted = normalizeForMatch(header);
  if (!wanted) return false;
  return pane.split('\n').some(line => {
    const left = (line.split(/[│┃]/u)[0] ?? line)
      .trim()
      .replace(/^[?❯›>»*•]\s*/u, '')
      .trim();
    return normalizeForMatch(left) === wanted;
  });
}

const QUESTION_PROBE_CHARS = 40;
/** Continuation lines a wrapped question may occupy below its own row. */
const QUESTION_WRAP_LINES = 2;

/** A bare input row — the composer, with nothing typed into it. Structurally
 * important twice over: it is where a free-text page receives typing, and a
 * composer BELOW a menu means that menu no longer owns the keyboard. */
function isComposerRow(line: string): boolean {
  const stripped = line.replace(/^[\s│|┃╭╰┌└]+/u, '').replace(/[\s│|┃╮╯┐┘]+$/u, '');
  return /^[>›❯»]$/u.test(stripped);
}

/** The harness's own question glyph: `? ` starting a line. A question printed
 * this way is a structural ROW, as opposed to the same words quoted inside
 * prose. */
function isQuestionAnchorLine(line: string): boolean {
  return /^\?\s+\S/u.test((line.split(/[│┃]/u)[0] ?? line).trim());
}

function introRowText(line: string): { text: string; anchored: boolean } | null {
  const left = (line.split(/[│┃]/u)[0] ?? line).trim();
  if (left === '') return null;
  const anchored = /^\?\s+\S/u.test(left);
  return { text: anchored ? left.replace(/^\?\s+/u, '') : left, anchored };
}

/** Is this question printed as its OWN row in `intro`, and if so on which line?
 * Returns the LOWEST such line, or -1.
 *
 * A first-40-character probe found anywhere in the intro is NOT enough. An
 * unrelated live selector's intro routinely quotes an earlier question —
 * `Earlier transcript: “Which one?” was discussed.` sitting above
 * `Continue deployment?` with rows the pending set happens to share — and a
 * substring probe accepted that, handing both answer and abandon a menu that is
 * not ours. A structural row is required instead, in one of exactly two forms:
 *  - a `?`-prefixed harness question row; or
 *  - a standalone row the harness printed with no `?` glyph,
 * in either case with bounded wrapped continuations, and in either case the
 * joined text must be the WHOLE question. A prefix match is not enough: two
 * different questions routinely share their opening clause, and matching on the
 * first 40 characters would let a longer, DIFFERENT anchored question claim a
 * short pending one. The single concession is an explicitly ellipsis-truncated
 * `?` row, which the harness itself clipped — and only when what survives is
 * long enough to mean something. Continuations are collected for at most
 * QUESTION_WRAP_LINES lines and stop at a blank line or the next question
 * anchor, so a wrap can never absorb unrelated text below it. */
export function questionRowIndex(intro: string, question: string): number {
  const full = normalizeForMatch(question);
  if (!full) return -1;
  const rows = intro.split('\n').map(introRowText);
  let found = -1;
  for (const [index, row] of rows.entries()) {
    if (!row) continue;
    let text = normalizeForMatch(row.text);
    for (let extra = 0; extra <= QUESTION_WRAP_LINES; extra++) {
      if (extra > 0) {
        const next = rows[index + extra];
        if (!next || next.anchored) break;
        text += normalizeForMatch(next.text);
      }
      if (questionRowTextMatches(text, full, row.anchored)) {
        found = index;
        break;
      }
    }
  }
  return found;
}

/** Shortest surviving stem an ellipsis-clipped question row may be matched on. */
const MIN_CLIPPED_QUESTION_CHARS = 8;

function questionRowTextMatches(text: string, full: string, anchored: boolean): boolean {
  if (text === full) return true;
  if (!anchored) return false;
  const clipped = text.replace(/[….]+$/u, '');
  return clipped !== text && clipped.length >= MIN_CLIPPED_QUESTION_CHARS && full.startsWith(clipped);
}

/** One parsed numbered row of a menu block. */
export interface MenuBlockRow {
  /** 0-based pane line this row was read from. */
  line: number;
  /** The ordinal the TUI printed (`3.` ⇒ 3). */
  ordinal: number;
  /** The row's label text, chrome removed. */
  text: string;
  /** The native selection cursor (`❯`) sits on this row. */
  cursor: boolean;
  /** Checkbox state when the row carries a marker we recognize. */
  checked?: boolean;
}

/** THE live structured-menu block: one contiguous region of the capture that a
 * keystroke may legally be aimed at. Every piece of evidence any authorizing
 * helper uses must come from this one object. */
export interface LiveMenuBlock {
  /** The whole block — intro + rows + footer — as pane text. */
  text: string;
  /** The bounded question/header region ABOVE the first numbered row. */
  intro: string;
  /** First numbered row through last numbered row, descriptions included. */
  rowsText: string;
  /** Inclusive 0-based pane line bounds of the block. */
  startLine: number;
  endLine: number;
  rows: MenuBlockRow[];
  /** 0-based OPTION index the native cursor sits on, read from THIS block only;
   * `undefined` when no row in the block carries the cursor glyph. */
  cursorRow?: number;
}

/** Non-row lines tolerated BETWEEN two numbered rows of one menu: Claude prints
 * a description, sometimes a blank line, and a separator rule before the trailing
 * "Chat about this" row. Beyond this the rows belong to different menus. */
const MENU_ROW_GAP_LINES = 4;
/** How far above the first numbered row the question/header region may reach. */
const MENU_INTRO_LINES = 8;
/** Consecutive blank lines tolerated inside the intro (header ␤ ␤ question). */
const MENU_INTRO_BLANK_RUN = 2;
/** How far below the last numbered row the native footer may reach. */
const MENU_FOOTER_LINES = 4;

/** A harness's own menu footer — it terminates the block above it. */
function menuFooterLine(value: string): boolean {
  return /(?:enter|return)\s+to\s+(?:select|submit|confirm)|esc(?:ape)?\s+to\s+cancel|to\s+navigate|space\s+to\s+toggle/iu.test(
    value,
  );
}

function parseMenuRow(line: string, index: number): MenuBlockRow | null {
  const left = (line.split(/[│┃]/u)[0] ?? line).trim();
  const cursor = /^[❯›>»]/u.test(left);
  const withoutCursor = left.replace(/^[❯›>»]\s*/u, '');
  const numbered = withoutCursor.match(/^(\d+)[.)]\s*(.*)$/);
  if (!numbered) return null;
  const ordinal = Number(numbered[1]);
  if (!Number.isInteger(ordinal) || ordinal < 1) return null;
  let rest = (numbered[2] ?? '').trim();
  let checked: boolean | undefined;
  const marker = [...CHECKED_MARKERS, ...UNCHECKED_MARKERS].find(candidate => rest.startsWith(candidate));
  if (marker) {
    checked = CHECKED_MARKERS.includes(marker);
    rest = rest.slice(marker.length).trim();
  }
  return { line: index, ordinal, text: rest, cursor, checked };
}

/** Derive the ONE bottom/live structured-menu block, or `null` when no such
 * block can be bound — in which case every caller refuses with zero keys.
 *
 * Why a block at all: a tmux capture is a scrollback, not a screen. An old,
 * already-answered question and its numbered rows sit above whatever is live
 * now. Pane-global evidence let the daemon combine a stale question found high
 * in scrollback with an unrelated selector's cursor row below it, then drive
 * Down/Enter or Escape into that unrelated selector. Binding all evidence to one
 * contiguous region makes that combination structurally impossible.
 *
 * Boundaries, all conservative — when in doubt the block ENDS:
 *  - ANCHOR: the LAST numbered row in the capture. The live menu is always the
 *    lowest one; anything below it is footer, not another menu.
 *  - ROWS: walk up from the anchor accepting rows whose ordinals descend by
 *    exactly one (N, N-1, … 1). A row that breaks the run belongs to a different
 *    menu and stops the walk, as does a run of more than MENU_ROW_GAP_LINES
 *    non-row lines. Interleaved descriptions, blanks and separator rules inside
 *    the gap are kept — that is the real Claude shape (options, descriptions,
 *    "Type something", a rule, "Chat about this").
 *  - INTRO: at most MENU_INTRO_LINES above the first row, stopping at ANY of a
 *    previous menu's numbered row, a menu footer line, or a blank run longer
 *    than MENU_INTRO_BLANK_RUN. This is the only region a question or header may
 *    be read from.
 *  - FOOTER: at most MENU_FOOTER_LINES below the last row, stopping at a
 *    numbered row.
 * Two further whole-block rejections: more than one cursor glyph among the rows
 * (two menus stitched, or a half-drawn repaint — the origin is unknowable), and
 * any bare composer row BELOW the rows (an input prompt owns the keyboard, so
 * the menu is scrollback). */
export function liveMenuBlock(pane: string): LiveMenuBlock | null {
  const lines = pane.split('\n');
  const parsed = lines.map((line, index) => parseMenuRow(line, index));
  let anchor = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (parsed[index]) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) return null;

  const rows: MenuBlockRow[] = [parsed[anchor]!];
  let expected = parsed[anchor]!.ordinal - 1;
  let gap = 0;
  for (let index = anchor - 1; index >= 0 && expected >= 1; index--) {
    const row = parsed[index];
    if (!row) {
      // A footer, another question row or a composer between two numbered rows
      // is a HARD boundary, not a description to be skipped over. Treating them
      // as ordinary gap lines let a clipped lower menu (row 1 scrolled off) be
      // stitched to a stale row 1 sitting above an old footer — one "block"
      // spanning two menus, carrying two cursor glyphs.
      const value = lines[index]!.trim();
      if (menuFooterLine(value) || isQuestionAnchorLine(lines[index]!) || isComposerRow(lines[index]!)) break;
      if (++gap > MENU_ROW_GAP_LINES) break;
      continue;
    }
    // A row that does not continue the descending run is a DIFFERENT menu.
    if (row.ordinal !== expected) break;
    rows.unshift(row);
    expected--;
    gap = 0;
  }
  // Two cursor glyphs in one cluster means two menus were stitched together, or
  // a repaint is half-drawn. Either way the navigation origin is unknowable.
  if (rows.filter(row => row.cursor).length > 1) return null;

  const firstRow = rows[0]!.line;
  const lastRow = rows[rows.length - 1]!.line;
  // A bare composer BELOW the rows means an input prompt has the keyboard and
  // this menu is scrollback — the idle-prompt-under-an-old-question shape that
  // otherwise pinned a pending question forever.
  for (let index = lastRow + 1; index < lines.length; index++) {
    if (isComposerRow(lines[index]!)) return null;
  }
  let startLine = firstRow;
  let blanks = 0;
  for (let index = firstRow - 1; index >= 0 && firstRow - index <= MENU_INTRO_LINES; index--) {
    if (parsed[index]) break;
    const value = lines[index]!.trim();
    if (menuFooterLine(value) || isComposerRow(lines[index]!)) break;
    if (value === '') {
      if (++blanks > MENU_INTRO_BLANK_RUN) break;
    } else blanks = 0;
    startLine = index;
  }
  let endLine = lastRow;
  for (let index = lastRow + 1; index < lines.length && index - lastRow <= MENU_FOOTER_LINES; index++) {
    if (parsed[index]) break;
    endLine = index;
  }

  // Exactly one cursor row survives the check above, so "the" cursor is unambiguous.
  const cursor = rows.find(row => row.cursor);
  const cursorRow = cursor ? cursor.ordinal - 1 : undefined;
  return {
    text: lines.slice(startLine, endLine + 1).join('\n'),
    intro: lines.slice(startLine, firstRow).join('\n'),
    rowsText: lines.slice(firstRow, lastRow + 1).join('\n'),
    startLine,
    endLine,
    rows,
    cursorRow,
  };
}

/** Is `label` a real numbered row OF THIS BLOCK? The block-bound replacement for
 * `exactOptionRowVisible` everywhere a keystroke depends on the answer. */
export function blockOptionRowVisible(block: LiveMenuBlock, label: string): boolean {
  return block.rows.some(row => rowTextMatchesLabel(row.text, label));
}

/** Does the live block structurally render THIS option set, in THIS order?
 *
 * Question text alone must never authorize a key. Freeform answers and abandon
 * carry no selected-label gate at all, so without this a pending question phrase
 * quoted in an unrelated live selector's intro or prose would resolve a singleton
 * and send Enter or Escape straight into that selector. The binding demanded here
 * is POSITIONAL and it binds the whole SET, not one label: option `i` must be
 * the row printed at ordinal `i + 1`, and ANY row in that ordinal range that
 * disagrees rejects the block outright. A single shared or generic label
 * ("Yes", "Continue") therefore cannot bind an unrelated selector to us.
 *
 * The one concession to real captures is that a row may be a WRAPPED or
 * ELLIPSIS-CLIPPED prefix of its label rather than the whole thing, and a row
 * that is not on screen at all (clipped menu) is neither agreement nor conflict.
 * At least one row must still be positively observed. A question that renders no
 * options has nothing to bind against, so it never authorizes a key. */
export function blockBindsOptions(block: LiveMenuBlock, labels: string[]): boolean {
  if (labels.length === 0) return false;
  let observed = 0;
  for (const [index, label] of labels.entries()) {
    const row = block.rows.find(candidate => candidate.ordinal === index + 1);
    if (!row) continue;
    if (!rowAgreesWithLabel(row.text, label)) return false;
    observed++;
  }
  return observed > 0;
}

/** Does a row's text belong to `label` — exactly, or as the prefix a wrap or an
 * ellipsis truncation leaves behind? Deliberately one-directional: the row must
 * be a prefix of the LABEL, so a longer unrelated row never agrees. */
function rowAgreesWithLabel(text: string, label: string): boolean {
  if (rowTextMatchesLabel(text, label)) return true;
  const row = normalizeForMatch(text).replace(/[….]+$/u, '');
  const wanted = normalizeForMatch(label);
  return row.length >= 4 && wanted.startsWith(row);
}

export type StructuredQuestionMatchReason =
  | 'block_missing'
  | 'menu_unbound'
  | 'question_missing'
  | 'prompt_ready'
  | 'option_missing';

export interface StructuredQuestionPaneMatch {
  ok: boolean;
  reason?: StructuredQuestionMatchReason;
  questionProbe: string;
  questionVisible: boolean;
  promptReady: boolean;
  /** Inclusive pane-line bounds of the block every field below was read from;
   * `null` when no live block could be bound at all. */
  block: { startLine: number; endLine: number; rows: number } | null;
  selected: Array<{
    label: string;
    distinctiveFragment: string | null;
    exactRowVisible: boolean;
    fragmentVisible: boolean;
  }>;
}

/** Detailed form of the safety gate. The journal records this object on every
 * refusal, so the next report says what the matcher actually saw instead of
 * collapsing all causes into “not visible”.
 *
 * EVERY field is read from ONE `liveMenuBlock`: the question probe from the
 * block's intro, the option rows from the block's rows, the wrap/truncation
 * fragment from the block's row region. Nothing is read from the wider capture,
 * so a stale question high in scrollback can never be combined with a live
 * unrelated selector's rows below it. No block ⇒ `block_missing` ⇒ refusal. */
export function structuredQuestionPaneMatch(args: {
  pane: string;
  question: string;
  options: string[];
  selected: string[];
  promptReady: boolean;
}): StructuredQuestionPaneMatch {
  const block = liveMenuBlock(args.pane);
  // Intro carries the question/header; rows carry labels and their wrapped
  // continuations. Keeping them apart stops a description inside the rows from
  // standing in for the question, and block prose from standing in for a label.
  const intro = block ? normalizeForMatch(block.intro) : '';
  const rowsText = block ? normalizeForMatch(block.rowsText) : '';
  const questionProbe = normalizeForMatch(args.question).slice(0, 40);
  // A structural question ROW, never an intro substring: an unrelated selector's
  // intro can quote our question in prose, and with a shared option set that was
  // enough to hand it both answer and abandon.
  const questionVisible = !!block && questionRowIndex(block.intro, args.question) >= 0;
  // The block must be THIS question's menu, not merely a menu whose intro quotes
  // its text. Freeform answers supply no selected labels, so without this the
  // option check below would be vacuous and prose could authorize Enter.
  const menuBound = !!block && blockBindsOptions(block, args.options);
  const selected = args.selected.map(label => {
    const distinctiveFragment = distinctiveOptionFragment(label, args.options);
    return {
      label,
      distinctiveFragment,
      exactRowVisible: !!block && blockOptionRowVisible(block, label),
      fragmentVisible: !!block && distinctiveFragment !== null && rowsText.includes(distinctiveFragment),
    };
  });
  const reason: StructuredQuestionMatchReason | undefined = !block
    ? 'block_missing'
    : !menuBound
      ? 'menu_unbound'
      : !questionVisible
        ? 'question_missing'
        : args.promptReady
          ? 'prompt_ready'
          : selected.some(option => !option.exactRowVisible && !option.fragmentVisible)
            ? 'option_missing'
            : undefined;
  return {
    ok: reason === undefined,
    reason,
    questionProbe,
    questionVisible,
    promptReady: args.promptReady,
    block: block ? { startLine: block.startLine, endLine: block.endLine, rows: block.rows.length } : null,
    selected,
  };
}

/** Is this question the one the LIVE block is asking? Bound to a structural
 * question row inside the block's intro region, so neither the same phrase
 * elsewhere in the capture nor a prose quote inside the intro counts. */
export function questionVisibleOnPane(pane: string, question: string): boolean {
  const block = liveMenuBlock(pane);
  return !!block && questionRowIndex(block.intro, question) >= 0;
}

export type VisibleQuestionReason = 'no_block' | 'no_candidate' | 'unbound' | 'ambiguous';

/** Per-candidate evidence behind a resolution. Booleans and ordinals only — a
 * refusal can be journalled in full without copying pane text. */
export interface VisibleQuestionEvidence {
  index: number;
  /** This question's probe cannot be produced by any OTHER candidate's text. */
  questionDistinct: boolean;
  /** A header only this candidate owns is the live block's own header row. */
  headerDistinct: boolean;
  /** An option label only this candidate owns is a numbered row OF THE LIVE
   * BLOCK. */
  optionDistinct: boolean;
  /** Nothing else this set could render sits BELOW it inside the block's intro
   * (it is the live question, not an earlier one repainted above). */
  lastRendered: boolean;
}

export interface VisibleQuestionResolution {
  /** The uniquely identified ordinal, or -1 when it cannot be pinned down. */
  index: number;
  /** Every ordinal whose text could account for the LIVE BLOCK. */
  candidates: number[];
  reason?: VisibleQuestionReason;
  evidence: VisibleQuestionEvidence[];
  /** Inclusive pane-line bounds of the block the resolution was read from. */
  block: { startLine: number; endLine: number; rows: number } | null;
}

/** A normalized signature is usable as an identifier only when nothing else the
 * set could render on the pane contains it — the same no-sibling-collision rule
 * `distinctiveOptionFragment` applies to option labels, applied to whole
 * questions/headers/labels across the ordinals of one question set. */
function distinctInCorpus(signature: string, corpus: string): boolean {
  return signature.length >= 4 && !corpus.includes(signature);
}

/** Which pending ordinal is on screen — and, crucially, whether that can be
 * known at all. Identifying a menu by question text alone is unsafe: a set may
 * ask the SAME question twice (Claude allows it), so the text, its position and
 * any tie-break over positions are all satisfied equally by two ordinals. The
 * daemon then starts a drive at the wrong ordinal and answers the wrong menu
 * with the wrong choice list — strictly worse than not answering at all.
 *
 * So an ordinal is returned only when exactly one candidate is BOTH the
 * last-rendered one and carries a signature (its own question text, its header,
 * or one of its option labels) that no other candidate could have produced.
 * Otherwise the resolution is `ambiguous` and every caller must refuse before
 * sending a key. `candidates` reports what stayed plausible so a refusal can say
 * which ordinals collided.
 *
 * ALL of that is evaluated against ONE `liveMenuBlock` and nothing else:
 *  - candidacy needs the question probe in the block's INTRO region, so a
 *    singleton is never accepted merely because its text exists somewhere in the
 *    capture, and the same phrase quoted in unrelated prose does not count;
 *  - header and option signatures must be the block's own header row and the
 *    block's own numbered rows.
 * With no block there is nothing a key could legally be aimed at, so the
 * resolution is `no_block` and every caller refuses. */
export function resolveVisibleQuestion(
  pane: string,
  questions: PendingQuestion['questions'],
): VisibleQuestionResolution {
  const block = liveMenuBlock(pane);
  if (!block) return { index: -1, candidates: [], reason: 'no_block', evidence: [], block: null };
  const bounds = { startLine: block.startLine, endLine: block.endLine, rows: block.rows.length };
  const texts = questions.map(question => normalizeForMatch(question.question));
  const probes = texts.map(text => text.slice(0, QUESTION_PROBE_CHARS));
  // Position = the intro LINE this question is printed on as its own row. A
  // substring hit is not candidacy: prose in an unrelated selector's intro
  // quotes earlier questions all the time.
  const positions = questions.map(question => questionRowIndex(block.intro, question.question));
  const spoken = questions.map((_, index) => index).filter(index => positions[index]! >= 0);
  // Text in the intro is NECESSARY but never SUFFICIENT: the block must also be
  // rendering this candidate's own option set at its own ordinals. Otherwise a
  // pending question quoted in an unrelated live selector's intro would resolve
  // as a singleton and authorize Enter/Escape into that selector — the exact
  // cross-menu failure this binding exists to make impossible.
  const candidates = spoken.filter(index =>
    blockBindsOptions(
      block,
      (questions[index]!.options ?? []).map(option => option.label),
    ),
  );
  if (candidates.length === 0)
    return {
      index: -1,
      candidates,
      reason: spoken.length > 0 ? 'unbound' : 'no_candidate',
      evidence: [],
      block: bounds,
    };
  // Only one ordinal of this set can account for the LIVE BLOCK: no sibling
  // exists to be confused with, so the probe match IS unique (unchanged
  // behaviour for the ordinary single-question case, now block-bound).
  if (candidates.length === 1) return { index: candidates[0]!, candidates, evidence: [], block: bounds };
  const lastPosition = Math.max(...candidates.map(index => positions[index]!));
  const evidence = candidates.map<VisibleQuestionEvidence>(index => {
    const question = questions[index]!;
    // Everything the OTHER plausible ordinals could put on this pane. A
    // signature found here proves nothing about which ordinal we are looking at.
    const corpus = candidates
      .filter(other => other !== index)
      .flatMap(other => {
        const sibling = questions[other]!;
        return [
          texts[other]!,
          normalizeForMatch(sibling.header ?? ''),
          ...(sibling.options ?? []).map(option => normalizeForMatch(option.label)),
        ];
      })
      .join(' ');
    // Both signatures demand STRUCTURAL evidence INSIDE THE BLOCK, never a pane
    // substring: a description, a wrapped line or old scrollback can contain a
    // header or a label verbatim, and a hit there would pin the ordinal on text
    // that is not the live menu at all. A false refusal costs a retry; a guessed
    // ordinal answers a menu we cannot see with another menu's choices.
    const header = question.header ?? '';
    const optionDistinct = (question.options ?? []).some(option => {
      const label = normalizeForMatch(option.label);
      if (!distinctInCorpus(label, corpus)) return false;
      return blockOptionRowVisible(block, option.label);
    });
    return {
      index,
      questionDistinct: distinctInCorpus(probes[index]!, corpus),
      headerDistinct: distinctInCorpus(normalizeForMatch(header), corpus) && exactHeaderRowVisible(block.intro, header),
      optionDistinct,
      lastRendered: positions[index] === lastPosition,
    };
  });
  const identified = evidence.filter(
    item => item.lastRendered && (item.questionDistinct || item.headerDistinct || item.optionDistinct),
  );
  if (identified.length === 1) return { index: identified[0]!.index, candidates, evidence, block: bounds };
  return { index: -1, candidates, reason: 'ambiguous', evidence, block: bounds };
}

/** The ordinal that is on screen, or `-1` when the frame cannot pin one down.
 * ORDINAL and PRESENCE are deliberately separate functions: an ordinal is a
 * thing keys get driven from, so ambiguity here is a refusal, never a fallback
 * guess. Anything asking only “is a question still up?” must call
 * `anyQuestionVisible`, which answers that without exposing an ordinal. */
export function visibleQuestionIndex(pane: string, questions: PendingQuestion['questions']): number {
  return resolveVisibleQuestion(pane, questions).index;
}

/** PRESENCE probe: is ANY question of this set still rendered on the pane? This
 * is all the self-heal and cancel gates ask, and they need it OPTIMISTIC — two
 * identically-worded ordinals colliding must still read as “a question is up”,
 * or they would clear live question state or fire Escape at a frame that is not
 * theirs. No ordinal is returned precisely because none can be trusted here. */
export function anyQuestionVisible(pane: string, questions: PendingQuestion['questions']): boolean {
  if (resolveVisibleQuestion(pane, questions).candidates.length > 0) return true;
  // The structured FREE-TEXT page ("Other" / "Type something") is legitimately
  // not a menu block at all: the numbered rows are replaced by a composer. It is
  // still this question, and a human may be mid-answer in it — reporting it as
  // gone would let the self-heal monitor clear the pending question out from
  // under them. But this is the ONE place presence may look outside a menu
  // block, so it is bounded exactly as strictly: the live bottom free-text
  // region with an explicit marker, and the question as its OWN row inside it.
  // A pane-wide substring plus a bare `❯` reads an ordinary idle prompt under an
  // old question as presence, which pins a closed question forever.
  return questions.some(question => freeTextPageShowsQuestion(pane, question.question));
}

/** Structural proof that THIS set's menu — not a repaint, an idle prompt, an
 * unrelated selector or scrollback text — is live on the pane. Escape is only
 * safe against such a frame; at an idle Codex prompt it quits the TUI, and at an
 * unrelated selector it answers somebody else's menu.
 *
 * Three things must hold IN THE SAME BLOCK: this set's question text in its
 * intro, this set's option row order at its ordinals (both carried by candidacy),
 * and the native selection cursor. The cursor requirement is what separates a
 * live, focused menu from numbered OUTPUT that merely looks like one — Escape
 * against the latter is a keystroke into whatever actually has focus. A cursor
 * alone was never enough either: an unrelated live selector always has one. */
export function structuredMenuVisible(pane: string, questions: PendingQuestion['questions']): boolean {
  const block = liveMenuBlock(pane);
  if (!block || block.cursorRow === undefined) return false;
  return resolveVisibleQuestion(pane, questions).candidates.length > 0;
}

/** The navigation origin: the 0-based option index the native cursor sits on,
 * read from the LIVE BLOCK only.
 *
 * A capture routinely holds an earlier, already-answered menu in scrollback with
 * its own frozen cursor glyph, and may hold an unrelated live selector too.
 * Reading either as the origin makes every subsequent `Down`/`Up` count from the
 * wrong place and selects whatever happens to sit that far away — a silently
 * wrong answer. Taking the cursor from the same block the question and option
 * rows were proven in is what makes the movement count meaningful. */
function blockMenuCursor(block: LiveMenuBlock, optionCount: number): number | undefined {
  const index = block.cursorRow;
  // Claude appends both “Type something” (optionCount) and “Chat about this”
  // (optionCount + 1). A human may have moved the native cursor there before
  // answering from the web UI; retaining that real origin lets us navigate
  // back to the requested row instead of assuming row 1 and mis-selecting.
  return index !== undefined && index <= optionCount + 1 ? index : undefined;
}

/** The checkbox state the pane actually shows for each option, in option order;
 * `undefined` where the row is absent or carries no marker we recognize.
 *
 * Multi-select cannot be driven by toggling only the wanted rows: that assumes
 * every box starts empty. A human at the pane (kteam attach is supported) may
 * have ticked boxes already, in which case a blind toggle un-ticks a wanted
 * option and leaves an unwanted one ticked — a silently wrong answer. Reading
 * the markers lets the drive toggle exactly the mismatches, and an unreadable
 * row makes the caller refuse instead of guessing. */
export function visibleMultiSelectState(pane: string, labels: string[]): Array<boolean | undefined> {
  const block = liveMenuBlock(pane);
  return block ? blockMultiSelectState(block, labels) : labels.map(() => undefined);
}

/** The block-bound form the driver uses: checkbox state is read from the SAME
 * rows the question and the selected options were proven in, never from a
 * scrollback copy of the menu whose ticks are frozen at whatever they were when
 * it scrolled past. With no live block every option reads `undefined`, which
 * makes the caller refuse. */
export function blockMultiSelectState(block: LiveMenuBlock, labels: string[]): Array<boolean | undefined> {
  return labels.map(label => {
    if (!normalizeForMatch(label)) return undefined;
    const matches = block.rows.filter(row => rowTextMatchesLabel(row.text, label));
    // Two rows carrying the same label are as unknowable as none.
    if (matches.length !== 1) return undefined;
    return matches[0]!.checked;
  });
}

/** Evidence that the free-text page of a structured question is open and ready
 * to receive typing: an empty composer row, or the harness's own type-your-
 * answer hint. Typing before this page renders puts the text into the MENU. */
export function paneShowsFreeformComposer(pane: string): boolean {
  return freeformComposerLine(pane) !== undefined;
}

/** The LOWEST line carrying free-text-page evidence, or `undefined` for none.
 * DIAGNOSTIC/shape helper only — it cannot tell a live free-text page from a
 * bare idle prompt. Everything that authorizes typing or reports presence uses
 * `freeTextQuestionRegion`. */
export function freeformComposerLine(pane: string): number | undefined {
  let found: number | undefined;
  pane.split('\n').forEach((line, index) => {
    if (isFreeTextMarkerRow(line)) {
      found = index;
      return;
    }
    if (isComposerRow(line)) found = index;
  });
  return found;
}

/** The harness's own "now type" hint, as a whole ROW.
 *
 * An explicit marker is mandatory because a bare `❯` is what an ORDINARY IDLE
 * PROMPT looks like, so glyph-only evidence cannot tell a live free-text page
 * from a session at rest. But the marker must be structural for the same reason
 * the question must be: a substring scrape accepts ordinary prose — "You can
 * type your answer later" a few lines above an idle prompt — and hands the drive
 * a forged free-text page. So the chrome-stripped line must BE the hint: it
 * starts with it, and carries nothing after it but punctuation or a
 * parenthesised key hint. */
const FREE_TEXT_MARKER_ROW =
  /^type\s+(?:your\s+)?(?:answer|response|reply|something)\b[\s.…:!]*(?:\([^)]*\))?[\s.…]*$/i;

function isFreeTextMarkerRow(line: string): boolean {
  const stripped = (line.split(/[│┃]/u)[0] ?? line).replace(/^[\s│|┃╭╰┌└>›❯»*•‣–—-]+/u, '').trim();
  return FREE_TEXT_MARKER_ROW.test(stripped);
}
/** Lines above the marker in which the question may be read. */
const FREE_TEXT_INTRO_LINES = 4;
/** How far above its composer the marker may sit. */
const FREE_TEXT_MARKER_GAP = 4;

export interface FreeTextRegion {
  markerLine: number;
  composerLine: number;
  /** The bounded lines ending at the marker — the ONLY place the question may
   * be read from for this region to count. */
  intro: string;
}

/** The ONE live free-text region at the bottom of the pane, or `null`.
 *
 * The structured "Other"/"Type something" page is legitimately not a menu block
 * — its rows are replaced by a composer — so it needs its own bounded proof, or
 * the loose version of this check does real damage in both directions: it lets
 * an old question plus any bare `❯` read as presence forever (self-heal can then
 * never clear a closed question), and it lets the drive type a freeform answer
 * into an ordinary idle prompt as a brand-new message.
 *
 * Bounds, all required:
 *  - the BOTTOM composer row of the pane (a lower one means this region is not
 *    the live one);
 *  - an explicit `Type your answer`-style marker within FREE_TEXT_MARKER_GAP
 *    lines above it, never a bare glyph, and never a numbered menu row that
 *    merely contains the words;
 *  - nothing but blanks and box chrome between the marker and its composer, so
 *    an older page's hint cannot claim an unrelated composer further down;
 *  - no live menu block at or below the marker — if a menu is still rendered
 *    there, the free-text page is scrollback and that menu owns the keyboard. */
export function freeTextQuestionRegion(pane: string): FreeTextRegion | null {
  const lines = pane.split('\n');
  let composerLine = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (isComposerRow(lines[index]!)) {
      composerLine = index;
      break;
    }
  }
  if (composerLine < 0) return null;
  let markerLine = -1;
  for (let index = composerLine - 1; index >= 0 && composerLine - index <= FREE_TEXT_MARKER_GAP; index--) {
    if (isFreeTextMarkerRow(lines[index]!) && !parseMenuRow(lines[index]!, index)) {
      markerLine = index;
      break;
    }
  }
  if (markerLine < 0) return null;
  for (let index = markerLine + 1; index < composerLine; index++) {
    if (lines[index]!.replace(/[\s│|┃╭╰┌└╮╯┐┘─━]/gu, '') !== '') return null;
  }
  const block = liveMenuBlock(pane);
  if (block && block.endLine >= markerLine) return null;
  return {
    markerLine,
    composerLine,
    intro: lines.slice(Math.max(0, markerLine - FREE_TEXT_INTRO_LINES), markerLine + 1).join('\n'),
  };
}

/** Is THIS question the one the live free-text region is collecting an answer
 * for? Structural on both axes: the region must be the live bottom one, and the
 * question must be its own row inside that region. */
export function freeTextPageShowsQuestion(pane: string, question: string): boolean {
  const region = freeTextQuestionRegion(pane);
  return !!region && questionRowIndex(region.intro, question) >= 0;
}

export interface StructuredAnswerOutcome {
  toolUseId: string;
  startedAtQuestion: number;
  answeredQuestions: number;
  confirmedBy: 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced';
}

export class StructuredQuestionDriveError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StructuredQuestionDriveError';
  }
}

/** Pure precondition for driving the interactive structured-question menu by
 *  index. Returns a refusal message, or `null` to proceed. The daemon must
 *  never type into a menu it cannot confirm is on screen — a wrong keystroke
 *  answers the wrong option, which is far worse than refusing — so this gate
 *  requires: the question text is visible, the pane is NOT back at an idle
 *  prompt, and every option we intend to select is unambiguously visible.
 *  A freeform-only answer supplies no `selected` labels, so the option check
 *  is vacuous (unchanged behaviour). */
export function structuredAnswerRefusal(args: {
  pane: string;
  question: string;
  options: string[];
  selected: string[];
  promptReady: boolean;
}): string | null {
  return structuredQuestionPaneMatch(args).ok ? null : STRUCTURED_ANSWER_NOT_VISIBLE;
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
    await this.waitReady(config.tmuxSession, LAUNCH_READY_TIMEOUT_MS, true, {
      resumeMenuChoice: config.resumeMenuChoice,
    });
  }

  async waitReady(
    name: string,
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
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

  async inject(name: string, text: string): Promise<InjectionOutcome> {
    // fillComposer owns the ONLY text-entry retry. It retries three times while
    // there is no landing evidence, and returns exactly once a copy is proven
    // present. From that point on this method may retry Enter, but must NEVER
    // retype: the TUI may have consumed a native command and already performed
    // an arbitrary side effect even when no model turn starts.
    const evidence = await this.fillComposer(name, text).catch(error => {
      if (/text did not land in the composer/i.test(String(error)))
        throw new Error('text did not land in the interactive input box');
      throw error;
    });

    // Enter can be swallowed while the TUI repaints. It is safe to press Enter
    // again only while the original payload is demonstrably still in the
    // composer; once it disappears, delivery has been consumed and is final.
    for (let submit = 0; submit < 3; submit++) {
      const enter = await this.keys(name, 'Enter');
      if (enter.code !== 0) throw new Error(enter.stderr.trim() || 'tmux submit failed');
      for (let poll = 0; poll < 12; poll++) {
        await Bun.sleep(this.injectionPollMs);
        const current = await this.state(name);
        if (!current.alive || current.dead || paneShowsActiveWork(current.visiblePane)) return 'turn-started';

        // Exact `/model` opens Codex's native model+effort selector. The pane
        // often retains `› /model` above it, which composerHolds() cannot
        // distinguish from an occupied composer. A selector heading proves the
        // first Enter was consumed; pressing another would make a choice for
        // the user. This local action is therefore complete after ONE Enter.
        if (text.trim() === '/model' && paneShowsModelSelector(current.visiblePane)) return 'handled-local';

        // promptReady is positive evidence that the cursor is back at an empty
        // composer. Check it before the broad pane text probe: local output may
        // echo the submitted command in scrollback, but that does not mean the
        // composer still holds it.
        if (current.promptReady) return 'handled-local';

        // The payload left the composer and the pane advanced to a non-idle
        // state (a normal turn beginning, a selector, or another local result).
        // Either way it was consumed, so success is final and retyping would be
        // unsafe. Preserve the established normal-turn classification here.
        if (!composerHolds(current.visiblePane, text, evidence)) return 'turn-started';
      }
    }
    throw new Error('the prompt landed but remained in the interactive input box after submit retries');
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

  async send(config: SessionConfig, text: string): Promise<InjectionOutcome> {
    // Startup dialogs (trust prompts, api-key confirmation) can surface late,
    // after launch()'s readiness gate — answer them here too so the injected
    // prompt is never queued behind a modal.
    const interactive = config.mode === 'interactive';
    await this.waitReady(
      config.tmuxSession,
      interactive ? INTERACTIVE_READY_TIMEOUT_MS : AUTOMODE_READY_TIMEOUT_MS,
      true,
      {
        resumeMenuChoice: config.resumeMenuChoice,
      },
    ).catch(async error => {
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
    return await this.inject(config.tmuxSession, text);
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

  /** Frame cadence while waiting for a landed input to be consumed. Kept as a
   *  field so the fixture-driven exactly-once tests exercise the real loop
   *  without sleeping. */
  protected readonly injectionPollMs: number = 500;

  /** Structured menus repaint asynchronously. Tests override these fields so
   * the real confirmation loop runs against fixtures without wall-clock waits. */
  protected readonly questionPollMs: number = 100;
  protected readonly questionConfirmationPolls: number = 50;

  /** The composer path's ONLY keystroke primitive. A single seam so landing
   *  verification (which must never press C-u over a delivered paste) can be
   *  tested against recorded frames instead of a live tmux server. */
  protected async keys(name: string, ...keys: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return await run(['tmux', 'send-keys', '-t', name, ...keys]);
  }

  /** Leave tmux copy-mode without sending a key to the harness. A structured
   * menu can be perfectly healthy underneath a scrolled client; retrying after
   * this is the safe “re-present” step before refusing an answer. */
  protected async exitCopyMode(name: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return await run(['tmux', 'copy-mode', '-q', '-t', name]);
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
    await this.waitReady(name, AUTOMODE_READY_TIMEOUT_MS);
  }

  private async questionKey(name: string, ...keys: string[]): Promise<void> {
    const result = await this.keys(name, ...keys);
    if (result.code !== 0)
      throw new StructuredQuestionDriveError(result.stderr.trim() || 'tmux structured-question key failed', {
        phase: 'send-key',
        keys,
        exitCode: result.code,
      });
  }

  private async moveQuestionCursor(name: string, from: number, to: number): Promise<void> {
    const key = to >= from ? 'Down' : 'Up';
    for (let cursor = 0; cursor < Math.abs(to - from); cursor++) await this.questionKey(name, key);
  }

  private async waitForQuestionAdvance(
    name: string,
    pending: PendingQuestion,
    questionIndex: number,
    beforePane: string,
  ): Promise<{ pane: PaneState; confirmedBy: StructuredAnswerOutcome['confirmedBy'] }> {
    let last = await this.state(name);
    for (let poll = 0; poll < this.questionConfirmationPolls; poll++) {
      if (poll > 0) await Bun.sleep(this.questionPollMs);
      last = poll === 0 ? last : await this.state(name);
      if (!last.alive || last.dead)
        throw new StructuredQuestionDriveError('session pane died while confirming the structured answer', {
          phase: 'confirm',
          questionIndex,
          paneAlive: last.alive,
          paneDead: last.dead,
        });
      // Advance proof must be UNIQUE too: with duplicate wording the optimistic
      // presence ordinal could read as "moved on" while the same menu is still
      // up. An unresolvable frame simply is not proof, so keep polling.
      const resolved = resolveVisibleQuestion(last.visiblePane, pending.questions);
      const activeIndex = resolved.index;
      if (questionIndex < pending.questions.length - 1) {
        if (activeIndex > questionIndex && !last.promptReady) return { pane: last, confirmedBy: 'next-question' };
      } else {
        if (paneShowsActiveWork(last.visiblePane)) return { pane: last, confirmedBy: 'turn-started' };
        if (last.promptReady) return { pane: last, confirmedBy: 'prompt-ready' };
        // `pane-advanced` is the weakest tier, so it requires that this question
        // is genuinely gone — no candidate of the set is on screen — rather than
        // merely unresolvable (an ambiguous frame still shows a question).
        if (resolved.candidates.length === 0 && last.visiblePane !== beforePane)
          return { pane: last, confirmedBy: 'pane-advanced' };
      }
    }
    const final = resolveVisibleQuestion(last.visiblePane, pending.questions);
    throw new StructuredQuestionDriveError(
      'the answer was typed, but the question pane did not advance; no success was recorded — retry or abandon the question',
      {
        phase: 'confirm',
        questionIndex,
        activeQuestionIndex: final.index,
        candidates: final.candidates,
        ambiguous: final.reason === 'ambiguous',
        promptReady: last.promptReady,
        activeWork: paneShowsActiveWork(last.visiblePane),
      },
    );
  }

  async answerQuestion(
    config: SessionConfig,
    state: SessionState,
    labels: string[],
    other?: string,
    responses?: string[],
  ): Promise<StructuredAnswerOutcome> {
    const pending = state.pendingQuestion;
    if (!pending) throw new Error('session has no pending structured question');
    if (other && pending.questions.length !== 1)
      throw new Error('use one --response per question when multiple questions are pending');
    if (responses && responses.length !== pending.questions.length)
      throw new Error(`expected ${pending.questions.length} --response values`);
    let current = await this.state(config.tmuxSession);
    let resolution = resolveVisibleQuestion(current.visiblePane, pending.questions);
    // A user can scroll the tmux client while the menu remains active. Exit
    // copy-mode once and re-read before declaring the pane unanswerable.
    if (resolution.index < 0 || current.promptReady) {
      await this.exitCopyMode(config.tmuxSession).catch(() => undefined);
      current = await this.state(config.tmuxSession);
      resolution = resolveVisibleQuestion(current.visiblePane, pending.questions);
    }
    if (!current.alive || current.dead)
      throw new StructuredQuestionDriveError('session pane is dead; use resume', {
        phase: 'preflight',
        paneAlive: current.alive,
        paneDead: current.dead,
      });
    // Ambiguity is its own refusal, distinct from "no question on screen". A set
    // that asks the same thing twice leaves two ordinals equally consistent with
    // the pane; starting the drive at either would answer a menu we cannot see
    // with the choices meant for the other one. Refuse with zero keys and name
    // the colliding ordinals so the retry/abandon controls stay actionable.
    if (resolution.reason === 'ambiguous')
      throw new StructuredQuestionDriveError(
        `cannot tell which of ${resolution.candidates.length} identically-worded questions is on screen (candidates ${resolution.candidates.join(', ')}); abandon the question and re-ask`,
        {
          phase: 'preflight',
          reason: 'ambiguous_question',
          candidates: resolution.candidates,
          evidence: resolution.evidence,
          promptReady: current.promptReady,
          questionCount: pending.questions.length,
        },
      );
    // `unbound` is its own diagnosis and the one Davis's cross-menu shape lands
    // on: the pending question's text was found, but the live block is rendering
    // SOMEBODY ELSE'S option set. Saying so keeps the report honest instead of
    // claiming the question simply scrolled away.
    if (resolution.index < 0)
      throw new StructuredQuestionDriveError(
        resolution.reason === 'unbound'
          ? 'the live menu on the pane is not this question’s menu (its options are not the ones on screen); retry or abandon the question'
          : 'the structured question is not visible after restoring the pane; retry or abandon the question',
        {
          phase: 'preflight',
          reason: resolution.reason === 'unbound' ? 'menu_unbound' : 'question_missing',
          block: resolution.block,
          promptReady: current.promptReady,
          questionCount: pending.questions.length,
        },
      );

    let questionIndex = resolution.index;
    const startedAtQuestion = questionIndex;
    let answeredQuestions = 0;
    let confirmedBy: StructuredAnswerOutcome['confirmedBy'] = 'pane-advanced';
    for (; questionIndex < pending.questions.length; questionIndex++) {
      const question = pending.questions[questionIndex]!;
      const pane = current.visiblePane;
      const options = question.options ?? [];
      const response = responses?.[questionIndex];
      const selected =
        response === undefined
          ? labels.filter(label => options.some(option => option.label === label))
          : options.some(option => option.label === response)
            ? [response]
            : [];
      const freeform = response !== undefined && selected.length === 0 ? response : other;
      // The daemon navigates this menu purely by INDEX over the stored
      // `options`; this gate only proves the right question is on screen so we
      // never drive it blind. A full-label contiguous match refused any option
      // whose label wrapped across two lines (panel text between the fragments)
      // or was ellipsis-truncated — see structuredAnswerRefusal for the
      // wrap/truncation-safe, mis-answer-proof check.
      let match = structuredQuestionPaneMatch({
        pane,
        question: question.question,
        options: options.map(option => option.label),
        selected,
        promptReady: current.promptReady,
      });
      if (!match.ok) {
        await this.exitCopyMode(config.tmuxSession).catch(() => undefined);
        current = await this.state(config.tmuxSession);
        match = structuredQuestionPaneMatch({
          pane: current.visiblePane,
          question: question.question,
          options: options.map(option => option.label),
          selected,
          promptReady: current.promptReady,
        });
      }
      if (!match.ok)
        throw new StructuredQuestionDriveError(
          `cannot safely locate this question in the terminal (${match.reason}); retry or abandon the question`,
          { phase: 'preflight', questionIndex, match },
        );
      if (selected.length === 0 && !freeform) throw new Error(`no supplied selection matches: ${question.question}`);
      // Mid-set safety: after the first answer the pane has repainted, so the
      // ordinal we are about to drive must still be THE uniquely identified one.
      // A partial retry is supported precisely as far as the evidence goes —
      // when the next page's own question text repeats an earlier one, its
      // header or options must disambiguate it, otherwise we stop here with the
      // questions answered so far intact rather than typing into a guess.
      const here = resolveVisibleQuestion(current.visiblePane, pending.questions);
      if (here.index !== questionIndex)
        throw new StructuredQuestionDriveError(
          here.reason === 'ambiguous'
            ? `cannot tell which of ${here.candidates.length} identically-worded questions is on screen (candidates ${here.candidates.join(', ')}); abandon the question and re-ask`
            : 'the visible question is no longer the one being answered; retry or abandon the question',
          {
            phase: 'preflight',
            reason: here.reason === 'ambiguous' ? 'ambiguous_question' : 'question_moved',
            questionIndex,
            resolvedIndex: here.index,
            candidates: here.candidates,
            evidence: here.evidence,
            answeredQuestions,
          },
        );
      // ONE block for the whole drive of this question: the ordinal above, the
      // option rows in `match`, the navigation origin below and the checkbox
      // read all come from these same lines. Re-deriving per helper would be
      // deterministic, but threading the object makes it impossible for a later
      // edit to reach past the boundary and read the wider capture again.
      const block = liveMenuBlock(current.visiblePane);
      if (!block)
        throw new StructuredQuestionDriveError(
          'no live menu block could be bound on the pane, so no key is safe; retry or abandon the question',
          { phase: 'preflight', reason: 'block_missing', questionIndex },
        );
      // The navigation origin must be OBSERVED, never assumed. `Down`×n from an
      // imagined row 1 selects whatever happens to sit n rows below the real
      // cursor — a wrong answer. A frame with no cursor row is simply not
      // drivable; refuse (retryable) instead of typing blind.
      let cursor = blockMenuCursor(block, options.length);
      if (cursor === undefined)
        throw new StructuredQuestionDriveError(
          'the menu cursor row is not visible, so the selection origin is unknown; retry or abandon the question',
          { phase: 'preflight', reason: 'cursor_missing', questionIndex, optionCount: options.length },
        );
      if (freeform) {
        await this.moveQuestionCursor(config.tmuxSession, cursor, options.length);
        await this.questionKey(config.tmuxSession, 'Enter');
        // Wait for the free-text page to actually render. Typing into a menu
        // that has not paged yet drives the MENU (each character is a shortcut)
        // and leaves the set mid-mutation for the retry.
        let composerReady = false;
        for (let poll = 0; poll < this.questionConfirmationPolls && !composerReady; poll++) {
          await Bun.sleep(this.questionPollMs);
          const frame = (await this.state(config.tmuxSession)).visiblePane;
          // Composer evidence ALONE does not authorize typing. A hint or an
          // empty composer row from an earlier page can sit in scrollback above
          // ANY live selector — ours, or an unrelated one that now has focus —
          // and typing then drives that menu, every character a shortcut. A bare
          // `❯` is worse still: that is what an ordinary IDLE PROMPT looks like,
          // so accepting it types the freeform answer as a brand-new message
          // after an Other that unexpectedly returned to rest.
          // What is required is the live bottom free-text region, carrying an
          // explicit marker, with THIS question printed as its own row in it.
          composerReady = freeTextPageShowsQuestion(frame, question.question);
        }
        if (!composerReady)
          throw new StructuredQuestionDriveError(
            'the free-text page did not open after selecting Other; retry or abandon the question',
            { phase: 'freeform', reason: 'composer_missing', questionIndex },
          );
        await this.fillComposer(config.tmuxSession, freeform);
        await this.questionKey(config.tmuxSession, 'Enter');
      } else if (question.multiSelect) {
        // Toggle only the rows whose CURRENT state differs from what was asked
        // for. Blind-toggling the wanted rows assumes every box starts empty; a
        // human at the pane may have ticked some already, which would un-tick a
        // wanted option and submit an unwanted one.
        const labels = options.map(option => option.label);
        const checkboxes = blockMultiSelectState(block, labels);
        const unreadable = checkboxes.flatMap((state, index) => (state === undefined ? [index] : []));
        if (unreadable.length > 0)
          throw new StructuredQuestionDriveError(
            'the current checkbox selection is not readable on the pane, so a toggle could submit the wrong set; retry or abandon the question',
            { phase: 'preflight', reason: 'selection_unreadable', questionIndex, unreadableOptions: unreadable },
          );
        const toggles = labels.flatMap((label, index) =>
          checkboxes[index] === selected.includes(label) ? [] : [index],
        );
        for (const index of toggles) {
          await this.moveQuestionCursor(config.tmuxSession, cursor, index);
          cursor = index;
          await this.questionKey(config.tmuxSession, 'Space');
        }
        await this.questionKey(config.tmuxSession, 'Enter');
      } else {
        const index = options.findIndex(option => option.label === selected[0]);
        await this.moveQuestionCursor(config.tmuxSession, cursor, index);
        await this.questionKey(config.tmuxSession, 'Enter');
      }
      const advanced = await this.waitForQuestionAdvance(config.tmuxSession, pending, questionIndex, pane);
      current = advanced.pane;
      confirmedBy = advanced.confirmedBy;
      answeredQuestions++;
    }
    return { toolUseId: pending.toolUseId, startedAtQuestion, answeredQuestions, confirmedBy };
  }

  /** Explicit structured-question abandon. Escape is sent only while a menu is
   * STRUCTURALLY on screen (a question of this set plus a real menu row); every
   * poll re-checks before another key. Checking only promptReady/active-work was
   * not enough: an ambiguous repaint frame is neither, and Escape at an idle
   * Codex prompt quits the TUI — so an unrecognizable frame refuses with zero
   * keys and leaves the question pending for a retry. */
  async cancelQuestion(
    config: SessionConfig,
    state: SessionState,
  ): Promise<{ confirmedBy: 'already-advanced' | 'prompt-ready' | 'turn-started' | 'pane-advanced'; pane: PaneState }> {
    const pending = state.pendingQuestion;
    if (!pending) throw new Error('session has no pending structured question');
    let current = await this.state(config.tmuxSession);
    if (!current.alive || current.dead) throw new Error('session pane is dead; use resume');
    const alreadyAdvanced = () => {
      // Presence, not ordinal: an ambiguous frame still means a question is up,
      // and treating it as "gone" would report the set advanced when it has not.
      const visible = anyQuestionVisible(current.visiblePane, pending.questions);
      if (current.promptReady) return 'prompt-ready' as const;
      if (paneShowsActiveWork(current.visiblePane) && !visible) return 'turn-started' as const;
      return undefined;
    };
    const initial = alreadyAdvanced();
    if (initial) return { confirmedBy: 'already-advanced', pane: current };
    await this.exitCopyMode(config.tmuxSession).catch(() => undefined);
    current = await this.state(config.tmuxSession);
    const before = current.visiblePane;
    /** Escape is only safe against a frame we can positively identify as this
     * set's live menu. Refuse rather than send a key into an unknown frame. */
    const refuseUnlessMenu = (phase: string) => {
      if (structuredMenuVisible(current.visiblePane, pending.questions)) return;
      const resolution = resolveVisibleQuestion(current.visiblePane, pending.questions);
      throw new StructuredQuestionDriveError(
        'the pane does not show this question as a live menu, so Escape was not sent; retry or abandon the question',
        {
          phase,
          reason: 'menu_not_visible',
          candidates: resolution.candidates,
          ambiguous: resolution.reason === 'ambiguous',
          promptReady: current.promptReady,
          activeWork: paneShowsActiveWork(current.visiblePane),
        },
      );
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const advanced = alreadyAdvanced();
      if (advanced) return { confirmedBy: advanced, pane: current };
      refuseUnlessMenu('cancel-preflight');
      await this.questionKey(config.tmuxSession, 'Escape');
      for (let poll = 0; poll < Math.max(2, Math.ceil(2_000 / Math.max(1, this.questionPollMs))); poll++) {
        await Bun.sleep(this.questionPollMs);
        current = await this.state(config.tmuxSession);
        if (!current.alive || current.dead) throw new Error('session pane died while abandoning the question');
        const confirmation = alreadyAdvanced();
        if (confirmation) return { confirmedBy: confirmation, pane: current };
        if (!anyQuestionVisible(current.visiblePane, pending.questions) && current.visiblePane !== before)
          return { confirmedBy: 'pane-advanced', pane: current };
      }
    }
    const remaining = resolveVisibleQuestion(current.visiblePane, pending.questions);
    throw new StructuredQuestionDriveError(
      'Escape was sent, but the question is still visible; it remains pending so it can be retried safely',
      {
        phase: 'cancel-confirm',
        promptReady: current.promptReady,
        activeQuestionIndex: remaining.index,
        candidates: remaining.candidates,
        ambiguous: remaining.reason === 'ambiguous',
      },
    );
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
