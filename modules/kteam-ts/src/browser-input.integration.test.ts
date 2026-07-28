import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime, resolveChromeExecutable } from './browser-runtime';
import type { BrowserScreencastFrame } from './browser-types';

const VIEWPORT = { width: 1_280, height: 800 } as const;
const CANVAS_DOWNSCALE = 2.5;
const DELAYED_HISTORY_BODY_MS = 750;
const BUTTON = { left: 250, top: 125, width: 200, height: 60 } as const;
const FIELD = { left: 250, top: 250, width: 240, height: 40 } as const;
const delayedHistoryRequests = { A: 0, B: 0 };

const chromeExecutable = (() => {
  try {
    return resolveChromeExecutable();
  } catch {
    return undefined;
  }
})();

let server: ReturnType<typeof Bun.serve>;
let fixtureUrl = '';

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const delayedHistoryPage = url.pathname === '/delayed-a' ? 'A' : url.pathname === '/delayed-b' ? 'B' : undefined;
      if (delayedHistoryPage) {
        delayedHistoryRequests[delayedHistoryPage] += 1;
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                '<!doctype html><html><head><script>window.addEventListener("unload", () => {});</script>',
              ),
            );
            timer = setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `<title>Delayed History ${delayedHistoryPage}</title></head><body><output id="page">Delayed ${delayedHistoryPage}</output></body></html>`,
                ),
              );
              controller.close();
            }, DELAYED_HISTORY_BODY_MS);
          },
          cancel() {
            if (timer) clearTimeout(timer);
          },
        });
        return new Response(body, {
          headers: {
            'cache-control': 'no-store',
            'content-type': 'text/html; charset=utf-8',
          },
        });
      }
      if (url.pathname === '/redirect') {
        return Response.redirect(new URL('/b', url), 302);
      }
      const historyPage = url.pathname === '/a' ? 'A' : url.pathname === '/b' ? 'B' : undefined;
      return new Response(
        `<!doctype html>
        <html>
          <head>
            <title>${
              historyPage
                ? `KTeam Browser ${historyPage}`
                : url.pathname === '/second'
                  ? 'Second fixture'
                  : url.pathname === '/popup'
                    ? 'Popup fixture'
                    : 'Input fixture'
            }</title>
            <style>
              html, body { margin: 0; width: 100%; height: 100%; }
              #hit { position: absolute; left: ${BUTTON.left}px; top: ${BUTTON.top}px;
                     width: ${BUTTON.width}px; height: ${BUTTON.height}px; }
              #field { position: absolute; left: ${FIELD.left}px; top: ${FIELD.top}px;
                       width: ${FIELD.width}px; height: ${FIELD.height}px; }
              #log { position: absolute; top: 340px; }
              #value { position: absolute; top: 370px; }
              #popup { position: absolute; left: 520px; top: 125px; width: 160px; height: 60px; }
            </style>
          </head>
          <body>
            <button id="hit" type="button">Hit target</button>
            <button id="popup" type="button">Open popup</button>
            <input id="field" aria-label="Known field" />
            <output id="log">idle</output>
            <output id="value"></output>
            <output id="page">${historyPage ?? 'input'}</output>
            <script>
              document.querySelector('#hit').addEventListener('click', () => {
                document.querySelector('#log').textContent = 'clicked';
              });
              document.querySelector('#field').addEventListener('input', event => {
                document.querySelector('#value').textContent = event.currentTarget.value;
              });
              document.querySelector('#popup').addEventListener('click', () => {
                window.open('/popup', '_blank');
              });
            </script>
          </body>
        </html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  });
  fixtureUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function firstFrame(
  runtime: BrowserRuntime,
  observe: (frame: BrowserScreencastFrame) => void,
): Promise<BrowserScreencastFrame> {
  return await new Promise<BrowserScreencastFrame>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for a Chrome screencast frame')), 10_000);
    void runtime
      .startScreencast(frame => {
        observe(frame);
        clearTimeout(timeout);
        resolve(frame);
      })
      .catch(error => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

async function waitForPageFrame(frames: BrowserScreencastFrame[], pageId: string): Promise<BrowserScreencastFrame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = frames.find(frame => frame.pageId === pageId);
    if (match) return match;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for a screencast frame from page ${pageId}`);
}

const devicePointFromDownscaledCanvas = (point: { x: number; y: number }): { x: number; y: number } => ({
  x: point.x * CANVAS_DOWNSCALE,
  y: point.y * CANVAS_DOWNSCALE,
});

async function clickAt(runtime: BrowserRuntime, x: number, y: number): Promise<void> {
  await runtime.dispatchInput({
    kind: 'mouse',
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await runtime.dispatchInput({
    kind: 'mouse',
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

function startNoStoreHistoryServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const page = url.pathname === '/a' ? 'A' : 'B';
      return new Response(
        `<!doctype html><html><head><title>Uncommitted ${page}</title><script>window.addEventListener('unload', () => {});</script></head><body>${page}</body></html>`,
        {
          headers: {
            'cache-control': 'no-store',
            'content-type': 'text/html; charset=utf-8',
          },
        },
      );
    },
  });
}

describe.skipIf(!chromeExecutable)('real Chrome browser input and page identity', () => {
  test('returns coherent ready snapshots promptly across redirect-backed history traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kteam-browser-history-'));
    let runtime: BrowserRuntime | undefined;
    try {
      runtime = await BrowserRuntime.launch('browser-history-integration', root, VIEWPORT, {
        chromeExecutable: chromeExecutable!,
      });
      const pageA = await runtime.navigate(`${fixtureUrl}/a`);
      expect(pageA).toMatchObject({
        url: `${fixtureUrl}/a`,
        title: 'KTeam Browser A',
        pageState: 'ready',
      });

      const frames: BrowserScreencastFrame[] = [];
      await firstFrame(runtime, frame => frames.push(frame));

      const pageB = await runtime.navigate(`${fixtureUrl}/redirect`);
      expect(pageB).toMatchObject({
        url: `${fixtureUrl}/b`,
        title: 'KTeam Browser B',
        activePageId: pageA.activePageId,
        actedPageId: pageA.activePageId,
        pageState: 'ready',
      });

      frames.length = 0;
      const backStartedAt = Date.now();
      const back = await runtime.back();
      expect(Date.now() - backStartedAt).toBeLessThan(10_000);
      expect(back).toMatchObject({
        url: `${fixtureUrl}/a`,
        title: 'KTeam Browser A',
        activePageId: pageA.activePageId,
        actedPageId: pageA.activePageId,
        pageState: 'ready',
        canGoBack: true,
        canGoForward: true,
      });
      expect(back.pageError).toBeUndefined();
      expect(back.pages.find(page => page.id === back.activePageId)).toMatchObject({
        url: back.url,
        title: back.title,
      });
      expect((await runtime.read('#page')).text).toBe('A');
      expect((await waitForPageFrame(frames, back.activePageId)).pageId).toBe(back.activePageId);

      frames.length = 0;
      const forwardStartedAt = Date.now();
      const forward = await runtime.forward();
      expect(Date.now() - forwardStartedAt).toBeLessThan(10_000);
      expect(forward).toMatchObject({
        url: `${fixtureUrl}/b`,
        title: 'KTeam Browser B',
        activePageId: pageA.activePageId,
        actedPageId: pageA.activePageId,
        pageState: 'ready',
        canGoBack: true,
        canGoForward: false,
      });
      expect(forward.pageError).toBeUndefined();
      expect(forward.pages.find(page => page.id === forward.activePageId)).toMatchObject({
        url: forward.url,
        title: forward.title,
      });
      expect((await runtime.read('#page')).text).toBe('B');
      expect((await waitForPageFrame(frames, forward.activePageId)).pageId).toBe(forward.activePageId);

      await expect(runtime.navigate('http://127.0.0.1:1/uncommitted')).rejects.toThrow();
      const failed = await runtime.location();
      expect(failed.pageState).toBe('error');
      expect(failed.pageError).toBeTruthy();
      expect(failed.pageError!.length).toBeLessThanOrEqual(200);
      expect(failed.pageError).not.toContain('\n');
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 75_000);

  test('waits for delayed no-store history documents before publishing ready metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kteam-browser-delayed-history-'));
    let runtime: BrowserRuntime | undefined;
    try {
      delayedHistoryRequests.A = 0;
      delayedHistoryRequests.B = 0;
      runtime = await BrowserRuntime.launch('browser-delayed-history-integration', root, VIEWPORT, {
        chromeExecutable: chromeExecutable!,
      });
      const pageA = await runtime.navigate(`${fixtureUrl}/delayed-a`);
      const pageB = await runtime.navigate(`${fixtureUrl}/delayed-b`);
      expect(pageB.activePageId).toBe(pageA.activePageId);

      const backStartedAt = Date.now();
      const back = await runtime.back();
      const backElapsed = Date.now() - backStartedAt;
      expect(backElapsed).toBeGreaterThanOrEqual(500);
      expect(backElapsed).toBeLessThan(10_000);
      expect(back).toMatchObject({
        url: `${fixtureUrl}/delayed-a`,
        title: 'Delayed History A',
        activePageId: pageA.activePageId,
        actedPageId: pageA.activePageId,
        pageState: 'ready',
        canGoBack: true,
        canGoForward: true,
      });
      expect(back.pageError).toBeUndefined();
      expect(back.pages.find(page => page.id === back.activePageId)).toMatchObject({
        url: back.url,
        title: back.title,
      });
      expect((await runtime.read('#page')).text).toBe('Delayed A');
      expect(delayedHistoryRequests.A).toBeGreaterThanOrEqual(2);

      const forwardStartedAt = Date.now();
      const forward = await runtime.forward();
      const forwardElapsed = Date.now() - forwardStartedAt;
      expect(forwardElapsed).toBeGreaterThanOrEqual(500);
      expect(forwardElapsed).toBeLessThan(10_000);
      expect(forward).toMatchObject({
        url: `${fixtureUrl}/delayed-b`,
        title: 'Delayed History B',
        activePageId: pageA.activePageId,
        actedPageId: pageA.activePageId,
        pageState: 'ready',
        canGoBack: true,
        canGoForward: false,
      });
      expect(forward.pageError).toBeUndefined();
      expect(forward.pages.find(page => page.id === forward.activePageId)).toMatchObject({
        url: forward.url,
        title: forward.title,
      });
      expect((await runtime.read('#page')).text).toBe('Delayed B');
      expect(delayedHistoryRequests.B).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('rejects Back and Forward traversals that cannot commit with bounded page errors', async () => {
    for (const direction of ['back', 'forward'] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `kteam-browser-${direction}-failure-`));
      const unavailable = startNoStoreHistoryServer();
      let runtime: BrowserRuntime | undefined;
      let serverRunning = true;
      try {
        const origin = `http://127.0.0.1:${unavailable.port}`;
        runtime = await BrowserRuntime.launch(`browser-${direction}-failure-integration`, root, VIEWPORT, {
          chromeExecutable: chromeExecutable!,
        });
        await runtime.navigate(`${origin}/a`);
        await runtime.navigate(`${origin}/b`);
        if (direction === 'forward') await runtime.back();

        unavailable.stop(true);
        serverRunning = false;
        const startedAt = Date.now();
        await expect(direction === 'back' ? runtime.back() : runtime.forward()).rejects.toThrow();
        expect(Date.now() - startedAt).toBeLessThan(10_000);

        const failed = await runtime.location();
        expect(failed.pageState).toBe('error');
        expect(failed.pageError).toBeTruthy();
        expect(failed.pageError!.length).toBeLessThanOrEqual(200);
        expect(failed.pageError).not.toContain('\n');
      } finally {
        if (serverRunning) unavailable.stop(true);
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test('keeps viewport, scaled input, typing, and real page lifecycle coherent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kteam-browser-input-'));
    let runtime: BrowserRuntime | undefined;
    try {
      runtime = await BrowserRuntime.launch('browser-input-integration', root, VIEWPORT, {
        chromeExecutable: chromeExecutable!,
      });
      const initial = await runtime.navigate(fixtureUrl);
      expect(initial.actedPageId).toBe(initial.activePageId);
      expect(initial.pages.find(page => page.id === initial.activePageId)).toMatchObject({
        url: initial.url,
        title: initial.title,
      });
      const frames: BrowserScreencastFrame[] = [];
      const frame = await firstFrame(runtime, item => frames.push(item));
      expect({ width: frame.width, height: frame.height }).toEqual(VIEWPORT);

      const renderedButtonCenter = {
        x: (BUTTON.left + BUTTON.width / 2) / CANVAS_DOWNSCALE,
        y: (BUTTON.top + BUTTON.height / 2) / CANVAS_DOWNSCALE,
      };
      const buttonPoint = devicePointFromDownscaledCanvas(renderedButtonCenter);
      await clickAt(runtime, buttonPoint.x, buttonPoint.y);
      expect((await runtime.read('#log')).text).toBe('clicked');

      const renderedFieldCenter = {
        x: (FIELD.left + FIELD.width / 2) / CANVAS_DOWNSCALE,
        y: (FIELD.top + FIELD.height / 2) / CANVAS_DOWNSCALE,
      };
      const fieldPoint = devicePointFromDownscaledCanvas(renderedFieldCenter);
      await clickAt(runtime, fieldPoint.x, fieldPoint.y);
      await runtime.dispatchInput({
        kind: 'key',
        type: 'keyDown',
        key: 'k',
        code: 'KeyK',
        text: 'k',
        unmodifiedText: 'k',
        windowsVirtualKeyCode: 75,
        nativeVirtualKeyCode: 75,
      });
      await runtime.dispatchInput({
        kind: 'key',
        type: 'keyUp',
        key: 'k',
        code: 'KeyK',
        windowsVirtualKeyCode: 75,
        nativeVirtualKeyCode: 75,
      });
      await runtime.dispatchInput({ kind: 'insertText', text: 'INS' });
      expect((await runtime.read('#value')).text).toBe('kINS');

      const popup = await runtime.click('#popup');
      expect(popup.pages).toHaveLength(2);
      expect(popup.activePageId).not.toBe(initial.activePageId);
      expect(popup.actedPageId).toBe(initial.activePageId);
      expect(popup.url).toBe(`${fixtureUrl}/popup`);
      expect((await waitForPageFrame(frames, popup.activePageId)).pageId).toBe(popup.activePageId);

      const afterPopupClose = await runtime.closePage(popup.activePageId);
      expect(afterPopupClose.actedPageId).toBe(popup.activePageId);
      expect(afterPopupClose.pages).toHaveLength(1);
      expect(afterPopupClose.activePageId).toBe(initial.activePageId);

      const second = await runtime.newPage(`${fixtureUrl}/second`);
      expect(second.pages).toHaveLength(2);
      expect(second.activePageId).not.toBe(initial.activePageId);
      expect(second.actedPageId).toBe(second.activePageId);
      expect(second.url).toBe(`${fixtureUrl}/second`);
      expect(second.pages.find(page => page.id === second.activePageId)).toMatchObject({
        url: second.url,
        title: second.title,
      });

      const activated = await runtime.activatePage(initial.activePageId);
      expect(activated.activePageId).toBe(initial.activePageId);
      expect(activated.actedPageId).toBe(initial.activePageId);
      expect(activated.url).toBe(initial.url);

      const afterInitialClose = await runtime.closePage(initial.activePageId);
      expect(afterInitialClose.actedPageId).toBe(initial.activePageId);
      expect(afterInitialClose.pages).toHaveLength(1);
      expect(afterInitialClose.activePageId).toBe(second.activePageId);
      expect(afterInitialClose.url).toBe(second.url);

      const afterLastClose = await runtime.closePage(second.activePageId);
      expect(afterLastClose.actedPageId).toBe(second.activePageId);
      expect(afterLastClose.pages).toHaveLength(1);
      expect(afterLastClose.activePageId).not.toBe(second.activePageId);
      expect(afterLastClose.url).toBe('about:blank');
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
