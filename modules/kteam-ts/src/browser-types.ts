/**
 * Remote browser transport contracts.
 *
 * Sensitive browser material is deliberately absent from every durable shape:
 * page text and screenshots exist only in an explicit request response, and
 * keystrokes are never represented in status or lifecycle metadata.
 */

export const BROWSER_MAX_INSTANCES = 3;
export const BROWSER_IDLE_TIMEOUT_MS = 10 * 60_000;
export const BROWSER_MIN_WIDTH = 320;
export const BROWSER_MIN_HEIGHT = 240;
export const BROWSER_MAX_WIDTH = 1_920;
export const BROWSER_MAX_HEIGHT = 1_200;
export const BROWSER_MAX_PAGE_ID_LENGTH = 128;
export const BROWSER_DEFAULT_VIEWPORT = { width: 1_280, height: 800 } as const;

export type BrowserLifecycle = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type BrowserActorKind = 'agent' | 'human';
export type BrowserPageState = 'loading' | 'ready' | 'error';
export type BrowserActivity =
  | 'start'
  | 'stop'
  | 'navigate'
  | 'click'
  | 'type'
  | 'read'
  | 'screenshot'
  | 'back'
  | 'forward'
  | 'reload'
  | 'new-page'
  | 'activate-page'
  | 'close-page'
  | 'resize'
  | 'pointer'
  | 'keyboard'
  | 'paste';

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserScreencastFrame {
  /** JPEG bytes from CDP, kept transient and never journalled. */
  dataBase64: string;
  width: number;
  height: number;
  /** Worker-lifetime id of the page whose CDP session emitted this frame. */
  pageId?: string;
}

export type BrowserMouseInput = {
  kind: 'mouse';
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
};

export type BrowserKeyInput = {
  kind: 'key';
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers?: number;
  autoRepeat?: boolean;
  isKeypad?: boolean;
};

export type BrowserInputEvent = BrowserMouseInput | BrowserKeyInput | { kind: 'insertText'; text: string };

export interface BrowserLastActor {
  kind: BrowserActorKind;
  at: string;
  action: BrowserActivity;
}

/** Transient metadata for one real Playwright page. Page ids are opaque and
 * stable only for the lifetime of the worker that issued them. */
export interface BrowserPageSummary {
  id: string;
  url: string;
  title: string;
}

/** A coherent sample of the worker's explicit active page and its context. */
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  pages: BrowserPageSummary[];
  activePageId: string;
  pageState: BrowserPageState;
  pageError?: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Result of one worker-serialized page action. `actedPageId` names the exact
 * Page object targeted by the action; `activePageId` is the shared target after
 * the action and may differ when a click opens a popup or a page is closed. */
export interface BrowserPageActionSnapshot extends BrowserPageSnapshot {
  actedPageId: string;
}

export interface BrowserAgentPage {
  pageId: string;
  kind: 'agent';
  action: BrowserActivity;
  at: string;
}

export interface BrowserCapacityView {
  running: number;
  maximum: number;
}

export interface BrowserStatusView {
  sessionId: string;
  state: BrowserLifecycle;
  viewport: BrowserViewport;
  viewers: number;
  persistentProfile: true;
  idleTimeoutSeconds: number;
  idleDeadline?: string;
  startedAt?: string;
  /** Current page identity, sampled transiently from the shared browser. */
  url?: string;
  title?: string;
  /** Real Playwright pages only. Empty while the browser is not running. */
  pages: BrowserPageSummary[];
  activePageId?: string;
  pageState?: BrowserPageState;
  /** Coarse, bounded active-document failure only. */
  pageError?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Last page used by an API-resolved agent. Human activity never rewrites it. */
  agentPage?: BrowserAgentPage;
  lastActor?: BrowserLastActor;
  capacity: BrowserCapacityView;
  /** A coarse launch/runtime failure only. Never page text, a screenshot, or a
   * command payload. */
  error?: string;
}

export type BrowserAction =
  | { action: 'start' }
  | { action: 'open'; url?: string }
  | { action: 'stop' }
  | { action: 'navigate'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'type'; selector: string; text: string }
  | { action: 'read'; selector?: string }
  | { action: 'screenshot' }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'new-page'; url?: string }
  | { action: 'activate-page'; pageId: string }
  | { action: 'close-page'; pageId: string }
  | { action: 'resize'; width: number; height: number }
  | { action: 'human-activity'; kind: 'pointer' | 'keyboard' | 'paste' };

export interface BrowserActionResult {
  status: BrowserStatusView;
  /** Explicit, non-durable command output. */
  result?: {
    url?: string;
    title?: string;
    pages?: BrowserPageSummary[];
    activePageId?: string;
    actedPageId?: string;
    pageState?: BrowserPageState;
    pageError?: string;
    canGoBack?: boolean;
    canGoForward?: boolean;
    text?: string;
    /** PNG bytes encoded only for the explicit screenshot response. */
    screenshotBase64?: string;
  };
}

export type BrowserErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'capacity'
  | 'not_running'
  | 'launch_failed'
  | 'upstream_failed';

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

export function isBrowserError(value: unknown): value is BrowserError {
  return value instanceof BrowserError || (value instanceof Error && value.name === 'BrowserError');
}

export function normalizeBrowserViewport(width: number, height: number): BrowserViewport {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new BrowserError('bad_request', 'browser width and height must be finite numbers', 400);
  }
  return {
    width: Math.max(BROWSER_MIN_WIDTH, Math.min(BROWSER_MAX_WIDTH, Math.round(width))),
    height: Math.max(BROWSER_MIN_HEIGHT, Math.min(BROWSER_MAX_HEIGHT, Math.round(height))),
  };
}
