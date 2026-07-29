import { describe, expect, test } from 'bun:test';
import {
  BrowserStreamBridge,
  encodeBrowserFrameEnvelope,
  parseBrowserInput,
  type BrowserStreamDownstream,
  type BrowserStreamScheduler,
} from './browser-stream';
import { BrowserService, type ManagedBrowserRuntime } from './browser-service';
import { createPaths } from './paths';
import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  type BrowserInputEvent,
  type BrowserScreencastFrame,
  type BrowserViewport,
} from './browser-types';

const SID = 'ms3moxcz-352c6078';

function decodeFrameEnvelope(chunk: Uint8Array): { version: number; pageId: string; jpeg: string } {
  if (Buffer.from(chunk.subarray(0, 4)).toString() !== 'KBRF') throw new Error('missing frame envelope magic');
  const pageIdLength = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint16(5, false);
  const jpegOffset = 7 + pageIdLength;
  return {
    version: chunk[4]!,
    pageId: new TextDecoder().decode(chunk.subarray(7, jpegOffset)),
    jpeg: Buffer.from(chunk.subarray(jpegOffset)).toString(),
  };
}

class Runtime implements ManagedBrowserRuntime {
  viewport: BrowserViewport = { width: 1280, height: 800 };
  inputs: BrowserInputEvent[] = [];
  listener?: (frame: BrowserScreencastFrame) => void;
  initialScreencastFrames: BrowserScreencastFrame[] = [];
  onStartScreencast?: () => Promise<void>;
  private pages = [{ id: 'page-1', url: 'about:blank', title: '' }];
  private activePageId = 'page-1';

  private snapshot() {
    const active = this.pages.find(page => page.id === this.activePageId)!;
    return {
      url: active.url,
      title: active.title,
      pages: this.pages.map(page => ({ ...page })),
      activePageId: active.id,
      pageState: 'ready' as const,
      canGoBack: false,
      canGoForward: false,
    };
  }

  private actionSnapshot(actedPageId = this.activePageId) {
    return { ...this.snapshot(), actedPageId };
  }

  async resize(viewport: BrowserViewport) {
    this.viewport = viewport;
    return this.actionSnapshot();
  }
  async navigate(url: string) {
    const active = this.pages.find(page => page.id === this.activePageId)!;
    active.url = url;
    return this.actionSnapshot();
  }
  async click() {
    return this.actionSnapshot();
  }
  async type() {
    return this.actionSnapshot();
  }
  async read() {
    return { ...this.actionSnapshot(), text: '' };
  }
  async screenshot() {
    return { ...this.actionSnapshot(), screenshotBase64: '' };
  }
  async back() {
    return this.actionSnapshot();
  }
  async forward() {
    return this.actionSnapshot();
  }
  async reload() {
    return this.actionSnapshot();
  }
  async location() {
    return this.snapshot();
  }
  async newPage(url = 'about:blank') {
    const id = `page-${this.pages.length + 1}`;
    this.pages.push({ id, url, title: '' });
    this.activePageId = id;
    return this.actionSnapshot(id);
  }
  async activatePage(pageId: string) {
    if (!this.pages.some(page => page.id === pageId)) throw new Error('page not found');
    this.activePageId = pageId;
    return this.actionSnapshot(pageId);
  }
  async closePage(pageId: string) {
    const index = this.pages.findIndex(page => page.id === pageId);
    if (index < 0) throw new Error('page not found');
    this.pages.splice(index, 1);
    if (this.pages.length === 0) this.pages.push({ id: 'page-replacement', url: 'about:blank', title: '' });
    if (this.activePageId === pageId) this.activePageId = this.pages[Math.min(index, this.pages.length - 1)]!.id;
    return this.actionSnapshot(pageId);
  }
  async startScreencast(listener: (frame: BrowserScreencastFrame) => void) {
    this.listener = listener;
    for (const frame of this.initialScreencastFrames) listener(frame);
    await this.onStartScreencast?.();
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
  sent: Uint8Array[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  buffered = 0;
  send(chunk: Uint8Array): number | void {
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
  override send(_chunk: Uint8Array) {
    throw new Error('socket is gone');
  }
}

class BackpressuredDownstream extends Downstream {
  override send(chunk: Uint8Array): number {
    this.sent.push(chunk);
    return -1;
  }
}

class DroppingDownstream extends Downstream {
  attempts: Uint8Array[] = [];
  result: number | void = 0;

  override send(chunk: Uint8Array): number | void {
    this.attempts.push(chunk);
    if (this.result === 0) return 0;
    this.sent.push(chunk);
    return this.result;
  }
}

class FrameClock implements BrowserStreamScheduler {
  private now = 0;
  private nextTimer = 0;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.nextTimer += 1;
    this.timers.set(this.nextTimer, { dueAt: this.now + delayMs, callback });
    return this.nextTimer;
  }

  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  advance(delayMs: number): void {
    const deadline = this.now + delayMs;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= deadline)
        .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.dueAt;
      timer.callback();
    }
    this.now = deadline;
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
  test('encodes page identity and JPEG bytes in one bounded versioned message', () => {
    const jpeg = Buffer.from('jpeg');
    const encoded = encodeBrowserFrameEnvelope('page-1', jpeg)!;
    expect(decodeFrameEnvelope(encoded)).toEqual({ version: 1, pageId: 'page-1', jpeg: 'jpeg' });
    expect(encodeBrowserFrameEnvelope('', jpeg)).toBeUndefined();
    expect(encodeBrowserFrameEnvelope('x'.repeat(BROWSER_MAX_PAGE_ID_LENGTH + 1), jpeg)).toBeUndefined();
    expect(encodeBrowserFrameEnvelope('page-1', new Uint8Array())).toBeUndefined();
  });

  test('relays transient binary frames and ordered human input', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    const bridge = await BrowserStreamBridge.connect(service, SID, downstream);
    runtime.listener?.({
      dataBase64: Buffer.from('jpeg').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    expect(decodeFrameEnvelope(downstream.sent[0]!)).toEqual({ version: 1, pageId: 'page-1', jpeg: 'jpeg' });
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

  test('relays only the latest frame emitted synchronously while attaching the viewer', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    runtime.initialScreencastFrames = [
      {
        dataBase64: Buffer.from('older-frame').toString('base64'),
        width: 1280,
        height: 800,
        pageId: 'page-older',
      },
      {
        dataBase64: Buffer.from('latest-frame').toString('base64'),
        width: 1280,
        height: 800,
        pageId: 'page-latest',
      },
    ];

    await BrowserStreamBridge.connect(service, SID, downstream);

    expect(downstream.sent).toHaveLength(1);
    expect(decodeFrameEnvelope(downstream.sent[0]!)).toEqual({
      version: 1,
      pageId: 'page-latest',
      jpeg: 'latest-frame',
    });
    await service.close();
  });

  test('terminal suppresses a frame emitted synchronously while attaching the viewer', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    runtime.initialScreencastFrames = [
      {
        dataBase64: Buffer.from('stale-frame').toString('base64'),
        width: 1280,
        height: 800,
        pageId: 'page-stale',
      },
    ];
    runtime.onStartScreencast = async () => {
      await service.stop(SID, 'agent');
    };

    await BrowserStreamBridge.connect(service, SID, downstream);

    expect(downstream.sent).toEqual([]);
    expect(downstream.closed).toEqual([{ code: 1000, reason: 'remote browser stopped' }]);
    await service.close();
  });

  test('drops independent JPEG frames while the viewer is backpressured', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    await BrowserStreamBridge.connect(service, SID, downstream);
    downstream.buffered = 5 * 1024 * 1024;
    runtime.listener?.({
      dataBase64: Buffer.from('frame').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    expect(downstream.sent).toHaveLength(0);
    expect((await service.status(SID)).viewers).toBe(1);
    await service.close();
  });

  test('sends only the newest buffered frame after a slow viewer recovers', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    const clock = new FrameClock();
    downstream.buffered = 1;
    await BrowserStreamBridge.connect(service, SID, downstream, clock);

    runtime.listener?.({
      dataBase64: Buffer.from('older-frame').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    runtime.listener?.({
      dataBase64: Buffer.from('newest-frame').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    expect(downstream.sent).toEqual([]);

    downstream.buffered = 0;
    clock.advance(16);
    expect(downstream.sent).toHaveLength(1);
    expect(decodeFrameEnvelope(downstream.sent[0]!)).toMatchObject({ jpeg: 'newest-frame' });
    await service.close();
  });

  test('keeps a fast viewer independent from a backpressured sibling', async () => {
    const { runtime, service } = await harness();
    const slow = new Downstream();
    const fast = new Downstream();
    const clock = new FrameClock();
    slow.buffered = 1;
    await BrowserStreamBridge.connect(service, SID, slow, clock);
    await BrowserStreamBridge.connect(service, SID, fast, clock);

    runtime.listener?.({
      dataBase64: Buffer.from('frame-one').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    runtime.listener?.({
      dataBase64: Buffer.from('frame-two').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });

    expect(fast.sent.map(decodeFrameEnvelope).map(frame => frame.jpeg)).toEqual(['frame-one', 'frame-two']);
    expect(slow.sent).toEqual([]);
    slow.buffered = 0;
    clock.advance(16);
    expect(slow.sent.map(decodeFrameEnvelope).map(frame => frame.jpeg)).toEqual(['frame-two']);
    expect(fast.sent).toHaveLength(2);
    await service.close();
  });

  test('treats Bun backpressure and dropped-frame results as healthy transport states', async () => {
    const { runtime, service } = await harness();
    const backpressured = new BackpressuredDownstream();
    const dropped = new DroppingDownstream();
    const clock = new FrameClock();
    await BrowserStreamBridge.connect(service, SID, backpressured, clock);
    await BrowserStreamBridge.connect(service, SID, dropped, clock);

    runtime.listener?.({
      dataBase64: Buffer.from('latest-frame').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });

    expect(backpressured.closed).toEqual([]);
    expect(backpressured.sent).toHaveLength(1);
    expect(dropped.closed).toEqual([]);
    expect(dropped.sent).toEqual([]);
    dropped.result = undefined;
    clock.advance(16);
    expect(dropped.sent.map(decodeFrameEnvelope).map(frame => frame.jpeg)).toEqual(['latest-frame']);
    expect((await service.status(SID)).viewers).toBe(2);
    await service.close();
  });

  test('drops frames whose page identity is missing or invalid without closing the viewer', async () => {
    const { runtime, service } = await harness();
    const downstream = new Downstream();
    await BrowserStreamBridge.connect(service, SID, downstream);
    const dataBase64 = Buffer.from('frame').toString('base64');

    runtime.listener?.({ dataBase64, width: 1280, height: 800 });
    runtime.listener?.({ dataBase64, width: 1280, height: 800, pageId: '' });
    runtime.listener?.({
      dataBase64,
      width: 1280,
      height: 800,
      pageId: 'x'.repeat(BROWSER_MAX_PAGE_ID_LENGTH + 1),
    });
    expect(downstream.sent).toHaveLength(0);
    expect(downstream.closed).toHaveLength(0);
    expect((await service.status(SID)).viewers).toBe(1);
    await service.close();
  });

  test('isolates a failed viewer send while sibling frames and input continue', async () => {
    const { runtime, service } = await harness();
    const failed = new ThrowingDownstream();
    const healthy = new Downstream();
    await BrowserStreamBridge.connect(service, SID, failed);
    const healthyBridge = await BrowserStreamBridge.connect(service, SID, healthy);

    runtime.listener?.({
      dataBase64: Buffer.from('frame-one').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    expect(failed.closed).toEqual([{ code: 1011, reason: 'browser display send failed' }]);
    expect(decodeFrameEnvelope(healthy.sent[0]!)).toEqual({ version: 1, pageId: 'page-1', jpeg: 'frame-one' });
    expect((await service.status(SID)).viewers).toBe(1);

    healthyBridge.fromClient(JSON.stringify({ kind: 'key', type: 'keyDown', key: 'b', code: 'KeyB', text: 'b' }));
    await Bun.sleep(0);
    expect(runtime.inputs.at(-1)).toMatchObject({ kind: 'key', key: 'b' });
    runtime.listener?.({
      dataBase64: Buffer.from('frame-two').toString('base64'),
      width: 1280,
      height: 800,
      pageId: 'page-1',
    });
    expect(decodeFrameEnvelope(healthy.sent[1]!)).toEqual({ version: 1, pageId: 'page-1', jpeg: 'frame-two' });
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
