import { watch, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { updateUserTurn } from './status';
import { debugLog } from '../llm/spawn';

interface TurnState {
  userTurn: boolean;
  ts: string;
}

/**
 * Watch a Claude JSONL conversation log to determine whose turn it is.
 *
 * - `type: 'assistant'` with `stop_reason: 'end_turn'` → user's turn (Claude finished)
 * - `type: 'assistant'` with other stop_reason → Claude still working (tool_use, etc.)
 * - `type: 'user'` → Claude's turn (user just sent something)
 *
 * Uses fs.watch for efficient change notification. Safe to run while the main
 * process is blocked on `await proc.exited` — only the watcher callback writes.
 *
 * Waits for the JSONL file to appear with exponential backoff (the Claude session
 * may not have created it yet when the watcher starts).
 */
export function watchTurn(jsonlPath: string, onChange: (state: TurnState) => void): { close: () => void } {
  let lastSize = 0;
  let closed = false;
  let fileWatcher: ReturnType<typeof watch> | null = null;

  function check() {
    if (!existsSync(jsonlPath)) return;

    // Only re-parse if file has grown
    let stat: { size: number };
    try {
      stat = Bun.file(jsonlPath);
    } catch {
      return;
    }
    if (stat.size === lastSize) return;
    lastSize = stat.size;

    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Walk backwards to find the last assistant or user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === 'assistant') {
          const stopReason = d.message?.stop_reason;
          // end_turn = Claude finished its turn, waiting for user input
          onChange({
            userTurn: stopReason === 'end_turn',
            ts: d.timestamp || new Date().toISOString(),
          });
          return;
        }
        if (d.type === 'user') {
          // User just sent something, it's Claude's turn now
          onChange({
            userTurn: false,
            ts: d.timestamp || new Date().toISOString(),
          });
          return;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  function startWatch() {
    if (closed) return;
    try {
      fileWatcher = watch(jsonlPath, { persistent: false }, () => check());
      check();
    } catch {
      // File may have vanished between check and watch — retry
      waitForFile();
    }
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
