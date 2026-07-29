import { inflateRawSync } from 'node:zlib';

export const DEFAULT_MAX_EXTRACTED_CHARACTERS = 250_000;
export const DEFAULT_MAX_PDF_PAGES = 100;
export const DEFAULT_PDF_EXTRACTION_TIMEOUT_MS = 15_000;

const MAX_DOCX_CONTENT_TYPES_BYTES = 1024 * 1024;
const MAX_DOCX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const DOCX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

export type TextExtractionMethod = 'pdfjs' | 'docx-xml';

export interface ExtractedDocumentText {
  method: TextExtractionMethod;
  text: string;
  characters: number;
  truncated: boolean;
  totalPages?: number;
  pagesRead?: number;
}

export type DocumentExtractionErrorCode =
  | 'password_protected_document'
  | 'no_extractable_text'
  | 'unreadable_document'
  | 'document_extraction_timeout'
  | 'document_too_complex';

export class DocumentExtractionError extends Error {
  readonly code: DocumentExtractionErrorCode;

  constructor(code: DocumentExtractionErrorCode, message: string) {
    super(message);
    this.name = 'DocumentExtractionError';
    this.code = code;
  }
}

export interface PdfExtractionOptions {
  maxCharacters?: number;
  maxPages?: number;
  timeoutMs?: number;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function safePrefix(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  let end = maxCharacters;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractionResult(
  method: TextExtractionMethod,
  rawText: string,
  maxCharacters: number,
  metadata: { truncated?: boolean; totalPages?: number; pagesRead?: number } = {},
): ExtractedDocumentText {
  const normalized = normalizeExtractedText(rawText);
  const text = safePrefix(normalized, maxCharacters);
  return {
    method,
    text,
    characters: text.length,
    truncated: metadata.truncated === true || text.length < normalized.length,
    ...(metadata.totalPages === undefined ? {} : { totalPages: metadata.totalPages }),
    ...(metadata.pagesRead === undefined ? {} : { pagesRead: metadata.pagesRead }),
  };
}

function pdfFailure(error: unknown): DocumentExtractionError {
  if (error instanceof DocumentExtractionError) return error;
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error ?? '');
  if (name === 'PasswordException' || /password|encrypted/i.test(message)) {
    return new DocumentExtractionError(
      'password_protected_document',
      'PDF is password-protected; kteam could not extract text',
    );
  }
  return new DocumentExtractionError('unreadable_document', 'file is not a readable PDF');
}

/**
 * Extract bounded text from untrusted PDF bytes with the serverless pdf.js build
 * bundled by unpdf. The parser receives bytes, never a URL; scripting/eval,
 * streaming, auto-fetch and font rendering are disabled. A single deadline
 * destroys the loading task, including work already processing a page.
 */
export async function extractPdfText(
  input: Uint8Array,
  options: PdfExtractionOptions = {},
): Promise<ExtractedDocumentText> {
  const maxCharacters = positiveLimit(options.maxCharacters, DEFAULT_MAX_EXTRACTED_CHARACTERS, 'maxCharacters');
  const maxPages = positiveLimit(options.maxPages, DEFAULT_MAX_PDF_PAGES, 'maxPages');
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_PDF_EXTRACTION_TIMEOUT_MS, 'timeoutMs');
  // Use unpdf's serverless pdf.js core directly, not its broad helper entrypoint:
  // the latter's declarations reference optional native canvas rendering even
  // though text extraction never loads it. pdf.js 6 removed the old
  // `isEvalSupported` option along with its dynamic-JS PostScript fast path; this
  // pinned serverless bundle has no eval/new-Function path. We call only
  // getTextContent below — never annotations, links, scripting or rendering.
  const pdfjs = await import('unpdf/pdfjs');
  const loadingTask = pdfjs.getDocument({
    data: input.slice(),
    disableAutoFetch: true,
    disableFontFace: true,
    disableStream: true,
    enableXfa: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 0,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  });

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void loadingTask.destroy();
      reject(
        new DocumentExtractionError(
          'document_extraction_timeout',
          `PDF text extraction exceeded the ${timeoutMs}-millisecond limit`,
        ),
      );
    }, timeoutMs);
  });

  const work = async (): Promise<ExtractedDocumentText> => {
    const document = await loadingTask.promise;
    const totalPages = document.numPages;
    const pageLimit = Math.min(totalPages, maxPages);
    const pages: string[] = [];
    let pagesRead = 0;
    let characters = 0;
    let characterLimitReached = false;

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item =>
          typeof item === 'object' && item !== null && 'str' in item && typeof item.str === 'string'
            ? `${item.str}${'hasEOL' in item && item.hasEOL === true ? '\n' : ''}`
            : '',
        )
        .join('');
      const separator = pages.length === 0 ? '' : '\n';
      const remaining = maxCharacters - characters;
      if (remaining <= separator.length) {
        characterLimitReached = true;
        break;
      }
      const availableForPage = remaining - separator.length;
      const included = safePrefix(pageText, availableForPage);
      pages.push(`${separator}${included}`);
      characters += separator.length + included.length;
      pagesRead = pageNumber;
      if (included.length < pageText.length) {
        characterLimitReached = true;
        break;
      }
    }

    const result = extractionResult('pdfjs', pages.join(''), maxCharacters, {
      totalPages,
      pagesRead,
      truncated: characterLimitReached || pagesRead < totalPages,
    });
    if (!result.text) {
      throw new DocumentExtractionError(
        'no_extractable_text',
        `PDF has no extractable text in the first ${pagesRead || pageLimit} page${pagesRead === 1 ? '' : 's'}; it looks like a scan or image-only PDF`,
      );
    }
    return result;
  };

  try {
    return await Promise.race([work(), deadline]);
  } catch (error) {
    if (timedOut && !(error instanceof DocumentExtractionError)) {
      throw new DocumentExtractionError(
        'document_extraction_timeout',
        `PDF text extraction exceeded the ${timeoutMs}-millisecond limit`,
      );
    }
    throw pdfFailure(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    await loadingTask.destroy().catch(() => undefined);
  }
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error('truncated ZIP field');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('truncated ZIP field');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const first = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (readU32(bytes, offset) !== 0x06054b50) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw new Error('ZIP central directory is missing');
}

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const end = findEndOfCentralDirectory(bytes);
  if (readU16(bytes, end + 4) !== 0 || readU16(bytes, end + 6) !== 0) {
    throw new Error('multi-disk ZIP files are not supported');
  }
  const entriesOnDisk = readU16(bytes, end + 8);
  const entryCount = readU16(bytes, end + 10);
  const centralSize = readU32(bytes, end + 12);
  const centralOffset = readU32(bytes, end + 16);
  if (entriesOnDisk !== entryCount || entryCount > 10_000) throw new Error('invalid ZIP entry count');
  if (centralOffset + centralSize > end) throw new Error('ZIP central directory is out of bounds');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new Error('invalid ZIP central header');
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const crc = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error('ZIP64 DOCX files are not supported');
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > centralOffset + centralSize) {
      throw new Error('ZIP entry is out of bounds');
    }
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd)).replaceAll('\\', '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error('unsafe ZIP entry name');
    entries.set(name, { name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP central directory size does not match');
  return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function unzipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Uint8Array {
  if ((entry.flags & 1) !== 0) {
    throw new DocumentExtractionError(
      'password_protected_document',
      'DOCX is password-protected; kteam could not extract text',
    );
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new DocumentExtractionError(
      'document_too_complex',
      `DOCX ${entry.name} is larger than the ${maxBytes}-byte extraction limit`,
    );
  }
  if (readU32(bytes, entry.localOffset) !== 0x04034b50) throw new Error('invalid ZIP local header');
  const nameLength = readU16(bytes, entry.localOffset + 26);
  const extraLength = readU16(bytes, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new Error('ZIP entry data is out of bounds');
  const compressed = bytes.subarray(start, end);
  let output: Uint8Array;
  if (entry.method === 0) output = compressed.slice();
  else if (entry.method === 8) {
    output = new Uint8Array(inflateRawSync(compressed, { maxOutputLength: maxBytes }));
  } else throw new Error(`unsupported ZIP compression method ${entry.method}`);
  if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc) {
    throw new Error('ZIP entry checksum or size does not match');
  }
  return output;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, entity => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
    const decimal = /^&#(\d+);$/.exec(entity);
    const codePoint = Number.parseInt(hex?.[1] ?? decimal?.[1] ?? '', hex ? 16 : 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : '';
  });
}

function wordDocumentText(xml: string): string {
  const parts: string[] = [];
  const tokens = /<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>|<w:tab\b[^>]*\/\s*>|<w:(?:br|cr)\b[^>]*\/\s*>|<\/w:p\s*>/gi;
  for (const token of xml.matchAll(tokens)) {
    if (token[1] !== undefined) parts.push(decodeXmlEntities(token[1]));
    else if (/^<w:tab/i.test(token[0])) parts.push('\t');
    else parts.push('\n');
  }
  return parts.join('');
}

function hasDocxMainContentType(xml: string): boolean {
  const overrides = xml.match(/<(?:[A-Za-z_][\w.-]*:)?Override\b[^>]*>/g) ?? [];
  return overrides.some(tag => {
    const part = /\bPartName\s*=\s*(["'])\/word\/document\.xml\1/.test(tag);
    const content = new RegExp(
      `\\bContentType\\s*=\\s*(["'])${DOCX_MAIN_CONTENT_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`,
    ).test(tag);
    return part && content;
  });
}

/** Validate the OOXML ZIP container and extract only local word/document.xml text. */
export function extractDocxText(input: Uint8Array, options: { maxCharacters?: number } = {}): ExtractedDocumentText {
  const maxCharacters = positiveLimit(options.maxCharacters, DEFAULT_MAX_EXTRACTED_CHARACTERS, 'maxCharacters');
  try {
    const entries = zipEntries(input);
    const contentTypes = entries.get('[Content_Types].xml');
    const documentXml = entries.get('word/document.xml');
    if (!contentTypes || !documentXml) throw new Error('required OOXML entries are missing');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const typesXml = decoder.decode(unzipEntry(input, contentTypes, MAX_DOCX_CONTENT_TYPES_BYTES));
    if (!hasDocxMainContentType(typesXml)) {
      throw new Error('OOXML main document content type is missing');
    }
    const xml = decoder.decode(unzipEntry(input, documentXml, MAX_DOCX_DOCUMENT_XML_BYTES));
    if (!/<w:document\b/i.test(xml)) throw new Error('word/document.xml is not a Word document');
    const result = extractionResult('docx-xml', wordDocumentText(xml), maxCharacters);
    if (!result.text) {
      throw new DocumentExtractionError('no_extractable_text', 'DOCX has no extractable text');
    }
    return result;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError('unreadable_document', 'file is not a valid DOCX document');
  }
}
