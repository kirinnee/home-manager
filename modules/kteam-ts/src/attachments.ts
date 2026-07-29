import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import {
  DocumentExtractionError,
  extractDocxText,
  extractPdfText,
  type DocumentExtractionErrorCode,
  type ExtractedDocumentText,
  type TextExtractionMethod,
} from './document-extract';
import {
  UnlockedAttachmentCache,
  type UnlockedAttachment,
  type UnlockedAttachmentCacheOptions,
} from './attachment-unlock';
import { decryptPdfInMemory, PdfDecryptionError, type PdfDecryptionOptions } from './pdf-decrypt';

export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_INLINE_EXTRACTED_CHARACTERS = 32_000;
export const DEFAULT_MAX_TOTAL_INLINE_EXTRACTED_CHARACTERS = 64_000;

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

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

export interface TextExtractionManifest {
  method: TextExtractionMethod;
  filename: string;
  size: number;
  characters: number;
  truncated: boolean;
  totalPages?: number;
  pagesRead?: number;
}

export interface TextExtractionFailureManifest {
  code: DocumentExtractionErrorCode;
  /** Bounded, single-line reason safe to surface to both the agent and UI. */
  message: string;
}

/**
 * Recorded when the stored original cannot be opened without a password.
 *
 * This is deliberately NOT a `textExtractionFailure`: a locked file is a state
 * the human can resolve by supplying the password, so it has to stay distinct
 * from the terminal reasons (scan, corrupt, timeout, oversize) that no password
 * will ever fix.
 *
 * Only `pdf` has an unlock flow. A password-protected DOCX is an MS-OFFCRYPTO
 * package, which the PDF decryptor cannot open, so it keeps its existing
 * terminal `password_protected_document` extraction failure.
 */
export interface AttachmentEncryptionManifest {
  kind: 'pdf';
}

export interface AttachmentManifest {
  version: 1;
  id: string;
  filename: string;
  mime: AttachmentMimeType;
  size: number;
  hash: string;
  time: string;
  textExtraction?: TextExtractionManifest;
  textExtractionFailure?: TextExtractionFailureManifest;
  /** Present when the stored bytes are encrypted and can be unlocked. */
  encrypted?: AttachmentEncryptionManifest;
}

export interface StoredAttachment {
  manifest: AttachmentManifest;
  /** Verified absolute path to the content file. */
  path: string;
  /** Verified, bounded extraction retained for harness-independent delivery. */
  extractedText?: string;
  /** Verified absolute path to the retained extraction. */
  extractedTextPath?: string;
  /** True while this attachment needs a password and has not been unlocked. */
  locked?: boolean;
  /**
   * The in-RAM decrypted copy, present only after a successful unlock in this
   * daemon process. Nothing here is ever persisted: the path is on a memory
   * filesystem and the text lives in the heap.
   */
  decrypted?: UnlockedAttachment;
}

export type AttachmentInput =
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface UploadAttachmentOptions {
  filename: string;
  /** Optional caller-provided MIME type. It must match the file signature. */
  mime?: string;
  maxSizeBytes?: number;
}

export interface AttachmentStoreOptions {
  /** The kteam root. Defaults to ~/.kteam. */
  rootDir?: string;
  maxSizeBytes?: number;
  /** Injectable for deterministic tests; production uses unpdf/pdf.js. */
  pdfExtractor?: (input: Uint8Array) => Promise<ExtractedDocumentText>;
  /** Injectable for deterministic tests; production runs qpdf in a Worker. */
  pdfDecryptor?: (input: Uint8Array, password: string, options?: PdfDecryptionOptions) => Promise<Uint8Array>;
  /** Bounds and TTL for decrypted copies held in RAM. */
  unlock?: UnlockedAttachmentCacheOptions;
}

export type AttachmentErrorCode =
  | 'invalid_identifier'
  | 'invalid_filename'
  | 'empty_attachment'
  | 'attachment_too_large'
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'attachment_not_found'
  | 'corrupt_attachment'
  // Unlock-flow reasons. `wrong_password` is the retryable one: the same bytes
  // with a different password may still succeed.
  | 'wrong_password'
  | 'attachment_not_locked'
  | 'decryption_unavailable'
  | 'decryption_timeout'
  | 'decryption_failed';

/** Codes a caller can usefully retry with different input. */
export const RETRYABLE_ATTACHMENT_ERROR_CODES = new Set<AttachmentErrorCode>(['wrong_password']);

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-pdf': 'application/pdf',
  'text/x-markdown': 'text/markdown',
  'text/x-csv': 'text/csv',
};

const MIME_EXTENSIONS: Readonly<Record<AttachmentMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const GENERIC_DECLARED_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ATTACHMENT_ID_PATTERN = /^att_([a-f0-9]{64})$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new AttachmentError('invalid_identifier', `invalid kteam session id "${sessionId}"`);
  }
}

function hashFromAttachmentId(id: string): string {
  const match = ATTACHMENT_ID_PATTERN.exec(id);
  if (!match) {
    throw new AttachmentError('invalid_identifier', `invalid attachment id "${id}"`);
  }
  return match[1]!;
}

function normalizedDeclaredMime(mime: string): string {
  const bare = mime.split(';', 1)[0]!.trim().toLowerCase();
  return MIME_ALIASES[bare] ?? bare;
}

function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function isAttachmentMimeType(value: string): value is AttachmentMimeType {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}

/** Detect the supported image type from magic bytes. */
export function detectImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (bytes.length >= 6) {
    const signature = new TextDecoder().decode(bytes.subarray(0, 6));
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }

  if (bytes.length >= 12) {
    const riff = new TextDecoder().decode(bytes.subarray(0, 4));
    const webp = new TextDecoder().decode(bytes.subarray(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }

  return undefined;
}

function fileExtension(filename: string): string {
  const leaf = filename.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot >= 0 ? leaf.slice(dot) : '';
}

function utf8Text(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return undefined;
    // Binary control bytes are not text-ish. Tabs, CR/LF and form feed remain
    // valid because they are ordinary document separators.
    if (/[\u0001-\u0008\u000e-\u001f\u007f]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function isOleCompoundFile(bytes: Uint8Array): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

const OLE_MAX_REGULAR_SECTOR = 0xfffffffa;

/**
 * Enumerate the names of the Root storage's direct *stream* children
 * (objectType 2) in a Compound File Binary container, bounded and safe for
 * malformed input. A storage (1) or the root (5) that merely shares a name is
 * not MS-OFFCRYPTO evidence, and neither is an unallocated/orphan directory
 * slot that no live entry links to.
 *
 * Detection follows the real CFB structure: it reads Root Entry (directory ID
 * 0, which must be a root storage) and traverses only its red-black child tree
 * by left/right sibling links, so a name counts only when a genuine stream
 * entry is reachable from Root. Traversal is bounded by a visited set (no cycles
 * or runaway pointers) and never descends into a sub-storage's own children, so
 * only top-level streams are seen. The directory sectors are located by
 * following the FAT chain no further than the header DIFAT (first 109 entries)
 * can resolve — enough to reach the entries MS-OFFCRYPTO writes first
 * (EncryptionInfo, EncryptedPackage) even for large packages, without unbounded
 * work.
 */
function oleTopLevelStreamNames(bytes: Uint8Array): Set<string> {
  const names = new Set<string>();
  if (bytes.byteLength < 512) return names;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorShift = view.getUint16(30, true);
  // v3 uses 512-byte sectors (shift 9); v4 uses 4096-byte sectors (shift 0xC).
  if (sectorShift !== 9 && sectorShift !== 0x0c) return names;
  const sectorSize = 1 << sectorShift;
  const entriesPerFatSector = sectorSize >> 2;
  const entriesPerDirSector = sectorSize >> 7;
  const NOSTREAM = 0xffffffff;

  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;
  const fatNext = (sector: number): number => {
    const fatIndex = Math.floor(sector / entriesPerFatSector);
    // Resolve FAT sectors only through the header DIFAT (first 109 entries).
    // Anything requiring a DIFAT chain stops the walk rather than reading on.
    if (fatIndex >= 109) return 0xfffffffe;
    const fatSector = view.getUint32(76 + fatIndex * 4, true);
    if (fatSector > OLE_MAX_REGULAR_SECTOR) return 0xfffffffe;
    const entryOffset = sectorOffset(fatSector) + (sector % entriesPerFatSector) * 4;
    if (entryOffset < 0 || entryOffset + 4 > bytes.byteLength) return 0xfffffffe;
    return view.getUint32(entryOffset, true);
  };

  // Collect the ordered directory sectors so entries can be addressed by ID.
  const dirSectors: number[] = [];
  {
    let sector = view.getUint32(48, true);
    const visited = new Set<number>();
    for (let walked = 0; walked < 4096 && sector <= OLE_MAX_REGULAR_SECTOR; walked += 1) {
      if (visited.has(sector)) break;
      visited.add(sector);
      const base = sectorOffset(sector);
      if (base < 0 || base + sectorSize > bytes.byteLength) break;
      dirSectors.push(sector);
      sector = fatNext(sector);
    }
  }
  const maxEntries = dirSectors.length * entriesPerDirSector;
  if (maxEntries === 0) return names;

  const entryOffset = (id: number): number => {
    if (id < 0 || id >= maxEntries) return -1;
    const sectorIndex = Math.floor(id / entriesPerDirSector);
    return sectorOffset(dirSectors[sectorIndex]!) + (id % entriesPerDirSector) * 128;
  };
  const entryName = (offset: number): string => {
    const nameLength = view.getUint16(offset + 64, true);
    if (nameLength < 4 || nameLength > 64 || nameLength % 2 !== 0) return '';
    let name = '';
    for (let character = 0; character < nameLength / 2 - 1; character += 1) {
      const code = view.getUint16(offset + character * 2, true);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    return name;
  };

  // Root Entry is directory ID 0 and must be a root storage (objectType 5).
  const rootOffset = entryOffset(0);
  if (rootOffset < 0 || view.getUint8(rootOffset + 66) !== 5) return names;

  // Traverse Root's red-black child tree by sibling links, counting only the
  // stream entries actually reachable from Root. Orphan slots are never seen.
  const stack: number[] = [view.getUint32(rootOffset + 76, true)];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === NOSTREAM || id < 0 || id >= maxEntries || seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 4096) break;
    const offset = entryOffset(id);
    if (offset < 0) continue;
    if (view.getUint8(offset + 66) === 2) {
      const name = entryName(offset);
      if (name) names.add(name);
      if (names.size > 4096) return names;
    }
    stack.push(view.getUint32(offset + 68, true)); // left sibling
    stack.push(view.getUint32(offset + 72, true)); // right sibling
  }
  return names;
}

/**
 * Recognize a genuine OOXML encrypted package: a CFB whose directory holds both
 * the EncryptionInfo and EncryptedPackage streams (case-sensitive per
 * [MS-OFFCRYPTO] §2.3.4). An arbitrary or legacy OLE file (a real .doc, .xls or
 * .msg renamed .docx) has neither and is not treated as a password-protected
 * DOCX.
 */
function isEncryptedOoxmlPackage(bytes: Uint8Array): boolean {
  try {
    const names = oleTopLevelStreamNames(bytes);
    return names.has('EncryptionInfo') && names.has('EncryptedPackage');
  } catch {
    return false;
  }
}

function claimsDocx(options: { filename: string; mime?: string }): boolean {
  const declared = options.mime === undefined ? '' : normalizedDeclaredMime(options.mime);
  return (
    declared === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileExtension(options.filename) === '.docx'
  );
}

/** Detect a supported type from bytes, using declarations/extensions only to
 * distinguish already-verified UTF-8 text subtypes. */
export function detectAttachmentMime(
  bytes: Uint8Array,
  options: { filename: string; mime?: string },
): AttachmentMimeType | undefined {
  const image = detectImageMime(bytes);
  if (image) return image;
  if (isPdf(bytes)) return 'application/pdf';
  if (isZip(bytes)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const text = utf8Text(bytes);
  if (text === undefined) return undefined;
  const declared = options.mime === undefined ? '' : normalizedDeclaredMime(options.mime);
  const extension = fileExtension(options.filename);
  if (declared === 'application/json' || extension === '.json') {
    try {
      JSON.parse(text.replace(/^\ufeff/, ''));
      return 'application/json';
    } catch {
      return 'text/plain';
    }
  }
  if (declared === 'text/markdown' || extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (declared === 'text/csv' || extension === '.csv') return 'text/csv';
  if (declared === 'text/plain') return 'text/plain';
  return 'text/plain';
}

/**
 * Turn an untrusted upload name into a short, single-component attachment filename.
 * The extension always comes from the detected MIME type.
 */
export function safeAttachmentFilename(filename: string, mime: AttachmentMimeType): string {
  const leaf = filename.replaceAll('\\', '/').split('/').at(-1)?.normalize('NFKC') ?? '';
  const lastDot = leaf.lastIndexOf('.');
  const rawStem = lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
  const stem = rawStem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);

  const safeStem = stem || (isImageMimeType(mime) ? 'image' : 'attachment');
  const safe = `${safeStem}.${MIME_EXTENSIONS[mime]}`;
  if (safe === '.' || safe === '..' || safe.includes('/') || safe.includes('\\')) {
    throw new AttachmentError('invalid_filename', 'attachment filename is not safe');
  }
  return safe;
}

function isReadableStream(input: AttachmentInput): input is ReadableStream<Uint8Array> {
  return typeof (input as ReadableStream<Uint8Array>).getReader === 'function';
}

function isAsyncIterable(input: AttachmentInput): input is AsyncIterable<Uint8Array> {
  return typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

async function* inputChunks(input: AttachmentInput): AsyncGenerator<Uint8Array> {
  if (input instanceof Uint8Array) {
    yield input;
    return;
  }

  if (input instanceof ArrayBuffer) {
    yield new Uint8Array(input);
    return;
  }

  if (ArrayBuffer.isView(input)) {
    yield new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return;
  }

  if (input instanceof Blob) {
    yield* inputChunks(input.stream());
    return;
  }

  if (isReadableStream(input)) {
    const reader = input.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (!(value instanceof Uint8Array)) {
          throw new TypeError('attachment streams must yield Uint8Array chunks');
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (isAsyncIterable(input)) {
    for await (const value of input) {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('attachment streams must yield Uint8Array chunks');
      }
      yield value;
    }
    return;
  }

  throw new TypeError('unsupported attachment input');
}

async function readBounded(input: AttachmentInput, maxSizeBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0) {
    throw new RangeError('maxSizeBytes must be a positive safe integer');
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of inputChunks(input)) {
    size += chunk.byteLength;
    if (size > maxSizeBytes) {
      throw new AttachmentError('attachment_too_large', `attachment is larger than the ${maxSizeBytes}-byte limit`);
    }
    chunks.push(chunk);
  }

  if (size === 0) throw new AttachmentError('empty_attachment', 'attachment is empty');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isTextExtractionManifest(value: unknown): value is TextExtractionManifest {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<TextExtractionManifest>;
  return (
    (item.method === 'pdfjs' || item.method === 'docx-xml') &&
    typeof item.filename === 'string' &&
    item.filename === path.basename(item.filename) &&
    !item.filename.includes('\\') &&
    typeof item.size === 'number' &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    typeof item.characters === 'number' &&
    Number.isSafeInteger(item.characters) &&
    item.characters > 0 &&
    typeof item.truncated === 'boolean' &&
    (item.totalPages === undefined || (Number.isSafeInteger(item.totalPages) && (item.totalPages as number) > 0)) &&
    (item.pagesRead === undefined || (Number.isSafeInteger(item.pagesRead) && (item.pagesRead as number) > 0)) &&
    (item.totalPages === undefined || item.pagesRead === undefined || item.pagesRead <= item.totalPages)
  );
}

const DOCUMENT_EXTRACTION_ERROR_CODES = new Set<DocumentExtractionErrorCode>([
  'password_protected_document',
  'no_extractable_text',
  'unreadable_document',
  'document_extraction_timeout',
  'document_too_complex',
]);

// Transient/limit-shaped failures: a later upload of identical bytes that
// extracts successfully may upgrade the retained failure. Permanent failures
// (password/no-text/unreadable) reproduce for the same bytes and stay put.
const TRANSIENT_EXTRACTION_ERROR_CODES = new Set<DocumentExtractionErrorCode>([
  'document_extraction_timeout',
  'document_too_complex',
]);

const TEXT_EXTRACTION_FAILURE_FALLBACK: Readonly<Record<DocumentExtractionErrorCode, string>> = {
  password_protected_document:
    'This document needs a password to open; kteam could not read its text. Decrypt it locally and re-attach it if you want the agent to read it',
  no_extractable_text: 'document has no extractable text; it may be a scan or image-only document',
  unreadable_document: 'document could not be parsed for text extraction',
  document_extraction_timeout: 'document text extraction exceeded the processing time limit',
  document_too_complex: 'document exceeded a text-extraction complexity or size limit',
};

function extractionFailureManifest(error: DocumentExtractionError): TextExtractionFailureManifest {
  const normalized = error.message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = TEXT_EXTRACTION_FAILURE_FALLBACK[error.code];
  // safePromptPrefix slices at 500 characters and can cut mid-space, leaving a
  // trailing space. The manifest validator requires message === message.trim(),
  // so trim again after truncating or the writer would emit a manifest its own
  // reader rejects — deleting the very original this path exists to retain.
  const message = safePromptPrefix(normalized || fallback, 500).trim() || fallback;
  return { code: error.code, message };
}

function isTextExtractionFailureManifest(value: unknown): value is TextExtractionFailureManifest {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<TextExtractionFailureManifest>;
  return (
    typeof item.code === 'string' &&
    DOCUMENT_EXTRACTION_ERROR_CODES.has(item.code as DocumentExtractionErrorCode) &&
    typeof item.message === 'string' &&
    item.message.length > 0 &&
    item.message.length <= 500 &&
    item.message === item.message.trim() &&
    !/[\u0000-\u001f\u007f]/.test(item.message)
  );
}

function isAttachmentEncryptionManifest(value: unknown): value is AttachmentEncryptionManifest {
  return typeof value === 'object' && value !== null && (value as AttachmentEncryptionManifest).kind === 'pdf';
}

function isManifest(value: unknown, expectedHash?: string): value is AttachmentManifest {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<AttachmentManifest>;
  return (
    item.version === 1 &&
    typeof item.id === 'string' &&
    ATTACHMENT_ID_PATTERN.test(item.id) &&
    typeof item.filename === 'string' &&
    item.filename === path.basename(item.filename) &&
    !item.filename.includes('\\') &&
    typeof item.mime === 'string' &&
    isAttachmentMimeType(item.mime) &&
    typeof item.size === 'number' &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    typeof item.hash === 'string' &&
    HASH_PATTERN.test(item.hash) &&
    item.id === `att_${item.hash}` &&
    (!expectedHash || item.hash === expectedHash) &&
    typeof item.time === 'string' &&
    !Number.isNaN(Date.parse(item.time)) &&
    (item.textExtraction === undefined || isTextExtractionManifest(item.textExtraction)) &&
    (item.textExtractionFailure === undefined || isTextExtractionFailureManifest(item.textExtractionFailure)) &&
    !(item.textExtraction !== undefined && item.textExtractionFailure !== undefined) &&
    (item.encrypted === undefined || isAttachmentEncryptionManifest(item.encrypted)) &&
    // Encrypted bytes cannot have yielded text, and a successful extraction
    // proves they were never locked. A manifest claiming both is corrupt.
    !(item.encrypted !== undefined && item.textExtraction !== undefined) &&
    (item.encrypted === undefined || item.mime === 'application/pdf')
  );
}

/**
 * Whether this attachment needs a password before its content can be read.
 *
 * Manifests written before the unlock flow existed recorded an encrypted PDF as
 * a terminal `password_protected_document` extraction failure. Reading that
 * shape as "locked" upgrades those uploads in place, with no migration and no
 * rewrite of bytes that are content-addressed by hash.
 */
export function isLockedAttachment(manifest: AttachmentManifest): boolean {
  if (manifest.encrypted?.kind === 'pdf') return true;
  return manifest.mime === 'application/pdf' && manifest.textExtractionFailure?.code === 'password_protected_document';
}

async function readManifest(manifestPath: string, expectedHash: string): Promise<AttachmentManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new AttachmentError(
      'corrupt_attachment',
      `could not read attachment manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isManifest(parsed, expectedHash)) {
    throw new AttachmentError('corrupt_attachment', 'attachment manifest is invalid');
  }
  return parsed;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

const DECRYPTION_ERROR_CODES: Readonly<Record<PdfDecryptionError['code'], AttachmentErrorCode>> = {
  wrong_password: 'wrong_password',
  unreadable_document: 'decryption_failed',
  decryption_timeout: 'decryption_timeout',
  decrypted_document_too_large: 'attachment_too_large',
};

async function pause(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Durable, content-addressed storage for attachments belonging to kteam sessions. */
export class AttachmentStore {
  readonly rootDir: string;
  readonly maxSizeBytes: number;
  /** Decrypted copies, in RAM only, for the lifetime of this daemon process. */
  readonly unlocked: UnlockedAttachmentCache;
  private readonly pdfExtractor: (input: Uint8Array) => Promise<ExtractedDocumentText>;
  private readonly pdfDecryptor: (
    input: Uint8Array,
    password: string,
    options?: PdfDecryptionOptions,
  ) => Promise<Uint8Array>;

  constructor(options: AttachmentStoreOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? path.join(homedir(), '.kteam'));
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.pdfExtractor = options.pdfExtractor ?? extractPdfText;
    this.pdfDecryptor = options.pdfDecryptor ?? decryptPdfInMemory;
    this.unlocked = new UnlockedAttachmentCache(options.unlock ?? {});
  }

  private attachmentsDir(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.rootDir, sessionId, 'attachments');
  }

  async upload(sessionId: string, input: AttachmentInput, options: UploadAttachmentOptions): Promise<StoredAttachment> {
    const attachmentsDir = this.attachmentsDir(sessionId);
    const bytes = await readBounded(input, options.maxSizeBytes ?? this.maxSizeBytes);
    // Password-protected OOXML is wrapped in an OLE compound-file container
    // instead of the ZIP container used by readable DOCX files. Only treat a
    // DOCX-claiming OLE file as encrypted when its CFB directory actually holds
    // the MS-OFFCRYPTO EncryptionInfo/EncryptedPackage streams. An arbitrary or
    // legacy OLE (a real .doc/.xls/.msg renamed .docx) has neither, so it never
    // enters the DOCX path and falls through to the unsupported-type error.
    const encryptedDocx = isOleCompoundFile(bytes) && claimsDocx(options) && isEncryptedOoxmlPackage(bytes);
    const detectedMime: AttachmentMimeType | null = encryptedDocx
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : (detectAttachmentMime(bytes, options) ?? null);
    if (!detectedMime) {
      throw new AttachmentError(
        'unsupported_mime',
        `unsupported file type; supported types are ${ATTACHMENT_MIME_TYPES.join(', ')}`,
      );
    }

    if (options.mime !== undefined) {
      const declaredMime = normalizedDeclaredMime(options.mime);
      const genericZipForDocx =
        declaredMime === 'application/zip' &&
        detectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (GENERIC_DECLARED_MIME_TYPES.has(declaredMime) || genericZipForDocx) {
        // Generic browser metadata is not evidence. The detected bytes decide.
      } else if (!isAttachmentMimeType(declaredMime)) {
        throw new AttachmentError('unsupported_mime', `unsupported declared MIME type "${options.mime}"`);
      } else if (declaredMime !== detectedMime) {
        throw new AttachmentError(
          'mime_mismatch',
          `declared MIME type ${declaredMime} does not match detected type ${detectedMime}`,
        );
      }
    }

    let extraction: ExtractedDocumentText | undefined;
    let textExtractionFailure: TextExtractionFailureManifest | undefined = encryptedDocx
      ? {
          code: 'password_protected_document',
          message:
            'This DOCX needs a password to open; kteam could not read its text. Decrypt it locally and re-attach it if you want the agent to read it',
        }
      : undefined;
    let encrypted: AttachmentEncryptionManifest | undefined;
    if (!textExtractionFailure) {
      try {
        if (detectedMime === 'application/pdf') extraction = await this.pdfExtractor(bytes);
        else if (detectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          extraction = extractDocxText(bytes);
        }
      } catch (error) {
        if (!(error instanceof DocumentExtractionError)) throw error;
        // A PDF that refuses to open without a user password is LOCKED, not
        // failed: the human can supply the password and get its text. Every
        // other reason — and every locked DOCX, which qpdf cannot open — keeps
        // its terminal named failure exactly as before.
        //
        // Verified in document-extract.test.ts: a permissions-only/owner-password
        // PDF opens with the empty user password and takes the success branch, so
        // it never reaches here and is never shown as locked.
        if (detectedMime === 'application/pdf' && error.code === 'password_protected_document') {
          encrypted = { kind: 'pdf' };
        } else textExtractionFailure = extractionFailureManifest(error);
      }
    }

    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = `att_${hash}`;
    const hashDir = path.join(attachmentsDir, hash);
    const manifestPath = path.join(hashDir, 'manifest.json');

    await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });

    let ownsHashDir = false;
    try {
      await mkdir(hashDir, { mode: 0o700 });
      ownsHashDir = true;
    } catch (error) {
      if (!isExists(error)) throw error;
    }

    if (!ownsHashDir) {
      // A concurrent writer may own the directory. Wait briefly for its atomic
      // manifest publication, then treat it as the canonical duplicate.
      let stored: StoredAttachment | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          stored = await this.get(sessionId, id);
          break;
        } catch (error) {
          if (
            !(error instanceof AttachmentError) ||
            (error.code !== 'attachment_not_found' && error.code !== 'corrupt_attachment')
          ) {
            throw error;
          }
          await pause(20);
        }
      }
      if (!stored) {
        throw new AttachmentError('corrupt_attachment', `attachment directory for ${id} is incomplete`);
      }
      // Content-addressed dedupe must not make a transient failure permanent:
      // if the stored copy retained a transient extraction failure and this
      // upload of the identical bytes extracted successfully, upgrade it in
      // place. Never downgrade a success and never touch a permanent failure.
      if (
        extraction &&
        !stored.manifest.textExtraction &&
        stored.manifest.textExtractionFailure &&
        TRANSIENT_EXTRACTION_ERROR_CODES.has(stored.manifest.textExtractionFailure.code)
      ) {
        return await this.upgradeTransientExtractionFailure(sessionId, hashDir, stored, extraction);
      }
      return stored;
    }

    try {
      const filename = safeAttachmentFilename(options.filename, detectedMime);
      const contentPath = path.join(hashDir, filename);
      let textExtraction: TextExtractionManifest | undefined;
      if (extraction) {
        const stem = filename.slice(0, filename.lastIndexOf('.')) || 'attachment';
        const extractedFilename = `${stem}.extracted.txt`;
        const extractedBytes = new TextEncoder().encode(extraction.text);
        await writeFile(path.join(hashDir, extractedFilename), extractedBytes, { flag: 'wx', mode: 0o600 });
        textExtraction = {
          method: extraction.method,
          filename: extractedFilename,
          size: extractedBytes.byteLength,
          characters: extraction.characters,
          truncated: extraction.truncated,
          ...(extraction.totalPages === undefined ? {} : { totalPages: extraction.totalPages }),
          ...(extraction.pagesRead === undefined ? {} : { pagesRead: extraction.pagesRead }),
        };
      }
      const manifest: AttachmentManifest = {
        version: 1,
        id,
        filename,
        mime: detectedMime,
        size: bytes.byteLength,
        hash,
        time: new Date().toISOString(),
        ...(textExtraction ? { textExtraction } : {}),
        ...(textExtractionFailure ? { textExtractionFailure } : {}),
        ...(encrypted ? { encrypted } : {}),
      };

      await writeFile(contentPath, bytes, { flag: 'wx', mode: 0o600 });
      const temporaryManifest = path.join(hashDir, `.manifest-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporaryManifest, manifestPath);
      // Resolve through get() so first uploads and deduplicated uploads return
      // the same canonical, verified path (notably across macOS /var symlinks).
      return await this.get(sessionId, id);
    } catch (error) {
      await rm(hashDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Replace a retained transient extraction failure with a successful
   * extraction of the same original bytes. Original bytes, name, id, hash,
   * mime and time are preserved; only the extraction is added and the failure
   * removed. Publication is crash- and concurrency-safe: the extracted text
   * lands at a content-addressed final name before the manifest is atomically
   * replaced. Concurrent upgrades can therefore never leave one writer's
   * manifest describing another writer's extracted bytes.
   */
  private async upgradeTransientExtractionFailure(
    sessionId: string,
    hashDir: string,
    stored: StoredAttachment,
    extraction: ExtractedDocumentText,
  ): Promise<StoredAttachment> {
    const { manifest } = stored;
    const stem = manifest.filename.slice(0, manifest.filename.lastIndexOf('.')) || 'attachment';
    const extractedBytes = new TextEncoder().encode(extraction.text);
    const extractedHash = createHash('sha256').update(extractedBytes).digest('hex');
    const extractedFilename = `${stem}.extracted-${extractedHash}.txt`;
    const temporaryExtracted = path.join(hashDir, `.extracted-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporaryExtracted, extractedBytes, { flag: 'wx', mode: 0o600 });
    await rename(temporaryExtracted, path.join(hashDir, extractedFilename));

    const upgraded: AttachmentManifest = {
      version: 1,
      id: manifest.id,
      filename: manifest.filename,
      mime: manifest.mime,
      size: manifest.size,
      hash: manifest.hash,
      time: manifest.time,
      textExtraction: {
        method: extraction.method,
        filename: extractedFilename,
        size: extractedBytes.byteLength,
        characters: extraction.characters,
        truncated: extraction.truncated,
        ...(extraction.totalPages === undefined ? {} : { totalPages: extraction.totalPages }),
        ...(extraction.pagesRead === undefined ? {} : { pagesRead: extraction.pagesRead }),
      },
    };
    const temporaryManifest = path.join(hashDir, `.manifest-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporaryManifest, `${JSON.stringify(upgraded, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporaryManifest, path.join(hashDir, 'manifest.json'));
    return await this.get(sessionId, manifest.id);
  }

  async get(sessionId: string, attachmentId: string): Promise<StoredAttachment> {
    const attachmentsDir = this.attachmentsDir(sessionId);
    const hash = hashFromAttachmentId(attachmentId);
    const hashDir = path.join(attachmentsDir, hash);
    const manifestPath = path.join(hashDir, 'manifest.json');

    let attachmentsRealPath: string;
    let directoryRealPath: string;
    let manifestRealPath: string;
    try {
      const [resolvedAttachments, resolvedDirectory, resolvedManifest, manifestMetadata] = await Promise.all([
        realpath(attachmentsDir),
        realpath(hashDir),
        realpath(manifestPath),
        lstat(manifestPath),
      ]);
      if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
        throw new AttachmentError('corrupt_attachment', 'attachment manifest is not a regular file');
      }
      if (!resolvedDirectory.startsWith(`${resolvedAttachments}${path.sep}`)) {
        throw new AttachmentError('corrupt_attachment', 'attachment directory escapes session storage');
      }
      if (!resolvedManifest.startsWith(`${resolvedDirectory}${path.sep}`)) {
        throw new AttachmentError('corrupt_attachment', 'attachment manifest escapes its storage directory');
      }
      attachmentsRealPath = resolvedAttachments;
      directoryRealPath = resolvedDirectory;
      manifestRealPath = resolvedManifest;
    } catch (error) {
      if (isMissing(error)) {
        throw new AttachmentError('attachment_not_found', `attachment ${attachmentId} was not found`);
      }
      throw error;
    }

    const manifest = await readManifest(manifestRealPath, hash);
    const contentPath = path.join(hashDir, manifest.filename);
    try {
      const [contentRealPath, metadata] = await Promise.all([realpath(contentPath), lstat(contentPath)]);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new AttachmentError('corrupt_attachment', 'attachment content is not a regular file');
      }
      const prefix = `${directoryRealPath}${path.sep}`;
      if (!contentRealPath.startsWith(prefix)) {
        throw new AttachmentError('corrupt_attachment', 'attachment content escapes its storage directory');
      }
      if (!directoryRealPath.startsWith(`${attachmentsRealPath}${path.sep}`)) {
        throw new AttachmentError('corrupt_attachment', 'attachment directory escapes session storage');
      }
      if (metadata.size !== manifest.size) {
        throw new AttachmentError('corrupt_attachment', 'attachment content size does not match its manifest');
      }
      if (!manifest.textExtraction) {
        return this.withUnlockState(sessionId, { manifest, path: contentRealPath });
      }

      const extractedPath = path.join(hashDir, manifest.textExtraction.filename);
      const [extractedRealPath, extractedMetadata] = await Promise.all([realpath(extractedPath), lstat(extractedPath)]);
      if (!extractedMetadata.isFile() || extractedMetadata.isSymbolicLink()) {
        throw new AttachmentError('corrupt_attachment', 'attachment text extraction is not a regular file');
      }
      if (!extractedRealPath.startsWith(prefix)) {
        throw new AttachmentError('corrupt_attachment', 'attachment text extraction escapes its storage directory');
      }
      if (extractedMetadata.size !== manifest.textExtraction.size) {
        throw new AttachmentError('corrupt_attachment', 'attachment text extraction size does not match its manifest');
      }
      const extractedText = await readFile(extractedRealPath, 'utf8');
      if (extractedText.length !== manifest.textExtraction.characters) {
        throw new AttachmentError(
          'corrupt_attachment',
          'attachment text extraction character count does not match its manifest',
        );
      }
      return this.withUnlockState(sessionId, {
        manifest,
        path: contentRealPath,
        extractedText,
        extractedTextPath: extractedRealPath,
      });
    } catch (error) {
      if (isMissing(error)) {
        throw new AttachmentError('corrupt_attachment', 'attachment content is missing');
      }
      throw error;
    }
  }

  /**
   * Overlay the process-local unlock state onto a stored attachment.
   *
   * Nothing here reads or writes durable storage: `locked` is derived from the
   * manifest and `decrypted` comes from the in-RAM cache, so a restarted daemon
   * correctly reports the attachment as locked again.
   */
  private withUnlockState(sessionId: string, stored: StoredAttachment): StoredAttachment {
    if (!isLockedAttachment(stored.manifest)) return stored;
    const decrypted = this.unlocked.get(sessionId, stored.manifest.id);
    return decrypted ? { ...stored, locked: false, decrypted } : { ...stored, locked: true };
  }

  /**
   * Decrypt a locked attachment with the human's password and publish the plain
   * bytes at a RAM-backed path the agent can open.
   *
   * The decrypted copy is never written to disk and never enters the
   * content-addressed store: the original stays exactly as uploaded, and the
   * plaintext lives on tmpfs plus this process's heap until it is released,
   * evicted, or expires. Text extraction runs against the decrypted bytes and is
   * kept in memory for the same lifetime — deliberately NOT through the durable
   * extraction writer, which would put the document's text on disk.
   */
  async unlock(sessionId: string, attachmentId: string, password: string): Promise<StoredAttachment> {
    assertSessionId(sessionId);
    if (typeof password !== 'string' || password.length === 0) {
      throw new AttachmentError('wrong_password', 'a password is required to unlock this attachment');
    }
    const stored = await this.get(sessionId, attachmentId);
    if (!isLockedAttachment(stored.manifest)) {
      throw new AttachmentError('attachment_not_locked', 'this attachment is not encrypted; no password is needed');
    }
    if (!this.unlocked.available) {
      throw new AttachmentError(
        'decryption_unavailable',
        'this host has no memory-backed filesystem, so a decrypted copy cannot be given to the agent without writing it to disk',
      );
    }

    const original = await readFile(stored.path);
    let plain: Uint8Array;
    try {
      plain = await this.pdfDecryptor(original, password);
    } catch (error) {
      if (!(error instanceof PdfDecryptionError)) throw error;
      throw new AttachmentError(DECRYPTION_ERROR_CODES[error.code], error.message);
    }

    let extraction: ExtractedDocumentText | undefined;
    let extractionFailure: TextExtractionFailureManifest | undefined;
    try {
      extraction = await this.pdfExtractor(plain);
    } catch (error) {
      if (error instanceof DocumentExtractionError) extractionFailure = extractionFailureManifest(error);
      else throw error;
    }

    try {
      await this.unlocked.set(sessionId, attachmentId, {
        bytes: plain,
        filename: stored.manifest.filename,
        ...(extraction
          ? {
              extraction: {
                method: extraction.method,
                characters: extraction.characters,
                truncated: extraction.truncated,
                ...(extraction.totalPages === undefined ? {} : { totalPages: extraction.totalPages }),
                ...(extraction.pagesRead === undefined ? {} : { pagesRead: extraction.pagesRead }),
              },
              text: extraction.text,
            }
          : {}),
        ...(extractionFailure ? { extractionFailure } : {}),
      });
    } catch (error) {
      if (error instanceof RangeError) throw new AttachmentError('attachment_too_large', error.message);
      throw error;
    } finally {
      // The RAM-backed file now owns the plaintext; drop our heap copy.
      plain.fill(0);
    }
    return await this.get(sessionId, attachmentId);
  }

  /** Forget a decrypted copy: zero its pages, remove it, and report locked again. */
  async lock(sessionId: string, attachmentId: string): Promise<StoredAttachment> {
    assertSessionId(sessionId);
    const stored = await this.get(sessionId, attachmentId);
    await this.unlocked.release(sessionId, stored.manifest.id);
    return await this.get(sessionId, attachmentId);
  }

  /** Release every decrypted copy belonging to a session (close/remove paths). */
  async releaseSession(sessionId: string): Promise<void> {
    await this.unlocked.releaseSession(sessionId);
  }

  /** Release every decrypted copy this store holds. Call on daemon shutdown. */
  async dispose(): Promise<void> {
    await this.unlocked.dispose();
  }

  async list(sessionId: string): Promise<StoredAttachment[]> {
    const attachmentsDir = this.attachmentsDir(sessionId);
    let entries;
    try {
      entries = await readdir(attachmentsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const attachments: StoredAttachment[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !HASH_PATTERN.test(entry.name)) continue;
      attachments.push(await this.get(sessionId, `att_${entry.name}`));
    }
    return attachments.sort((left, right) => left.manifest.time.localeCompare(right.manifest.time));
  }

  /** Resolve IDs safely and build the text injected into an interactive TUI. */
  async buildAttachmentReferenceBlock(sessionId: string, attachmentIds: string[]): Promise<string> {
    const attachments = await Promise.all(attachmentIds.map(id => this.get(sessionId, id)));
    return formatAttachmentReferenceBlock(attachments);
  }

  /** Compatibility delegator retained for SessionManager fixtures and older callers. */
  async buildImageReferenceBlock(sessionId: string, attachmentIds: string[]): Promise<string> {
    return this.buildAttachmentReferenceBlock(sessionId, attachmentIds);
  }
}

/** Format already-verified attachments as an unambiguous prompt suffix for tmux. */
export function formatAttachmentReferenceBlock(attachments: readonly StoredAttachment[]): string {
  if (attachments.length === 0) return '';
  const heading = attachments.length === 1 ? 'Attached file' : 'Attached files';
  const extractedCount = attachments.filter(item => item.manifest.textExtraction || item.decrypted?.extraction).length;
  const perExtractionBudget =
    extractedCount === 0
      ? 0
      : Math.min(
          DEFAULT_MAX_INLINE_EXTRACTED_CHARACTERS,
          Math.floor(DEFAULT_MAX_TOTAL_INLINE_EXTRACTED_CHARACTERS / extractedCount),
        );
  const lines = [
    `${heading} (inspect ${attachments.length === 1 ? 'this file' : 'these files'} directly before responding):`,
  ];

  for (const attachment of attachments) {
    const { manifest, decrypted } = attachment;
    if (decrypted) {
      // The agent gets the DECRYPTED path, because a path it cannot open is the
      // same as no attachment at all. The line still states plainly what that
      // path is, so nothing here reads as an ordinary stored file.
      lines.push(`- ${decrypted.path} (${manifest.mime}, ${decrypted.size} bytes, id ${manifest.id})`);
      lines.push(
        `  Encrypted PDF unlocked in kteam with a password the human supplied. The path above is a temporary copy on a memory filesystem (RAM, never written to disk) that expires at ${decrypted.expiresAt}; read it now rather than later. The stored original at ${attachment.path} is still encrypted.`,
      );
      if (decrypted.extractionFailure) {
        lines.push(
          `  Text extraction failed in kteam (${decrypted.extractionFailure.code}): ${trimTerminator(decrypted.extractionFailure.message)}. The decrypted PDF itself is readable at the path above; do not assume its text was read.`,
        );
        continue;
      }
      if (!decrypted.extraction || decrypted.text === undefined) continue;
      lines.push(...extractionLines(manifest.id, decrypted.extraction, decrypted.text, perExtractionBudget, undefined));
      continue;
    }
    lines.push(`- ${attachment.path} (${manifest.mime}, ${manifest.size} bytes, id ${manifest.id})`);
    if (attachment.locked) {
      lines.push(
        `  This PDF is encrypted and still locked in kteam (encrypted_pdf_locked): no password has been supplied, so its text was not read and the file at the path above cannot be opened without one. Ask the human to unlock it in kteam if you need its contents.`,
      );
      continue;
    }
    const extractionFailure = manifest.textExtractionFailure;
    if (extractionFailure) {
      // Strip a trailing sentence terminator before re-appending our own, but
      // never let the reason collapse to empty: a message that is entirely
      // trailing punctuation would otherwise yield a line the UI parser cannot
      // match, which makes it fall back to showing the raw reference block
      // (storage path included). Keep the original message in that case.
      lines.push(
        `  Text extraction failed in kteam (${extractionFailure.code}): ${trimTerminator(extractionFailure.message)}. The original file remains available at the path above; do not assume its text was read.`,
      );
      continue;
    }
    const extraction = manifest.textExtraction;
    if (!extraction || attachment.extractedText === undefined || attachment.extractedTextPath === undefined) continue;
    lines.push(
      ...extractionLines(
        manifest.id,
        extraction,
        attachment.extractedText,
        perExtractionBudget,
        attachment.extractedTextPath,
      ),
    );
  }
  return lines.join('\n');
}

/** Strip a trailing sentence terminator before our own is appended, but never
 * let the reason collapse to empty: a message that is entirely trailing
 * punctuation would yield a line the UI parser cannot match, which makes it fall
 * back to showing the raw reference block (storage path included). */
function trimTerminator(message: string): string {
  return message.replace(/[.!?]+$/, '') || message;
}

interface ExtractionSummary {
  method: TextExtractionMethod;
  characters: number;
  truncated: boolean;
  totalPages?: number;
  pagesRead?: number;
}

/**
 * The extracted-text stanza, shared by the durable and the RAM-only paths.
 *
 * `retainedPath` is omitted for a decrypted attachment: its text was never
 * written anywhere, so pointing the agent at a file would be a lie. The stanza
 * says exactly as much as is true in each case.
 */
function extractionLines(
  attachmentId: string,
  extraction: ExtractionSummary,
  text: string,
  budget: number,
  retainedPath: string | undefined,
): string[] {
  const excerpt = safePromptPrefix(text, budget);
  const promptTruncated = excerpt.length < text.length;
  const pageDetails =
    extraction.totalPages === undefined
      ? ''
      : extraction.pagesRead === extraction.totalPages
        ? `${extraction.totalPages} page${extraction.totalPages === 1 ? '' : 's'}; `
        : `${extraction.pagesRead ?? 0} of ${extraction.totalPages} pages; `;
  const retained = extraction.truncated
    ? `retained first ${extraction.characters} characters; source extraction truncated; `
    : `retained ${extraction.characters} characters; `;
  const prompt = promptTruncated
    ? `prompt excerpt ${excerpt.length} of ${extraction.characters} retained characters; `
    : `prompt includes all ${excerpt.length} retained characters; `;
  const omissions =
    extraction.method === 'pdfjs'
      ? 'layout, images, and scanned content are not included'
      : 'formatting, images, and other non-text document content are not included';
  return [
    `  Text extracted by kteam (${extraction.method === 'pdfjs' ? 'pdf.js' : 'DOCX XML'}; ${pageDetails}${retained}${prompt}${omissions}).`,
    ...(retainedPath === undefined
      ? ['  This extraction is held in memory only and was never written to disk.']
      : [`  Full retained extraction: ${retainedPath}`]),
    `  ----- BEGIN KTEAM EXTRACTED TEXT ${attachmentId} -----`,
    excerpt,
    `  ----- END KTEAM EXTRACTED TEXT ${attachmentId} -----`,
  ];
}

function safePromptPrefix(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  let end = maxCharacters;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Compatibility export for callers/tests that used the image-era name. */
export function formatImageReferenceBlock(attachments: readonly StoredAttachment[]): string {
  return formatAttachmentReferenceBlock(attachments);
}
