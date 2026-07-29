import type { PdfDecryptWorkerRequest, PdfDecryptWorkerResponse } from './pdf-decrypt-worker';

export const DEFAULT_PDF_DECRYPTION_TIMEOUT_MS = 20_000;
/** A decrypted PDF is usually a little larger than its encrypted original (the
 * streams are no longer AES-padded but the object structure is rewritten). Twice
 * the 20 MiB upload ceiling bounds a decompression-bomb rewrite without
 * rejecting any real document that was accepted in the first place. */
export const DEFAULT_MAX_DECRYPTED_PDF_BYTES = 40 * 1024 * 1024;

export type PdfDecryptionErrorCode =
  | 'wrong_password'
  | 'unreadable_document'
  | 'decryption_timeout'
  | 'decrypted_document_too_large';

/** `wrong_password` is the only retryable code: the same bytes with a different
 * password may still succeed. The others reproduce for the same input. */
export const RETRYABLE_PDF_DECRYPTION_ERROR_CODES = new Set<PdfDecryptionErrorCode>(['wrong_password']);

const MESSAGES: Readonly<Record<PdfDecryptionErrorCode, string>> = {
  wrong_password: 'that password did not unlock this PDF',
  unreadable_document: 'this PDF could not be decrypted; it may be corrupt or use an unsupported scheme',
  decryption_timeout: 'PDF decryption exceeded the processing time limit',
  decrypted_document_too_large: 'the decrypted PDF exceeds the in-memory size limit',
};

export class PdfDecryptionError extends Error {
  readonly code: PdfDecryptionErrorCode;

  constructor(code: PdfDecryptionErrorCode, message = MESSAGES[code]) {
    super(message);
    this.name = 'PdfDecryptionError';
    this.code = code;
  }

  get retryable(): boolean {
    return RETRYABLE_PDF_DECRYPTION_ERROR_CODES.has(this.code);
  }
}

export interface PdfDecryptionOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function isWorkerResponse(value: unknown): value is PdfDecryptWorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { ok?: unknown; output?: unknown; code?: unknown };
  if (message.ok === true) return message.output instanceof ArrayBuffer;
  return (
    message.ok === false &&
    (message.code === 'wrong_password' ||
      message.code === 'unreadable_document' ||
      message.code === 'decrypted_document_too_large')
  );
}

/**
 * Strip the encryption from a PDF entirely in memory and return the decrypted
 * bytes. Nothing is written to disk on any path.
 *
 * The work runs in a one-shot Worker (see pdf-decrypt-worker.ts for why that
 * isolation is mandatory rather than tidy) which is terminated as soon as the
 * first message, the timeout, or an error settles this call. Termination is the
 * deadline: it applies to a wedged WASM parser too, which a Promise race around
 * an in-process call could not interrupt.
 *
 * The password is never logged, never persisted and is zeroed by the worker
 * after use. This function keeps no reference to it beyond the postMessage.
 */
export async function decryptPdfInMemory(
  input: Uint8Array,
  password: string,
  options: PdfDecryptionOptions = {},
): Promise<Uint8Array> {
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_PDF_DECRYPTION_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = positiveLimit(options.maxOutputBytes, DEFAULT_MAX_DECRYPTED_PDF_BYTES, 'maxOutputBytes');
  if (input.byteLength === 0) throw new PdfDecryptionError('unreadable_document');

  const worker = new Worker(new URL('./pdf-decrypt-worker.ts', import.meta.url), { type: 'module' });
  // A detached copy: the original stays owned by the caller, and the worker gets
  // exclusive ownership of the transferred buffer.
  const transferred = input.slice();

  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };
      const timer = setTimeout(() => settle(() => reject(new PdfDecryptionError('decryption_timeout'))), timeoutMs);

      worker.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!isWorkerResponse(message)) {
          settle(() => reject(new PdfDecryptionError('unreadable_document')));
          return;
        }
        if (message.ok) {
          const bytes = new Uint8Array(message.output);
          settle(() => resolve(bytes));
          return;
        }
        const code: PdfDecryptionErrorCode =
          message.code === 'decrypted_document_too_large' ? 'decrypted_document_too_large' : message.code;
        settle(() => reject(new PdfDecryptionError(code)));
      };
      worker.onerror = () => settle(() => reject(new PdfDecryptionError('unreadable_document')));

      const request: PdfDecryptWorkerRequest = {
        input: transferred.buffer as ArrayBuffer,
        password,
        maxOutputBytes,
      };
      worker.postMessage(request, [transferred.buffer as ArrayBuffer]);
    });
  } finally {
    worker.terminate();
  }
}
