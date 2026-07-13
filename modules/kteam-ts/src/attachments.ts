import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';

export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface AttachmentManifest {
  version: 1;
  id: string;
  filename: string;
  mime: ImageMimeType;
  size: number;
  hash: string;
  time: string;
}

export interface StoredAttachment {
  manifest: AttachmentManifest;
  /** Verified absolute path to the content file. */
  path: string;
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
}

export type AttachmentErrorCode =
  | 'invalid_identifier'
  | 'invalid_filename'
  | 'empty_attachment'
  | 'attachment_too_large'
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'attachment_not_found'
  | 'corrupt_attachment';

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
};

const MIME_EXTENSIONS: Readonly<Record<ImageMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

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

/**
 * Turn an untrusted upload name into a short, single-component image filename.
 * The extension always comes from the detected MIME type.
 */
export function safeAttachmentFilename(filename: string, mime: ImageMimeType): string {
  const leaf = filename.replaceAll('\\', '/').split('/').at(-1)?.normalize('NFKC') ?? '';
  const lastDot = leaf.lastIndexOf('.');
  const rawStem = lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
  const stem = rawStem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);

  const safeStem = stem || 'image';
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
    isImageMimeType(item.mime) &&
    typeof item.size === 'number' &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    typeof item.hash === 'string' &&
    HASH_PATTERN.test(item.hash) &&
    item.id === `att_${item.hash}` &&
    (!expectedHash || item.hash === expectedHash) &&
    typeof item.time === 'string' &&
    !Number.isNaN(Date.parse(item.time))
  );
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

async function pause(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Durable, content-addressed storage for images belonging to kteam sessions. */
export class AttachmentStore {
  readonly rootDir: string;
  readonly maxSizeBytes: number;

  constructor(options: AttachmentStoreOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? path.join(homedir(), '.kteam'));
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  private attachmentsDir(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.rootDir, sessionId, 'attachments');
  }

  async upload(sessionId: string, input: AttachmentInput, options: UploadAttachmentOptions): Promise<StoredAttachment> {
    const attachmentsDir = this.attachmentsDir(sessionId);
    const bytes = await readBounded(input, options.maxSizeBytes ?? this.maxSizeBytes);
    const detectedMime = detectImageMime(bytes);
    if (!detectedMime) {
      throw new AttachmentError(
        'unsupported_mime',
        `unsupported image type; supported types are ${IMAGE_MIME_TYPES.join(', ')}`,
      );
    }

    if (options.mime !== undefined) {
      const declaredMime = normalizedDeclaredMime(options.mime);
      if (!isImageMimeType(declaredMime)) {
        throw new AttachmentError('unsupported_mime', `unsupported declared MIME type "${options.mime}"`);
      }
      if (declaredMime !== detectedMime) {
        throw new AttachmentError(
          'mime_mismatch',
          `declared MIME type ${declaredMime} does not match detected type ${detectedMime}`,
        );
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
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          return await this.get(sessionId, id);
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
      throw new AttachmentError('corrupt_attachment', `attachment directory for ${id} is incomplete`);
    }

    try {
      const filename = safeAttachmentFilename(options.filename, detectedMime);
      const contentPath = path.join(hashDir, filename);
      const manifest: AttachmentManifest = {
        version: 1,
        id,
        filename,
        mime: detectedMime,
        size: bytes.byteLength,
        hash,
        time: new Date().toISOString(),
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
      return { manifest, path: contentRealPath };
    } catch (error) {
      if (isMissing(error)) {
        throw new AttachmentError('corrupt_attachment', 'attachment content is missing');
      }
      throw error;
    }
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
  async buildImageReferenceBlock(sessionId: string, attachmentIds: string[]): Promise<string> {
    const attachments = await Promise.all(attachmentIds.map(id => this.get(sessionId, id)));
    return formatImageReferenceBlock(attachments);
  }
}

/** Format already-verified attachments as an unambiguous prompt suffix for tmux. */
export function formatImageReferenceBlock(attachments: readonly StoredAttachment[]): string {
  if (attachments.length === 0) return '';
  const heading = attachments.length === 1 ? 'Attached image' : 'Attached images';
  return [
    `${heading} (inspect ${attachments.length === 1 ? 'this file' : 'these files'} directly before responding):`,
    ...attachments.map(
      ({ manifest, path: imagePath }) => `- ${imagePath} (${manifest.mime}, ${manifest.size} bytes, id ${manifest.id})`,
    ),
  ].join('\n');
}
