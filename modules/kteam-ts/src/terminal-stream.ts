import type { TerminalService, TerminalViewerAttachment, TerminalViewerTerminal } from './terminal-service';

const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;
const MAX_INPUT_MESSAGE_BYTES = 64 * 1024;
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;
const MAX_DOWNSTREAM_BUFFERED_BYTES = 1024 * 1024;
const REDRAW_POLL_MS = 100;

export type TerminalStreamChunk = string | ArrayBuffer | ArrayBufferView;

export interface TerminalStreamDownstream {
  send(chunk: Uint8Array): number | void;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
}

type ClientOperation = { kind: 'input'; bytes: Uint8Array } | { kind: 'resize'; cols: number; rows: number };

function bytes(chunk: Exclude<TerminalStreamChunk, string>): Uint8Array {
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk);
}

function parseClientOperation(chunk: TerminalStreamChunk): { operation: ClientOperation; size: number } {
  if (typeof chunk !== 'string') {
    const value = bytes(chunk);
    if (value.byteLength > MAX_INPUT_MESSAGE_BYTES) throw new Error('terminal input message exceeded');
    return { operation: { kind: 'input', bytes: value.slice() }, size: value.byteLength };
  }
  const size = Buffer.byteLength(chunk);
  if (size > MAX_CONTROL_MESSAGE_BYTES) throw new Error('terminal control message exceeded');
  const value = JSON.parse(chunk) as Record<string, unknown>;
  if (value['type'] !== 'resize' || !Number.isFinite(value['cols']) || !Number.isFinite(value['rows'])) {
    throw new Error('invalid terminal control message');
  }
  return {
    operation: { kind: 'resize', cols: Number(value['cols']), rows: Number(value['rows']) },
    size,
  };
}

/**
 * One authenticated terminal WebSocket.
 *
 * Server-to-client bytes are the pane's ANSI stream. Client-to-server binary
 * frames are raw terminal input; text frames are bounded resize JSON. Nothing
 * is logged or journalled. If a slow viewer falls behind, raw deltas are
 * dropped and replaced with a bounded full tmux redraw once its socket drains.
 */
export class TerminalStreamBridge {
  private closed = false;
  private queuedInputBytes = 0;
  private serial = Promise.resolve();
  private desynced = false;
  private droppedVersion = 0;
  private redrawTimer?: ReturnType<typeof setTimeout>;
  private redrawRunning = false;

  private constructor(
    private readonly service: TerminalService,
    private readonly sessionId: string,
    private readonly terminalId: string,
    private readonly downstream: TerminalStreamDownstream,
    private readonly attachment: TerminalViewerAttachment,
  ) {}

  static async connect(
    service: TerminalService,
    sessionId: string,
    terminalId: string,
    downstream: TerminalStreamDownstream,
  ): Promise<TerminalStreamBridge> {
    let bridge: TerminalStreamBridge | undefined;
    const pending: Uint8Array[] = [];
    let pendingTerminal: TerminalViewerTerminal | undefined;
    const attachment = await service.attachViewer(
      sessionId,
      terminalId,
      chunk => {
        if (bridge) bridge.fromOutput(chunk);
        else pending.push(chunk.slice());
      },
      terminal => {
        if (bridge) bridge.fromTerminal(terminal);
        else pendingTerminal = terminal;
      },
    );
    bridge = new TerminalStreamBridge(service, sessionId, terminalId, downstream, attachment);
    for (const chunk of pending) bridge.fromOutput(chunk);
    if (pendingTerminal) bridge.fromTerminal(pendingTerminal);
    return bridge;
  }

  fromClient(chunk: TerminalStreamChunk): void {
    if (this.closed) return;
    let parsed: { operation: ClientOperation; size: number };
    try {
      parsed = parseClientOperation(chunk);
    } catch {
      this.finish(1008, 'invalid terminal input');
      return;
    }
    if (this.queuedInputBytes + parsed.size > MAX_QUEUED_INPUT_BYTES) {
      this.finish(1009, 'terminal input queue exceeded');
      return;
    }
    this.queuedInputBytes += parsed.size;
    this.serial = this.serial
      .then(async () => {
        if (this.closed) return;
        if (parsed.operation.kind === 'input') {
          await this.service.write(this.sessionId, this.terminalId, parsed.operation.bytes);
        } else {
          await this.service.resize(this.sessionId, this.terminalId, parsed.operation.cols, parsed.operation.rows);
        }
      })
      .catch(() => this.finish(1011, 'terminal operation failed'))
      .finally(() => {
        this.queuedInputBytes = Math.max(0, this.queuedInputBytes - parsed.size);
      });
  }

  private send(bytes: Uint8Array): void {
    try {
      const sent = this.downstream.send(bytes);
      if (typeof sent === 'number' && sent < 0) this.finish(1013, 'terminal viewer unavailable');
    } catch {
      this.finish(1011, 'terminal output send failed');
    }
  }

  private fromOutput(chunk: Uint8Array): void {
    if (this.closed) return;
    if (this.desynced || (this.downstream.getBufferedAmount?.() ?? 0) > MAX_DOWNSTREAM_BUFFERED_BYTES) {
      this.desynced = true;
      this.droppedVersion++;
      this.scheduleRedraw();
      return;
    }
    this.send(chunk);
  }

  private scheduleRedraw(): void {
    if (this.closed || this.redrawRunning || this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = undefined;
      void this.redraw();
    }, REDRAW_POLL_MS);
    this.redrawTimer.unref?.();
  }

  private async redraw(): Promise<void> {
    if (this.closed || !this.desynced || this.redrawRunning) return;
    if ((this.downstream.getBufferedAmount?.() ?? 0) > MAX_DOWNSTREAM_BUFFERED_BYTES) {
      this.scheduleRedraw();
      return;
    }
    this.redrawRunning = true;
    const version = this.droppedVersion;
    try {
      const snapshot = await this.service.snapshot(this.sessionId, this.terminalId);
      if (this.closed) return;
      this.send(snapshot);
      if (this.droppedVersion === version) this.desynced = false;
      else this.scheduleRedraw();
    } catch {
      this.finish(1011, 'terminal redraw failed');
    } finally {
      this.redrawRunning = false;
      if (this.desynced) this.scheduleRedraw();
    }
  }

  private fromTerminal(terminal: TerminalViewerTerminal): void {
    this.finish(terminal.code, terminal.reason);
  }

  close(): void {
    this.finish(1000, 'terminal viewer disconnected', false);
  }

  private finish(code: number, reason: string, closeDownstream = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.redrawTimer) clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    this.attachment.detach();
    if (closeDownstream) {
      try {
        this.downstream.close(code, reason);
      } catch {}
    }
  }
}
