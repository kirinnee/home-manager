import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';

const endpoint = process.argv[2];
if (!endpoint) throw new Error('a CDP endpoint is required');

const MAX_PAGES = 40;
const MAX_URL = 4_096;
const MAX_TITLE = 500;
const MAX_ERROR = 200;
const CLICK_SETTLE_MS = 250;
const CLICK_LOAD_TIMEOUT_MS = 5_000;
const HISTORY_DOCUMENT_READY_TIMEOUT_MS = 5_000;
const DOCUMENT_READY_POLL_MS = 50;

const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const safeError = error => {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright errors can append locator snapshots/page text. Only the first
  // line crosses the worker boundary.
  return message.split('\n', 1)[0].slice(0, 500);
};
const bounded = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : undefined);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser;
let context;
let viewport = { width: 1280, height: 800 };
let screencastConfig;
let screencastPage;
let screencastSession;
let frameWritable = true;

/**
 * The explicit page model. `activePage` is the single target for every verb,
 * CDP input event, status sample, and screencast binding: array position is
 * only ever consulted to seed it once at startup or to pick a neighbour after
 * the active page disappears.
 */
let activePage;
let pageSerial = 0;
const pageIds = new WeakMap();
/** Coarse main-document state per page. Never page content. */
const pageStates = new WeakMap();
/** Last observed context ordering, used for deterministic neighbour choice. */
let knownOrder = [];

function pageId(page) {
  const existing = pageIds.get(page);
  if (existing) return existing;
  pageSerial += 1;
  const id = `pg-${pageSerial.toString(36)}`;
  pageIds.set(page, id);
  return id;
}

function setPageState(page, state, error) {
  // First line, then the cap — same rule as `safeError`, so a CDP or Playwright
  // reason can never carry a locator snapshot or page text into status.
  const reason = typeof error === 'string' ? error.split('\n', 1)[0].slice(0, MAX_ERROR) : undefined;
  pageStates.set(page, { state, error: reason || undefined });
}

/**
 * Becoming ready must never erase a real failure. A failed navigation still
 * fires DOMContentLoaded/load on Chrome's error page, so an unconditional ready
 * would discard the `requestfailed` reason for the very navigation that failed.
 * A later successful main-frame navigation request resets the state to `loading`
 * first, so a genuine recovery still reaches `ready` normally.
 */
function markReadyUnlessError(page) {
  if ((pageStates.get(page)?.state ?? 'ready') === 'error') return;
  setPageState(page, 'ready');
}

function registerPage(page) {
  const id = pageIds.get(page);
  if (id) return id;
  const assigned = pageId(page);
  setPageState(page, 'ready');
  // A real main-frame navigation REQUEST, not `framenavigated`: same-document
  // hash/pushState history emits framenavigated without a following
  // DOMContentLoaded and would pin the state at `loading` forever. This also
  // catches a human clicking a link earlier than the document events do.
  page.on('request', request => {
    try {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      setPageState(page, 'loading');
    } catch {
      // A request can outlive its frame; a lost coarse signal is acceptable.
    }
  });
  page.on('domcontentloaded', () => markReadyUnlessError(page));
  page.on('load', () => markReadyUnlessError(page));
  page.on('crash', () => setPageState(page, 'error', 'the page crashed'));
  page.on('requestfailed', request => {
    try {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      setPageState(page, 'error', request.failure()?.errorText ?? 'navigation failed');
    } catch {
      // A request object can outlive its frame; a lost coarse signal is fine.
    }
  });
  page.on('close', () => {
    void enqueue(() => onPageClosed(page));
  });
  return assigned;
}

function livePages() {
  const live = context.pages().filter(page => !page.isClosed());
  for (const page of live) registerPage(page);
  knownOrder = live;
  return live;
}

async function selectPage(page) {
  registerPage(page);
  activePage = page;
  if (screencastConfig) await refreshScreencast(true);
}

/**
 * Pick the deterministic neighbour for a page that was at `index` before it
 * closed: the page now sitting at the same index, else the previous one. If the
 * context is empty the human/agent still needs a usable surface, so open one.
 */
async function ensureActiveAfterLoss(index) {
  const live = livePages();
  const next = live[index] ?? live[Math.max(0, index - 1)];
  if (next) {
    await selectPage(next);
    return;
  }
  const blank = await context.newPage();
  await selectPage(blank);
}

async function activePageOrRecover() {
  if (activePage && !activePage.isClosed()) return activePage;
  const lastIndex = activePage ? knownOrder.indexOf(activePage) : -1;
  await ensureActiveAfterLoss(lastIndex < 0 ? 0 : lastIndex);
  return activePage;
}

/** A brand new context page (agent `newPage`, or a popup) becomes active. */
async function adoptPage(page) {
  if (page.isClosed()) return;
  registerPage(page);
  if (activePage === page) return;
  await selectPage(page);
}

async function onPageClosed(page) {
  const index = knownOrder.indexOf(page);
  knownOrder = knownOrder.filter(item => item !== page);
  if (activePage !== page && activePage && !activePage.isClosed()) {
    livePages();
    return;
  }
  await ensureActiveAfterLoss(index < 0 ? 0 : index);
}

async function safeTitle(page) {
  try {
    return bounded(await page.title(), MAX_TITLE) ?? '';
  } catch {
    return '';
  }
}

function safeUrl(page) {
  try {
    return bounded(page.url(), MAX_URL) ?? '';
  } catch {
    return '';
  }
}

/**
 * The tab list is capped, but the ACTIVE page can never be the entry that falls
 * off the end: a 41st popup that just became active would otherwise vanish from
 * `pages` while `activePageId` still named it. Keep real context order for the
 * rest and spend the last slot on the active page when the cap would drop it.
 */
async function pageSummaries(active) {
  const live = livePages();
  let shown = live.slice(0, MAX_PAGES);
  if (active && !shown.includes(active) && live.includes(active)) {
    shown = [...shown.slice(0, MAX_PAGES - 1), active];
  }
  return await Promise.all(
    shown.map(async page => ({ id: pageId(page), url: safeUrl(page), title: await safeTitle(page) })),
  );
}

async function navigationCapability(page) {
  try {
    const history = await withPageSession(session => session.send('Page.getNavigationHistory'), page);
    const index = Number.isFinite(history?.currentIndex) ? history.currentIndex : 0;
    const total = Array.isArray(history?.entries) ? history.entries.length : 0;
    return { canGoBack: index > 0, canGoForward: index >= 0 && index < total - 1 };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

/**
 * Every verb answers with the same explicit shape so any single result can
 * refresh the whole page model: compat identity plus real tabs, truthful active
 * identity, coarse document state, and real navigation capability.
 */
async function snapshot(extra) {
  const page = await activePageOrRecover();
  const pages = await pageSummaries(page);
  const capability = await navigationCapability(page);
  const state = pageStates.get(page) ?? { state: 'ready' };
  return {
    url: safeUrl(page),
    title: await safeTitle(page),
    activePageId: pageId(page),
    pages,
    pageState: state.state,
    ...(state.error ? { pageError: state.error } : {}),
    canGoBack: capability.canGoBack,
    canGoForward: capability.canGoForward,
    ...extra,
  };
}

/**
 * Every action reports the exact Page it targeted, separately from whichever
 * page is active afterwards. The two differ on purpose: a click that opens a
 * popup acted on the opener, and a close acted on a page that is now gone. The
 * id survives the close because the WeakMap entry lives as long as the caller's
 * own reference to that Page.
 */
async function actionSnapshot(actedPage, extra) {
  return { ...(await snapshot(extra)), actedPageId: actedPage ? pageId(actedPage) : '' };
}

function findLivePage(id) {
  if (typeof id !== 'string' || !id) throw new Error('a pageId is required');
  const match = livePages().find(page => pageIds.get(page) === id);
  if (!match) throw new Error('that page is no longer open');
  return match;
}

async function stopScreencastSession() {
  const session = screencastSession;
  screencastSession = undefined;
  screencastPage = undefined;
  if (!session) return;
  await session.send('Page.stopScreencast').catch(() => undefined);
  await session.detach().catch(() => undefined);
}

function emitFrame(event, session, framePageId) {
  void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
  if (!frameWritable || session !== screencastSession) return;
  const width = Math.max(1, Math.round(event.metadata?.deviceWidth ?? viewport.width));
  const height = Math.max(1, Math.round(event.metadata?.deviceHeight ?? viewport.height));
  frameWritable = write({
    type: 'screencast-frame',
    dataBase64: event.data,
    width,
    height,
    pageId: framePageId,
  });
  if (!frameWritable)
    process.stdout.once('drain', () => {
      frameWritable = true;
    });
}

async function refreshScreencast(force = false) {
  if (!screencastConfig) return;
  const page = await activePageOrRecover();
  if (!force && page === screencastPage && screencastSession) return;
  await stopScreencastSession();
  const session = await context.newCDPSession(page);
  const framePageId = pageId(page);
  screencastPage = page;
  screencastSession = session;
  session.on('Page.screencastFrame', event => emitFrame(event, session, framePageId));
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: screencastConfig.width,
    height: screencastConfig.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: screencastConfig.quality,
    maxWidth: screencastConfig.width,
    maxHeight: screencastConfig.height,
    everyNthFrame: screencastConfig.everyNthFrame,
  });
}

async function withPageSession(operation, target) {
  const page = target ?? (await activePageOrRecover());
  if (screencastConfig && page === screencastPage) {
    await refreshScreencast();
    // A target can close while refreshScreencast awaits. In that case refresh
    // recovers the active page and binds a different session; never run this
    // target's operation against that replacement page.
    if (screencastSession && screencastPage === page) return await operation(screencastSession, page);
  }
  const session = await context.newCDPSession(page);
  try {
    return await operation(session, page);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function resizePage(width, height) {
  // Keep this reference for action provenance. A close can make recovery pick
  // a neighbour while CDP or screencast work is awaited, but that does not make
  // the neighbour the page whose metrics this resize targeted.
  const page = await activePageOrRecover();
  await withPageSession(async session => {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }, page);
  // The shared viewport only changes after CDP accepted the target update.
  // Otherwise a failed resize would leave later frames/input scaled for a size
  // Chrome never adopted.
  viewport = { width, height };
  if (screencastConfig) {
    screencastConfig = { ...screencastConfig, width, height };
    await refreshScreencast(true);
  }
  return page;
}

async function dispatchInput(input) {
  await refreshScreencast();
  const session = screencastSession;
  if (!session) throw new Error('screencast input requires an active viewer');
  if (input.kind === 'mouse') {
    await session.send('Input.dispatchMouseEvent', {
      type: input.type,
      x: input.x,
      y: input.y,
      button: input.button ?? 'none',
      buttons: input.buttons ?? 0,
      clickCount: input.clickCount ?? 0,
      deltaX: input.deltaX ?? 0,
      deltaY: input.deltaY ?? 0,
      modifiers: input.modifiers ?? 0,
      pointerType: 'mouse',
    });
    return;
  }
  if (input.kind === 'key') {
    await session.send('Input.dispatchKeyEvent', {
      type: input.type,
      key: input.key,
      code: input.code,
      text: input.type === 'keyDown' ? input.text : undefined,
      unmodifiedText: input.type === 'keyDown' ? input.unmodifiedText : undefined,
      windowsVirtualKeyCode: input.windowsVirtualKeyCode,
      nativeVirtualKeyCode: input.nativeVirtualKeyCode,
      modifiers: input.modifiers ?? 0,
      autoRepeat: input.autoRepeat ?? false,
      isKeypad: input.isKeypad ?? false,
    });
    return;
  }
  await session.send('Input.insertText', { text: input.text });
}

/**
 * A commit-level history wait avoids the BFCache false timeout, but commit is
 * earlier than DOM readiness for a normal network restoration. Poll the target
 * document boundedly: BFCache, same-document, and no-history cases are already
 * interactive/complete and return immediately; a genuinely slow document may
 * still return as truthful `loading` after the bound instead of false `ready`.
 */
async function waitForDocumentReady(page) {
  const deadline = Date.now() + HISTORY_DOCUMENT_READY_TIMEOUT_MS;
  while (!page.isClosed()) {
    try {
      if (await page.evaluate(() => document.readyState !== 'loading')) return true;
    } catch {
      // A commit can replace the execution context between polls.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(DOCUMENT_READY_POLL_MS, remaining));
  }
  return false;
}

async function navigateActive(operation, waitForReadyDocument = false) {
  const page = await activePageOrRecover();
  setPageState(page, 'loading');
  try {
    await operation(page);
  } catch (error) {
    setPageState(page, 'error', safeError(error));
    throw error;
  }
  // A no-history back/forward, or a same-document navigation, resolves without
  // ever firing DOMContentLoaded, so `loading` would stick forever. The awaited
  // operation plus an already-ready document is the ready signal. Normal
  // navigate/reload operations already wait for DOMContentLoaded themselves.
  if (!waitForReadyDocument || (await waitForDocumentReady(page))) markReadyUnlessError(page);
  await refreshScreencast();
  return await actionSnapshot(page);
}

/**
 * A click can open a popup or start a navigation, and the caller's returned
 * identity has to describe the page it landed on. Observe only `page`'s popup
 * event: a global context-page listener would also see unrelated human or
 * background pages and could mistake one for this click's popup.
 */
async function clickActive(selector) {
  const page = await activePageOrRecover();
  let popup;
  let resolvePopup;
  const popupSeen = new Promise(resolve => {
    resolvePopup = resolve;
  });
  const onPopup = candidate => {
    // Preserve the first page opened by this exact opener. The action only
    // needs one popup target, and later context pages must not replace it.
    if (popup) return;
    popup = candidate;
    resolvePopup();
  };
  page.on('popup', onPopup);
  try {
    await page.locator(selector).first().click({ timeout: 30_000 });
    if (!popup && !page.isClosed()) {
      await page.waitForLoadState('domcontentloaded', { timeout: CLICK_LOAD_TIMEOUT_MS }).catch(() => undefined);
    }
    if (!popup) await Promise.race([popupSeen, sleep(CLICK_SETTLE_MS)]);
  } finally {
    page.off('popup', onPopup);
  }
  if (popup && !popup.isClosed()) {
    // A popup arrives on the context event before its navigation commits, so an
    // immediate snapshot would report about:blank with an empty title. Wait
    // boundedly for its document; on timeout the popup is still adopted, so the
    // caller gets the right page identity either way.
    await popup.waitForLoadState('domcontentloaded', { timeout: CLICK_LOAD_TIMEOUT_MS }).catch(() => undefined);
    await adoptPage(popup);
  } else await refreshScreencast();
  // The opener is what was acted on, even when the popup is now active.
  return await actionSnapshot(page);
}

async function closePage(id) {
  const target = findLivePage(id);
  const before = livePages();
  const index = before.indexOf(target);
  const wasActive = target === activePage;
  await target.close({ runBeforeUnload: false }).catch(error => {
    throw new Error(safeError(error));
  });
  knownOrder = knownOrder.filter(item => item !== target);
  if (wasActive) await ensureActiveAfterLoss(index < 0 ? 0 : index);
  else livePages();
  // The acted id is the page just closed, so a caller can tell which tab its
  // request removed. It is deliberately absent from `pages`.
  return await actionSnapshot(target);
}

async function run(message) {
  const params = message.params ?? {};
  switch (message.method) {
    case 'navigate':
      return await navigateActive(page => page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }));
    case 'click':
      return await clickActive(params.selector);
    case 'type': {
      const page = await activePageOrRecover();
      await page.locator(params.selector).first().fill(params.text, { timeout: 30_000 });
      return await actionSnapshot(page);
    }
    case 'read': {
      const page = await activePageOrRecover();
      const text = params.selector
        ? await page.locator(params.selector).first().innerText({ timeout: 30_000 })
        : await page.locator('body').innerText({ timeout: 30_000 });
      return await actionSnapshot(page, { text: text.slice(0, 200_000) });
    }
    case 'screenshot': {
      const page = await activePageOrRecover();
      const bytes = await page.screenshot({ type: 'png', fullPage: false });
      return await actionSnapshot(page, { screenshotBase64: bytes.toString('base64') });
    }
    case 'back':
      // BFCache/history restores commit without firing a fresh DOMContentLoaded.
      // Waiting for that event reports a timeout after Chrome already moved.
      // Commit still fails closed when traversal never starts or commits;
      // navigateActive then waits boundedly for real document readiness.
      return await navigateActive(page => page.goBack({ waitUntil: 'commit', timeout: 30_000 }), true);
    case 'forward':
      return await navigateActive(page => page.goForward({ waitUntil: 'commit', timeout: 30_000 }), true);
    case 'reload':
      return await navigateActive(page => page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }));
    case 'location':
      return await snapshot();
    case 'newPage':
    case 'new-page': {
      // One queued command: open, activate, then optionally navigate, all
      // without yielding the queue, so no popup can steal active in between.
      const page = await context.newPage();
      await adoptPage(page);
      if (typeof params.url === 'string' && params.url) {
        setPageState(page, 'loading');
        try {
          await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          markReadyUnlessError(page);
        } catch (error) {
          setPageState(page, 'error', safeError(error));
          throw error;
        }
        await refreshScreencast();
      }
      return await actionSnapshot(page);
    }
    case 'activatePage':
    case 'activate-page': {
      const page = findLivePage(params.pageId);
      await selectPage(page);
      return await actionSnapshot(page);
    }
    case 'closePage':
    case 'close-page':
      return await closePage(params.pageId);
    case 'resize': {
      const page = await resizePage(params.width, params.height);
      return await actionSnapshot(page);
    }
    case 'startScreencast':
      viewport = { width: params.width, height: params.height };
      screencastConfig = { ...viewport, quality: 75, everyNthFrame: 1 };
      await refreshScreencast(true);
      return {};
    case 'stopScreencast':
      screencastConfig = undefined;
      await stopScreencastSession();
      return {};
    case 'dispatchInput':
      await dispatchInput(params.input);
      return {};
    case 'close':
      screencastConfig = undefined;
      await stopScreencastSession();
      await browser.close();
      return {};
    default:
      throw new Error(`unknown Playwright worker method: ${message.method}`);
  }
}

/**
 * One serial queue for commands and for page lifecycle events, so a popup or a
 * close can never interleave with the active-page selection or the screencast
 * rebind of a command that is already running.
 */
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  context = browser.contexts()[0];
  if (!context) throw new Error('Chrome exposed no persistent browser context');
  context.on('page', page => {
    // Claim the id synchronously, then let the queue perform activation and
    // screencast rebinding in order. clickActive observes its own popup from
    // the opener Page event rather than treating every context page as a click
    // result.
    registerPage(page);
    void enqueue(() => adoptPage(page));
  });
  const existing = livePages();
  // The only positional selection in the worker: seed the explicit active page.
  activePage = existing.at(-1) ?? (await context.newPage());
  registerPage(activePage);
  write({ type: 'ready' });
} catch (error) {
  write({ type: 'fatal', error: safeError(error) });
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let message;
  void enqueue(async () => {
    try {
      message = JSON.parse(line);
      const result = await run(message);
      write({ id: message.id, ok: true, result });
      if (message.method === 'close') process.exit(0);
    } catch (error) {
      write({ id: message?.id, ok: false, error: safeError(error) });
    }
  });
});

process.stdin.on('end', () => {
  screencastConfig = undefined;
  void stopScreencastSession()
    .then(() => browser?.close())
    .finally(() => process.exit(0));
});
