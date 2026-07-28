/**
 * Independent shell-terminal contracts.
 *
 * These terminals are deliberately unrelated to an agent's own tmux pane.
 * Each one is a separate shell, rooted at the owning kteam session's cwd, and
 * may therefore accept arbitrary human input without bypassing turn tracking.
 */

export const TERMINAL_MAX_PER_SESSION = 6;
export const TERMINAL_MAX_GLOBAL = 24;
export const TERMINAL_IDLE_TIMEOUT_MS = 60 * 60_000;
export const TERMINAL_SCROLLBACK_LINES = 5_000;
export const TERMINAL_REATTACH_LINES = 2_000;
export const TERMINAL_DEFAULT_SIZE = { cols: 100, rows: 30 } as const;
export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MAX_COLS = 300;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_MAX_ROWS = 120;
export const TERMINAL_MAX_TITLE_CHARS = 64;

const TERMINAL_ID = /^[a-f0-9]{12}$/;

export type TerminalLifecycle = 'running';

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalView {
  id: string;
  sessionId: string;
  title: string;
  state: TerminalLifecycle;
  cols: number;
  rows: number;
  viewers: number;
  createdAt: string;
  lastActivityAt: string;
  /** Present only while no WebSocket viewer is attached. */
  idleDeadline?: string;
}

export interface TerminalListView {
  sessionId: string;
  terminals: TerminalView[];
  limits: {
    perSession: number;
    global: number;
    runningGlobal: number;
    idleTimeoutSeconds: number;
    scrollbackLines: number;
  };
}

export type TerminalErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'capacity'
  | 'unavailable'
  | 'upstream_failed';

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}

export function isTerminalError(value: unknown): value is TerminalError {
  return value instanceof TerminalError || (value instanceof Error && value.name === 'TerminalError');
}

export function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && TERMINAL_ID.test(value);
}

export function normalizeTerminalSize(cols: number, rows: number): TerminalSize {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    throw new TerminalError('bad_request', 'terminal columns and rows must be finite numbers', 400);
  }
  return {
    cols: Math.max(TERMINAL_MIN_COLS, Math.min(TERMINAL_MAX_COLS, Math.round(cols))),
    rows: Math.max(TERMINAL_MIN_ROWS, Math.min(TERMINAL_MAX_ROWS, Math.round(rows))),
  };
}

export function normalizeTerminalTitle(value: unknown): string {
  if (typeof value !== 'string') throw new TerminalError('bad_request', 'terminal title must be a string', 400);
  const title = value.trim();
  if (!title) throw new TerminalError('bad_request', 'terminal title cannot be empty', 400);
  if (title.length > TERMINAL_MAX_TITLE_CHARS) {
    throw new TerminalError(
      'bad_request',
      `terminal title must be no longer than ${TERMINAL_MAX_TITLE_CHARS} characters`,
      400,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(title)) {
    throw new TerminalError('bad_request', 'terminal title cannot contain control characters', 400);
  }
  return title;
}
