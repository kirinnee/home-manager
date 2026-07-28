import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  BrowserError,
  type BrowserInputEvent,
  type BrowserKeyInput,
  type BrowserScreencastFrame,
} from './browser-types';
import type { BrowserService, BrowserViewerAttachment, BrowserViewerTerminal } from './browser-service';

const MAX_INPUT_MESSAGE_BYTES = 256 * 1024;
const MAX_QUEUED_INPUT_BYTES = 1 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_DOWNSTREAM_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_KEY_CHARS = 128;
const MAX_INSERT_TEXT_CHARS = 200_000;
const FRAME_ENVELOPE_MAGIC = Uint8Array.of(0x4b, 0x42, 0x52, 0x46); // "KBRF"
const FRAME_ENVELOPE_VERSION = 1;
const FRAME_ENVELOPE_HEADER_BYTES = 7;

export type BrowserStreamChunk = string | ArrayBuffer | ArrayBufferView;

export interface BrowserStreamDownstream {
  /** Screencast output is one versioned page-id/JPEG envelope; the wider
   * BrowserStreamChunk union is accepted only in the client-to-daemon input
   * direction. */
  send(chunk: Uint8Array): number | void;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function finite(raw: Record<string, unknown>, key: string, fallback = 0): number {
  const value = raw[key] === undefined ? fallback : Number(raw[key]);
  if (!Number.isFinite(value)) throw new BrowserError('bad_request', `${key} must be finite`, 400);
  return value;
}

function shortString(raw: Record<string, unknown>, key: string, maximum = MAX_KEY_CHARS): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length > maximum) {
    throw new BrowserError('bad_request', `${key} must be a string no longer than ${maximum} characters`, 400);
  }
  return value;
}

export function parseBrowserInput(value: unknown): BrowserInputEvent {
  const raw = asObject(value);
  if (raw['kind'] === 'mouse') {
    const type = raw['type'];
    if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(type))) {
      throw new BrowserError('bad_request', 'unsupported mouse input type', 400);
    }
    const button = raw['button'];
    if (button !== undefined && !['none', 'left', 'middle', 'right', 'back', 'forward'].includes(String(button))) {
      throw new BrowserError('bad_request', 'unsupported mouse button', 400);
    }
    return {
      kind: 'mouse',
      type: type as 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel',
      x: finite(raw, 'x'),
      y: finite(raw, 'y'),
      ...(button === undefined ? {} : { button: button as 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward' }),
      buttons: Math.max(0, Math.min(31, Math.round(finite(raw, 'buttons')))),
      clickCount: Math.max(0, Math.min(3, Math.round(finite(raw, 'clickCount')))),
      deltaX: Math.max(-10_000, Math.min(10_000, finite(raw, 'deltaX'))),
      deltaY: Math.max(-10_000, Math.min(10_000, finite(raw, 'deltaY'))),
      modifiers: Math.max(0, Math.min(15, Math.round(finite(raw, 'modifiers')))),
    };
  }
  if (raw['kind'] === 'key') {
    const type = raw['type'];
    if (type !== 'keyDown' && type !== 'keyUp')
      throw new BrowserError('bad_request', 'unsupported key input type', 400);
    const text = raw['text'];
    const unmodifiedText = raw['unmodifiedText'];
    return {
      kind: 'key',
      type,
      key: shortString(raw, 'key'),
      code: shortString(raw, 'code'),
      ...(typeof text === 'string' && text.length <= 16 ? { text } : {}),
      ...(typeof unmodifiedText === 'string' && unmodifiedText.length <= 16 ? { unmodifiedText } : {}),
      windowsVirtualKeyCode: Math.max(0, Math.min(0xffff, Math.round(finite(raw, 'windowsVirtualKeyCode')))),
      nativeVirtualKeyCode: Math.max(0, Math.min(0xffff, Math.round(finite(raw, 'nativeVirtualKeyCode')))),
      modifiers: Math.max(0, Math.min(15, Math.round(finite(raw, 'modifiers')))),
      autoRepeat: raw['autoRepeat'] === true,
      isKeypad: raw['isKeypad'] === true,
    };
  }
  if (raw['kind'] === 'insertText') {
    const text = raw['text'];
    if (typeof text !== 'string' || text.length > MAX_INSERT_TEXT_CHARS) {
      throw new BrowserError('bad_request', `text must be no longer than ${MAX_INSERT_TEXT_CHARS} characters`, 400);
    }
    return { kind: 'insertText', text };
  }
  throw new BrowserError('bad_request', 'unsupported browser input kind', 400);
}

function inputBytes(chunk: BrowserStreamChunk): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk);
}

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
 * with decodeRemoteBrowserFrame() in ui/src/lib/remote-browser.ts.
 */
export function encodeBrowserFrameEnvelope(pageId: string, jpegBytes: Uint8Array): Uint8Array | undefined {
  if (pageId.length === 0 || pageId.length > BROWSER_MAX_PAGE_ID_LENGTH || jpegBytes.byteLength === 0) {
    return undefined;
  }
  const pageIdBytes = new TextEncoder().encode(pageId);
  if (pageIdBytes.byteLength === 0 || pageIdBytes.byteLength > 0xffff) return undefined;
  const envelope = new Uint8Array(FRAME_ENVELOPE_HEADER_BYTES + pageIdBytes.byteLength + jpegBytes.byteLength);
  envelope.set(FRAME_ENVELOPE_MAGIC, 0);
  envelope[4] = FRAME_ENVELOPE_VERSION;
  new DataView(envelope.buffer).setUint16(5, pageIdBytes.byteLength, false);
  envelope.set(pageIdBytes, FRAME_ENVELOPE_HEADER_BYTES);
  envelope.set(jpegBytes, FRAME_ENVELOPE_HEADER_BYTES + pageIdBytes.byteLength);
  return envelope;
}

/** Authenticated browser stream: atomic page-id/JPEG envelopes flow down,
 * bounded JSON CDP input flows up. Neither direction is logged or persisted. */
export class BrowserStreamBridge {
  private closed = false;
  private queuedInputBytes = 0;
  private serial = Promise.resolve();
  private readonly pressedKeys = new Map<string, BrowserKeyInput>();

  private constructor(
    private readonly service: BrowserService,
    private readonly sessionId: string,
    private readonly downstream: BrowserStreamDownstream,
    private readonly attachment: BrowserViewerAttachment,
  ) {}

  static async connect(
    service: BrowserService,
    sessionId: string,
    downstream: BrowserStreamDownstream,
  ): Promise<BrowserStreamBridge> {
    let bridge: BrowserStreamBridge | undefined;
    let pendingFrame: BrowserScreencastFrame | undefined;
    let pendingTerminal: BrowserViewerTerminal | undefined;
    const attachment = await service.attachViewer(
      sessionId,
      frame => {
        if (bridge) bridge.fromFrame(frame);
        else pendingFrame = frame;
      },
      terminal => {
        if (bridge) bridge.fromTerminal(terminal);
        else pendingTerminal = terminal;
      },
    );
    bridge = new BrowserStreamBridge(service, sessionId, downstream, attachment);
    if (pendingTerminal) bridge.fromTerminal(pendingTerminal);
    else if (pendingFrame) bridge.fromFrame(pendingFrame);
    return bridge;
  }

  fromClient(chunk: BrowserStreamChunk): void {
    if (this.closed) return;
    const bytes = inputBytes(chunk);
    if (
      bytes.byteLength > MAX_INPUT_MESSAGE_BYTES ||
      this.queuedInputBytes + bytes.byteLength > MAX_QUEUED_INPUT_BYTES
    ) {
      this.finish(1009, 'browser input queue exceeded');
      return;
    }
    let input: BrowserInputEvent;
    try {
      input = parseBrowserInput(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      this.finish(1008, 'invalid browser input');
      return;
    }
    this.queuedInputBytes += bytes.byteLength;
    this.serial = this.serial
      .then(async () => {
        if (this.closed) return;
        if (input.kind === 'key') {
          const id = input.code || input.key;
          if (input.type === 'keyDown') this.pressedKeys.set(id, input);
          else this.pressedKeys.delete(id);
        }
        await this.service.dispatchHumanInput(this.sessionId, input);
      })
      .catch(() => {
        this.finish(1011, 'browser input failed');
      })
      .finally(() => {
        this.queuedInputBytes = Math.max(0, this.queuedInputBytes - bytes.byteLength);
      });
  }

  private fromFrame(frame: BrowserScreencastFrame): void {
    if (this.closed) return;
    try {
      if ((this.downstream.getBufferedAmount?.() ?? 0) > MAX_DOWNSTREAM_BUFFERED_BYTES) return;
      if (
        typeof frame.pageId !== 'string' ||
        frame.pageId.length === 0 ||
        frame.pageId.length > BROWSER_MAX_PAGE_ID_LENGTH
      ) {
        // A frame with no trustworthy identity cannot be placed under a real
        // active-page marker. Drop it without taking down a healthy viewer.
        return;
      }
      const bytes = Buffer.from(frame.dataBase64, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) {
        this.finish(1009, 'browser frame exceeded');
        return;
      }
      const envelope = encodeBrowserFrameEnvelope(frame.pageId, bytes);
      if (!envelope) return;
      const sent = this.downstream.send(envelope);
      if (typeof sent === 'number' && sent < 0) this.finish(1013, 'browser viewer unavailable');
    } catch {
      this.finish(1011, 'browser display send failed');
    }
  }

  private fromTerminal(terminal: BrowserViewerTerminal): void {
    this.finish(terminal.code, terminal.reason);
  }

  close(): void {
    this.finish(1000, 'browser viewer disconnected', false);
  }

  private finish(code: number, reason: string, closeDownstream = true): void {
    if (this.closed) return;
    this.closed = true;
    const releases = [...this.pressedKeys.values()].reverse().map(input => {
      const { text: _text, unmodifiedText: _unmodifiedText, ...rest } = input;
      return { ...rest, type: 'keyUp' as const, modifiers: 0, autoRepeat: false };
    });
    this.pressedKeys.clear();
    if (releases.length > 0) {
      const release = async () => {
        for (const input of releases) {
          await this.service.dispatchHumanInput(this.sessionId, input).catch(() => undefined);
        }
      };
      this.serial = this.serial.then(release, release);
    }
    this.attachment.detach();
    if (closeDownstream) {
      try {
        this.downstream.close(code, reason);
      } catch {}
    }
  }
}
