import { describe, expect, test } from 'bun:test';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentApiPath,
  attachmentErrorMessage,
  attachmentFromView,
  attachmentFromToolPath,
  formatAttachmentSize,
  isAttachmentEncryption,
  isTextExtractionFailure,
  sameAttachmentIds,
  textExtractionFailureCopy,
  validateAttachmentFile,
  type TextExtraction,
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

describe('document extraction failure metadata', () => {
  const failure = {
    code: 'no_extractable_text' as const,
    message: 'document has no extractable text; it may be a scan or image-only document',
  };
  const view = {
    id: `att_${'b'.repeat(64)}`,
    filename: 'scan.pdf',
    mime: 'application/pdf',
    size: 123,
    sha256: 'b'.repeat(64),
    path: '/daemon-only/scan.pdf',
    createdAt: '2026-07-29T00:00:00.000Z',
  };
  const futureFailure = {
    code: 'future_document_read_error',
    message: 'parser detail /home/kirin/.kteam/ms1docs-12345678/attachments/private.pdf',
  };

  test('preserves the daemon failure metadata when an uploaded attachment joins the transcript', () => {
    const attachment = attachmentFromView('ms1docs-12345678', {
      ...view,
      textExtractionFailure: failure,
    });
    expect(attachment).toMatchObject({
      kind: 'attachment',
      filename: 'scan.pdf',
      textExtractionFailure: failure,
    });
    expect(attachment.textExtraction).toBeUndefined();
  });

  test('preserves a valid future API failure while using generic copy that omits daemon detail', () => {
    const attachment = attachmentFromView('ms1docs-12345678', {
      ...view,
      textExtractionFailure: futureFailure,
    });
    expect(attachment.textExtractionFailure).toEqual(futureFailure);
    const copy = textExtractionFailureCopy(futureFailure.code);
    expect(copy).toBe(
      'Agent text extraction failed: kteam could not read the document text. The original remains attached and downloadable.',
    );
    expect(copy).not.toContain(futureFailure.message);
    expect(copy).not.toContain('/home/kirin/.kteam/');
  });

  test('accepts bounded single-line future codes and rejects malformed or oversized ones', () => {
    expect(isTextExtractionFailure(failure)).toBe(true);
    expect(isTextExtractionFailure({ ...failure, code: 'future_document_read_error' })).toBe(true);
    for (const code of [
      'Future_document',
      'future-document',
      'future__document',
      'future_document_',
      '1future_document',
    ]) {
      expect(isTextExtractionFailure({ ...failure, code })).toBe(false);
    }
    expect(isTextExtractionFailure({ ...failure, code: 'a'.repeat(65) })).toBe(false);
    expect(isTextExtractionFailure({ ...failure, message: ' raw detail\nnext line' })).toBe(false);
    expect(isTextExtractionFailure({ ...failure, message: 'x'.repeat(501) })).toBe(false);
  });

  test('drops malformed API failure metadata and contradictory extraction states', () => {
    const malformed = attachmentFromView('ms1docs-12345678', {
      ...view,
      textExtractionFailure: { ...failure, code: 'future-document' },
    });
    expect(malformed.textExtractionFailure).toBeUndefined();

    const contradictory = attachmentFromView('ms1docs-12345678', {
      ...view,
      textExtraction: { method: 'pdfjs', characters: 70, truncated: false },
      textExtractionFailure: failure,
    });
    expect(contradictory.textExtraction).toBeUndefined();
    expect(contradictory.textExtractionFailure).toBeUndefined();

    const malformedExtraction = attachmentFromView('ms1docs-12345678', {
      ...view,
      textExtraction: {
        method: 'future-extractor',
        characters: 70,
        truncated: false,
      } as unknown as TextExtraction,
      textExtractionFailure: futureFailure,
    });
    expect(malformedExtraction.textExtraction).toBeUndefined();
    expect(malformedExtraction.textExtractionFailure).toEqual(futureFailure);
  });

  test('uses concise, code-specific UI copy instead of the daemon message', () => {
    expect(textExtractionFailureCopy('password_protected_document')).toBe(
      'Agent text extraction failed: this PDF or Word document needs a password, so kteam could not read its text. The original remains attached and downloadable; decrypt it locally and re-attach it if the agent should read it.',
    );
    expect(textExtractionFailureCopy('no_extractable_text')).toBe(
      'Agent text extraction failed: no readable text was found; it may be a scan.',
    );
    expect(textExtractionFailureCopy('unreadable_document')).toBe(
      'Agent text extraction failed: the document is unreadable or corrupt.',
    );
    expect(textExtractionFailureCopy('document_extraction_timeout')).toBe(
      'Agent text extraction failed: document reading timed out.',
    );
    expect(textExtractionFailureCopy('document_too_complex')).toBe(
      'Agent text extraction failed: the document is too complex or exceeds extraction limits.',
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

describe('encrypted attachment metadata', () => {
  test('accepts the daemon shape and rejects anything it cannot trust', () => {
    expect(isAttachmentEncryption({ kind: 'pdf', locked: true })).toBe(true);
    expect(
      isAttachmentEncryption({ kind: 'pdf', locked: false, expiresAt: '2026-07-29T02:30:00.000Z', decryptedSize: 777 }),
    ).toBe(true);
    // A missing or malformed field must render as unknown, not as a confident
    // "unlocked" — that would show the reader a file the agent cannot read.
    expect(isAttachmentEncryption({ kind: 'pdf' })).toBe(false);
    expect(isAttachmentEncryption({ kind: 'docx', locked: true })).toBe(false);
    expect(isAttachmentEncryption({ kind: 'pdf', locked: 'yes' })).toBe(false);
    expect(isAttachmentEncryption({ kind: 'pdf', locked: false, expiresAt: 'soon' })).toBe(false);
    expect(isAttachmentEncryption(undefined)).toBe(false);
    expect(isAttachmentEncryption(null)).toBe(false);
  });

  test('the transcript record carries the lock state so a locked file never looks ordinary', () => {
    const record = attachmentFromView('ms1docs-12345678', {
      id: 'att_' + 'a'.repeat(64),
      filename: 'statement.pdf',
      mime: 'application/pdf',
      size: 1234,
      sha256: 'a'.repeat(64),
      path: '/daemon-only/statement.pdf',
      createdAt: '2026-07-29T02:00:00.000Z',
      encrypted: { kind: 'pdf', locked: true },
    });
    expect(record.encrypted).toEqual({ kind: 'pdf', locked: true });
    expect(record.textExtraction).toBeUndefined();
    expect(record.textExtractionFailure).toBeUndefined();
  });

  test('an untrustworthy lock state is dropped rather than half-rendered', () => {
    const record = attachmentFromView('ms1docs-12345678', {
      id: 'att_' + 'b'.repeat(64),
      filename: 'statement.pdf',
      mime: 'application/pdf',
      size: 1234,
      sha256: 'b'.repeat(64),
      path: '/daemon-only/statement.pdf',
      createdAt: '2026-07-29T02:00:00.000Z',
      encrypted: { kind: 'pdf' } as never,
    });
    expect(record.encrypted).toBeUndefined();
  });
});
