import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  browserDestination,
  InAppBrowserLink,
  InAppBrowserPane,
  InAppBrowserSheet,
  InAppBrowserWorkspace,
  isLoopbackHostname,
  shouldOpenInApp,
  type BrowserActivation,
} from './InAppBrowser';

const plainClick: BrowserActivation = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

describe('browserDestination', () => {
  test('resolves relative daemon pages as same-origin', () => {
    expect(browserDestination('/session/abc?tab=chat#latest', 'https://app.example.test/session/abc')).toEqual({
      href: 'https://app.example.test/session/abc?tab=chat#latest',
      hostname: 'app.example.test',
      scope: 'same-origin',
    });
  });

  test('allows a genuinely frameable public URL to be attempted', () => {
    expect(browserDestination('https://example.com/docs', 'https://app.example.test/')).toEqual({
      href: 'https://example.com/docs',
      hostname: 'example.com',
      scope: 'cross-origin',
    });
  });

  test('flags device-local links when the app itself is reached through a tunnel', () => {
    for (const href of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://0.0.0.0:8080', 'http://[::1]:4321']) {
      expect(browserDestination(href, 'https://team-tunnel.example.test/')?.scope).toBe('device-loopback');
    }
  });

  test('does not mislabel loopback while the app is itself running locally', () => {
    expect(browserDestination('http://localhost:5173', 'http://localhost:4173/')?.scope).toBe('cross-origin');
  });

  test('rejects non-web and malformed destinations', () => {
    expect(browserDestination('javascript:alert(1)', 'https://app.example.test/')).toBeNull();
    expect(browserDestination('mailto:person@example.com', 'https://app.example.test/')).toBeNull();
    expect(browserDestination('not an absolute URL')).toBeNull();
  });
});

describe('loopback recognition', () => {
  test('covers names agents commonly print for local dev servers', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('preview.localhost')).toBe(true);
    expect(isLoopbackHostname('127.42.0.9')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('example.com')).toBe(false);
  });
});

describe('tap policy', () => {
  const destination = browserDestination('https://example.com')!;

  test('opens only an explicit ordinary primary activation', () => {
    expect(shouldOpenInApp(plainClick, destination, undefined)).toBe(true);
    expect(shouldOpenInApp({ ...plainClick, button: 1 }, destination, undefined)).toBe(false);
    expect(shouldOpenInApp({ ...plainClick, metaKey: true }, destination, undefined)).toBe(false);
    expect(shouldOpenInApp({ ...plainClick, ctrlKey: true }, destination, undefined)).toBe(false);
    expect(shouldOpenInApp({ ...plainClick, defaultPrevented: true }, destination, undefined)).toBe(false);
    expect(shouldOpenInApp(plainClick, null, undefined)).toBe(false);
    expect(shouldOpenInApp(plainClick, destination, 'file.txt')).toBe(false);
  });
});

describe('InAppBrowserSheet', () => {
  test('keeps the URL, honest refusal copy, and thumb-safe escape controls visible around an iframe', () => {
    const destination = browserDestination('https://example.com/path?q=1', 'https://app.example.test/')!;
    const html = renderToStaticMarkup(<InAppBrowserSheet destination={destination} open onClose={() => undefined} />);

    expect(html).toContain('URL being viewed');
    expect(html).toContain('https://example.com/path?q=1');
    expect(html).toContain('Most public sites block embedded viewing');
    expect(html).toContain('Open externally');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).not.toContain('allow-modals');
  });

  test('explains tunnel loopback honestly instead of creating a doomed frame', () => {
    const destination = browserDestination('http://localhost:3000', 'https://team-tunnel.example.test/')!;
    const html = renderToStaticMarkup(<InAppBrowserSheet destination={destination} open onClose={() => undefined} />);

    expect(html).toContain('This address is on your phone');
    expect(html).toContain('not the agent');
    expect(html).toContain('Open externally');
    expect(html).not.toContain('<iframe');
  });
});

describe('desktop split pane', () => {
  test('is a bounded non-modal complementary pane with the same permanent escape controls', () => {
    const destination = browserDestination('https://example.com/docs', 'https://app.example.test/')!;
    const html = renderToStaticMarkup(
      <InAppBrowserPane id="browser-pane" destination={destination} onClose={() => undefined} />,
    );

    expect(html).toContain('role="complementary"');
    expect(html).toContain('width:clamp(320px, 44%, 680px)');
    expect(html).toContain('Close browser pane');
    expect(html).toContain('Open externally');
    expect(html).toContain('https://example.com/docs');
    expect(html).not.toContain('aria-modal');
  });

  test('desktop links control a pane while compact links advertise the dialog fallback', () => {
    const desktop = renderToStaticMarkup(
      <InAppBrowserWorkspace compact={false}>
        <main data-conversation="visible">Conversation</main>
        <InAppBrowserLink href="https://example.com">Read this</InAppBrowserLink>
      </InAppBrowserWorkspace>,
    );
    expect(desktop).toContain('data-conversation="visible"');
    expect(desktop).toContain('aria-controls="in-app-browser-pane-');
    expect(desktop).not.toContain('aria-haspopup="dialog"');

    const mobile = renderToStaticMarkup(
      <InAppBrowserWorkspace compact>
        <InAppBrowserLink href="https://example.com">Read this</InAppBrowserLink>
      </InAppBrowserWorkspace>,
    );
    expect(mobile).toContain('aria-haspopup="dialog"');
    expect(mobile).not.toContain('aria-controls=');
  });
});

describe('InAppBrowserLink', () => {
  test('advertises the dialog while retaining external/new-tab fallback semantics', () => {
    const html = renderToStaticMarkup(<InAppBrowserLink href="https://example.com">Read this</InAppBrowserLink>);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  test('leaves non-HTTP schemes as ordinary external links', () => {
    const html = renderToStaticMarkup(<InAppBrowserLink href="mailto:person@example.com">Email</InAppBrowserLink>);
    expect(html).not.toContain('aria-haspopup');
    expect(html).toContain('mailto:person@example.com');
  });
});
