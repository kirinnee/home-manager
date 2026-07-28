import { describe, expect, test } from 'bun:test';
import {
  BrowserStreamBridge,
  parseBrowserInput,
  type BrowserStreamChunk,
  type BrowserStreamDownstream,
} from './browser-stream';
import { BrowserService, type ManagedBrowserRuntime } from './browser-service';
import { createPaths } from './paths';
import type { BrowserInputEvent, BrowserScreencastFrame, BrowserViewport } from './browser-types';

const SID = 'ms3moxcz-352c6078';

class Runtime implements ManagedBrowserRuntime {
  viewport: BrowserViewport = { width: 1280, height: 800 };
  inputs: BrowserInputEvent[] = [];
  listener?: (frame: BrowserScreencastFrame) => void;
  async resize(viewport: BrowserViewport) {
    this.viewport = viewport;
  }
  async navigate(url: string) {
    return { url, title: '' };
  }
  async click() {
    return { url: '', title: '' };
  }
  async type() {
    return { url: '', title: '' };
  }
  async read() {
    return { url: '', title: '', text: '' };
  }
  async screenshot() {
    return { url: '', title: '', screenshotBase64: '' };
  }
  async back() {
    return { url: '', title: '' };
  }
  async forward() {
    return { url: '', title: '' };
  }
  async reload() {
    return { url: '', title: '' };
  }
  async location() {
    return { url: '', title: '' };
  }
  async startScreencast(listener: (frame: BrowserScreencastFrame) => void) {
    this.listener = listener;
  }
  async stopScreencast() {
    this.listener = undefined;
  }
  async dispatchInput(input: BrowserInputEvent) {
    this.inputs.push(input);
  }
  async close() {}
}

class Downstream implements BrowserStreamDownstream {
  sent: BrowserStreamChunk[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  buffered = 0;
  send(chunk: BrowserStreamChunk) {
    this.sent.push(chunk);
  }
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
  }
  getBufferedAmount() {
    return this.buffered;
  }
}

class ThrowingDownstream extends Downstream {
  override send(_chunk: BrowserStreamChunk) {
    throw new Error('socket is gone');
  }
}

async function harness() {
  const runtime = new Runtime();
  const service = new BrowserService(
    createPaths('/tmp/kteam-browser-stream-test'),
    { resolve: async ref => (ref === SID ? SID : undefined) },
    { runtimeFactory: async () => runtime },
  );
  await service.start(SID, 'human');
  return { runtime, service };
}

describe('browser stream input validation', () => {
  test('accepts bounded mouse, keyboard, and insertText events', () => {
    expect(parseBrowserInput({ kind: 'mouse', type: 'mouseWheel', x: 4, y: 5, deltaY: 90 })).toMatchObject({
      kind: 'mouse',
      deltaY: 90,
    });
    expect(parseBrowserInput({ kind: 'key', type: 'keyDown', key: 'A', code: 'KeyA', modifiers: 8 })).toMatchObject({
      kind: 'key',
      key: 'A',
    });
    expect(parseBrowserInput({ kind: 'insertText', text: 'secret' })).toEqual({ kind: 'insertText', text: 'secret' });
  });

  test('rejects malformed or oversized input', () => {
    expect(() => parseBrowserInput({ kind: 'mouse', type: 'teleport', x: 0, y: 0 })).toThrow();
    expect(() => parseBrowserInput({ kind: 'insertText', text: 'x'.repeat(200_001) })).toThrow();
  });
});

describe('browser JPEG stream bridge', () => {
  test('relays transient binary frames and ordered human input', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    const bridge = await BrowserStreamBridge.connect(service, SID, downstream);
    runtime.listener?.({ dataBase64: Buffer.from('jpeg').toString('base64'), width: 1280, height: 800 });
    expect(Buffer.from(downstream.sent[0] as Uint8Array).toString()).toBe('jpeg');
    bridge.fromClient(JSON.stringify({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }));
    await Bun.sleep(0);
    expect(runtime.inputs[0]).toMatchObject({ kind: 'key', key: 'a' });
    expect((await service.status(SID)).lastActor).toMatchObject({ kind: 'human', action: 'keyboard' });
    bridge.close();
    await Bun.sleep(0);
    expect((await service.status(SID)).viewers).toBe(0);
    expect(runtime.inputs.at(-1)).toMatchObject({ kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' });
    await service.close();
  });

  test('drops independent JPEG frames while the viewer is backpressured', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    await BrowserStreamBridge.connect(service, SID, downstream);
    downstream.buffered = 5 * 1024 * 1024;
    runtime.listener?.({ dataBase64: Buffer.from('frame').toString('base64'), width: 1280, height: 800 });
    expect(downstream.sent).toHaveLength(0);
    expect((await service.status(SID)).viewers).toBe(1);
    await service.close();
  });

  test('isolates a failed viewer send while sibling frames and input continue', async () => {
    const { runtime, service } = await harness();
    const failed = new ThrowingDownstream();
    const healthy = new Downstream();
    await BrowserStreamBridge.connect(service, SID, failed);
    const healthyBridge = await BrowserStreamBridge.connect(service, SID, healthy);

    runtime.listener?.({ dataBase64: Buffer.from('frame-one').toString('base64'), width: 1280, height: 800 });
    expect(failed.closed).toEqual([{ code: 1011, reason: 'browser display send failed' }]);
    expect(Buffer.from(healthy.sent[0] as Uint8Array).toString()).toBe('frame-one');
    expect((await service.status(SID)).viewers).toBe(1);

    healthyBridge.fromClient(JSON.stringify({ kind: 'key', type: 'keyDown', key: 'b', code: 'KeyB', text: 'b' }));
    await Bun.sleep(0);
    expect(runtime.inputs.at(-1)).toMatchObject({ kind: 'key', key: 'b' });
    runtime.listener?.({ dataBase64: Buffer.from('frame-two').toString('base64'), width: 1280, height: 800 });
    expect(Buffer.from(healthy.sent[1] as Uint8Array).toString()).toBe('frame-two');
    await service.close();
  });

  test('closes the stream immediately when the browser stops', async () => {
    const { service } = await harness();
    const downstream = new Downstream();
    await BrowserStreamBridge.connect(service, SID, downstream);
    await service.stop(SID, 'agent');
    expect(downstream.closed).toEqual([{ code: 1000, reason: 'remote browser stopped' }]);
    expect((await service.status(SID)).viewers).toBe(0);
    await service.close();
  });
});
