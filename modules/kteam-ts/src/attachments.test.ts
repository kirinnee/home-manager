import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AttachmentError,
  AttachmentStore,
  detectAttachmentMime,
  detectImageMime,
  formatAttachmentReferenceBlock,
  formatImageReferenceBlock,
  safeAttachmentFilename,
} from './attachments';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(payload = 'kteam'): Uint8Array {
  const suffix = new TextEncoder().encode(payload);
  const bytes = new Uint8Array(PNG_SIGNATURE.length + suffix.length);
  bytes.set(PNG_SIGNATURE);
  bytes.set(suffix, PNG_SIGNATURE.length);
  return bytes;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AttachmentError ? error.code : undefined;
}

describe('AttachmentStore', () => {
  let rootDir: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'kteam-attachments-'));
    store = new AttachmentStore({
      rootDir,
      pdfExtractor: async () => ({
        method: 'pdfjs',
        text: 'extracted PDF text',
        characters: 18,
        truncated: false,
        totalPages: 1,
        pagesRead: 1,
      }),
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test('stores an image by hash with a safe filename and durable manifest', async () => {
    const bytes = png('first');
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const stored = await store.upload('session-1', bytes, {
      filename: '../../My unsafe screenshot.exe',
      mime: 'image/png; charset=binary',
    });

    expect(stored.manifest).toMatchObject({
      version: 1,
      id: `att_${expectedHash}`,
      filename: 'My-unsafe-screenshot.png',
      mime: 'image/png',
      size: bytes.byteLength,
      hash: expectedHash,
    });
    expect(Date.parse(stored.manifest.time)).not.toBeNaN();
    expect(path.isAbsolute(stored.path)).toBe(true);
    expect(stored.path).toEndWith(path.join('session-1', 'attachments', expectedHash, 'My-unsafe-screenshot.png'));
    expect(Array.from(new Uint8Array(await Bun.file(stored.path).arrayBuffer()))).toEqual(Array.from(bytes));

    const manifest = JSON.parse(await readFile(path.join(path.dirname(stored.path), 'manifest.json'), 'utf8'));
    expect(manifest).toEqual(stored.manifest);
  });

  test('accepts a byte stream and deduplicates identical content', async () => {
    const bytes = png('streamed');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      },
    });

    const first = await store.upload('session-1', stream, { filename: 'first.png' });
    const duplicate = await store.upload('session-1', bytes, { filename: 'second.png' });

    expect(duplicate).toEqual(first);
    expect((await store.list('session-1')).map(item => item.manifest.id)).toEqual([first.manifest.id]);
    expect((await readdir(path.dirname(first.path))).sort()).toEqual(['first.png', 'manifest.json']);
  });

  test('deduplicates concurrent uploads', async () => {
    const bytes = png('concurrent');
    const [first, second] = await Promise.all([
      store.upload('session-1', bytes, { filename: 'one.png' }),
      store.upload('session-1', bytes, { filename: 'two.png' }),
    ]);
    expect(first.manifest.id).toBe(second.manifest.id);
    expect(first.path).toBe(second.path);
    expect(await store.list('session-1')).toHaveLength(1);
  });

  test('stores text and PDF documents with verified types and retained extraction', async () => {
    const note = await store.upload('session-1', new TextEncoder().encode('hello attachment'), {
      filename: '../../notes.md',
      mime: 'text/x-markdown; charset=utf-8',
    });
    expect(note.manifest).toMatchObject({ filename: 'notes.md', mime: 'text/markdown' });

    const pdfBytes = new TextEncoder().encode('%PDF-1.4\nfixture');
    const pdf = await store.upload('session-1', pdfBytes, {
      filename: '../../report.exe',
      mime: 'application/pdf',
    });
    expect(pdf.manifest).toMatchObject({
      filename: 'report.pdf',
      mime: 'application/pdf',
      textExtraction: {
        method: 'pdfjs',
        characters: 18,
        truncated: false,
        totalPages: 1,
        pagesRead: 1,
      },
    });
    expect(pdf.extractedText).toBe('extracted PDF text');
    expect(pdf.extractedTextPath).toEndWith('report.extracted.txt');
    expect(await readFile(pdf.extractedTextPath!, 'utf8')).toBe('extracted PDF text');
  });

  test('rejects oversized, unsupported, and MIME-mismatched uploads', async () => {
    expect(
      errorCode(
        await store
          .upload('session-1', png('large'), {
            filename: 'large.png',
            maxSizeBytes: 4,
          })
          .catch(error => error),
      ),
    ).toBe('attachment_too_large');

    expect(
      errorCode(
        await store
          .upload('session-1', Uint8Array.from([0, 1, 2, 3, 4]), {
            filename: 'binary.bin',
          })
          .catch(error => error),
      ),
    ).toBe('unsupported_mime');

    expect(
      errorCode(
        await store
          .upload('session-1', png(), {
            filename: 'wrong.jpg',
            mime: 'image/jpeg',
          })
          .catch(error => error),
      ),
    ).toBe('mime_mismatch');
  });

  test('reports encrypted DOCX containers without accepting legacy DOC files', async () => {
    const compoundFile = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const encrypted = await store
      .upload('session-1', compoundFile, {
        filename: 'protected.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      .catch(error => error);
    expect(errorCode(encrypted)).toBe('password_protected_document');
    expect(encrypted.message).toContain('password-protected or encrypted');

    const legacy = await store
      .upload('session-1', compoundFile, { filename: 'legacy.doc', mime: 'application/msword' })
      .catch(error => error);
    expect(errorCode(legacy)).toBe('unsupported_mime');
  });

  test('resists traversal in session IDs, attachment IDs, and manifests', async () => {
    const stored = await store.upload('safe-session', png(), { filename: 'safe.png' });

    expect(errorCode(await store.get('../safe-session', stored.manifest.id).catch(error => error))).toBe(
      'invalid_identifier',
    );
    expect(errorCode(await store.get('safe-session', '../manifest.json').catch(error => error))).toBe(
      'invalid_identifier',
    );

    const manifestPath = path.join(path.dirname(stored.path), 'manifest.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        ...stored.manifest,
        filename: '../../outside.png',
      })}\n`,
    );
    expect(errorCode(await store.get('safe-session', stored.manifest.id).catch(error => error))).toBe(
      'corrupt_attachment',
    );
  });

  test('returns an empty list for a session with no attachments', async () => {
    expect(await store.list('new-session')).toEqual([]);
  });

  test('builds an absolute image-reference block for tmux input', async () => {
    const first = await store.upload('session-1', png('one'), { filename: 'one.png' });
    const second = await store.upload('session-1', png('two'), { filename: 'two.png' });
    const block = await store.buildImageReferenceBlock('session-1', [first.manifest.id, second.manifest.id]);

    expect(block).toStartWith('Attached files (inspect these files directly before responding):');
    expect(block).toContain(`- ${first.path} (image/png`);
    expect(block).toContain(`id ${second.manifest.id})`);
    expect(formatImageReferenceBlock([])).toBe('');
  });
});

describe('attachment helpers', () => {
  test('detects supported image signatures', () => {
    expect(detectImageMime(png())).toBe('image/png');
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(detectImageMime(new TextEncoder().encode('GIF89a!'))).toBe('image/gif');
    expect(detectImageMime(new TextEncoder().encode('RIFF0000WEBP'))).toBe('image/webp');
  });

  test('normalizes hostile and empty filenames', () => {
    expect(safeAttachmentFilename('..\\..\\hello world.jpeg', 'image/jpeg')).toBe('hello-world.jpg');
    expect(safeAttachmentFilename('../../...', 'image/png')).toBe('image.png');
    expect(safeAttachmentFilename('../../quarterly report.exe', 'application/pdf')).toBe('quarterly-report.pdf');
    expect(safeAttachmentFilename('..\\..\\notes.bin', 'text/plain')).toBe('notes.txt');
  });

  test('detects verified documents without treating declarations as proof', () => {
    expect(
      detectAttachmentMime(new TextEncoder().encode('%PDF-1.7\n'), {
        filename: 'wrong.txt',
        mime: 'text/plain',
      }),
    ).toBe('application/pdf');
    expect(
      detectAttachmentMime(new TextEncoder().encode('{"ok":true}'), {
        filename: 'data.json',
        mime: 'application/json',
      }),
    ).toBe('application/json');
    expect(
      detectAttachmentMime(new TextEncoder().encode('not JSON'), {
        filename: 'data.json',
        mime: 'application/json',
      }),
    ).toBe('text/plain');
  });

  test('formats extracted text with id-bound markers and an honest truncation disclosure', () => {
    const hash = 'a'.repeat(64);
    const block = formatAttachmentReferenceBlock([
      {
        path: `/safe/${hash}/report.pdf`,
        extractedTextPath: `/safe/${hash}/report.extracted.txt`,
        extractedText: 'the extracted contents',
        manifest: {
          version: 1,
          id: `att_${hash}`,
          filename: 'report.pdf',
          mime: 'application/pdf',
          size: 42,
          hash,
          time: '2026-07-28T12:00:00.000Z',
          textExtraction: {
            method: 'pdfjs',
            filename: 'report.extracted.txt',
            size: 22,
            characters: 22,
            truncated: true,
            totalPages: 200,
            pagesRead: 100,
          },
        },
      },
    ]);
    expect(block).toStartWith('Attached file (inspect this file directly before responding):');
    expect(block).toContain('Text extracted by kteam (pdf.js; 100 of 200 pages;');
    expect(block).toContain('source extraction truncated');
    expect(block).toContain(`----- BEGIN KTEAM EXTRACTED TEXT att_${hash} -----`);
    expect(block).toContain('layout, images, and scanned content are not included');
    expect(formatImageReferenceBlock([])).toBe('');
  });
});
