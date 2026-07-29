import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserLoginBanner, browserLoginRemaining } from './BrowserLoginBanner';

describe('BrowserLoginBanner', () => {
  test('renders only an open or unknown window, never a closed one', () => {
    const close = async () => ({ state: 'closed' as const, profilePrimed: false });
    expect(
      renderToStaticMarkup(<BrowserLoginBanner status={{ state: 'closed', profilePrimed: false }} onClose={close} />),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        <BrowserLoginBanner status={{ state: 'unknown', error: 'network unavailable' }} onClose={close} />,
      ),
    ).toContain('Browser login status unknown');
  });

  test('keeps the countdown accurate and exposes copyable, explicit close choices', () => {
    expect(browserLoginRemaining('2026-07-28T12:01:01.000Z', Date.parse('2026-07-28T12:00:00.000Z'))).toBe('1:01');
    const html = renderToStaticMarkup(
      <BrowserLoginBanner
        status={{
          state: 'open',
          profilePrimed: false,
          expiresAt: '2099-01-01T00:00:00.000Z',
          connection: {
            host: '127.0.0.1',
            port: 5951,
            password: 'password',
            sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 kirin@box',
          },
        }}
        onClose={async () => ({ state: 'closed', profilePrimed: false })}
      />,
    );
    expect(html).toContain('Browser login window open');
    expect(html).toContain('Connection details');
    expect(html).toContain('127.0.0.1:5951');
    expect(html).toContain('overflow-auto');
  });
});
