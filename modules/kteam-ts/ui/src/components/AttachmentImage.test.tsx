import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentBlobCache, AttachmentImageProvider, TranscriptImageGallery } from './AttachmentImage';
import type { TranscriptImage } from '../lib/attachments';

describe('transcript image presentation', () => {
  test('tool groups cap inline thumbnails at four and disclose the remainder', () => {
    const images: TranscriptImage[] = Array.from({ length: 5 }, (_, index) => ({
      kind: 'inline',
      src: `data:image/png;base64,image-${index}`,
      alt: `Tool result image ${index + 1}`,
    }));
    const html = renderToStaticMarkup(<TranscriptImageGallery images={images} initialLimit={4} />);
    expect(html.match(/loading="lazy"/g)).toHaveLength(4);
    expect(html).toContain('Show 1 more attachment');
    expect(html).not.toContain('image-4');
  });

  test('stored attachments render a lazy placeholder until authenticated fetch visibility', () => {
    const html = renderToStaticMarkup(
      <AttachmentImageProvider>
        <TranscriptImageGallery
          images={[
            {
              kind: 'attachment',
              sessionId: 'ms1images-12345678',
              attachmentId: `att_${'a'.repeat(64)}`,
              filename: 'probe.png',
              size: 233,
            },
          ]}
        />
      </AttachmentImageProvider>,
    );
    expect(html).toContain('Loading probe.png');
    expect(html).not.toContain('/v1/sessions/');
    expect(html).not.toContain('src="/home/');
  });

  test('every loaded thumbnail is a labelled expand target with lazy semantics', () => {
    const html = renderToStaticMarkup(
      <TranscriptImageGallery images={[{ kind: 'inline', src: 'data:image/png;base64,abc', alt: 'probe image' }]} />,
    );
    expect(html).toContain('aria-label="Expand probe image"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('max-h-[280px]');
    expect(html).toContain('min-h-[44px]');
  });

  test('documents render a file card with honest extraction metadata, never an image', () => {
    const html = renderToStaticMarkup(
      <AttachmentImageProvider>
        <TranscriptImageGallery
          images={[
            {
              kind: 'attachment',
              sessionId: 'ms1docs-12345678',
              attachmentId: `att_${'b'.repeat(64)}`,
              filename: 'brief.pdf',
              mime: 'application/pdf',
              size: 123_456,
              textExtraction: { method: 'pdfjs', characters: 92, truncated: true },
            },
          ]}
        />
      </AttachmentImageProvider>,
    );
    expect(html).toContain('brief.pdf');
    expect(html).toContain('PDF document');
    expect(html).toContain('text extracted for agent · truncated');
    expect(html).toContain('loading file…');
    expect(html).toContain('aria-label="Open brief.pdf"');
    expect(html).toContain('aria-label="Download brief.pdf"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/home/');
  });

  test('a stored document warns about failed agent extraction without losing its file controls', () => {
    const html = renderToStaticMarkup(
      <AttachmentImageProvider>
        <TranscriptImageGallery
          images={[
            {
              kind: 'attachment',
              sessionId: 'ms1docs-12345678',
              attachmentId: `att_${'c'.repeat(64)}`,
              filename: 'large-report.pdf',
              mime: 'application/pdf',
              size: 123_456,
              textExtractionFailure: {
                code: 'document_too_complex',
                message: 'internal path /home/kirin/.kteam/secret exceeded a parser limit',
              },
            },
          ]}
        />
      </AttachmentImageProvider>,
    );
    expect(html).toContain('Agent text extraction failed: the document is too complex or exceeds extraction limits.');
    expect(html).toContain('text-warn');
    expect(html).not.toContain('internal path');
    expect(html).not.toContain('/home/kirin/.kteam/secret');
    expect(html).toContain('aria-label="Open large-report.pdf"');
    expect(html).toContain('aria-label="Download large-report.pdf"');
    expect(html).not.toContain('Retry');
  });
});

describe('attachment blob cache ownership', () => {
  test('revokes a URL that resolves after disposal and preserves a replacement entry after an old rejection', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    let nextUrl = 0;
    URL.createObjectURL = () => `blob:attachment-${++nextUrl}`;
    URL.revokeObjectURL = url => revoked.push(url);

    try {
      let resolveLate!: (blob: Blob) => void;
      const lateBlob = new Promise<Blob>(resolve => {
        resolveLate = resolve;
      });
      const disposed = new AttachmentBlobCache();
      const lateUrl = disposed.acquire('late', () => lateBlob);
      disposed.dispose();
      resolveLate(new Blob(['png'], { type: 'image/png' }));
      await expect(lateUrl).rejects.toThrow('no longer needed');
      expect(revoked).toEqual(['blob:attachment-1']);

      let rejectOld!: (error: Error) => void;
      const oldBlob = new Promise<Blob>((_resolve, reject) => {
        rejectOld = reject;
      });
      let resolveReplacement!: (blob: Blob) => void;
      const replacementBlob = new Promise<Blob>(resolve => {
        resolveReplacement = resolve;
      });
      const cache = new AttachmentBlobCache(1);
      const oldUrl = cache.acquire('same', () => oldBlob);
      cache.release('same');
      void cache.acquire('pinned', () => new Promise<Blob>(() => {}));
      const replacementUrl = cache.acquire('same', () => replacementBlob);

      rejectOld(new Error('old request failed'));
      await expect(oldUrl).rejects.toThrow('old request failed');
      let replacementReloaded = false;
      expect(
        cache.acquire('same', () => {
          replacementReloaded = true;
          return Promise.resolve(new Blob(['wrong'], { type: 'image/png' }));
        }),
      ).toBe(replacementUrl);
      expect(replacementReloaded).toBe(false);

      resolveReplacement(new Blob(['png'], { type: 'image/png' }));
      expect(await replacementUrl).toBe('blob:attachment-2');
      cache.dispose();
      expect(revoked).toEqual(['blob:attachment-1', 'blob:attachment-2']);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
