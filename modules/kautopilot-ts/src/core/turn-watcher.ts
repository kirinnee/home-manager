import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { debugLog } from '../llm/spawn';
import { updateUserTurn } from './status';

// ============================================================================
// Types
// ============================================================================

interface TurnState {
  userTurn: boolean;
  ts: string;
}

type MachineState = 'user_turn' | 'llm_thinking' | 'llm_executing' | 'user_interactive';

export interface TurnMachineContext {
  cursor: number;
  state: MachineState;
  permissionMode: string | null;
  lastSize: number;
  lastTs: string;
  pendingTail: string;
}

// biome-ignore lint/suspicious/noExplicitAny: JSONL entries are untyped
export type ParsedEntry = Record<string, any>;

// ============================================================================
// Interactive tool classification
// ============================================================================

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);

// ============================================================================
// Pure state machine
// ============================================================================

function userTurnFromState(state: MachineState): boolean {
  return state === 'user_turn' || state === 'user_interactive';
}

function readAppendedRaw(path: string, startOffset: number, endOffset: number): string {
  if (endOffset <= startOffset) {
    return '';
  }

  const fd = openSync(path, 'r');
  try {
    const length = endOffset - startOffset;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, startOffset);
    if (bytesRead <= 0) {
      return '';
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Process a single parsed JSONL entry and return the updated context.
 * Pure function — no I/O, fully testable.
 */
function processEntry(ctx: TurnMachineContext, entry: ParsedEntry): TurnMachineContext {
  const next = { ...ctx };
  const ts = entry.timestamp ?? ctx.lastTs;
  next.lastTs = ts;

  const type = entry.type;

  if (type === 'user') {
    // Track permission mode from human user entries (those without toolUseResult)
    if (!('toolUseResult' in entry) && entry.permissionMode != null) {
      next.permissionMode = entry.permissionMode;
    }
    next.state = 'llm_thinking';
    return next;
  }

  if (type === 'assistant') {
    const msg = entry.message;
    if (!msg) return next; // malformed

    const stopReason = msg.stop_reason;

    // Streaming intermediate — no state change
    if (stopReason == null) {
      return next;
    }

    if (stopReason === 'end_turn') {
      next.state = 'user_turn';
      return next;
    }

    if (stopReason === 'tool_use') {
      // Extract tool names from content array
      const content: Array<{ type: string; name?: string }> = msg.content ?? [];
      const toolNames = content
        .filter((c: { type: string }) => c.type === 'tool_use')
        .map((c: { name?: string }) => c.name)
        .filter(Boolean);

      // If ANY tool is interactive → user_interactive
      const hasInteractive = toolNames.some((name: string | undefined) => name != null && INTERACTIVE_TOOLS.has(name));
      if (hasInteractive) {
        next.state = 'user_interactive';
        return next;
      }

      // Non-interactive tool: check permission mode
      const isBypass = ctx.permissionMode === 'bypassPermissions';
      if (isBypass) {
        next.state = 'llm_executing';
      } else {
        // Non-bypass: user needs to approve tool execution
        next.state = 'user_interactive';
      }
      return next;
    }

    // Unknown stop_reason — treat as LLM still working
    return next;
  }

  if (type === 'queue-operation') {
    if (entry.operation === 'enqueue' && ctx.state === 'user_turn') {
      next.state = 'llm_thinking';
    }
    return next;
  }

  if (type === 'system' && entry.subtype === 'turn_duration') {
    // turn_duration is emitted when the LLM's turn completes — it's the user's turn now
    next.state = 'user_turn';
    return next;
  }

  // system (other), progress, file-history-snapshot, last-prompt, custom-title, agent-name — no change
  return next;
}

function createInitialContext(): TurnMachineContext {
  return {
    cursor: 0,
    state: 'user_turn',
    permissionMode: null,
    lastSize: 0,
    lastTs: new Date().toISOString(),
    pendingTail: '',
  };
}

// ============================================================================
// File watcher with cursor-based incremental reads
// ============================================================================

/**
 * Watch a Claude JSONL conversation log to determine whose turn it is.
 *
 * Uses a cursor-based forward state machine:
 * - Tracks how many lines have been processed
 * - On each file change, only processes newly appended lines
 * - Classifies interactive tools (AskUserQuestion, EnterPlanMode, ExitPlanMode) as user's turn
 * - Tracks permission mode to determine if tool approval is needed
 *
 * Uses fs.watch for efficient change notification. Safe to run while the main
 * process is blocked on `await proc.exited` — only the watcher callback writes.
 *
 * Waits for the JSONL file to appear with exponential backoff (the Claude session
 * may not have created it yet when the watcher starts).
 */
function watchTurn(jsonlPath: string, onChange: (state: TurnState) => void): { close: () => void } {
  let ctx = createInitialContext();
  let closed = false;
  let fileWatcher: ReturnType<typeof watch> | null = null;

  function check() {
    if (!existsSync(jsonlPath)) return;

    // Only re-parse if file has grown (or been truncated/replaced)
    let stat: { size: number };
    try {
      stat = statSync(jsonlPath);
    } catch {
      return;
    }

    // File truncated/replaced — reset and re-process (including pendingTail)
    if (stat.size < ctx.lastSize) {
      ctx = createInitialContext();
    }

    if (stat.size === ctx.lastSize) return;

    const prevState = ctx.state;
    const prevCursor = ctx.cursor;
    const endOffset = stat.size;
    const raw = readAppendedRaw(jsonlPath, prevCursor, endOffset);
    ctx.lastSize = endOffset;
    ctx.cursor = endOffset;

    // Prepend any buffered incomplete line from the previous read
    const text = ctx.pendingTail + raw;

    // If text doesn't end with newline, the last segment may be incomplete
    const endsWithNewline = text.endsWith('\n');
    const segments = text.split('\n').filter(Boolean);

    if (!endsWithNewline && segments.length > 0) {
      // Last segment is potentially incomplete — buffer it for next read
      ctx.pendingTail = segments.pop() as string;
    } else {
      ctx.pendingTail = '';
    }

    for (const line of segments) {
      try {
        const entry = JSON.parse(line);
        ctx = processEntry(ctx, entry);
      } catch {
        // Skip non-JSON lines
      }
    }

    if (ctx.state !== prevState || prevCursor === 0) {
      onChange({
        userTurn: userTurnFromState(ctx.state),
        ts: ctx.lastTs,
      });
    }
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** Periodic poll as fallback — fs.watch on macOS/APFS can silently drop events */
  const POLL_INTERVAL_MS = 2_000;
  function startPoll() {
    if (closed) return;
    pollTimer = setInterval(check, POLL_INTERVAL_MS);
  }

  function startWatch() {
    if (closed) return;
    try {
      fileWatcher = watch(jsonlPath, { persistent: false }, () => check());
      check();
    } catch {
      // File may have vanished between check and watch — retry
      waitForFile();
      return;
    }
    // Always run polling as fallback for fs.watch reliability
    startPoll();
  }

  /** Poll for file existence with exponential backoff: 500ms, 1s, 2s, 4s, ... max 8s */
  function waitForFile() {
    let delay = 500;
    const maxDelay = 8_000;

    function poll() {
      if (closed) return;
      if (existsSync(jsonlPath)) {
        startWatch();
      } else {
        delay = Math.min(delay * 2, maxDelay);
        debugLog(`[turn-watcher] ${jsonlPath} not found, retrying in ${delay}ms`);
        setTimeout(poll, delay);
      }
    }

    setTimeout(poll, delay);
  }

  // Ensure the parent directory exists so we can watch later
  mkdirSync(dirname(jsonlPath), { recursive: true });

  // Try to start immediately, fall back to polling
  if (existsSync(jsonlPath)) {
    startWatch();
  } else {
    waitForFile();
  }

  return {
    close: () => {
      closed = true;
      fileWatcher?.close();
      if (pollTimer) clearInterval(pollTimer);
    },
  };
}

/**
 * Start watching a Claude JSONL file and update status.yaml's userTurn field.
 * Returns a cleanup function to stop watching.
 */
export function startTurnWatcher(sessionId: string, jsonlPath: string): { close: () => void } {
  return watchTurn(jsonlPath, state => {
    updateUserTurn(sessionId, state.userTurn);
  });
}
