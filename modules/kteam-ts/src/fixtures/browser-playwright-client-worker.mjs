import { createInterface } from 'node:readline';

const mode = process.argv[2];
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const writeProtocolOverflow = () => process.stdout.write(Buffer.alloc(27 * 1024 * 1024, 0x78));
// Mirrors BROWSER_MAX_PAGE_ID_LENGTH; this Node fixture cannot import the
// TypeScript contract directly.
const MAX_PAGE_ID = 128;

if (mode === 'fatal' || mode === 'fatal-multiline') {
  write({
    type: 'fatal',
    error:
      mode === 'fatal-multiline'
        ? `${'f'.repeat(900)}\ncall log: locator('#secret')\nleaked page text`
        : 'fixture could not connect',
  });
  process.exit(19);
}
if (mode === 'exit-before-ready') process.exit(0);

let viewport = { width: 1280, height: 800 };
/** A tiny in-memory page model so client-side lifecycle plumbing is testable. */
let serial = 1;
// A full-length valid id makes the overlong frame-id regression prove that
// truncation would collide exactly with a real tab identity.
const initialPageId = mode === 'frames-sloppy' ? 'p'.repeat(MAX_PAGE_ID) : 'pg-1';
const collisionPageId = 'c'.repeat(MAX_PAGE_ID);
let pages = [{ id: initialPageId, url: 'https://fixture.test/', title: `${viewport.width}x${viewport.height}` }];
let activePageId = initialPageId;
let history = { canGoBack: false, canGoForward: false };
let frameCount = 0;
let pageState = 'ready';
let pageError;

const active = () => pages.find(page => page.id === activePageId);

/**
 * Like the real worker, the top-level url/title always describe the page named
 * by activePageId — the fixture must not model an incoherent protocol. Resize
 * coverage rides on the active page's title so that equality still holds.
 */
/** An action snapshot carries the exact page acted on, which is not always the
 * page that ends up active (close, and a click that opens a popup). */
function actionSnapshot(actedPageId, extra) {
  return { ...snapshot(extra), actedPageId };
}

function snapshot(extra) {
  const page = active();
  return {
    url: page?.url ?? '',
    title: page?.title ?? '',
    pages: pages.map(item => ({ ...item })),
    activePageId,
    pageState,
    ...(pageError ? { pageError } : {}),
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
    ...extra,
  };
}

if (mode === 'stdout-overflow-before-ready') writeProtocolOverflow();
else {
  write({ type: 'ready' });
  if (mode === 'exit-after-ready') setTimeout(() => process.exit(23), 25);
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  if (message.method === 'crash') process.exit(23);
  if (mode === 'action-error-multiline' && message.method === 'navigate') {
    write({
      id: message.id,
      ok: false,
      error: `${'a'.repeat(900)}\ncall log: locator('#secret')\nleaked page text`,
    });
    return;
  }
  if (mode === 'stdout-overflow' && message.method === 'location') {
    writeProtocolOverflow();
    return;
  }
  // Captured BEFORE the action mutates the model, so close reports the page it
  // removed and a popup-opening click reports its opener.
  let actedPageId = activePageId;
  if (message.method === 'resize') {
    viewport = params;
    // Keep resize observable through the coherent snapshot: the active page is
    // what a resize actually affects.
    const page = active();
    if (page) page.title = `${viewport.width}x${viewport.height}`;
    if (mode === 'resize-closed') {
      // Mirror an external close after the CDP resize completed: recovery moves
      // active to a new page, but the action still acted on the closed tab.
      pages = pages.filter(item => item.id !== actedPageId);
      serial += 1;
      const replacement = { id: `pg-${serial}`, url: 'about:blank', title: 'replacement' };
      pages = [...pages, replacement];
      activePageId = replacement.id;
    }
  }

  if (message.method === 'newPage') {
    serial += 1;
    const page = { id: `pg-${serial}`, url: params.url ?? 'about:blank', title: 'new' };
    pages = [...pages, page];
    activePageId = page.id;
    // newPage acts on the page it created, not on the previously active one.
    actedPageId = page.id;
  }
  if (message.method === 'activatePage' || message.method === 'closePage') {
    const index = pages.findIndex(page => page.id === params.pageId);
    if (index === -1) {
      write({ id: message.id, ok: false, error: 'that page is no longer open' });
      return;
    }
    actedPageId = params.pageId;
    if (message.method === 'activatePage') activePageId = pages[index].id;
    else {
      const wasActive = pages[index].id === activePageId;
      pages = pages.filter(page => page.id !== params.pageId);
      if (!pages.length) {
        serial += 1;
        pages = [{ id: `pg-${serial}`, url: 'about:blank', title: 'blank' }];
        activePageId = pages[0].id;
      } else if (wasActive) activePageId = (pages[index] ?? pages[index - 1]).id;
    }
  }
  if (['navigate', 'back', 'forward', 'reload'].includes(message.method)) {
    // Mirror the worker's navigation state rule: a verb starts as loading, and
    // the operation resolving is itself the ready signal — a no-history
    // back/forward or a same-document hop never fires a document event, so
    // nothing else would ever clear it.
    pageState = 'loading';
    pageError = undefined;
    if (mode === 'nav-error' || mode === 'nav-error-long') {
      // requestfailed records the failure, then the error page still fires
      // DOMContentLoaded/load. Becoming ready must not erase the reason.
      pageState = 'error';
      pageError = mode === 'nav-error-long' ? 'x'.repeat(900) : 'net::ERR_NAME_NOT_RESOLVED';
      if (pageState !== 'error') pageState = 'ready';
    } else pageState = 'ready';
  }
  if (message.method === 'navigate') {
    const page = active();
    if (page) page.url = params.url;
    history = { canGoBack: true, canGoForward: false };
  }
  if (message.method === 'back') history = { canGoBack: false, canGoForward: true };
  if ((mode === 'popup' || mode === 'popup-unrelated') && message.method === 'click') {
    if (mode === 'popup-unrelated') {
      serial += 1;
      const background = { id: `pg-${serial}`, url: 'https://background.test/', title: 'background' };
      pages = [...pages, background];
    }
    // A click that opens a popup: the popup becomes active, but the action was
    // performed on the opener, which actedPageId must still name. The
    // popup-unrelated mode also creates a background tab first; it must not be
    // selected as this click's popup.
    serial += 1;
    const popup = { id: `pg-${serial}`, url: 'https://popup.test/', title: 'popup' };
    pages = [...pages, popup];
    activePageId = popup.id;
  }

  const result =
    message.method === 'read'
      ? actionSnapshot(actedPageId, { text: 'fixture text' })
      : message.method === 'screenshot'
        ? actionSnapshot(actedPageId, { screenshotBase64: 'cG5n' })
        : mode === 'id-prefix-collision' && message.method === 'location'
          ? {
              // This invalid id has a real id as its exact prefix. A client
              // must reject it rather than truncating it into that real page.
              url: 'https://spoof.test/',
              title: 'spoof',
              pages: [
                { id: collisionPageId, url: 'https://valid.test/', title: 'valid' },
                { id: `${collisionPageId}spoof`, url: 'https://spoof.test/', title: 'spoof' },
              ],
              activePageId: `${collisionPageId}spoof`,
              pageState: 'ready',
              canGoBack: false,
              canGoForward: false,
            }
          : mode === 'id-prefix-collision' && message.method === 'navigate'
            ? {
                // Same collision in action provenance: it cannot be silently
                // rewritten to the valid active page id.
                url: 'https://valid.test/',
                title: 'valid',
                pages: [{ id: collisionPageId, url: 'https://valid.test/', title: 'valid' }],
                activePageId: collisionPageId,
                actedPageId: `${collisionPageId}spoof`,
                pageState: 'ready',
                canGoBack: false,
                canGoForward: false,
              }
            : mode === 'sloppy' && message.method === 'location'
              ? {
                  // A hostile/buggy worker: the client must bound and coerce this
                  // rather than passing it through to the runtime. The active page
                  // sits past the 40-page cap and carries over-long strings.
                  url: 'u'.repeat(9_000),
                  title: 't'.repeat(2_000),
                  pages: [
                    { id: '', url: 'https://dropped.test/', title: 'no id' },
                    ...Array.from({ length: 60 }, (_, index) => ({
                      id: `extra-${index}`,
                      url: 'https://extra.test/',
                      title: 'extra',
                    })),
                    // Invalid page identities are dropped rather than truncated;
                    // keep a valid active page after it to test cap preservation.
                    { id: `${'i'.repeat(MAX_PAGE_ID)}spoof`, url: 'https://dropped-id.test/', title: 'dropped' },
                    {
                      id: 'i'.repeat(MAX_PAGE_ID),
                      url: `https://active.test/${'q'.repeat(9_000)}`,
                      title: 'z'.repeat(2_000),
                    },
                  ],
                  activePageId: 'i'.repeat(MAX_PAGE_ID),
                  pageState: 'not-a-state',
                  // A short first line followed by a locator snapshot and page text:
                  // slicing alone would let the suffix through, so the client must
                  // cut at the newline first.
                  pageError: `net::ERR_FAILED\ncall log:\n  - waiting for locator('#secret')\n${'leaked page text '.repeat(200)}`,
                  canGoBack: 'yes',
                  canGoForward: 1,
                }
              : mode === 'sloppy' && message.method === 'reload'
                ? {
                    // activePageId names no page at all — the client must refuse.
                    url: 'https://ghost.test/',
                    title: 'ghost',
                    pages: [{ id: 'pg-1', url: 'https://fixture.test/', title: 'fixture' }],
                    activePageId: 'pg-nonexistent',
                    actedPageId: 'pg-1',
                    pageState: 'ready',
                    canGoBack: false,
                    canGoForward: false,
                  }
                : mode === 'sloppy' && message.method === 'forward'
                  ? // A provenance-free action result: the client must refuse rather
                    // than defaulting actedPageId to the active page.
                    snapshot()
                  : // `location` is a sample, so it carries no provenance; every
                    // other verb is an action.
                    message.method === 'location'
                    ? snapshot()
                    : actionSnapshot(actedPageId);

  if (mode === 'frames' && (message.method === 'location' || message.method === 'newPage')) {
    // Frames follow the active page, the way a real screencast rebind does.
    write({
      type: 'screencast-frame',
      dataBase64: Buffer.from('jpeg').toString('base64'),
      width: viewport.width,
      height: viewport.height,
      pageId: activePageId,
    });
  }
  if (mode === 'frames-sloppy' && message.method === 'location') {
    frameCount += 1;
    write({
      type: 'screencast-frame',
      dataBase64: Buffer.from('jpeg').toString('base64'),
      width: viewport.width,
      height: viewport.height,
      pageId: frameCount === 1 ? '' : `${activePageId}${'spoof'.repeat(60)}`,
    });
  }
  write({ id: message.id, ok: true, result });
  if (message.method === 'close') process.exit(0);
});
