import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../lib/api';
import { attachmentLockCopy, unlockFailure } from '../lib/attachments';
import { AttachmentUnlockPrompt } from './AttachmentUnlockPrompt';

function html(open = true): string {
  return renderToStaticMarkup(
    <AttachmentUnlockPrompt
      filename="statement.pdf"
      open={open}
      onUnlock={async () => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe('AttachmentUnlockPrompt', () => {
  test('asks for the password and states plainly where the decrypted copy goes', () => {
    const markup = html();
    expect(markup).toContain('Unlock encrypted PDF');
    expect(markup).toContain('statement.pdf');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('never written to');
    expect(markup).toContain('the password is never stored');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Unlock');
    // Touch targets stay at the 44px floor the rest of the UI uses.
    expect(markup).toContain('min-h-[44px]');
  });

  test('keeps a document password out of browser autofill', () => {
    // A PDF password is not a site credential; offering to save it against this
    // origin would put it in a password manager under the wrong identity.
    expect(html()).toContain('autoComplete="off"');
  });

  test('renders nothing while closed', () => {
    expect(html(false)).toBe('');
  });
});

describe('unlockFailure', () => {
  test('a wrong password is retryable and gets copy that invites another attempt', () => {
    const failure = unlockFailure(new ApiError(400, 'that password did not unlock this PDF', 'wrong_password'));
    expect(failure.retryable).toBe(true);
    expect(failure.message).toBe('That password did not open this PDF — try again');
  });

  test('a host with no memory filesystem is a dead end, not a retry', () => {
    const failure = unlockFailure(new ApiError(503, 'no memory-backed filesystem', 'decryption_unavailable'));
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('will not write one to disk');
  });

  test('every other unlock failure is stated once and not offered a retry', () => {
    for (const code of ['decryption_failed', 'decryption_timeout', 'attachment_not_locked', 'attachment_not_found']) {
      expect(unlockFailure(new ApiError(400, 'daemon detail', code)).retryable).toBe(false);
    }
  });

  test('an unknown failure never leaks the daemon’s raw text or a storage path', () => {
    const failure = unlockFailure(new ApiError(500, '/home/kirin/.kteam/s1/attachments/abc/statement.pdf is broken'));
    expect(failure.retryable).toBe(false);
    expect(failure.message).not.toContain('/home/kirin');
  });
});

describe('attachmentLockCopy', () => {
  test('locked reads as an action the reader can take, not as a failure', () => {
    const copy = attachmentLockCopy({ kind: 'pdf', locked: true });
    expect(copy).toContain('enter its password');
    expect(copy).toContain('never written to disk');
    expect(copy).not.toContain('failed');
  });

  test('unlocked says the copy is memory-only and the stored original is untouched', () => {
    const copy = attachmentLockCopy({ kind: 'pdf', locked: false, expiresAt: '2026-07-29T02:30:00.000Z' });
    expect(copy).toContain('only in memory');
    expect(copy).toContain('stored original stays encrypted');
  });
});
