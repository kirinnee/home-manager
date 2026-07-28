import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';

const endpoint = process.argv[2];
if (!endpoint) throw new Error('a CDP endpoint is required');

const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const safeError = error => {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright errors can append locator snapshots/page text. Only the first
  // line crosses the worker boundary.
  return message.split('\n', 1)[0].slice(0, 500);
};

let browser;
let context;
let viewport = { width: 1280, height: 800 };
let screencastConfig;
let screencastPage;
let screencastSession;
let frameWritable = true;

async function currentPage() {
  const pages = context.pages();
  return pages.at(-1) ?? (await context.newPage());
}

async function pageIdentity(page) {
  return { url: page.url(), title: await page.title() };
}

async function stopScreencastSession() {
  const session = screencastSession;
  screencastSession = undefined;
  screencastPage = undefined;
  if (!session) return;
  await session.send('Page.stopScreencast').catch(() => undefined);
  await session.detach().catch(() => undefined);
}

function emitFrame(event, session) {
  void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
  if (!frameWritable || session !== screencastSession) return;
  const width = Math.max(1, Math.round(event.metadata?.deviceWidth ?? viewport.width));
  const height = Math.max(1, Math.round(event.metadata?.deviceHeight ?? viewport.height));
  frameWritable = write({ type: 'screencast-frame', dataBase64: event.data, width, height });
  if (!frameWritable)
    process.stdout.once('drain', () => {
      frameWritable = true;
    });
}

async function refreshScreencast(force = false) {
  if (!screencastConfig) return;
  const page = await currentPage();
  if (!force && page === screencastPage && screencastSession) return;
  await stopScreencastSession();
  const session = await context.newCDPSession(page);
  screencastPage = page;
  screencastSession = session;
  session.on('Page.screencastFrame', event => emitFrame(event, session));
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 75,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });
}

async function withPageSession(operation) {
  const page = await currentPage();
  if (screencastConfig) {
    await refreshScreencast();
    return await operation(screencastSession, page);
  }
  const session = await context.newCDPSession(page);
  try {
    return await operation(session, page);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function resizePage(width, height) {
  viewport = { width, height };
  await withPageSession(async session => {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });
  if (screencastConfig) {
    screencastConfig = { width, height };
    await refreshScreencast(true);
  }
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

async function run(message) {
  const params = message.params ?? {};
  switch (message.method) {
    case 'navigate': {
      const page = await currentPage();
      await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await refreshScreencast();
      return await pageIdentity(page);
    }
    case 'click': {
      const page = await currentPage();
      await page.locator(params.selector).first().click({ timeout: 30_000 });
      await refreshScreencast();
      return await pageIdentity(await currentPage());
    }
    case 'type': {
      const page = await currentPage();
      await page.locator(params.selector).first().fill(params.text, { timeout: 30_000 });
      return await pageIdentity(page);
    }
    case 'read': {
      const page = await currentPage();
      const text = params.selector
        ? await page.locator(params.selector).first().innerText({ timeout: 30_000 })
        : await page.locator('body').innerText({ timeout: 30_000 });
      return { ...(await pageIdentity(page)), text: text.slice(0, 200_000) };
    }
    case 'screenshot': {
      const page = await currentPage();
      const bytes = await page.screenshot({ type: 'png', fullPage: false });
      return { ...(await pageIdentity(page)), screenshotBase64: bytes.toString('base64') };
    }
    case 'back': {
      const page = await currentPage();
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await refreshScreencast();
      return await pageIdentity(page);
    }
    case 'forward': {
      const page = await currentPage();
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await refreshScreencast();
      return await pageIdentity(page);
    }
    case 'reload': {
      const page = await currentPage();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await refreshScreencast();
      return await pageIdentity(page);
    }
    case 'location':
      return await pageIdentity(await currentPage());
    case 'resize':
      await resizePage(params.width, params.height);
      return {};
    case 'startScreencast':
      viewport = { width: params.width, height: params.height };
      screencastConfig = { ...viewport };
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

try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  context = browser.contexts()[0];
  if (!context) throw new Error('Chrome exposed no persistent browser context');
  write({ type: 'ready' });
} catch (error) {
  write({ type: 'fatal', error: safeError(error) });
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let serial = Promise.resolve();
lines.on('line', line => {
  serial = serial.then(async () => {
    let message;
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
