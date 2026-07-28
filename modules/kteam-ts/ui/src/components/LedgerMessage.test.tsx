import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SendRecord } from '../types';
import { LedgerMessage, RESEND_RISK_COPY, ledgerPlacementCopy, runResendOnce } from './LedgerMessage';

const ACCEPTED = '2026-07-27T02:00:32.112Z';
const NOW = Date.parse('2026-07-27T03:30:00.000Z');

function record(overrides: Partial<SendRecord> = {}): SendRecord {
  return {
    sendId: 'send-1',
    acceptedAt: ACCEPTED,
    message: 'please continue',
    attachmentIds: [],
    fate: 'unaccounted',
    ...overrides,
  };
}

describe('LedgerMessage', () => {
  test('the async latch collapses a rapid double activation to one resend', async () => {
    const latch = { current: false };
    let calls = 0;
    let release!: (accepted: boolean) => void;
    const gate = new Promise<boolean>(resolve => {
      release = resolve;
    });
    const first = runResendOnce(latch, async () => {
      calls++;
      return await gate;
    });
    const second = runResendOnce(latch, async () => {
      calls++;
      return true;
    });
    expect(await second).toBeUndefined();
    expect(calls).toBe(1);
    release(true);
    expect(await first).toBe(true);
    expect(latch.current).toBe(false);
  });

  test('renders uncertainty and makes resend an explicit warned second step', () => {
    const html = renderToStaticMarkup(
      <LedgerMessage record={record()} sessionId="ms1" asOf={NOW} onResend={async () => true} />,
    );
    expect(html).toContain('unconfirmed');
    expect(html).toContain('resend…');
    expect(html).toContain('resend as a new message');
    expect(html).toContain('new send ID; the original stays unconfirmed');
    expect(html).toContain(RESEND_RISK_COPY);
    expect(html).not.toContain('dismiss');
  });

  test('marks an off-page row honestly at the top history boundary', () => {
    const html = renderToStaticMarkup(
      <LedgerMessage record={record()} sessionId="ms1" placement="before-loaded" asOf={NOW} />,
    );
    expect(html).toContain('data-ledger-placement="before-loaded"');
    expect(html).toContain('older than the loaded transcript · shown at the history boundary');
    expect(ledgerPlacementCopy('unknown-time')).toContain('position unavailable');
  });

  test('a current accepted row has no resend action', () => {
    const html = renderToStaticMarkup(
      <LedgerMessage
        record={record({
          fate: 'accepted',
          path: 'native-inline',
          unaccountedDeadline: '2026-07-27T04:00:00.000Z',
        })}
        sessionId="ms1"
        asOf={NOW}
        onResend={async () => true}
      />,
    );
    expect(html).toContain('queued for next turn');
    expect(html).not.toContain('resend as a new message');
  });

  test('an accepted row becomes honestly unconfirmed once its deadline passes', () => {
    const html = renderToStaticMarkup(
      <LedgerMessage
        record={record({ fate: 'accepted', unaccountedDeadline: '2026-07-27T03:00:00.000Z' })}
        sessionId="ms1"
        asOf={NOW}
        onResend={async () => true}
      />,
    );
    expect(html).toContain('unconfirmed');
    expect(html).toContain('resend as a new message');
  });

  test('peer transport prose becomes attribution plus body, not a raw banner', () => {
    const banner = `[peer message from teammate jessica (session mspeer-1) — not from the human lead]
No reply is required; jessica has carried on.

peer body`;
    const html = renderToStaticMarkup(
      <LedgerMessage record={record({ message: banner })} sessionId="ms1" asOf={NOW} />,
    );
    expect(html).toContain('Jessica');
    expect(html).toContain('peer body');
    expect(html).not.toContain('[peer message');
  });
});
