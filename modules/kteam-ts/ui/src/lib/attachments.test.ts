import { describe, expect, test } from 'bun:test';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentApiPath,
  attachmentErrorMessage,
  attachmentFromToolPath,
  formatAttachmentSize,
  sameAttachmentIds,
  validateAttachmentFile,
} from './attachments';

describe('attachment validation mirrors the daemon', () => {
  test('accepts images, approved documents, aliases, and sniffable declarations', () => {
    for (const type of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/jpg',
      'image/pjpeg',
      'application/pdf',
      'application/x-pdf',
      'text/plain',
      'text/markdown',
      'text/x-markdown',
      'text/csv',
      'text/x-csv',
      'application/json',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '',
      'application/octet-stream',
      'application/octet-stream; charset=binary',
      'binary/octet-stream',
    ]) {
      expect(validateAttachmentFile({ size: 10, type })).toBeNull();
    }
  });

  test('rejects empty, oversized, video, and arbitrary files before upload', () => {
    expect(validateAttachmentFile({ size: 0, type: 'image/png' })).toBe('empty_attachment');
    expect(validateAttachmentFile({ size: MAX_ATTACHMENT_BYTES + 1, type: 'image/png' })).toBe('attachment_too_large');
    expect(validateAttachmentFile({ size: 10, type: 'video/mp4' })).toBe('unsupported_mime');
    expect(validateAttachmentFile({ size: 10, type: 'application/msword' })).toBe('unsupported_mime');
  });
});

describe('attachment error copy', () => {
  test('maps every daemon message family to actionable copy', () => {
    expect(attachmentErrorMessage(new Error('attachment is larger than the 20971520-byte limit'))).toBe(
      'Files must be 20 MiB or smaller',
    );
    expect(attachmentErrorMessage(new Error('unsupported image type'))).toBe("That file type isn't supported");
    expect(
      attachmentErrorMessage(new Error('declared MIME type image/png does not match detected type image/jpeg')),
    ).toBe('The file type does not match its contents');
    expect(attachmentErrorMessage(new Error('attachment is empty'))).toBe('That file is empty');
    expect(attachmentErrorMessage(new Error('attachment filename is not safe'))).toBe("That file can't be attached");
    expect(attachmentErrorMessage(new Error('attachment att_dead was not found'))).toBe(
      'Attachment is no longer available — re-add it',
    );
    expect(attachmentErrorMessage(new Error('attachment manifest is invalid'))).toBe(
      'Attachment is no longer available — re-add it',
    );
    expect(attachmentErrorMessage({ status: 422, message: 'PDF text extraction failed' })).toBe(
      'PDF text extraction failed',
    );
    expect(attachmentErrorMessage({ status: 422, message: 'corrupt /home/kirin/.kteam attachment' })).toBe(
      'Attachment is no longer available — re-add it',
    );
  });
});

describe('safe stored-image references', () => {
  const hash = 'a'.repeat(64);
  const sessionId = 'ms1abcde-12345678';

  test('derives an id only from this session attachment-store shape', () => {
    const path = `/home/kirin/.kteam/${sessionId}/attachments/${hash}/probe.png`;
    expect(attachmentFromToolPath(sessionId, path)).toEqual({
      kind: 'attachment',
      sessionId,
      attachmentId: `att_${hash}`,
      filename: 'probe.png',
      alt: path,
    });
    expect(attachmentFromToolPath('ms1other-00000000', path)).toBeNull();
    expect(attachmentFromToolPath(sessionId, `${path}/../secret`)).toBeNull();
    expect(
      attachmentFromToolPath(sessionId, `/home/kirin/.kteam/${sessionId}/attachments/${hash}/../${hash}/probe.png`),
    ).toBeNull();
    expect(
      attachmentFromToolPath(
        sessionId,
        `C:\\Users\\kirin\\.kteam\\${sessionId}\\attachments\\${hash}\\..\\${hash}\\probe.png`,
      ),
    ).toBeNull();
    expect(attachmentFromToolPath(sessionId, path.replace(hash, hash.toUpperCase()))).toBeNull();
    expect(attachmentFromToolPath(sessionId, `/tmp/${hash}/probe.png`)).toBeNull();
  });

  test('constructs only the authenticated id endpoint and formats metadata', () => {
    expect(attachmentApiPath('session / one', 'att_?#')).toBe(
      '/v1/sessions/session%20%2F%20one/attachments/att_%3F%23',
    );
    expect(formatAttachmentSize(233)).toBe('233 B');
    expect(formatAttachmentSize(1536)).toBe('1.5 KB');
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(sameAttachmentIds(['b', 'a'], ['a', 'b'])).toBe(true);
  });
});
