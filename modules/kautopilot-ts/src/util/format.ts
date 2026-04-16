// ============================================================================
// Duration formatting
// ============================================================================

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const s = seconds % 60;
  const m = minutes % 60;

  if (hours > 0) {
    return `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  return `${s}s`;
}

// ============================================================================
// ANSI colors
// ============================================================================

const isTTY = process.stdout.isTTY;

const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red: isTTY ? '\x1b[31m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
  blue: isTTY ? '\x1b[34m' : '',
};

// ============================================================================
// Colored log helpers
// ============================================================================

/** Key-value label like "Ticket:    PE-1234" — cyan label, white value */
export function logField(label: string, value: string): void {
  console.log(`${c.cyan}${label.padEnd(11)}${c.reset}${value}`);
}

/** Success / positive message */
export function logOk(msg: string): void {
  console.log(`${c.green}✓${c.reset} ${msg}`);
}

/** Informational message */
export function logInfo(msg: string): void {
  console.log(`${c.blue}ℹ${c.reset} ${msg}`);
}

/** Warning message */
export function logWarn(msg: string): void {
  console.warn(`${c.yellow}⚠${c.reset} ${msg}`);
}

/** Error message */
export function logError(msg: string): void {
  console.error(`${c.red}✗${c.reset} ${msg}`);
}

/** Section heading */
export function logHeading(title: string): void {
  console.log(`\n${c.bold}${c.cyan}${title}${c.reset}`);
}

/** Dim/debug text */
export function logDim(msg: string): void {
  console.log(`${c.dim}${msg}${c.reset}`);
}

// ============================================================================
// Banners
// ============================================================================

/** Display a bordered banner with title and optional key-value fields */
export function logBanner(title: string, fields?: Record<string, string>): void {
  const line = '─'.repeat(60);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}  ${title}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}`);
  if (fields && Object.keys(fields).length > 0) {
    for (const [key, value] of Object.entries(fields)) {
      console.log(`  ${c.cyan}${key}:${c.reset} ${value}`);
    }
    console.log(`${c.cyan}${line}${c.reset}`);
  }
  console.log();
}

/** Display an error banner with title and optional key-value fields */
export function logErrorBanner(title: string, fields?: Record<string, string>): void {
  const line = '─'.repeat(60);
  console.log(`\n${c.red}${line}${c.reset}`);
  console.log(`${c.bold}${c.red}  ${title}${c.reset}`);
  console.log(`${c.red}${line}${c.reset}`);
  if (fields && Object.keys(fields).length > 0) {
    for (const [key, value] of Object.entries(fields)) {
      console.log(`  ${c.cyan}${key}:${c.reset} ${value}`);
    }
    console.log(`${c.red}${line}${c.reset}`);
  }
  console.log();
}

// ============================================================================
// State icons
// ============================================================================

const STATE_ICONS: Record<string, string> = {
  pull_ticket: '🎫',
  gather_context: '🔍',
  write_spec: '📝',
  finalize_spec: '📌',
  write_plans: '📋',
  finalize_plans: '✅',
  setup_run: '⚙️',
  running: '🏃',
  commit: '💾',
  completed: '✅',
  failed: '❌',
  create_pr: '🔗',
  ensure_branch: '🌿',
  commit_pending: '💾',
  poll: '👀',
  eval: '🧪',
  push: '🚀',
  prereview: '🔬',
  feedback_check: '💬',
  act: '⚡',
  run_fix: '🔧',
  tty_resolve: '🖥️',
  next_plan: '📑',
  clear_loop: '🧹',
  resolve: '🔓',
  amend_plans: '✏️',
};

/** Get an icon for a state machine state name. */
export function stateIcon(state: string): string {
  return STATE_ICONS[state] ?? '●';
}

export function formatPhase(phase: string): string {
  if (!phase || phase === 'none') return `${c.dim}—${c.reset}`;
  return `${c.magenta}${phase}${c.reset}`;
}

// ============================================================================
// Step line formatting for phase progress display
// ============================================================================

export function formatStepLine(step: string, status: 'done' | 'active' | 'pending', detail?: string): string {
  const icon =
    status === 'done' ? `${c.green}✓${c.reset}` : status === 'active' ? `${c.cyan}→${c.reset}` : `${c.dim}○${c.reset}`;
  const label =
    status === 'done'
      ? `${c.dim}${step}${c.reset}`
      : status === 'active'
        ? `${c.bold}${step}${c.reset}`
        : `${c.dim}${step}${c.reset}`;
  const detailStr = detail ? `  ${c.dim}${detail}${c.reset}` : '';
  return ` ${icon} ${label}${detailStr}`;
}

// ============================================================================
// Repo parsing
// ============================================================================

export function parseRepoHost(gitRootHost: string): {
  platform: string;
  org: string;
  repo: string;
} {
  // Format: github-{platform}/{org}/{repo}
  const match = gitRootHost.match(/^(github-[^/]+)\/(.+)\/(.+)$/);
  if (!match) return { platform: gitRootHost, org: '?', repo: '?' };
  return { platform: match[1], org: match[2], repo: match[3] };
}
