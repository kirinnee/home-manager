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
import { DocumentExtractionError, type DocumentExtractionErrorCode } from './document-extract';

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

/**
 * Build a minimal but genuine v3 CFB compound file: a 512-byte header, one FAT
 * sector (sector 0), and one directory sector (sector 1) holding the root plus
 * up to three named streams. Enough for the store's directory walk to observe
 * the stream names without a real Office document. `entryObjectType` overrides
 * the objectType stamped on the non-root entries (2 = stream by default; pass 1
 * to model storages that merely share those names). `linkFromRoot` controls
 * whether the entries are reachable from Root Entry's child tree — pass false to
 * model orphan/unlinked directory slots the parser must ignore.
 */
function oleCompoundFile(streamNames: string[], entryObjectType = 2, linkFromRoot = true): Uint8Array {
  const SECTOR = 512;
  const ENDOFCHAIN = 0xfffffffe;
  const FREESECT = 0xffffffff;
  const FATSECT = 0xfffffffd;
  const NOSTREAM = 0xffffffff;
  const bytes = new Uint8Array(SECTOR * 3);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(24, 0x003e, true); // minor version
  view.setUint16(26, 3, true); // major version (v3)
  view.setUint16(28, 0xfffe, true); // little-endian byte order
  view.setUint16(30, 9, true); // sector shift → 512-byte sectors
  view.setUint16(32, 6, true); // mini sector shift
  view.setUint32(44, 1, true); // FAT sector count
  view.setUint32(48, 1, true); // first directory sector
  view.setUint32(56, 4096, true); // mini stream cutoff
  view.setUint32(60, ENDOFCHAIN, true); // first mini FAT sector
  view.setUint32(68, ENDOFCHAIN, true); // first DIFAT sector
  view.setUint32(76, 0, true); // DIFAT[0] → FAT sector 0
  for (let index = 1; index < 109; index += 1) view.setUint32(76 + index * 4, FREESECT, true);

  const fatBase = SECTOR; // FAT sector 0 at (0 + 1) * 512
  view.setUint32(fatBase, FATSECT, true); // sector 0 holds the FAT itself
  view.setUint32(fatBase + 4, ENDOFCHAIN, true); // sector 1 (directory) ends its chain
  for (let index = 2; index < 128; index += 1) view.setUint32(fatBase + index * 4, FREESECT, true);

  const dirBase = SECTOR * 2; // directory sector 1 at (1 + 1) * 512
  const entries = ['Root Entry', ...streamNames];
  entries.forEach((name, index) => {
    const off = dirBase + index * 128;
    for (let character = 0; character < name.length; character += 1) {
      view.setUint16(off + character * 2, name.charCodeAt(character), true);
    }
    view.setUint16(off + 64, (name.length + 1) * 2, true); // name length incl null terminator
    view.setUint8(off + 66, index === 0 ? 5 : entryObjectType); // root storage / entry type
    view.setUint8(off + 67, 1); // black
    view.setUint32(off + 68, NOSTREAM, true); // left sibling
    view.setUint32(off + 72, NOSTREAM, true); // right sibling
    view.setUint32(off + 76, NOSTREAM, true); // child
    view.setUint32(off + 116, ENDOFCHAIN, true); // starting sector
  });
  if (linkFromRoot && streamNames.length > 0) {
    // Root Entry (ID 0) points its child at the first stream (ID 1); each stream
    // links to the next via its right sibling, forming a walkable child tree.
    view.setUint32(dirBase + 76, 1, true); // Root Entry child → ID 1
    for (let index = 1; index < entries.length; index += 1) {
      const rightSibling = index + 1 < entries.length ? index + 1 : NOSTREAM;
      view.setUint32(dirBase + index * 128 + 72, rightSibling, true);
    }
  }
  return bytes;
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

  test('retains original documents with typed, agent-visible reasons when text extraction fails', async () => {
    const failures: [DocumentExtractionErrorCode, string][] = [
      ['no_extractable_text', 'PDF has no extractable text; it looks like a scan'],
      [
        'password_protected_document',
        'This PDF needs a password to open; kteam could not read its text. Decrypt it locally and re-attach it if you want the agent to read it',
      ],
      ['unreadable_document', 'file is not a readable PDF'],
      ['document_extraction_timeout', 'PDF text extraction exceeded the processing time limit'],
      ['document_too_complex', 'PDF exceeded the text-extraction complexity limit'],
    ];

    for (const [index, [code, message]] of failures.entries()) {
      const bytes = new TextEncoder().encode(`%PDF-1.4\nfixture-${index}`);
      const failingStore = new AttachmentStore({
        rootDir,
        pdfExtractor: async () => {
          throw new DocumentExtractionError(code, message);
        },
      });
      const stored = await failingStore.upload('session-1', bytes, {
        filename: `failure-${index}.pdf`,
        mime: 'application/pdf',
      });

      expect(stored.manifest.textExtraction).toBeUndefined();
      expect(stored.manifest.textExtractionFailure).toEqual({ code, message });
      expect(stored.extractedText).toBeUndefined();
      expect(Array.from(new Uint8Array(await Bun.file(stored.path).arrayBuffer()))).toEqual(Array.from(bytes));
      expect((await readdir(path.dirname(stored.path))).sort()).toEqual([stored.manifest.filename, 'manifest.json']);
      expect((await failingStore.get('session-1', stored.manifest.id)).manifest.textExtractionFailure).toEqual({
        code,
        message,
      });

      const block = await failingStore.buildAttachmentReferenceBlock('session-1', [stored.manifest.id]);
      expect(block).toContain(`Text extraction failed in kteam (${code}): ${message}.`);
      expect(block).toContain('The original file remains available at the path above');
      expect(block).toContain('do not assume its text was read');
      expect(block).not.toContain('BEGIN KTEAM EXTRACTED TEXT');
    }
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

  test('retains a genuine encrypted DOCX but rejects arbitrary and renamed OLE files', async () => {
    const encryptedBytes = oleCompoundFile(['EncryptionInfo', 'EncryptedPackage']);
    const encrypted = await store.upload('session-1', encryptedBytes, {
      filename: 'protected.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(encrypted.manifest).toMatchObject({
      filename: 'protected.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      textExtractionFailure: {
        code: 'password_protected_document',
        message:
          'This DOCX needs a password to open; kteam could not read its text. Decrypt it locally and re-attach it if you want the agent to read it',
      },
    });
    expect(encrypted.manifest.textExtraction).toBeUndefined();
    expect(Array.from(new Uint8Array(await Bun.file(encrypted.path).arrayBuffer()))).toEqual(
      Array.from(encryptedBytes),
    );

    // A real legacy .doc is an OLE file without the encryption streams.
    const legacyOle = oleCompoundFile(['WordDocument', '1Table']);
    expect(
      errorCode(
        await store
          .upload('session-1', legacyOle, { filename: 'legacy.doc', mime: 'application/msword' })
          .catch(error => error),
      ),
    ).toBe('unsupported_mime');

    // The same arbitrary OLE renamed .docx must not be accepted as a DOCX.
    expect(
      errorCode(
        await store
          .upload('session-1', legacyOle, {
            filename: 'renamed.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          })
          .catch(error => error),
      ),
    ).toBe('unsupported_mime');

    // A bare CFB signature is not evidence of an encrypted package either.
    const bareSignature = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(
      errorCode(await store.upload('session-1', bareSignature, { filename: 'stub.docx' }).catch(error => error)),
    ).toBe('unsupported_mime');

    // Storages (objectType 1) that merely share the stream names are not
    // MS-OFFCRYPTO evidence; only genuine stream entries count.
    const storagesNotStreams = oleCompoundFile(['EncryptionInfo', 'EncryptedPackage'], 1);
    expect(
      errorCode(
        await store
          .upload('session-1', storagesNotStreams, {
            filename: 'spoofed.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          })
          .catch(error => error),
      ),
    ).toBe('unsupported_mime');

    // Orphan stream entries the Root child tree does not link to are not
    // reachable evidence; unlinked EncryptionInfo/EncryptedPackage slots are
    // ignored and the file falls through to a typed client error.
    const orphanStreams = oleCompoundFile(['EncryptionInfo', 'EncryptedPackage'], 2, false);
    expect(
      errorCode(
        await store
          .upload('session-1', orphanStreams, {
            filename: 'orphan.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          })
          .catch(error => error),
      ),
    ).toBe('unsupported_mime');
  });

  test('upgrades a retained transient failure when identical bytes later extract', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\ntransient');
    const failingStore = new AttachmentStore({
      rootDir,
      pdfExtractor: async () => {
        throw new DocumentExtractionError(
          'document_extraction_timeout',
          'PDF text extraction exceeded the processing time limit',
        );
      },
    });
    const succeedingStore = new AttachmentStore({
      rootDir,
      pdfExtractor: async () => ({
        method: 'pdfjs',
        text: 'recovered PDF text',
        characters: 18,
        truncated: false,
        totalPages: 1,
        pagesRead: 1,
      }),
    });

    const failed = await failingStore.upload('session-1', pdfBytes, {
      filename: 'report.pdf',
      mime: 'application/pdf',
    });
    expect(failed.manifest.textExtractionFailure?.code).toBe('document_extraction_timeout');
    expect(failed.manifest.textExtraction).toBeUndefined();

    const upgraded = await succeedingStore.upload('session-1', pdfBytes, {
      filename: 'report.pdf',
      mime: 'application/pdf',
    });
    expect(upgraded.manifest.id).toBe(failed.manifest.id);
    expect(upgraded.path).toBe(failed.path);
    expect(upgraded.manifest.textExtractionFailure).toBeUndefined();
    expect(upgraded.manifest.textExtraction).toMatchObject({ method: 'pdfjs', characters: 18, truncated: false });
    expect(upgraded.extractedText).toBe('recovered PDF text');
    expect(Array.from(new Uint8Array(await Bun.file(upgraded.path).arrayBuffer()))).toEqual(Array.from(pdfBytes));

    // The upgrade is durable: a fresh get() exposes the extraction, not the failure.
    const reread = await failingStore.get('session-1', failed.manifest.id);
    expect(reread.manifest.textExtractionFailure).toBeUndefined();
    expect(reread.extractedText).toBe('recovered PDF text');
  });

  test('keeps concurrent transient-failure upgrades internally consistent', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\nconcurrent-transient');
    const failingStore = new AttachmentStore({
      rootDir,
      pdfExtractor: async () => {
        throw new DocumentExtractionError('document_extraction_timeout', 'timed out');
      },
    });
    const failed = await failingStore.upload('session-1', pdfBytes, {
      filename: 'report.pdf',
      mime: 'application/pdf',
    });

    let failureReads = 0;
    let releaseFailureReads!: () => void;
    const bothReadFailure = new Promise<void>(resolve => {
      releaseFailureReads = resolve;
    });
    class GatedAttachmentStore extends AttachmentStore {
      override async get(sessionId: string, attachmentId: string) {
        const stored = await super.get(sessionId, attachmentId);
        if (stored.manifest.textExtractionFailure && failureReads < 2) {
          failureReads += 1;
          if (failureReads === 2) releaseFailureReads();
          await bothReadFailure;
        }
        return stored;
      }
    }

    const firstText = 'first concurrent extraction';
    const secondText = 'second, substantially different concurrent extraction';
    const firstStore = new GatedAttachmentStore({
      rootDir,
      pdfExtractor: async () => ({
        method: 'pdfjs',
        text: firstText,
        characters: firstText.length,
        truncated: false,
        totalPages: 1,
        pagesRead: 1,
      }),
    });
    const secondStore = new GatedAttachmentStore({
      rootDir,
      pdfExtractor: async () => ({
        method: 'pdfjs',
        text: secondText,
        characters: secondText.length,
        truncated: false,
        totalPages: 1,
        pagesRead: 1,
      }),
    });

    const upgraded = await Promise.all([
      firstStore.upload('session-1', pdfBytes, { filename: 'report.pdf', mime: 'application/pdf' }),
      secondStore.upload('session-1', pdfBytes, { filename: 'report.pdf', mime: 'application/pdf' }),
    ]);
    expect(failureReads).toBe(2);
    for (const attachment of upgraded) {
      expect(attachment.manifest.textExtractionFailure).toBeUndefined();
      expect([firstText, secondText]).toContain(attachment.extractedText!);
    }

    const extractionFiles = (await readdir(path.dirname(failed.path))).filter(filename =>
      /^report\.extracted-[a-f0-9]{64}\.txt$/.test(filename),
    );
    expect(extractionFiles).toHaveLength(2);
    const reread = await failingStore.get('session-1', failed.manifest.id);
    expect(reread.manifest.textExtractionFailure).toBeUndefined();
    expect(extractionFiles).toContain(reread.manifest.textExtraction!.filename);
    expect([firstText, secondText]).toContain(reread.extractedText!);
  });

  test('does not downgrade a stored success when a later identical upload fails', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\ndurable');
    const succeeded = await store.upload('session-1', pdfBytes, { filename: 'ok.pdf', mime: 'application/pdf' });
    expect(succeeded.manifest.textExtraction).toBeDefined();

    const failingStore = new AttachmentStore({
      rootDir,
      pdfExtractor: async () => {
        throw new DocumentExtractionError('document_extraction_timeout', 'timed out');
      },
    });
    const second = await failingStore.upload('session-1', pdfBytes, { filename: 'ok.pdf', mime: 'application/pdf' });
    expect(second.manifest.textExtraction).toBeDefined();
    expect(second.manifest.textExtractionFailure).toBeUndefined();
    expect(second.extractedText).toBe('extracted PDF text');
  });

  test('trims a normalized failure message after truncating so the manifest validates', async () => {
    // 499 non-space characters, a space at index 499, then more text: the 500-
    // character cut ends on that space and the writer must trim it off.
    const longMessage = `${'A'.repeat(499)} ${'B'.repeat(120)}`;
    const failingStore = new AttachmentStore({
      rootDir,
      pdfExtractor: async () => {
        throw new DocumentExtractionError('document_too_complex', longMessage);
      },
    });
    const stored = await failingStore.upload('session-1', new TextEncoder().encode('%PDF-1.4\nlong'), {
      filename: 'long.pdf',
      mime: 'application/pdf',
    });
    const failure = stored.manifest.textExtractionFailure!;
    expect(failure.code).toBe('document_too_complex');
    expect(failure.message).toBe('A'.repeat(499));
    expect(failure.message.length).toBe(499);
    expect(failure.message).toBe(failure.message.trim());
    // A fresh get() must accept the manifest and still expose the original.
    const reread = await failingStore.get('session-1', stored.manifest.id);
    expect(reread.manifest.textExtractionFailure?.message).toBe('A'.repeat(499));
    expect(Array.from(new Uint8Array(await Bun.file(reread.path).arrayBuffer()))).toEqual(
      Array.from(new TextEncoder().encode('%PDF-1.4\nlong')),
    );
  });

  test('rejects a manifest that carries both extraction and failure fields', async () => {
    const pdf = await store.upload('session-1', new TextEncoder().encode('%PDF-1.4\nboth'), {
      filename: 'both.pdf',
      mime: 'application/pdf',
    });
    const manifestPath = path.join(path.dirname(pdf.path), 'manifest.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        { ...pdf.manifest, textExtractionFailure: { code: 'document_too_complex', message: 'contradictory failure' } },
        null,
        2,
      )}\n`,
    );
    expect(errorCode(await store.get('session-1', pdf.manifest.id).catch(error => error))).toBe('corrupt_attachment');
  });

  test('loads an old manifest that has neither new extraction field', async () => {
    const image = await store.upload('session-1', png('legacy-manifest'), { filename: 'legacy.png' });
    const manifestPath = path.join(path.dirname(image.path), 'manifest.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          version: 1,
          id: image.manifest.id,
          filename: image.manifest.filename,
          mime: image.manifest.mime,
          size: image.manifest.size,
          hash: image.manifest.hash,
          time: image.manifest.time,
        },
        null,
        2,
      )}\n`,
    );
    const reread = await store.get('session-1', image.manifest.id);
    expect(reread.manifest.textExtraction).toBeUndefined();
    expect(reread.manifest.textExtractionFailure).toBeUndefined();
    expect(Array.from(new Uint8Array(await Bun.file(reread.path).arrayBuffer()))).toEqual(
      Array.from(png('legacy-manifest')),
    );
  });

  test('records an honest DOCX failure through the real extractor and keeps the original', async () => {
    // A ZIP-signature buffer detects as DOCX but is not a valid OOXML package,
    // so the real extractDocxText path (not an injected extractor) must fail.
    const brokenDocx = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00]);
    const stored = await store.upload('session-1', brokenDocx, {
      filename: 'broken.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(stored.manifest.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(stored.manifest.textExtraction).toBeUndefined();
    expect(stored.manifest.textExtractionFailure).toEqual({
      code: 'unreadable_document',
      message: 'file is not a valid DOCX document',
    });
    expect(stored.extractedText).toBeUndefined();
    expect(Array.from(new Uint8Array(await Bun.file(stored.path).arrayBuffer()))).toEqual(Array.from(brokenDocx));
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

  test('keeps a non-empty reason when a failure message is only trailing punctuation', () => {
    const hash = 'b'.repeat(64);
    const block = formatAttachmentReferenceBlock([
      {
        path: `/safe/${hash}/report.pdf`,
        manifest: {
          version: 1,
          id: `att_${hash}`,
          filename: 'report.pdf',
          mime: 'application/pdf',
          size: 42,
          hash,
          time: '2026-07-28T12:00:00.000Z',
          textExtractionFailure: { code: 'unreadable_document', message: '...' },
        },
      },
    ]);
    // Stripping the trailing punctuation would empty the reason; the fallback
    // keeps the original so the UI parser still matches the reference line.
    expect(block).toContain('Text extraction failed in kteam (unreadable_document): ...');
    expect(block).toContain('The original file remains available at the path above');
    expect(block).not.toContain('(unreadable_document): . The original');
  });
});
