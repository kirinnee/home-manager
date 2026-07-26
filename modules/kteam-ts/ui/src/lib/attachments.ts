/** UI-side attachment contracts and validation.
 *
 * The daemon remains authoritative (it sniffs magic bytes and confines every
 * read to the content-addressed session store), but rejecting obvious mistakes
 * here keeps a bad 20 MB paste from making a pointless round trip. */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

export type AttachmentErrorCode =
  | 'invalid_identifier'
  | 'invalid_filename'
  | 'empty_attachment'
  | 'attachment_too_large'
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'attachment_not_found'
  | 'corrupt_attachment';

export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  /** Daemon-local audit metadata only. The UI must never render or fetch it. */
  path: string;
  createdAt: string;
}

export interface StoredTranscriptImage {
  kind: 'attachment';
  sessionId: string;
  attachmentId: string;
  filename: string;
  mime?: string;
  size?: number;
  /** A tool path is useful alt text, but is never used as a fetch target. */
  alt?: string;
}

export interface InlineTranscriptImage {
  kind: 'inline';
  src: string;
  alt: string;
}

export type TranscriptImage = StoredTranscriptImage | InlineTranscriptImage;

const MIME_ALIASES: Readonly<Record<string, AttachmentMime>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};

const ERROR_COPY: Record<AttachmentErrorCode, string> = {
  attachment_too_large: 'Images must be under 20 MB',
  unsupported_mime: 'Only PNG, JPEG, GIF or WebP images work',
  mime_mismatch: 'Only PNG, JPEG, GIF or WebP images work',
  empty_attachment: 'That file is empty',
  invalid_filename: "That file can't be attached",
  invalid_identifier: "That file can't be attached",
  attachment_not_found: 'Attachment is no longer available — re-add it',
  corrupt_attachment: 'Attachment is no longer available — re-add it',
};

export function attachmentErrorCopy(code: AttachmentErrorCode): string {
  return ERROR_COPY[code];
}

/** File.type is a declaration, not proof. Empty is allowed so the daemon can
 * sniff bytes from browsers that omit clipboard/file MIME metadata. */
export function validateAttachmentFile(file: Pick<File, 'size' | 'type'>): AttachmentErrorCode | null {
  if (file.size === 0) return 'empty_attachment';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'attachment_too_large';
  const declared = file.type.trim().toLowerCase();
  if (!declared) return null;
  const normalized = MIME_ALIASES[declared] ?? declared;
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(normalized) ? null : 'unsupported_mime';
}

/** The current daemon returns an error string; newer versions may also return
 * a typed code. Understand both without exposing storage paths or raw errors. */
export function attachmentErrorMessage(error: unknown): string {
  const obj =
    error && typeof error === 'object' ? (error as { code?: unknown; status?: unknown; message?: unknown }) : null;
  if (typeof obj?.code === 'string' && obj.code in ERROR_COPY) return ERROR_COPY[obj.code as AttachmentErrorCode];
  if (obj?.status === 404) return ERROR_COPY.attachment_not_found;

  const message = String(obj?.message ?? error ?? '').toLowerCase();
  if (/larger than|too large|byte limit/.test(message)) return ERROR_COPY.attachment_too_large;
  if (/declared mime.*does not match|mime mismatch/.test(message)) return ERROR_COPY.mime_mismatch;
  if (/unsupported (declared )?(mime|image type)/.test(message)) return ERROR_COPY.unsupported_mime;
  if (/attachment is empty|empty attachment/.test(message)) return ERROR_COPY.empty_attachment;
  if (/filename.*not safe|invalid filename/.test(message)) return ERROR_COPY.invalid_filename;
  if (/invalid (attachment|kteam session) id/.test(message)) return ERROR_COPY.invalid_identifier;
  if (/not found|no longer available/.test(message)) return ERROR_COPY.attachment_not_found;
  if (/corrupt|manifest|escapes .*storage|content size/.test(message)) return ERROR_COPY.corrupt_attachment;
  return 'Image could not be attached — try again';
}

export function attachmentFromView(sessionId: string, view: AttachmentView): StoredTranscriptImage {
  return {
    kind: 'attachment',
    sessionId,
    attachmentId: view.id,
    filename: view.filename,
    mime: view.mime,
    size: view.size,
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
