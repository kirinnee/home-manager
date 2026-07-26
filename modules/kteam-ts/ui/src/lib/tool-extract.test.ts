import { describe, expect, test } from 'bun:test';
import { resultImages, resultText } from './tool-extract';

describe('tool-result images', () => {
  test('extracts safe base64 image blocks and keeps text without a placeholder', () => {
    const result = {
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'text', text: 'after' },
      ],
    };
    expect(resultImages(result)).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(resultText(result)).toBe('before\nafter');
    expect(resultText(result)).not.toContain('[image]');
  });

  test('rejects SVG, remote sources, empty bytes, and malformed blocks', () => {
    expect(
      resultImages({
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
          { type: 'image', source: { type: 'url', media_type: 'image/png', data: 'abc' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          { type: 'image' },
        ],
      }),
    ).toEqual([]);
  });

  test('an image-only result has no fake textual result', () => {
    const result = {
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } }],
    };
    expect(resultImages(result)).toHaveLength(1);
    expect(resultText(result)).toBeNull();
  });
});
