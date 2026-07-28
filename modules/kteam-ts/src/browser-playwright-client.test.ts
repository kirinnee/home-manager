import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { PlaywrightWorkerClient } from './browser-playwright-client';
import { BROWSER_MAX_PAGE_ID_LENGTH, type BrowserPageSnapshot, type BrowserScreencastFrame } from './browser-types';

const fixture = path.join(import.meta.dir, 'fixtures', 'browser-playwright-client-worker.mjs');

/** The compat top-level identity must always describe the page it claims is
 * active, or a UI showing tabs and an address bar would disagree with itself. */
function expectCoherent(snapshot: BrowserPageSnapshot): void {
  const active = snapshot.pages.find(page => page.id === snapshot.activePageId);
  expect(active).toBeDefined();
  expect(snapshot.url).toBe(active!.url);
  expect(snapshot.title).toBe(active!.title);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected promise to reject');
}

describe('Playwright Node worker client', () => {
  test('waits for readiness and carries typed commands over JSON lines', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    expect(await client.resize({ width: 900, height: 700 })).toMatchObject({ actedPageId: 'pg-1' });
    expect(await client.location()).toMatchObject({ url: 'https://fixture.test/', title: '900x700' });
    expect(await client.read()).toMatchObject({ text: 'fixture text' });
    expect(await client.forward()).toMatchObject({ url: 'https://fixture.test/', title: '900x700' });
    expect(await client.reload()).toMatchObject({ url: 'https://fixture.test/', title: '900x700' });
    await client.close();
  });

  test('surfaces a bounded startup failure from the worker', async () => {
    await expect(PlaywrightWorkerClient.connect('fatal', fixture)).rejects.toMatchObject({
      code: 'launch_failed',
      status: 503,
    });
  });

  test('keeps multiline oversized fatal errors out of the launch response', async () => {
    const message = await rejectionMessage(PlaywrightWorkerClient.connect('fatal-multiline', fixture));
    expect(message).toBe(`Playwright worker failed: ${'f'.repeat(200)}`);
    expect(message).not.toContain('call log');
    expect(message).not.toContain('locator');
    expect(message).not.toContain('leaked page text');
    expect(message).not.toContain('\n');
  });

  test('keeps multiline oversized action errors out of the API-facing error', async () => {
    const client = await PlaywrightWorkerClient.connect('action-error-multiline', fixture);
    const message = await rejectionMessage(client.navigate('https://broken.test/'));
    expect(message).toBe(`Playwright action failed: ${'a'.repeat(200)}`);
    expect(message).not.toContain('call log');
    expect(message).not.toContain('locator');
    expect(message).not.toContain('leaked page text');
    expect(message).not.toContain('\n');
    await client.close();
  });

  test('does not wait for the full readiness timeout when a worker exits cleanly before ready', async () => {
    const started = performance.now();
    await expect(PlaywrightWorkerClient.connect('exit-before-ready', fixture)).rejects.toMatchObject({
      code: 'launch_failed',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('fails launch promptly when worker stdout exceeds the newline-free protocol limit', async () => {
    const started = performance.now();
    await expect(PlaywrightWorkerClient.connect('stdout-overflow-before-ready', fixture)).rejects.toMatchObject({
      code: 'launch_failed',
      status: 503,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('terminates a ready worker and rejects its pending request on protocol overflow', async () => {
    const client = await PlaywrightWorkerClient.connect('stdout-overflow', fixture);
    const started = performance.now();
    await expect(client.location()).rejects.toMatchObject({ code: 'upstream_failed', status: 502 });
    expect(performance.now() - started).toBeLessThan(5_000);
    await expect(client.location()).rejects.toMatchObject({ code: 'not_running', status: 409 });
  });

  test('reports an unexpected post-ready worker exit and refuses later writes', async () => {
    const client = await PlaywrightWorkerClient.connect('exit-after-ready', fixture);
    expect(await client.unexpectedExit).toBe(23);
    await expect(client.location()).rejects.toMatchObject({ code: 'not_running', status: 409 });
  });

  test('isolates a throwing frame listener so later listeners and responses continue', async () => {
    const client = await PlaywrightWorkerClient.connect('frames', fixture);
    let healthyFrames = 0;
    await client.startScreencast({ width: 1280, height: 800 }, () => {
      throw new Error('viewer failed');
    });
    await client.startScreencast({ width: 1280, height: 800 }, () => {
      healthyFrames += 1;
    });
    await expect(client.location()).resolves.toMatchObject({ url: 'https://fixture.test/' });
    expect(healthyFrames).toBe(1);
    await client.close();
  });

  test('carries bounded frame provenance for the page the screencast is bound to', async () => {
    const client = await PlaywrightWorkerClient.connect('frames', fixture);
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast({ width: 1280, height: 800 }, frame => frames.push(frame));

    const before = await client.location();
    expect(frames.at(-1)?.pageId).toBe(before.activePageId);

    // After a new page becomes active, later frames must be attributed to it.
    const opened = await client.newPage('https://popup.test/');
    const after = await client.location();
    expect(after.activePageId).toBe(opened.activePageId);
    expect(frames.at(-1)?.pageId).toBe(opened.activePageId);

    // Valid worker-supplied ids remain bounded by the protocol contract.
    const oversized = await client.activatePage('pg-1');
    expect(oversized.activePageId).toBe('pg-1');
    await client.close();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) expect((frame.pageId ?? '').length).toBeLessThanOrEqual(BROWSER_MAX_PAGE_ID_LENGTH);
  });

  test('drops empty or over-long frame page ids rather than truncating a valid prefix', async () => {
    const client = await PlaywrightWorkerClient.connect('frames-sloppy', fixture);
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast({ width: 1280, height: 800 }, frame => frames.push(frame));
    const snapshot = await client.location();
    await client.location();
    expect(frames).toHaveLength(2);
    expect(frames[0]?.pageId).toBeUndefined();
    // The malformed id begins with this exact maximum-length valid id. Slicing
    // would turn it into a false claim that the frame came from the active tab.
    expect(snapshot.activePageId).toHaveLength(BROWSER_MAX_PAGE_ID_LENGTH);
    expect(frames[1]?.pageId).toBeUndefined();
    await client.close();
  });

  test('refuses over-long active and acted ids that share a valid page-id prefix', async () => {
    const client = await PlaywrightWorkerClient.connect('id-prefix-collision', fixture);
    await expect(client.location()).rejects.toMatchObject({ code: 'upstream_failed', status: 502 });
    await expect(client.navigate('https://valid.test/')).rejects.toMatchObject({
      code: 'upstream_failed',
      status: 502,
    });
    await client.close();
  });

  test('returns a coherent page snapshot from every verb', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    const snapshot = await client.location();
    expect(snapshot).toEqual({
      url: 'https://fixture.test/',
      title: '1280x800',
      pages: [{ id: 'pg-1', url: 'https://fixture.test/', title: '1280x800' }],
      activePageId: 'pg-1',
      pageState: 'ready',
      canGoBack: false,
      canGoForward: false,
    });
    expectCoherent(snapshot);
    const navigated = await client.navigate('https://next.test/');
    expect(navigated).toMatchObject({ url: 'https://next.test/', activePageId: 'pg-1', canGoBack: true });
    expectCoherent(navigated);
    const back = await client.back();
    expect(back).toMatchObject({ canGoBack: false, canGoForward: true });
    expectCoherent(back);
    for (const verb of [client.read(), client.screenshot(), client.reload(), client.forward()]) {
      expectCoherent(await verb);
    }
    await client.close();
  });

  test('carries page lifecycle actions and reports the new active identity', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    const opened = await client.newPage('https://second.test/');
    expect(opened.pages).toHaveLength(2);
    expect(opened.activePageId).toBe('pg-2');
    expect(opened.url).toBe('https://second.test/');
    expectCoherent(opened);

    const reactivated = await client.activatePage('pg-1');
    expect(reactivated.activePageId).toBe('pg-1');
    expect(reactivated.url).toBe('https://fixture.test/');
    expectCoherent(reactivated);

    const blank = await client.newPage();
    expect(blank.activePageId).toBe('pg-3');
    expect(blank.url).toBe('about:blank');

    const afterClose = await client.closePage('pg-3');
    expect(afterClose.pages.map(page => page.id)).toEqual(['pg-1', 'pg-2']);
    expect(afterClose.activePageId).toBe('pg-2');
    expectCoherent(afterClose);
    await client.close();
  });

  test('closing the last page still yields one usable page', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    const afterClose = await client.closePage('pg-1');
    expect(afterClose.pages).toHaveLength(1);
    expect(afterClose.pages[0]?.url).toBe('about:blank');
    expect(afterClose.activePageId).toBe(afterClose.pages[0]?.id);
    expectCoherent(afterClose);
    await client.close();
  });

  test('rejects a lifecycle action for a page id the worker does not know', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    await expect(client.activatePage('pg-missing')).rejects.toMatchObject({
      code: 'upstream_failed',
      status: 502,
    });
    await expect(client.closePage('pg-missing')).rejects.toMatchObject({ code: 'upstream_failed' });
    expect((await client.location()).activePageId).toBe('pg-1');
    await client.close();
  });

  test('bounds an untrustworthy snapshot and keeps the active page inside the cap', async () => {
    const client = await PlaywrightWorkerClient.connect('sloppy', fixture);
    const snapshot = await client.location();
    expect(snapshot.pages).toHaveLength(40);
    expect(snapshot.pages.some(page => page.id === '')).toBe(false);
    // The worker put the active page past the cap; it must still be listed, and
    // the compat identity must agree with its entry.
    expect(snapshot.activePageId).toHaveLength(BROWSER_MAX_PAGE_ID_LENGTH);
    expectCoherent(snapshot);
    expect(snapshot.url).toHaveLength(4_096);
    expect(snapshot.title).toHaveLength(500);
    expect(snapshot.pageState).toBe('ready');
    // Only the first line survives: the locator snapshot and page text the
    // worker appended must be gone, not merely truncated at 200 chars.
    expect(snapshot.pageError).toBe('net::ERR_FAILED');
    expect(snapshot.pageError).not.toContain('call log');
    expect(snapshot.pageError).not.toContain('leaked page text');
    expect(snapshot.pageError).not.toContain('\n');
    expect(snapshot.canGoBack).toBe(false);
    expect(snapshot.canGoForward).toBe(false);
    await client.close();
  });

  test('refuses a snapshot whose active page id matches no page', async () => {
    const client = await PlaywrightWorkerClient.connect('sloppy', fixture);
    await expect(client.reload()).rejects.toMatchObject({ code: 'upstream_failed', status: 502 });
    await client.close();
  });

  test('refuses an action result that carries no page provenance', async () => {
    const client = await PlaywrightWorkerClient.connect('sloppy', fixture);
    await expect(client.forward()).rejects.toMatchObject({ code: 'upstream_failed', status: 502 });
    await client.close();
  });

  test('caps a long single-line coarse error at 200 characters', async () => {
    const client = await PlaywrightWorkerClient.connect('nav-error-long', fixture);
    const snapshot = await client.navigate('https://broken.test/');
    expect(snapshot.pageState).toBe('error');
    expect(snapshot.pageError).toHaveLength(200);
    await client.close();
  });

  test('names the exact page each action targeted', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    for (const action of [
      client.navigate('https://a.test/'),
      client.type('#field', 'text'),
      client.read(),
      client.screenshot(),
      client.back(),
      client.reload(),
      client.resize({ width: 800, height: 600 }),
    ]) {
      const snapshot = await action;
      // With no popup or close in play, provenance and active target agree.
      expect(snapshot.actedPageId).toBe('pg-1');
      expect(snapshot.activePageId).toBe('pg-1');
    }

    // newPage acts on the page it created, which is also now active.
    const opened = await client.newPage('https://b.test/');
    expect(opened.actedPageId).toBe('pg-2');
    expect(opened.activePageId).toBe('pg-2');

    // activate-page acts on its explicit argument.
    const activated = await client.activatePage('pg-1');
    expect(activated.actedPageId).toBe('pg-1');
    expect(activated.activePageId).toBe('pg-1');
    await client.close();
  });

  test('keeps provenance distinct from the active page for close and popup clicks', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    await client.newPage('https://second.test/');

    // Closing a page reports the page it removed, which is deliberately absent
    // from the resulting tab list.
    const closed = await client.closePage('pg-2');
    expect(closed.actedPageId).toBe('pg-2');
    expect(closed.activePageId).toBe('pg-1');
    expect(closed.pages.some(page => page.id === 'pg-2')).toBe(false);
    expectCoherent(closed);
    await client.close();

    // A click that opens a popup reports the opener, while active moves on.
    const popupClient = await PlaywrightWorkerClient.connect('popup', fixture);
    const clicked = await popupClient.click('a[target=_blank]');
    expect(clicked.actedPageId).toBe('pg-1');
    expect(clicked.activePageId).toBe('pg-2');
    expect(clicked.url).toBe('https://popup.test/');
    expectCoherent(clicked);
    await popupClient.close();
  });

  test('does not let an unrelated new tab become the popup identity for a click', async () => {
    const client = await PlaywrightWorkerClient.connect('popup-unrelated', fixture);
    const clicked = await client.click('a[target=_blank]');
    expect(clicked.actedPageId).toBe('pg-1');
    expect(clicked.activePageId).toBe('pg-3');
    expect(clicked.url).toBe('https://popup.test/');
    expect(clicked.pages).toEqual([
      { id: 'pg-1', url: 'https://fixture.test/', title: '1280x800' },
      { id: 'pg-2', url: 'https://background.test/', title: 'background' },
      { id: 'pg-3', url: 'https://popup.test/', title: 'popup' },
    ]);
    expectCoherent(clicked);
    await client.close();
  });

  test('preserves resize provenance when recovery moves active after the target closes', async () => {
    const client = await PlaywrightWorkerClient.connect('resize-closed', fixture);
    const resized = await client.resize({ width: 900, height: 700 });
    expect(resized.actedPageId).toBe('pg-1');
    expect(resized.activePageId).toBe('pg-2');
    expect(resized.pages).toEqual([{ id: 'pg-2', url: 'about:blank', title: 'replacement' }]);
    expectCoherent(resized);
    await client.close();
  });

  test('never reports a stuck loading state after a navigation verb resolves', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    for (const verb of ['navigate', 'back', 'forward', 'reload'] as const) {
      const snapshot = verb === 'navigate' ? await client.navigate('https://x.test/') : await client[verb]();
      expect(snapshot.pageState).toBe('ready');
      expect(snapshot.pageError).toBeUndefined();
    }
    await client.close();
  });

  test('carries a bounded coarse navigation error without page content', async () => {
    const client = await PlaywrightWorkerClient.connect('nav-error', fixture);
    const snapshot = await client.navigate('https://broken.test/');
    expect(snapshot.pageState).toBe('error');
    expect(snapshot.pageError).toBe('net::ERR_NAME_NOT_RESOLVED');
    // The error page's own load events must not erase the failure reason.
    expect(await client.location()).toMatchObject({
      pageState: 'error',
      pageError: 'net::ERR_NAME_NOT_RESOLVED',
    });
    await client.close();
  });
});
