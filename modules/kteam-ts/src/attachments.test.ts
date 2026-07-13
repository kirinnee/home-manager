import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AttachmentError,
  AttachmentStore,
  detectImageMime,
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
    store = new AttachmentStore({ rootDir });
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
          .upload('session-1', new TextEncoder().encode('not an image'), {
            filename: 'text.txt',
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

    expect(block).toStartWith('Attached images (inspect these files directly before responding):');
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
  });
});
