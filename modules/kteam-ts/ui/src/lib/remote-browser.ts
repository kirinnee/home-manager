import { BROWSER_MAX_PAGE_ID_LENGTH } from '../../../src/browser-types';
import { ApiError, TOKEN } from './api';

const REMOTE_FRAME_ENVELOPE_MAGIC = Uint8Array.of(0x4b, 0x42, 0x52, 0x46); // "KBRF"
const REMOTE_FRAME_ENVELOPE_VERSION = 1;
const REMOTE_FRAME_ENVELOPE_HEADER_BYTES = 7;
const REMOTE_MAX_JPEG_BYTES = 8 * 1024 * 1024;

export type RemoteBrowserState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type RemoteBrowserActivity =
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
  | 'resize'
  | 'pointer'
  | 'keyboard'
  | 'paste'
  | 'new-page'
  | 'activate-page'
  | 'close-page';

/** Coarse main-document state for the ACTIVE page only. */
export type RemoteBrowserPageState = 'loading' | 'ready' | 'error';

/** One real Chrome page. Ids are opaque worker-issued strings, never actor
 *  identity, and are only stable for the worker's lifetime. */
export interface RemoteBrowserPage {
  id: string;
  url: string;
  title: string;
}

/** The page the agent last acted on. Deliberately separate from `lastActor` so
 *  an automatic human resize cannot erase the provenance signal. */
export interface RemoteBrowserAgentPage {
  pageId: string;
  /** Matches `lastActor.kind` vocabulary so staleness rendering is shared
   *  across pages, terminals, and the browser. Always 'agent' here. */
  kind: 'agent';
  action: RemoteBrowserActivity;
  at: string;
}

export interface RemoteBrowserStatus {
  sessionId: string;
  state: RemoteBrowserState;
  viewport: { width: number; height: number };
  viewers: number;
  persistentProfile: true;
  idleTimeoutSeconds: number;
  idleDeadline?: string;
  startedAt?: string;
  url?: string;
  title?: string;
  lastActor?: { kind: 'agent' | 'human'; at: string; action: RemoteBrowserActivity };
  capacity: { running: number; maximum: number };
  error?: string;
  /** Every real Chrome page. The UI renders these and never invents its own. */
  pages?: RemoteBrowserPage[];
  activePageId?: string;
  pageState?: RemoteBrowserPageState;
  /** Coarse navigation failure for the active page; never page content. */
  pageError?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  agentPage?: RemoteBrowserAgentPage;
}

export interface RemoteBrowserActionResult {
  status: RemoteBrowserStatus;
  result?: { url?: string; title?: string; text?: string; screenshotBase64?: string };
}

export type RemoteBrowserFrame =
  | { kind: 'tagged'; pageId: string; jpegBytes: ArrayBuffer }
  | { kind: 'legacy'; jpegBytes: ArrayBuffer };

/**
 * Browser frame envelope v1 (one WebSocket binary message):
 *
 *   bytes 0..3   ASCII magic "KBRF"
 *   byte  4      version 1
 *   bytes 5..6   unsigned big-endian UTF-8 page-id byte length
 *   next N bytes UTF-8 opaque page id
 *   remainder    JPEG bytes
 *
 * The message boundary supplies the JPEG length. Identity and pixels can
 * therefore never be reordered independently. Keep this description in sync
 * with encodeBrowserFrameEnvelope() in src/browser-stream.ts.
 *
 * A non-envelope binary message is returned as `legacy`; the pane may paint it
 * only while the daemon has committed no activePageId. A malformed or unknown
 * envelope is never downgraded to legacy.
 */
export function decodeRemoteBrowserFrame(message: ArrayBuffer): RemoteBrowserFrame | null {
  const bytes = new Uint8Array(message);
  if (bytes.byteLength === 0) return null;

  const compared = Math.min(bytes.byteLength, REMOTE_FRAME_ENVELOPE_MAGIC.byteLength);
  let magicPrefix = true;
  for (let index = 0; index < compared; index += 1) {
    if (bytes[index] !== REMOTE_FRAME_ENVELOPE_MAGIC[index]) {
      magicPrefix = false;
      break;
    }
  }
  if (magicPrefix && bytes.byteLength < REMOTE_FRAME_ENVELOPE_MAGIC.byteLength) return null;
  const tagged =
    bytes.byteLength >= REMOTE_FRAME_ENVELOPE_MAGIC.byteLength &&
    REMOTE_FRAME_ENVELOPE_MAGIC.every((value, index) => bytes[index] === value);
  if (!tagged) {
    if (bytes.byteLength > REMOTE_MAX_JPEG_BYTES) return null;
    return { kind: 'legacy', jpegBytes: message };
  }

  if (bytes.byteLength < REMOTE_FRAME_ENVELOPE_HEADER_BYTES) return null;
  if (bytes[4] !== REMOTE_FRAME_ENVELOPE_VERSION) return null;
  const pageIdBytesLength = new DataView(message).getUint16(5, false);
  // Four UTF-8 bytes per UTF-16 code unit is a safe pre-decode ceiling for the
  // shared 128-character opaque-id contract; real worker IDs are ASCII.
  if (pageIdBytesLength === 0 || pageIdBytesLength > BROWSER_MAX_PAGE_ID_LENGTH * 4) return null;
  const jpegOffset = REMOTE_FRAME_ENVELOPE_HEADER_BYTES + pageIdBytesLength;
  const jpegLength = bytes.byteLength - jpegOffset;
  if (jpegLength <= 0 || jpegLength > REMOTE_MAX_JPEG_BYTES) return null;

  try {
    const pageIdBytes = bytes.subarray(REMOTE_FRAME_ENVELOPE_HEADER_BYTES, jpegOffset);
    const pageId = new TextDecoder('utf-8', { fatal: true }).decode(pageIdBytes);
    if (pageId.length === 0 || pageId.length > BROWSER_MAX_PAGE_ID_LENGTH) return null;
    if (new TextEncoder().encode(pageId).byteLength !== pageIdBytesLength) return null;
    return { kind: 'tagged', pageId, jpegBytes: message.slice(jpegOffset) };
  } catch {
    return null;
  }
}

async function browserRequest<T>(sessionId: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body) headers.set('content-type', 'application/json');
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') headers.set('x-kteam-request-id', crypto.randomUUID());
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/browser`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.code);
  }
  return (await response.json()) as T;
}

const action = (sessionId: string, body: unknown) =>
  browserRequest<RemoteBrowserActionResult>(sessionId, { method: 'POST', body: JSON.stringify(body) });

export const remoteBrowserApi = {
  status: (sessionId: string) => browserRequest<RemoteBrowserStatus>(sessionId),
  start: (sessionId: string) => action(sessionId, { action: 'start' }),
  /** Start or reuse the persistent browser, then navigate in the same request when a URL is supplied. */
  open: (sessionId: string, url?: string) => action(sessionId, { action: 'open', ...(url ? { url } : {}) }),
  stop: (sessionId: string) => action(sessionId, { action: 'stop' }),
  navigate: (sessionId: string, url: string) => action(sessionId, { action: 'navigate', url }),
  back: (sessionId: string) => action(sessionId, { action: 'back' }),
  forward: (sessionId: string) => action(sessionId, { action: 'forward' }),
  reload: (sessionId: string) => action(sessionId, { action: 'reload' }),
  resize: (sessionId: string, width: number, height: number) => action(sessionId, { action: 'resize', width, height }),
  activity: (sessionId: string, kind: 'pointer' | 'keyboard' | 'paste') =>
    action(sessionId, { action: 'human-activity', kind }),
  /** Real Chrome page control. The daemon owns every id; the UI only echoes them. */
  newPage: (sessionId: string, url?: string) => action(sessionId, { action: 'new-page', ...(url ? { url } : {}) }),
  activatePage: (sessionId: string, pageId: string) => action(sessionId, { action: 'activate-page', pageId }),
  closePage: (sessionId: string, pageId: string) => action(sessionId, { action: 'close-page', pageId }),
};

export function remoteBrowserStreamUrl(sessionId: string, locationValue: Location = window.location): string {
  const protocol = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${locationValue.host}/v1/sessions/${encodeURIComponent(sessionId)}/browser/stream`);
  if (TOKEN) url.searchParams.set('token', TOKEN);
  return url.toString();
}

export type RemoteViewportMode = 'responsive' | 'desktop';

export function remoteViewportForContainer(
  width: number,
  height: number,
  mode: RemoteViewportMode,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  if (mode === 'desktop') return { width: 1_280, height: 800 };
  return {
    width: Math.max(320, Math.min(1_920, Math.round(width))),
    height: Math.max(240, Math.min(1_200, Math.round(height))),
  };
}

// ---------------------------------------------------------------------------
// Pointer geometry and multi-click, kept pure so both can be proven without a DOM.

export interface RemoteCanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Rendered client point → device pixel of the painted frame.
 *
 * The screencast is painted into a `<canvas>`, so the element's border box IS
 * the drawn image: CSS preserves a replaced element's aspect ratio under
 * max-width/max-height, and the letterbox bars belong to the flex parent. That
 * is why a plain `width` ratio is correct at any scale and no object-fit offset
 * has to be undone. The daemon clamps again, but clamping here keeps the helper
 * total for edge taps and for a zero-width rect during layout.
 */
export function remoteCanvasPoint(
  rect: RemoteCanvasRect,
  canvasWidth: number,
  canvasHeight: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const width = Math.max(1, canvasWidth);
  const height = Math.max(1, canvasHeight);
  const x = ((clientX - rect.left) * width) / Math.max(1, rect.width);
  const y = ((clientY - rect.top) * height) / Math.max(1, rect.height);
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
  };
}

/** Chrome's own double-click window; CDP itself caps a click run at 3. */
export const REMOTE_MULTI_CLICK_MS = 500;
export const REMOTE_MULTI_CLICK_SLOP = 5;
export const REMOTE_MAX_CLICK_COUNT = 3;

export interface RemoteClickRun {
  count: number;
  at: number;
  x: number;
  y: number;
}

/**
 * `PointerEvent.detail` is 0 for pointerdown/pointerup, so it can never carry a
 * click run. Track the run locally from time + distance instead, and send the
 * SAME count on press and release so Chrome sees a well-formed multi-click.
 */
export function nextRemoteClickRun(
  previous: RemoteClickRun | null,
  point: { x: number; y: number },
  at: number,
): RemoteClickRun {
  const continues =
    previous !== null &&
    at - previous.at <= REMOTE_MULTI_CLICK_MS &&
    Math.abs(point.x - previous.x) <= REMOTE_MULTI_CLICK_SLOP &&
    Math.abs(point.y - previous.y) <= REMOTE_MULTI_CLICK_SLOP;
  return {
    count: continues ? Math.min(REMOTE_MAX_CLICK_COUNT, previous.count + 1) : 1,
    at,
    x: point.x,
    y: point.y,
  };
}

/** True for the local paste chord, which must reach the canvas paste handler
 *  instead of being forwarded as a keystroke to the remote Chrome. */
export function isLocalPasteChord(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
}
