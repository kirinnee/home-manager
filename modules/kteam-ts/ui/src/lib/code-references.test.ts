import { describe, expect, test } from 'bun:test';
import {
  codeReferenceHref,
  findCodeReferences,
  formatCodeReference,
  parseCodeReference,
  parseCodeReferenceHref,
  remarkCodeReferences,
  type CodeReference,
} from './code-references';

type MdTree = Parameters<ReturnType<typeof remarkCodeReferences>>[0];

describe('code reference syntax', () => {
  test.each([
    ['src/api-server.ts:890', { path: 'src/api-server.ts', line: 890 }],
    ['@src/api-server.ts:890', { path: 'src/api-server.ts', line: 890 }],
    ['src/api-server.ts:890:7', { path: 'src/api-server.ts', line: 890, column: 7 }],
    ['src/api-server.ts:890-912', { path: 'src/api-server.ts', line: 890, endLine: 912 }],
    ['src/api-server.ts#L890', { path: 'src/api-server.ts', line: 890 }],
    ['src/api-server.ts#L890-L912', { path: 'src/api-server.ts', line: 890, endLine: 912 }],
    ['src/api-server.ts#L890-912', { path: 'src/api-server.ts', line: 890, endLine: 912 }],
    ['@package.json', { path: 'package.json' }],
    ['docs/Makefile', { path: 'docs/Makefile' }],
  ] satisfies Array<[string, CodeReference]>)('recognises %s', (raw, expected) => {
    expect(parseCodeReference(raw)).toEqual(expected);
  });

  test.each([
    '1:30',
    '12:34:56',
    'ordinary-word',
    'README',
    '../outside.ts:3',
    'src/../outside.ts:3',
    'src/app.ts:0',
    'src/app.ts:12-4',
    'src/app.ts#L0',
    'src/app.ts#L12-4',
    'https://example.com/src/app.ts:4',
  ])('does not recognise false positive %s', raw => {
    expect(parseCodeReference(raw)).toBeNull();
    expect(findCodeReferences(`before ${raw} after`)).toEqual([]);
  });

  test('inserts compiler-style syntax canonically while retaining optional @ mentions', () => {
    expect(formatCodeReference({ path: 'src/app.ts' })).toBe('src/app.ts');
    expect(formatCodeReference({ path: 'src/app.ts', line: 4 }, true)).toBe('@src/app.ts:4');
    expect(formatCodeReference({ path: 'src/app.ts', line: 4, endLine: 9 }, true)).toBe('@src/app.ts:4-9');
    expect(formatCodeReference({ path: 'src/app.ts', line: 4, column: 2 })).toBe('src/app.ts:4:2');
  });

  test('finds multiple authored forms without swallowing sentence punctuation', () => {
    const text = 'See @src/app.ts:4-9, then docs/readme.md#L2.';
    expect(findCodeReferences(text)).toEqual([
      {
        reference: { path: 'src/app.ts', line: 4, endLine: 9 },
        raw: '@src/app.ts:4-9',
        start: 4,
        end: 19,
        mentioned: true,
      },
      {
        reference: { path: 'docs/readme.md', line: 2 },
        raw: 'docs/readme.md#L2',
        start: 26,
        end: 43,
        mentioned: false,
      },
    ]);
  });
});

describe('reserved code reference hrefs', () => {
  test('round-trips file, line, range, and column descriptors', () => {
    for (const reference of [
      { path: 'src/a b.ts' },
      { path: 'src/a.ts', line: 2 },
      { path: 'src/a.ts', line: 2, endLine: 8 },
      { path: 'src/a.ts', line: 2, column: 5 },
    ] satisfies CodeReference[]) {
      expect(parseCodeReferenceHref(codeReferenceHref(reference))).toEqual(reference);
    }
  });

  test.each([
    undefined,
    '#elsewhere?path=src%2Fa.ts&line=2',
    '#kteam-code-reference?path=src%2Fa.ts&line=0',
    '#kteam-code-reference?path=src%2Fa.ts&end=3',
    '#kteam-code-reference?path=src%2Fa.ts&line=4&end=2',
    '#kteam-code-reference?path=src%2Fa.ts&line=2&column=3&end=4',
    '#kteam-code-reference?path=src%2Fa.ts&path=src%2Fb.ts',
    '#kteam-code-reference?path=src%2Fa.ts&unknown=1',
  ])('rejects malformed or non-reserved href %s', href => {
    expect(parseCodeReferenceHref(href)).toBeNull();
  });
});

describe('remark code references', () => {
  test('links only paths the authoritative resolver confirms and preserves authored text', () => {
    const tree: MdTree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Open @src/app.ts:4-9; missing.ts:2 stays text.' }],
        },
      ],
    };
    remarkCodeReferences({ resolvePath: path => (path === 'src/app.ts' ? 'src/app.ts' : null) })(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: 'Open ' },
      {
        type: 'link',
        url: '#kteam-code-reference?path=src%2Fapp.ts&line=4&end=9',
        title: 'Open src/app.ts at lines 4–9',
        data: { hProperties: { 'data-code-reference': 'src/app.ts' } },
        children: [{ type: 'text', value: '@src/app.ts:4-9' }],
      },
      { type: 'text', value: '; missing.ts:2 stays text.' },
    ]);
  });

  test('does nothing without a resolver instead of creating broken-looking links', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'src/app.ts:4' }] }],
    };
    const before = structuredClone(tree);
    remarkCodeReferences()(tree);
    expect(tree).toEqual(before);
  });

  test('never nests links or changes inline code, fenced code, or raw HTML', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'inlineCode', value: 'src/inline.ts:2' },
        { type: 'code', lang: 'ts', value: 'src/fence.ts:3' },
        { type: 'html', value: '<i>src/raw.ts:4</i>' },
        { type: 'link', url: '/elsewhere', children: [{ type: 'text', value: 'src/link.ts:5' }] },
      ],
    };
    const before = structuredClone(tree);
    remarkCodeReferences({ resolvePath: path => path })(tree);
    expect(tree).toEqual(before);
  });

  test.each([
    'Meet at 1:30.',
    'Duration 12:34:56.',
    'The version is 1.2:3.',
    'Visit https://example.com/src/app.ts:4.',
    'The file missing.ts:2 does not exist.',
  ])('keeps conservative non-reference prose as text: %s', text => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] };
    const before = structuredClone(tree);
    remarkCodeReferences({ resolvePath: () => null })(tree);
    expect(tree).toEqual(before);
  });
});
