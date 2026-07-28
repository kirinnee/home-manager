import { describe, expect, test } from 'bun:test';
import type { TerminalService } from './terminal-service';
import { TerminalStreamBridge, type TerminalStreamDownstream } from './terminal-stream';

const encoder = new TextEncoder();

function fixture(options: { buffered?: number } = {}) {
  let data: ((bytes: Uint8Array) => void) | undefined;
  let terminal: ((value: { code: number; reason: string }) => void) | undefined;
  let detached = 0;
  let buffered = options.buffered ?? 0;
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let snapshots = 0;
  const service = {
    attachViewer: async (
      _session: string,
      _terminal: string,
      onData: (bytes: Uint8Array) => void,
      onTerminal: (value: { code: number; reason: string }) => void,
    ) => {
      data = onData;
      terminal = onTerminal;
      onData(encoder.encode('initial'));
      return { id: 'viewer', detach: () => detached++ };
    },
    write: async (_session: string, _terminal: string, bytes: Uint8Array) => {
      writes.push(new TextDecoder().decode(bytes));
    },
    resize: async (_session: string, _terminal: string, cols: number, rows: number) => {
      resizes.push({ cols, rows });
      return { cols, rows };
    },
    snapshot: async () => {
      snapshots++;
      return encoder.encode('redraw');
    },
  } as unknown as TerminalService;
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const downstream: TerminalStreamDownstream = {
    send: bytes => {
      sent.push(new TextDecoder().decode(bytes));
      return bytes.byteLength;
    },
    close: (code, reason) => closed.push({ code, reason }),
    getBufferedAmount: () => buffered,
  };
  return {
    service,
    downstream,
    sent,
    closed,
    writes,
    resizes,
    snapshots: () => snapshots,
    detached: () => detached,
    emit: (value: string) => data?.(encoder.encode(value)),
    terminate: (code: number, reason: string) => terminal?.({ code, reason }),
    setBuffered: (value: number) => (buffered = value),
  };
}

describe('TerminalStreamBridge', () => {
  test('relays ANSI down and serializes binary input plus resize control up', async () => {
    const probe = fixture();
    const bridge = await TerminalStreamBridge.connect(probe.service, 'ms-test', '012345abcdef', probe.downstream);
    expect(probe.sent).toEqual(['initial']);
    probe.emit('\u001b[32mlive\u001b[0m');
    expect(probe.sent.at(-1)).toBe('\u001b[32mlive\u001b[0m');
    bridge.fromClient(encoder.encode('echo ok\r'));
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await Bun.sleep(0);
    expect(probe.writes).toEqual(['echo ok\r']);
    expect(probe.resizes).toEqual([{ cols: 120, rows: 40 }]);
    bridge.close();
    expect(probe.detached()).toBe(1);
  });

  test('rejects text keystrokes and closes on terminal lifecycle notification', async () => {
    const invalid = fixture();
    const bridge = await TerminalStreamBridge.connect(invalid.service, 'ms-test', '012345abcdef', invalid.downstream);
    bridge.fromClient('this is not resize JSON');
    expect(invalid.closed).toEqual([{ code: 1008, reason: 'invalid terminal input' }]);
    expect(invalid.detached()).toBe(1);

    const lifecycle = fixture();
    await TerminalStreamBridge.connect(lifecycle.service, 'ms-test', '012345abcdef', lifecycle.downstream);
    lifecycle.terminate(1000, 'terminal closed');
    expect(lifecycle.closed).toEqual([{ code: 1000, reason: 'terminal closed' }]);
  });

  test('coalesces a backpressured byte stream into a full redraw', async () => {
    const probe = fixture({ buffered: 2 * 1024 * 1024 });
    const bridge = await TerminalStreamBridge.connect(probe.service, 'ms-test', '012345abcdef', probe.downstream);
    probe.emit('delta-one');
    probe.emit('delta-two');
    expect(probe.sent).toEqual([]);
    probe.setBuffered(0);
    await Bun.sleep(180);
    expect(probe.snapshots()).toBeGreaterThanOrEqual(1);
    expect(probe.sent).toContain('redraw');
    bridge.close();
  });
});
