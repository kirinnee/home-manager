import { describe, expect, test } from 'bun:test';
import { extractPdfText } from './document-extract';
import { decryptPdfInMemory, PdfDecryptionError, type PdfDecryptionErrorCode } from './pdf-decrypt';
import {
  encryptedPdfBytes,
  OWNER_PASSWORD_ONLY_PDF_BASE64,
  USER_PASSWORD_PDF_BASE64,
  USER_PASSWORD_PDF_PASSWORD,
} from './fixtures/encrypted-pdf';

function code(error: unknown): PdfDecryptionErrorCode | undefined {
  return error instanceof PdfDecryptionError ? error.code : undefined;
}

describe('decryptPdfInMemory', () => {
  test('the correct password produces a PDF the existing extractor can read', async () => {
    const encrypted = encryptedPdfBytes(USER_PASSWORD_PDF_BASE64);
    const plain = await decryptPdfInMemory(encrypted, USER_PASSWORD_PDF_PASSWORD);

    expect(new TextDecoder().decode(plain.subarray(0, 5))).toBe('%PDF-');
    expect(plain.byteLength).toBeGreaterThan(0);
    // The decrypted copy is a DIFFERENT document from the stored original.
    expect(Buffer.from(plain).equals(Buffer.from(encrypted))).toBe(false);

    const extracted = await extractPdfText(plain);
    expect(extracted.method).toBe('pdfjs');
    expect(extracted.text.length).toBeGreaterThan(0);
    // The same bytes are unreadable without the password.
    await expect(extractPdfText(encrypted)).rejects.toThrow();
  }, 30_000);

  test('the input the caller passed in is left untouched', async () => {
    const encrypted = encryptedPdfBytes(USER_PASSWORD_PDF_BASE64);
    const before = Buffer.from(encrypted);
    await decryptPdfInMemory(encrypted, USER_PASSWORD_PDF_PASSWORD);
    expect(Buffer.from(encrypted).equals(before)).toBe(true);
  }, 30_000);

  test('a wrong password is a named, retryable failure that does not poison the process', async () => {
    // qpdf's emscripten `quit_` sets `process.exitCode = 2` on a wrong password.
    // Inside a Bun Worker that assignment is thread-local, so the daemon's own
    // exit status must be exactly what it was before the attempt.
    const exitCodeBefore = process.exitCode;

    const error = await decryptPdfInMemory(encryptedPdfBytes(USER_PASSWORD_PDF_BASE64), 'not-the-password').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(code(error)).toBe('wrong_password');
    expect(error).toBeInstanceOf(PdfDecryptionError);
    expect((error as PdfDecryptionError).retryable).toBe(true);
    // No storage path, no qpdf diagnostic spill, no password echo.
    expect((error as PdfDecryptionError).message).not.toContain('not-the-password');
    expect(process.exitCode).toBe(exitCodeBefore);
  }, 30_000);

  test('a retry with the right password after a wrong one still succeeds', async () => {
    const encrypted = encryptedPdfBytes(USER_PASSWORD_PDF_BASE64);
    await expect(decryptPdfInMemory(encrypted, 'wrong')).rejects.toThrow();
    const plain = await decryptPdfInMemory(encrypted, USER_PASSWORD_PDF_PASSWORD);
    expect(new TextDecoder().decode(plain.subarray(0, 5))).toBe('%PDF-');
  }, 40_000);

  test('an owner-password-only PDF decrypts with its owner password', async () => {
    // This fixture never enters the unlock flow — it opens with the empty user
    // password, so it is classified as readable, not locked. Pinning it here
    // records what qpdf actually does with it: an arbitrary password is still
    // rejected, because `--password-file` supplies a password to check rather
    // than falling back to the empty one.
    const encrypted = encryptedPdfBytes(OWNER_PASSWORD_ONLY_PDF_BASE64);
    const plain = await decryptPdfInMemory(encrypted, 'owner-secret');
    expect(new TextDecoder().decode(plain.subarray(0, 5))).toBe('%PDF-');
    await expect(decryptPdfInMemory(encrypted, 'anything')).rejects.toMatchObject({ code: 'wrong_password' });
  }, 40_000);

  test('bytes that are not a PDF fail as unreadable rather than as a wrong password', async () => {
    const error = await decryptPdfInMemory(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'secret').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(code(error)).toBe('unreadable_document');
    expect((error as PdfDecryptionError).retryable).toBe(false);
  }, 30_000);

  test('empty input is rejected without starting a worker', async () => {
    await expect(decryptPdfInMemory(new Uint8Array(0), 'secret')).rejects.toMatchObject({
      code: 'unreadable_document',
    });
  });

  test('a deadline that expires first reports a timeout', async () => {
    const error = await decryptPdfInMemory(encryptedPdfBytes(USER_PASSWORD_PDF_BASE64), USER_PASSWORD_PDF_PASSWORD, {
      timeoutMs: 1,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    // A 1 ms budget cannot outrun WASM instantiation, so this is deterministic.
    expect(code(error)).toBe('decryption_timeout');
  }, 30_000);

  test('a decrypted document larger than the cap is refused', async () => {
    const error = await decryptPdfInMemory(encryptedPdfBytes(USER_PASSWORD_PDF_BASE64), USER_PASSWORD_PDF_PASSWORD, {
      maxOutputBytes: 16,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(code(error)).toBe('decrypted_document_too_large');
  }, 30_000);

  test('non-positive limits are a programming error, not a decryption failure', async () => {
    await expect(decryptPdfInMemory(new Uint8Array([1]), 'x', { timeoutMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(decryptPdfInMemory(new Uint8Array([1]), 'x', { maxOutputBytes: -1 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
