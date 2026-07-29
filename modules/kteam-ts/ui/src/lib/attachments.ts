/** UI-side attachment contracts and validation.
 *
 * The daemon remains authoritative (it sniffs magic bytes and confines every
 * read to the content-addressed session store), but rejecting obvious mistakes
 * here keeps a bad 20 MB paste from making a pointless round trip. */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const ATTACHMENT_MIME_TYPES = [...IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

export type AttachmentErrorCode =
  | 'invalid_identifier'
  | 'invalid_filename'
  | 'empty_attachment'
  | 'attachment_too_large'
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'attachment_not_found'
  | 'corrupt_attachment'
  | 'wrong_password'
  | 'attachment_not_locked'
  | 'decryption_unavailable'
  | 'decryption_timeout'
  | 'decryption_failed';

/** The only unlock failure worth another password. Everything else means this
 * document will not open here no matter what the reader types. */
export const RETRYABLE_UNLOCK_ERROR_CODES: readonly AttachmentErrorCode[] = ['wrong_password'];

export function isRetryableUnlockError(code: string | undefined): boolean {
  return code !== undefined && (RETRYABLE_UNLOCK_ERROR_CODES as readonly string[]).includes(code);
}

export interface UnlockFailure {
  message: string;
  /** True only when ANOTHER password could succeed. Offering "try again" for a
   * failure no password fixes renders a dead end as an invitation. */
  retryable: boolean;
}

export function unlockFailure(error: unknown): UnlockFailure {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  return { message: attachmentErrorMessage(error), retryable: isRetryableUnlockError(code) };
}

export interface TextExtraction {
  method: 'pdfjs' | 'docx-xml';
  characters: number;
  truncated: boolean;
  totalPages?: number;
  pagesRead?: number;
}

export const TEXT_EXTRACTION_FAILURE_CODES = [
  'password_protected_document',
  'no_extractable_text',
  'unreadable_document',
  'document_extraction_timeout',
  'document_too_complex',
] as const;

export type KnownTextExtractionFailureCode = (typeof TEXT_EXTRACTION_FAILURE_CODES)[number];

/** Keep known codes discoverable while allowing a newer daemon to add a safe,
 * validated machine code before a cached UI bundle is refreshed. */
export type TextExtractionFailureCode = KnownTextExtractionFailureCode | (string & {});

export interface TextExtractionFailure {
  code: TextExtractionFailureCode;
  /** Daemon metadata retained for transcript fidelity; never render it verbatim. */
  message: string;
}

/**
 * An encrypted original. `locked` is a state the reader can RESOLVE by supplying
 * the password — not a failure — so it is never rendered with the terminal
 * extraction-failure copy.
 *
 * Unlocking is process-local to the daemon: the decrypted copy lives in RAM and
 * a daemon restart puts this back to `locked: true`. The UI therefore trusts the
 * daemon's latest view and never caches "unlocked" past a reload.
 */
export interface AttachmentEncryption {
  kind: 'pdf';
  locked: boolean;
  /** Only while unlocked: when the daemon drops the decrypted copy. */
  expiresAt?: string;
  /** Only while unlocked: size of the decrypted copy, which differs from `size`. */
  decryptedSize?: number;
}

export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  /** Daemon-local audit metadata only. The UI must never render or fetch it. */
  path: string;
  createdAt: string;
  textExtraction?: TextExtraction;
  /** Mutually exclusive with textExtraction when the daemon could retain the original but not its text. */
  textExtractionFailure?: TextExtractionFailure;
  encrypted?: AttachmentEncryption;
}

export interface StoredTranscriptAttachment {
  kind: 'attachment';
  sessionId: string;
  attachmentId: string;
  filename: string;
  mime?: string;
  size?: number;
  /** A tool path is useful alt text, but is never used as a fetch target. */
  alt?: string;
  textExtraction?: TextExtraction;
  textExtractionFailure?: TextExtractionFailure;
  encrypted?: AttachmentEncryption;
}

/** Compatibility name while callers migrate from image-only presentation. */
export type StoredTranscriptImage = StoredTranscriptAttachment;

export interface InlineTranscriptImage {
  kind: 'inline';
  src: string;
  alt: string;
}

export type TranscriptImage = StoredTranscriptAttachment | InlineTranscriptImage;

const MIME_ALIASES: Readonly<Record<string, AttachmentMime>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-pdf': 'application/pdf',
  'text/x-markdown': 'text/markdown',
  'text/x-csv': 'text/csv',
};

const GENERIC_DECLARED_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const ERROR_COPY: Record<AttachmentErrorCode, string> = {
  attachment_too_large: 'Files must be 20 MiB or smaller',
  unsupported_mime: "That file type isn't supported",
  mime_mismatch: 'The file type does not match its contents',
  empty_attachment: 'That file is empty',
  invalid_filename: "That file can't be attached",
  invalid_identifier: "That file can't be attached",
  attachment_not_found: 'Attachment is no longer available — re-add it',
  corrupt_attachment: 'Attachment is no longer available — re-add it',
  wrong_password: 'That password did not open this PDF — try again',
  attachment_not_locked: 'That file is not encrypted; no password is needed',
  decryption_unavailable:
    'This machine cannot hold a decrypted copy in memory, and kteam will not write one to disk. Decrypt the PDF yourself and re-attach it.',
  decryption_timeout: 'Decrypting that PDF took too long — try again',
  decryption_failed: 'That PDF could not be decrypted; it may be corrupt or use an unsupported scheme',
};

const MAX_TEXT_EXTRACTION_FAILURE_CODE_LENGTH = 64;
const TEXT_EXTRACTION_FAILURE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const TEXT_EXTRACTION_FAILURE_COPY: Readonly<Record<KnownTextExtractionFailureCode, string>> = {
  password_protected_document:
    'Agent text extraction failed: this PDF or Word document needs a password, so kteam could not read its text. The original remains attached and downloadable; decrypt it locally and re-attach it if the agent should read it.',
  no_extractable_text: 'Agent text extraction failed: no readable text was found; it may be a scan.',
  unreadable_document: 'Agent text extraction failed: the document is unreadable or corrupt.',
  document_extraction_timeout: 'Agent text extraction failed: document reading timed out.',
  document_too_complex: 'Agent text extraction failed: the document is too complex or exceeds extraction limits.',
};

const UNKNOWN_TEXT_EXTRACTION_FAILURE_COPY =
  'Agent text extraction failed: kteam could not read the document text. The original remains attached and downloadable.';

export function attachmentErrorCopy(code: AttachmentErrorCode): string {
  return ERROR_COPY[code];
}

function isKnownTextExtractionFailureCode(code: string): code is KnownTextExtractionFailureCode {
  return (TEXT_EXTRACTION_FAILURE_CODES as readonly string[]).includes(code);
}

export function isTextExtraction(value: unknown): value is TextExtraction {
  if (!value || typeof value !== 'object') return false;
  const extraction = value as Record<string, unknown>;
  return (
    (extraction['method'] === 'pdfjs' || extraction['method'] === 'docx-xml') &&
    typeof extraction['characters'] === 'number' &&
    typeof extraction['truncated'] === 'boolean' &&
    (extraction['totalPages'] === undefined || typeof extraction['totalPages'] === 'number') &&
    (extraction['pagesRead'] === undefined || typeof extraction['pagesRead'] === 'number')
  );
}

export function isTextExtractionFailure(value: unknown): value is TextExtractionFailure {
  if (!value || typeof value !== 'object') return false;
  const failure = value as Record<string, unknown>;
  return (
    typeof failure['code'] === 'string' &&
    failure['code'].length <= MAX_TEXT_EXTRACTION_FAILURE_CODE_LENGTH &&
    TEXT_EXTRACTION_FAILURE_CODE.test(failure['code']) &&
    typeof failure['message'] === 'string' &&
    failure['message'].length > 0 &&
    failure['message'].length <= 500 &&
    failure['message'] === failure['message'].trim() &&
    !/[\u0000-\u001f\u007f]/.test(failure['message'])
  );
}

export function isAttachmentEncryption(value: unknown): value is AttachmentEncryption {
  if (!value || typeof value !== 'object') return false;
  const encryption = value as Record<string, unknown>;
  return (
    encryption['kind'] === 'pdf' &&
    typeof encryption['locked'] === 'boolean' &&
    (encryption['expiresAt'] === undefined ||
      (typeof encryption['expiresAt'] === 'string' && !Number.isNaN(Date.parse(encryption['expiresAt'])))) &&
    (encryption['decryptedSize'] === undefined ||
      (typeof encryption['decryptedSize'] === 'number' && Number.isFinite(encryption['decryptedSize'])))
  );
}

/** What the reader is told about an encrypted attachment. Locked is an invitation
 * to act, not a report of failure, so it never borrows the extraction-failure copy. */
export function attachmentLockCopy(encryption: AttachmentEncryption): string {
  return encryption.locked
    ? 'Encrypted PDF — enter its password and kteam will decrypt it in memory for the agent. The decrypted copy is never written to disk.'
    : 'Unlocked — the agent gets a decrypted copy that exists only in memory. Nothing was written to disk and the stored original stays encrypted.';
}

/** Curated UI copy deliberately omits the daemon's opaque raw message. */
export function textExtractionFailureCopy(code: TextExtractionFailureCode): string {
  return isKnownTextExtractionFailureCode(code)
    ? TEXT_EXTRACTION_FAILURE_COPY[code]
    : UNKNOWN_TEXT_EXTRACTION_FAILURE_COPY;
}

/** File.type is a declaration, not proof. Empty is allowed so the daemon can
 * sniff bytes from browsers that omit clipboard/file MIME metadata. */
export function validateAttachmentFile(file: Pick<File, 'size' | 'type'>): AttachmentErrorCode | null {
  if (file.size === 0) return 'empty_attachment';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'attachment_too_large';
  const declared = file.type.trim().toLowerCase();
  const normalized = normalizeAttachmentMime(declared);
  if (GENERIC_DECLARED_MIME_TYPES.has(normalized)) return null;
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(normalized) ? null : 'unsupported_mime';
}

export function normalizeAttachmentMime(mime: string | undefined): string {
  const bare = (mime ?? '').split(';', 1)[0]!.trim().toLowerCase();
  return MIME_ALIASES[bare] ?? bare;
}

export function isImageMime(mime: string | undefined): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(normalizeAttachmentMime(mime));
}

export function attachmentTypeLabel(mime: string | undefined): string {
  switch (normalizeAttachmentMime(mime)) {
    case 'application/pdf':
      return 'PDF document';
    case 'text/plain':
      return 'Text file';
    case 'text/markdown':
      return 'Markdown file';
    case 'text/csv':
      return 'CSV file';
    case 'application/json':
      return 'JSON file';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'Word document';
    default:
      return mime || 'File';
  }
}

export function isBrowserOpenableAttachment(mime: string | undefined): boolean {
  return ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(
    normalizeAttachmentMime(mime),
  );
}

/** The current daemon returns an error string; newer versions may also return
 * a typed code. Understand both without exposing storage paths or raw errors. */
export function attachmentErrorMessage(error: unknown): string {
  const obj =
    error && typeof error === 'object' ? (error as { code?: unknown; status?: unknown; message?: unknown }) : null;
  if (typeof obj?.code === 'string' && obj.code in ERROR_COPY) return ERROR_COPY[obj.code as AttachmentErrorCode];
  if (obj?.status === 404) return ERROR_COPY.attachment_not_found;

  const rawMessage = String(obj?.message ?? error ?? '');
  const message = rawMessage.toLowerCase();
  if (/larger than|too large|byte limit/.test(message)) return ERROR_COPY.attachment_too_large;
  if (/declared mime.*does not match|mime mismatch/.test(message)) return ERROR_COPY.mime_mismatch;
  if (/unsupported (declared )?(mime|image type)/.test(message)) return ERROR_COPY.unsupported_mime;
  if (/attachment is empty|empty attachment/.test(message)) return ERROR_COPY.empty_attachment;
  if (/filename.*not safe|invalid filename/.test(message)) return ERROR_COPY.invalid_filename;
  if (/invalid (attachment|kteam session) id/.test(message)) return ERROR_COPY.invalid_identifier;
  if (/not found|no longer available/.test(message)) return ERROR_COPY.attachment_not_found;
  if (/corrupt|manifest|escapes .*storage|content size/.test(message)) return ERROR_COPY.corrupt_attachment;
  if (/(?:^|[\\/])(?:home|tmp|var|private|attachments?)(?:[\\/]|$)/.test(message)) return ERROR_COPY.corrupt_attachment;
  if (typeof obj?.status === 'number' && obj.status >= 400 && obj.status < 500 && rawMessage) return rawMessage;
  return 'File could not be attached — try again';
}

export function attachmentFromView(sessionId: string, view: AttachmentView): StoredTranscriptAttachment {
  const textExtraction = isTextExtraction(view.textExtraction) ? view.textExtraction : undefined;
  const textExtractionFailure = isTextExtractionFailure(view.textExtractionFailure)
    ? view.textExtractionFailure
    : undefined;
  const encrypted = isAttachmentEncryption(view.encrypted) ? view.encrypted : undefined;
  return {
    kind: 'attachment',
    sessionId,
    attachmentId: view.id,
    filename: view.filename,
    mime: view.mime,
    size: view.size,
    ...(textExtraction && !textExtractionFailure ? { textExtraction } : {}),
    ...(textExtractionFailure && !textExtraction ? { textExtractionFailure } : {}),
    ...(encrypted ? { encrypted } : {}),
  };
}

export function attachmentApiPath(sessionId: string, attachmentId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Derive a content id only from this session's attachment-store shape. The
 * returned URL still targets the authenticated id endpoint; the local path is
 * never fetched or placed in src=. */
export function attachmentFromToolPath(
  sessionId: string,
  toolPath: string,
  known?: ReadonlyMap<string, StoredTranscriptImage>,
): StoredTranscriptImage | null {
  const normalized = toolPath.replaceAll('\\', '/');
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  const escapedSession = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`/(?:[^/]+/)*\\.kteam/${escapedSession}/attachments/([a-f0-9]{64})/([^/]+)$`).exec(
    normalized,
  );
  if (!match) return null;
  if (match[2] === '.' || match[2] === '..') return null;
  const attachmentId = `att_${match[1]!.toLowerCase()}`;
  const existing = known?.get(attachmentId);
  if (existing) return { ...existing, alt: toolPath };
  return {
    kind: 'attachment',
    sessionId,
    attachmentId,
    filename: match[2]!,
    alt: toolPath,
  };
}

export function formatAttachmentSize(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function sameAttachmentIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  return aa.every((id, index) => id === bb[index]);
}
