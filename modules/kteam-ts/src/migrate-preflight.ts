// Safe-migration pre-flight gate (phase 1, CLI-side only — no daemon change).
//
// `kteam migrate` RELAUNCHES a session: it kills the pane process tree
// children-first and resumes the harness under the new account. Live-proved
// (see ~/.kteam/ms2cfhcf-9b36de58/safe-migration-design.md §2): a mid-turn
// migrate destroys a running subprocess with ZERO warning, and the pane kill
// happens BEFORE the relaunch attempt — so a migrate that later fails and rolls
// the account back has ALREADY destroyed the in-flight work. This module runs
// entirely client-side, BEFORE the migrate HTTP call, so it can refuse first.
//
// It inventories what is in flight (open harness tools joined to their full
// command text + the pane-pid process tree + the codex background-terminal
// footer count), classifies each item, and lets the caller REFUSE by default
// when anything is destructive or unknown. Everything here is pure and
// injectable except `collectProcessInventory`/`buildInflightReport`, which take
// their shell + fetch dependencies as parameters so the logic is table-testable.

import path from 'path';
import { run as defaultRun } from './io';
import { backgroundTerminalCount } from './tmux-controller';
import type { SessionState, SessionStatus } from './types';

/** Four verdicts, ordered by how dangerous interrupting the work is. */
export type InflightVerdict = 'safe_to_kill' | 're_armable' | 'destructive_to_interrupt' | 'unknown';

/** Ordering used to pick the WORST verdict across many items. The gate refuses
 *  on `unknown` or `destructive_to_interrupt`, so both rank above the two that
 *  proceed — `unknown` degrades to refuse, never to "probably fine". */
const VERDICT_RANK: Record<InflightVerdict, number> = {
  safe_to_kill: 0,
  re_armable: 1,
  unknown: 2,
  destructive_to_interrupt: 3,
};

export function worstVerdict(verdicts: readonly InflightVerdict[]): InflightVerdict {
  let worst: InflightVerdict = 'safe_to_kill';
  for (const verdict of verdicts) if (VERDICT_RANK[verdict] > VERDICT_RANK[worst]) worst = verdict;
  return worst;
}

/** A verdict blocks the migrate by default (refuse-unless-forced). */
export function verdictBlocks(verdict: InflightVerdict): boolean {
  return verdict === 'destructive_to_interrupt' || verdict === 'unknown';
}

export interface OpenToolInfo {
  toolUseId: string;
  /** Harness tool name (Bash, Read, …); `?` when the id did not join to a chat record. */
  name: string;
  /** Full command text for Bash, else a short input summary. */
  summary: string;
  startedAt?: string;
  verdict: InflightVerdict;
}

export interface ProcessInfo {
  pid: number;
  argv: string;
  startedSecondsAgo?: number;
  cwd?: string;
  verdict: InflightVerdict;
}

export interface InflightReport {
  status: SessionStatus;
  turn: number;
  /** True when there is demonstrably nothing in flight — migrate as today, no
   *  report, no handoff. */
  empty: boolean;
  openTools: OpenToolInfo[];
  processes: ProcessInfo[];
  /** Codex background terminals (footer count). Their children are NOT under the
   *  pane pid and carry no argv — they are unaccountable and count as unknown. */
  codexBackgroundTerminals: number;
  /** Unaccountable items (codex background terminals we cannot classify). */
  discrepancy: number;
  /** The worst verdict across every open tool, process, and the discrepancy. */
  worstVerdict: InflightVerdict;
  /** Start of the current continuous subprocess episode, if warm. */
  subprocessSince?: string;
}

// ── classifier ──────────────────────────────────────────────────────────────
//
// The classifier's input is unusually good: for Bash tools we have the FULL
// command text, so a deterministic pattern table gets the common cases right in
// microseconds. Anything not clearly read-only or clearly idempotent falls to
// `unknown`, which refuses — the safe default.

/** Shell words that PREFIX another command rather than being the command. */
const COMMAND_PREFIXES = new Set([
  'sudo',
  'doas',
  'env',
  'time',
  'nice',
  'ionice',
  'nohup',
  'setsid',
  'command',
  'builtin',
  'exec',
  'stdbuf',
  'timeout',
  'watch',
]);

/** Read-only / ephemeral heads — killing them loses nothing. */
const SAFE_HEADS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'fd',
  'find',
  'locate',
  'ls',
  'll',
  'cat',
  'bat',
  'head',
  'tail',
  'jq',
  'yq',
  'wc',
  'echo',
  'printf',
  'pwd',
  'whoami',
  'date',
  'printenv',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'which',
  'type',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'nl',
  'tac',
  'rev',
  'realpath',
  'dirname',
  'basename',
  'readlink',
  'sleep',
  'true',
  'false',
  'test',
  'hostname',
  'uname',
  'id',
  'ps',
  'top',
  'htop',
  'free',
  'uptime',
  'sed',
  'awk',
  'less',
  'more',
  'diff',
  'cmp',
  'md5sum',
  'sha256sum',
  'seq',
  'zsh',
  'bash',
  'sh',
  'fish',
  'dash',
  'tmux',
]);

/** Idempotent, re-runnable heads — a handoff note says "re-run if still needed". */
const RE_ARMABLE_HEADS = new Set([
  'tsc',
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'mocha',
  'ava',
  'tap',
  'tape',
  'pytest',
  'phpunit',
  'rspec',
  'ctest',
  'make',
  'cmake',
  'ninja',
  'gradle',
  'mvn',
  'bazel',
  'buck',
  'webpack',
  'vite',
  'rollup',
  'esbuild',
  'swc',
  'tsx',
  'biome',
  'ruff',
  'mypy',
  'flake8',
  'black',
  'gofmt',
  'rustc',
  'gcc',
  'g++',
  'cc',
  'clang',
  'clang++',
  'deno',
  'tsserver',
  'stylelint',
  'tflint',
]);

/** Always state-mutating / non-idempotent — never auto-interrupt. */
const DESTRUCTIVE_HEADS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'dd',
  'shred',
  'truncate',
  'mkfs',
  'mkfifo',
  'ln',
  'chmod',
  'chown',
  'chgrp',
  'install',
  'tee',
  'hms',
  'darwin-rebuild',
  'nixos-rebuild',
  'home-manager',
  'nix',
  'nix-env',
  'nix-build',
  'nix-shell',
  'nix-collect-garbage',
  'nixos-rebuild-ng',
  'tofu',
  'terraform',
  'terragrunt',
  'pulumi',
  'ansible',
  'ansible-playbook',
  'kubectl',
  'helm',
  'kustomize',
  'argocd',
  'loctl',
  'kubeadm',
  'k9s',
  'eksctl',
  'sops',
  'age',
  'gpg',
  'rsync',
  'scp',
  'sftp',
  'ssh',
  'systemctl',
  'service',
  'mount',
  'umount',
  'swapon',
  'kill',
  'pkill',
  'killall',
  'pkexec',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'crontab',
  'aws',
  'gcloud',
  'az',
  'doctl',
  'vagrant',
  'packer',
  'flyctl',
  'fly',
  'apt',
  'apt-get',
  'dpkg',
  'yum',
  'dnf',
  'rpm',
  'pacman',
  'apk',
  'brew',
  'port',
  'snap',
  'flatpak',
  'systemd-run',
  'usermod',
  'useradd',
  'passwd',
]);

/** Package-manager heads whose danger depends on the sub-command. */
const PACKAGE_MANAGERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'cargo',
  'go',
  'gem',
  'composer',
  'poetry',
  'uv',
  'bundle',
]);

/** Sub-commands that MUTATE the environment for any package manager. */
const PM_DESTRUCTIVE_SUBCOMMANDS = new Set([
  'install',
  'add',
  'remove',
  'uninstall',
  'rm',
  'ci',
  'update',
  'upgrade',
  'up',
  'publish',
  'link',
  'unlink',
  'dedupe',
  'prune',
  'get',
  'sync',
  'lock',
]);

/** Package-manager sub-commands that merely build/test/lint (idempotent). */
const PM_REARMABLE_SUBCOMMANDS = new Set([
  'test',
  'build',
  'lint',
  'check',
  'fmt',
  'format',
  'clippy',
  'vet',
  'tsc',
  'compile',
  'bench',
  'doc',
]);

/** `<pm> run <script>` — the danger is the SCRIPT, which we cannot see, so we
 *  classify by its NAME and fall to unknown for anything unrecognized
 *  (`npm run deploy` must not read as "probably fine"). */
const PM_RUN_SUBCOMMANDS = new Set(['run', 'run-script']);
const REARMABLE_SCRIPT_NAMES = new Set([
  'build',
  'test',
  'tests',
  'lint',
  'check',
  'checks',
  'typecheck',
  'tsc',
  'compile',
  'fmt',
  'format',
  'coverage',
  'unit',
  'e2e',
  'bench',
  'ci',
  'verify',
  'validate',
  'prettier',
  'eslint',
]);
const DESTRUCTIVE_SCRIPT_NAMES = new Set([
  'deploy',
  'publish',
  'release',
  'prod',
  'push',
  'migrate',
  'db',
  'db:migrate',
  'reset',
  'clean',
  'prepublish',
  'postinstall',
  'preinstall',
  'install',
]);

/** git sub-commands that only READ. Everything else (commit, push, pull, merge,
 *  rebase, reset, checkout, restore, stash, clean, add, rm, mv, cherry-pick,
 *  revert, apply, am, tag -d …) mutates and is destructive. */
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'describe',
  'blame',
  'shortlog',
  'config',
  'fetch',
  'cat-file',
  'reflog',
  'rev-list',
  'name-rev',
  'whatchanged',
  'grep',
  'ls-tree',
]);

const CURL_LIKE = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie']);
const MUTATING_HTTP =
  /(^|\s)(-X\s*(post|put|patch|delete)|--request\s+(post|put|patch|delete)|--data\b|--data-\w+|-d\b|--upload-file|-T\b|-F\b|--form\b|--method\s+(post|put|patch|delete))/i;

/** Strip a leading path so `/usr/bin/git` classifies like `git`. */
function head(word: string): string {
  return path.basename(word);
}

/** Split a compound command on shell separators into runnable segments. */
function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;&\n]/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

/** The command word of one segment, skipping env-assignments (`FOO=bar`),
 *  prefix words (`sudo`, `timeout`), and the bare numeric/duration argument a
 *  `timeout`/`nice` prefix carries. Returns undefined for an empty/garbled
 *  segment (a shell keyword like `if`, a lone redirection, etc.). */
function segmentHead(segment: string): string | undefined {
  const tokens = segment.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    // env assignment: NAME=value that isn't a path.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const word = head(token.replace(/^['"]|['"]$/g, ''));
    if (!word) continue;
    if (COMMAND_PREFIXES.has(word)) continue;
    // A duration/number argument to timeout/nice/etc.
    if (/^\d+[smhd]?$/.test(word)) continue;
    if (/^-/.test(word)) continue; // a flag before the command word
    return word;
  }
  return undefined;
}

function classifyGit(segment: string): InflightVerdict {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const gitIndex = tokens.findIndex(token => head(token) === 'git');
  // Skip git's own options (`-C dir`, `-c k=v`) to find the sub-command.
  for (let i = gitIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('-')) {
      if (token === '-C' || token === '-c') i++; // consume its value
      continue;
    }
    return GIT_READONLY_SUBCOMMANDS.has(token) ? 'safe_to_kill' : 'destructive_to_interrupt';
  }
  return 'safe_to_kill'; // bare `git` prints help
}

function classifyPackageManager(head: string, segment: string): InflightVerdict {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const pmIndex = tokens.findIndex(token => path.basename(token) === head);
  for (let i = pmIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('-')) continue;
    if (PM_DESTRUCTIVE_SUBCOMMANDS.has(token)) return 'destructive_to_interrupt';
    if (PM_REARMABLE_SUBCOMMANDS.has(token)) return 're_armable';
    if (PM_RUN_SUBCOMMANDS.has(token)) {
      // The next non-flag token is the script name; classify by it.
      for (let j = i + 1; j < tokens.length; j++) {
        const script = tokens[j]!;
        if (script.startsWith('-')) continue;
        if (DESTRUCTIVE_SCRIPT_NAMES.has(script)) return 'destructive_to_interrupt';
        if (REARMABLE_SCRIPT_NAMES.has(script)) return 're_armable';
        return 'unknown'; // an unrecognized script (e.g. `npm run deploy`)
      }
      return 'unknown';
    }
    return 'unknown'; // an unrecognized sub-command
  }
  return 'unknown';
}

/** Classify ONE segment by its command word. */
function classifySegment(segment: string): InflightVerdict {
  const word = segmentHead(segment);
  if (!word) return 'unknown';
  if (word === 'git') return classifyGit(segment);
  if (PACKAGE_MANAGERS.has(word)) return classifyPackageManager(word, segment);
  if (CURL_LIKE.has(word)) return MUTATING_HTTP.test(segment) ? 'destructive_to_interrupt' : 'safe_to_kill';
  if (DESTRUCTIVE_HEADS.has(word)) return 'destructive_to_interrupt';
  if (RE_ARMABLE_HEADS.has(word)) return 're_armable';
  if (SAFE_HEADS.has(word)) return 'safe_to_kill';
  return 'unknown';
}

/** Classify a full (possibly compound) Bash command by its WORST segment, so a
 *  `git push` buried in a pipeline still reads as destructive. */
export function classifyCommand(command: string): InflightVerdict {
  const trimmed = command.trim();
  if (!trimmed) return 'unknown';
  const segments = splitSegments(trimmed);
  if (!segments.length) return 'unknown';
  return worstVerdict(segments.map(classifySegment));
}

/** Non-Bash harness tools classify by NAME. Read tools are safe; file writes
 *  are near-atomic and deterministically re-applied, so re_armable; a tool we
 *  do not recognize is unknown. */
export function classifyToolName(name: string): InflightVerdict {
  switch (name) {
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'NotebookRead':
    case 'WebFetch':
    case 'WebSearch':
    case 'TodoWrite':
    case 'BashOutput':
    case 'KillBash':
    case 'KillShell':
      return 'safe_to_kill';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 're_armable';
    case 'Bash':
      // Callers with the command text should use classifyCommand; a Bash tool
      // with no recoverable input is genuinely unknown.
      return 'unknown';
    default:
      return 'unknown';
  }
}

// ── open-tool join (state.openTools ⋈ chat tail) ─────────────────────────────

/** A normalized chat record as served by GET /v1/sessions/:id/chat — we only
 *  read the `tool.use` shape emitted by both transcript parsers. */
interface ChatToolUse {
  type: string;
  timestamp?: string;
  data?: { toolUseId?: string; name?: string; input?: unknown };
}

function isToolUse(record: unknown): record is ChatToolUse {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { type?: unknown }).type === 'tool.use' &&
    typeof (record as { data?: unknown }).data === 'object'
  );
}

/** Best-effort one-line summary of a tool's input: the full Bash command, else
 *  a compact JSON of the most telling fields. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string') return record.command.trim();
    if (typeof record.file_path === 'string') return String(record.file_path);
    if (typeof record.path === 'string') return String(record.path);
    if (typeof record.pattern === 'string') return String(record.pattern);
    try {
      return JSON.stringify(record);
    } catch {
      return '(uninspectable input)';
    }
  }
  return name;
}

/** Join open tool ids to their chat records for full command text + verdict. */
export function joinOpenTools(openTools: readonly string[], chatRecords: readonly unknown[]): OpenToolInfo[] {
  const byId = new Map<string, ChatToolUse>();
  for (const record of chatRecords)
    if (isToolUse(record) && record.data?.toolUseId) byId.set(record.data.toolUseId, record);
  return openTools.map(toolUseId => {
    const record = byId.get(toolUseId);
    const name = record?.data?.name ?? '?';
    const input = record?.data?.input;
    const summary = record ? summarizeToolInput(name, input) : '(command not found in chat tail)';
    const verdict =
      name === 'Bash' && typeof (input as { command?: unknown })?.command === 'string'
        ? classifyCommand(String((input as { command?: unknown }).command))
        : record
          ? classifyToolName(name)
          : 'unknown';
    return { toolUseId, name, summary, startedAt: record?.timestamp, verdict };
  });
}

// ── process inventory (pane-pid tree walk) ───────────────────────────────────

export interface ProcRow {
  pid: number;
  ppid: number;
  startedSecondsAgo?: number;
  argv: string;
}

/** Parse `ps -Ao pid=,ppid=,etimes=,args=` output. Rows whose leading columns
 *  are not three integers are skipped (a garbled line, not a fatal error). */
export function parseProcessTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedSecondsAgo = Number(match[3]);
    const argv = match[4]!.trim();
    if (pid > 1 && Number.isFinite(ppid)) rows.push({ pid, ppid, startedSecondsAgo, argv });
  }
  return rows;
}

/** Descendants of `rootPid` (excluding the root itself), via a BFS over ppid. */
export function descendantsOf(rootPid: number, rows: readonly ProcRow[]): ProcRow[] {
  const childrenOf = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.ppid);
    if (list) list.push(row);
    else childrenOf.set(row.ppid, [row]);
  }
  const out: ProcRow[] = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    for (const child of childrenOf.get(queue[i]!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export interface InventoryDeps {
  run?: typeof defaultRun;
  /** readlink of /proc/<pid>/cwd; returns undefined when unreadable. */
  readCwd?: (pid: number) => Promise<string | undefined>;
}

/** Walk the pane-pid process tree and classify each descendant by its argv.
 *  Impure (spawns tmux + ps + readlink), so its shell dependencies are
 *  injectable for tests. Returns [] when the pane pid cannot be resolved. */
export async function collectProcessInventory(tmuxSession: string, deps: InventoryDeps = {}): Promise<ProcessInfo[]> {
  const run = deps.run ?? defaultRun;
  const paneResult = await run(['tmux', 'display-message', '-p', '-t', tmuxSession, '#{pane_pid}']).catch(
    () => undefined,
  );
  const panePid = paneResult && paneResult.code === 0 ? Number(paneResult.stdout.trim()) : NaN;
  if (!Number.isFinite(panePid) || panePid <= 1) return [];
  const ps = await run(['ps', '-Ao', 'pid=,ppid=,etimes=,args=']).catch(() => undefined);
  if (!ps || ps.code !== 0) return [];
  const rows = parseProcessTable(ps.stdout);
  const descendants = descendantsOf(panePid, rows);
  const readCwd = deps.readCwd ?? defaultReadCwd(run);
  const out: ProcessInfo[] = [];
  for (const row of descendants) {
    // The pane's own login shell with no child running is idle; classifyCommand
    // already scores bare shells as safe, so it does not block on its own.
    out.push({
      pid: row.pid,
      argv: row.argv,
      startedSecondsAgo: row.startedSecondsAgo,
      cwd: await readCwd(row.pid),
      verdict: classifyCommand(row.argv),
    });
  }
  return out;
}

function defaultReadCwd(run: typeof defaultRun): (pid: number) => Promise<string | undefined> {
  return async pid => {
    const result = await run(['readlink', `/proc/${pid}/cwd`]).catch(() => undefined);
    return result && result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  };
}

// ── report assembly + gate ───────────────────────────────────────────────────

const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'running',
  'thinking',
  'tool_running',
  'retrying',
]);

export interface AssembleInput {
  status: SessionStatus;
  turn: number;
  openTools: OpenToolInfo[];
  processes: ProcessInfo[];
  codexBackgroundTerminals: number;
  subprocessSince?: string;
}

/** Fold the three signals into one report + its worst verdict. Pure. */
export function assembleInflightReport(input: AssembleInput): InflightReport {
  const discrepancy = input.codexBackgroundTerminals; // unaccountable (no argv, ever)
  const verdicts: InflightVerdict[] = [
    ...input.openTools.map(tool => tool.verdict),
    ...input.processes.map(process => process.verdict),
  ];
  if (discrepancy > 0) verdicts.push('unknown'); // codex bg terminals we cannot classify
  const worst = worstVerdict(verdicts);
  const hasInflight =
    input.openTools.length > 0 ||
    input.codexBackgroundTerminals > 0 ||
    input.processes.some(process => process.verdict !== 'safe_to_kill') ||
    input.subprocessSince !== undefined;
  const empty = !ACTIVE_STATUSES.has(input.status) && !hasInflight;
  return {
    status: input.status,
    turn: input.turn,
    empty,
    openTools: input.openTools,
    processes: input.processes,
    codexBackgroundTerminals: input.codexBackgroundTerminals,
    discrepancy,
    worstVerdict: verdicts.length ? worst : 'safe_to_kill',
    subprocessSince: input.subprocessSince,
  };
}

export interface BuildDeps extends InventoryDeps {
  /** Fetch the recent chat records (the openTools ⋈ chat join source). */
  fetchChat: (limit: number) => Promise<unknown[]>;
  /** Fetch the pane snapshot text (codex footer count). Optional — a failure
   *  just leaves the codex count at 0. */
  fetchSnapshot?: () => Promise<string>;
  chatLimit?: number;
}

export interface MigrateTargetView {
  state: SessionState;
  config: { harness: string; tmuxSession: string };
}

/** Assemble the full report for a session view. Impure orchestrator: joins the
 *  daemon-served state + chat, walks the local process tree, reads the codex
 *  footer. Never throws on a missing signal — it degrades to a partial report. */
export async function buildInflightReport(view: MigrateTargetView, deps: BuildDeps): Promise<InflightReport> {
  const openToolIds = view.state.openTools ?? [];
  const chat = openToolIds.length ? await deps.fetchChat(deps.chatLimit ?? 200).catch(() => []) : [];
  const openTools = joinOpenTools(openToolIds, chat);
  const processes = await collectProcessInventory(view.config.tmuxSession, deps).catch(() => []);
  let codexBackgroundTerminals = 0;
  if (view.config.harness === 'codex' && deps.fetchSnapshot) {
    const snapshot = await deps.fetchSnapshot().catch(() => '');
    codexBackgroundTerminals = backgroundTerminalCount(snapshot);
  }
  return assembleInflightReport({
    status: view.state.status,
    turn: view.state.turn,
    openTools,
    processes,
    codexBackgroundTerminals,
    subprocessSince: view.state.subprocessSince,
  });
}

export interface GateDecision {
  proceed: boolean;
  forced: boolean;
  /** A one-line reason for the decision (shown/recorded). */
  reason: string;
}

/** The default flow (design §6): empty → proceed; only safe/re_armable →
 *  proceed (with a report + handoff); any destructive/unknown → refuse unless
 *  `force`. */
export function gateInflight(report: InflightReport, options: { force?: boolean } = {}): GateDecision {
  if (report.empty) return { proceed: true, forced: false, reason: 'no in-flight work' };
  if (!verdictBlocks(report.worstVerdict))
    return { proceed: true, forced: false, reason: `in-flight work is ${report.worstVerdict}` };
  if (options.force)
    return { proceed: true, forced: true, reason: `forced past ${report.worstVerdict} in-flight work` };
  return { proceed: false, forced: false, reason: `refused: in-flight work is ${report.worstVerdict}` };
}

// ── rendering ─────────────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<InflightVerdict, string> = {
  safe_to_kill: 'safe',
  re_armable: 're-armable',
  destructive_to_interrupt: 'DESTRUCTIVE',
  unknown: 'UNKNOWN',
};

function age(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '?';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Compact terminal table (printed on refuse and on a report-writing proceed). */
export function renderInflightCli(report: InflightReport): string {
  const lines: string[] = [];
  lines.push(
    `in-flight inventory — status ${report.status}, turn ${report.turn}, worst: ${VERDICT_LABEL[report.worstVerdict]}`,
  );
  for (const tool of report.openTools)
    lines.push(`  tool  [${VERDICT_LABEL[tool.verdict]}] ${tool.name}: ${truncate(tool.summary, 90)}`);
  for (const process of report.processes)
    lines.push(
      `  proc  [${VERDICT_LABEL[process.verdict]}] pid ${process.pid} (${age(process.startedSecondsAgo)}): ${truncate(process.argv, 90)}`,
    );
  if (report.codexBackgroundTerminals > 0)
    lines.push(`  codex ${report.codexBackgroundTerminals} background terminal(s) [UNKNOWN — no argv, unaccountable]`);
  if (!report.openTools.length && !report.processes.length && !report.codexBackgroundTerminals)
    lines.push('  (no open tools or descendant processes observed)');
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export interface ReportMeta {
  sessionId: string;
  targetAgent: string;
  targetModel?: string;
  forced: boolean;
  /** ISO timestamp; the CLI passes `now()` so this module stays deterministic. */
  at: string;
}

/** The markdown written to `<session dir>/migration-inflight.md` — the handoff
 *  note AND the forensic record of what a forced migrate destroyed. */
export function renderInflightReport(report: InflightReport, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push('# Migration in-flight report');
  lines.push('');
  lines.push(`- Session: \`${meta.sessionId}\``);
  lines.push(`- Migrated onto: \`${meta.targetAgent}\`${meta.targetModel ? ` (model \`${meta.targetModel}\`)` : ''}`);
  lines.push(`- At: ${meta.at}`);
  lines.push(`- Status at migrate: ${report.status} (turn ${report.turn})`);
  lines.push(`- Worst verdict: **${VERDICT_LABEL[report.worstVerdict]}**`);
  if (meta.forced)
    lines.push(
      '- **FORCED past a destructive/unknown refusal (`--force-inflight`).** The items below were killed by the relaunch.',
    );
  lines.push('');

  lines.push('## What was running');
  lines.push('');
  if (report.openTools.length) {
    lines.push('### Open harness tools');
    lines.push('');
    lines.push('| verdict | tool | command / input |');
    lines.push('|---|---|---|');
    for (const tool of report.openTools)
      lines.push(`| ${VERDICT_LABEL[tool.verdict]} | ${tool.name} | \`${escapeCell(tool.summary)}\` |`);
    lines.push('');
  }
  if (report.processes.length) {
    lines.push('### Descendant processes (pane-pid tree)');
    lines.push('');
    lines.push('| verdict | pid | age | cwd | argv |');
    lines.push('|---|---|---|---|---|');
    for (const process of report.processes)
      lines.push(
        `| ${VERDICT_LABEL[process.verdict]} | ${process.pid} | ${age(process.startedSecondsAgo)} | ${process.cwd ? `\`${escapeCell(process.cwd)}\`` : '?'} | \`${escapeCell(process.argv)}\` |`,
      );
    lines.push('');
  }
  if (report.codexBackgroundTerminals > 0) {
    lines.push(`### Codex background terminals: ${report.codexBackgroundTerminals}`);
    lines.push('');
    lines.push(
      'Their children are NOT under the pane pid and carry no argv — they are **unaccountable**. Treat as unknown: check the pane for what they were doing before re-running anything.',
    );
    lines.push('');
  }
  if (!report.openTools.length && !report.processes.length && !report.codexBackgroundTerminals) {
    lines.push('_No open tools or descendant processes were observed at migrate time._');
    lines.push('');
  }

  lines.push('## What to do now (per class)');
  lines.push('');
  lines.push('- **safe**: read-only/ephemeral (rg, ls, sleep …). Killed by the relaunch; ignore.');
  lines.push('- **re-armable**: idempotent (test suites, builds, linters …). Re-run only if still needed.');
  lines.push(
    '- **DESTRUCTIVE**: state-mutating / non-idempotent (git commit/push/rebase, installs, nix/hms, tofu, kubectl, sops, rm/mv …). **Do NOT blindly re-run.** VERIFY state first — `git status`, half-applied changes, partial writes — then decide.',
  );
  lines.push(
    '- **UNKNOWN**: not recognized (incl. codex background terminals). Inspect the pane/transcript before acting.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** The one-line handoff `kteam send` fires after a successful migrate. */
export function handoffMessage(reportPath: string): string {
  return `You were migrated mid-turn. Read ${reportPath} — it lists what was running and what to check before re-running anything.`;
}
