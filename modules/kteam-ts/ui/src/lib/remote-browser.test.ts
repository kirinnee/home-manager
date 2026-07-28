import { afterEach, describe, expect, test } from 'bun:test';
import { BROWSER_MAX_PAGE_ID_LENGTH } from '../../../src/browser-types';
import {
  decodeRemoteBrowserFrame,
  isLocalPasteChord,
  nextRemoteClickRun,
  remoteBrowserApi,
  remoteBrowserStreamUrl,
  remoteCanvasPoint,
  remoteViewportForContainer,
  REMOTE_MULTI_CLICK_MS,
  REMOTE_MULTI_CLICK_SLOP,
} from './remote-browser';

const originalFetch = globalThis.fetch;

function frameEnvelopeFromBytes(
  pageIdBytes: Uint8Array<ArrayBufferLike>,
  jpegBytes: Uint8Array<ArrayBufferLike> = Uint8Array.of(0xff, 0xd8, 0xff),
  version = 1,
) {
  const bytes = new Uint8Array(7 + pageIdBytes.byteLength + jpegBytes.byteLength);
  bytes.set([0x4b, 0x42, 0x52, 0x46], 0); // "KBRF"
  bytes[4] = version;
  new DataView(bytes.buffer).setUint16(5, pageIdBytes.byteLength, false);
  bytes.set(pageIdBytes, 7);
  bytes.set(jpegBytes, 7 + pageIdBytes.byteLength);
  return bytes.buffer;
}

function frameEnvelope(pageId: string, jpegBytes?: Uint8Array<ArrayBufferLike>, version?: number) {
  return frameEnvelopeFromBytes(new TextEncoder().encode(pageId), jpegBytes, version);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('remote browser viewport modes', () => {
  test('responsive follows the pane within the daemon/CDP bounds', () => {
    expect(remoteViewportForContainer(679.6, 742.2, 'responsive')).toEqual({ width: 680, height: 742 });
    expect(remoteViewportForContainer(200, 5_000, 'responsive')).toEqual({ width: 320, height: 1_200 });
  });

  test('desktop fit gives a phone a stable desktop viewport for canvas scaling', () => {
    expect(remoteViewportForContainer(390, 700, 'desktop')).toEqual({ width: 1_280, height: 800 });
  });

  test('ignores hidden/zero-sized retained surfaces', () => {
    expect(remoteViewportForContainer(0, 0, 'responsive')).toBeNull();
  });
});

describe('same-origin browser stream URL', () => {
  test('uses the daemon origin and session-scoped authenticated proxy path', () => {
    const location = { protocol: 'https:', host: 'kteam.example.test' } as Location;
    expect(remoteBrowserStreamUrl('session one', location)).toBe(
      'wss://kteam.example.test/v1/sessions/session%20one/browser/stream',
    );
  });
});

describe('remote browser frame envelope', () => {
  test('decodes one atomic v1 page-id/JPEG message through the shared id boundary', () => {
    const pageId = 'p'.repeat(BROWSER_MAX_PAGE_ID_LENGTH);
    const decoded = decodeRemoteBrowserFrame(frameEnvelope(pageId, Uint8Array.of(1, 2, 3, 4)));
    expect(decoded).toEqual({ kind: 'tagged', pageId, jpegBytes: expect.any(ArrayBuffer) });
    expect([...new Uint8Array(decoded!.jpegBytes)]).toEqual([1, 2, 3, 4]);
  });

  test('rejects malformed, unknown-version, invalid-UTF8, and overlong tagged messages', () => {
    expect(decodeRemoteBrowserFrame(new Uint8Array([0x4b, 0x42, 0x52]).buffer)).toBeNull();
    expect(decodeRemoteBrowserFrame(frameEnvelope('page-1', undefined, 2))).toBeNull();
    expect(decodeRemoteBrowserFrame(frameEnvelopeFromBytes(Uint8Array.of(0xff)))).toBeNull();
    expect(decodeRemoteBrowserFrame(frameEnvelope('x'.repeat(BROWSER_MAX_PAGE_ID_LENGTH + 1)))).toBeNull();
    expect(decodeRemoteBrowserFrame(frameEnvelope('', Uint8Array.of(1)))).toBeNull();
    expect(decodeRemoteBrowserFrame(frameEnvelope('page-1', new Uint8Array()))).toBeNull();
  });

  test('identifies an untagged raw JPEG only as an explicit legacy frame', () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9).buffer;
    const decoded = decodeRemoteBrowserFrame(jpeg);
    expect(decoded).toEqual({ kind: 'legacy', jpegBytes: jpeg });
  });
});

describe('shared browser navigation actions', () => {
  test('posts atomic open-with-URL, forward, and reload actions', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: { state: 'running' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await remoteBrowserApi.open('session one', 'https://example.test/login');
    await remoteBrowserApi.forward('session one');
    await remoteBrowserApi.reload('session one');

    expect(bodies).toEqual([
      { action: 'open', url: 'https://example.test/login' },
      { action: 'forward' },
      { action: 'reload' },
    ]);
  });

  test('posts real Chrome page control actions with daemon-issued ids only', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: { state: 'running' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await remoteBrowserApi.newPage('session one');
    await remoteBrowserApi.newPage('session one', 'https://example.test/docs');
    await remoteBrowserApi.activatePage('session one', 'page-3');
    await remoteBrowserApi.closePage('session one', 'page-3');

    expect(bodies).toEqual([
      { action: 'new-page' },
      { action: 'new-page', url: 'https://example.test/docs' },
      { action: 'activate-page', pageId: 'page-3' },
      { action: 'close-page', pageId: 'page-3' },
    ]);
  });
});

describe('remoteCanvasPoint', () => {
  test('maps a rendered point to a device pixel at 2.5x downscale with a non-zero offset', () => {
    // A 1280x800 frame painted into a 512x320 box that starts at (40, 24).
    const rect = { left: 40, top: 24, width: 512, height: 320 };

    expect(remoteCanvasPoint(rect, 1_280, 800, 100, 84)).toEqual({ x: 150, y: 150 });
    expect(remoteCanvasPoint(rect, 1_280, 800, 40, 24)).toEqual({ x: 0, y: 0 });
    // The exact centre of the rendered box is the exact centre of the frame.
    expect(remoteCanvasPoint(rect, 1_280, 800, 296, 184)).toEqual({ x: 640, y: 400 });
  });

  test('is the identity mapping at 1:1 with no offset', () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    expect(remoteCanvasPoint(rect, 800, 600, 321, 214)).toEqual({ x: 321, y: 214 });
  });

  test('clamps a point outside the rendered box into the frame', () => {
    const rect = { left: 40, top: 24, width: 512, height: 320 };
    expect(remoteCanvasPoint(rect, 1_280, 800, -400, -400)).toEqual({ x: 0, y: 0 });
    expect(remoteCanvasPoint(rect, 1_280, 800, 5_000, 5_000)).toEqual({ x: 1_279, y: 799 });
  });

  test('stays finite for a zero-sized rect measured mid-layout', () => {
    const point = remoteCanvasPoint({ left: 0, top: 0, width: 0, height: 0 }, 1_280, 800, 10, 10);
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});

describe('nextRemoteClickRun', () => {
  test('starts a run at one and counts a fast, close second press as a double click', () => {
    const first = nextRemoteClickRun(null, { x: 100, y: 100 }, 1_000);
    expect(first.count).toBe(1);

    const second = nextRemoteClickRun(first, { x: 102, y: 98 }, 1_200);
    expect(second.count).toBe(2);

    const third = nextRemoteClickRun(second, { x: 100, y: 100 }, 1_400);
    expect(third.count).toBe(3);
  });

  test('never exceeds the CDP click-run cap', () => {
    let run = nextRemoteClickRun(null, { x: 10, y: 10 }, 0);
    for (let press = 1; press < 6; press += 1) run = nextRemoteClickRun(run, { x: 10, y: 10 }, press * 100);
    expect(run.count).toBe(3);
  });

  test('restarts the run when the presses are too far apart in time', () => {
    const first = nextRemoteClickRun(null, { x: 100, y: 100 }, 1_000);
    const later = nextRemoteClickRun(first, { x: 100, y: 100 }, 1_000 + REMOTE_MULTI_CLICK_MS + 1);
    expect(later.count).toBe(1);
  });

  test('restarts the run when the second press lands too far away', () => {
    const first = nextRemoteClickRun(null, { x: 100, y: 100 }, 1_000);
    const moved = nextRemoteClickRun(first, { x: 100 + REMOTE_MULTI_CLICK_SLOP + 1, y: 100 }, 1_050);
    expect(moved.count).toBe(1);
  });
});

describe('isLocalPasteChord', () => {
  test('recognises both platform paste chords and nothing else', () => {
    expect(isLocalPasteChord({ key: 'v', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isLocalPasteChord({ key: 'V', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isLocalPasteChord({ key: 'v', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isLocalPasteChord({ key: 'c', ctrlKey: true, metaKey: false })).toBe(false);
  });
});
