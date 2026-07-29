import { describe, expect, test } from 'bun:test';
import {
  findReferences,
  formatReference,
  parseReferenceHref,
  parseReferenceToken,
  referenceHref,
  referenceIdentity,
  remarkReferences,
  resolveReference,
  revalidateReference,
  type ReferenceResolvers,
  type Reference,
  type ResolvedReference,
} from './references';

type Tree = Parameters<ReturnType<typeof remarkReferences>>[0];

const resolvers: ReferenceResolvers = {
  agent: lookup =>
    lookup.name === 'zelda' || lookup.sessionId === 'ms-zelda' ? { sessionId: 'ms-zelda', name: 'zelda' } : null,
  file: path => (path === 'src/api.ts' || path === 'handover.md' ? path : null),
  task: id => id === 'F12',
  attention: id => id === 'A3',
};

describe('canonical reference grammar', () => {
  test.each([
    [':zelda', { kind: 'agent', name: 'zelda' }],
    [':ZELDA', { kind: 'agent', name: 'zelda' }],
    ['@handover.md', { kind: 'file', path: 'handover.md' }],
    ['@src/api.ts:120', { kind: 'file', path: 'src/api.ts', line: 120 }],
    ['@src/api.ts:120-140', { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 }],
    ['&F12', { kind: 'task', id: 'F12' }],
    ['&f12', { kind: 'task', id: 'F12' }],
    ['!A3', { kind: 'attention', id: 'A3' }],
  ])('parses %s', (raw, expected) => {
    expect(parseReferenceToken(raw)).toEqual(expected as Reference);
  });

  test.each([
    '',
    '@',
    '@@src/api.ts',
    '@@@src/api.ts',
    'src/api.ts',
    'src/api.ts:12',
    '@src/api.ts:0',
    '@src/api.ts:12-0',
    '@src/api.ts:14-12',
    '@src/api.ts:12:4',
    '@src/',
    '@../secret',
    '@a/../secret',
    '#F12',
    '?A3',
    ':1zelda',
    ':zelda_name',
    '&A3',
    '!A0',
    'pin:thing',
  ])('rejects non-canonical token %s', raw => {
    expect(parseReferenceToken(raw)).toBeNull();
  });

  test('finds all four kinds with exact offsets and leaves repetitions/non-boundaries alone', () => {
    const text =
      'Ping :zelda; inspect @src/api.ts:120-140, then &F12 and !A3. Ignore x:link, word&F2, !!A4, @@@, #F9, ?A8.';
    expect(findReferences(text)).toEqual([
      {
        reference: { kind: 'agent', name: 'zelda' },
        raw: ':zelda',
        start: text.indexOf(':zelda'),
        end: text.indexOf(':zelda') + ':zelda'.length,
      },
      {
        reference: { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 },
        raw: '@src/api.ts:120-140',
        start: text.indexOf('@src/api.ts'),
        end: text.indexOf('@src/api.ts') + '@src/api.ts:120-140'.length,
      },
      {
        reference: { kind: 'task', id: 'F12' },
        raw: '&F12',
        start: text.indexOf('&F12'),
        end: text.indexOf('&F12') + '&F12'.length,
      },
      {
        reference: { kind: 'attention', id: 'A3' },
        raw: '!A3',
        start: text.indexOf('!A3'),
        end: text.indexOf('!A3') + '!A3'.length,
      },
    ]);
  });

  test('formats every kind in its one written form', () => {
    expect(formatReference({ kind: 'agent', name: 'Zelda' })).toBe(':zelda');
    expect(formatReference({ kind: 'file', path: 'handover.md' })).toBe('@handover.md');
    expect(formatReference({ kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 })).toBe('@src/api.ts:120-140');
    expect(formatReference({ kind: 'task', id: 'f12' })).toBe('&F12');
    expect(formatReference({ kind: 'attention', id: 'A3' })).toBe('!A3');
  });
});

describe('proof-before-link', () => {
  test('resolves only authoritative matches and converts thrown proof into absence', () => {
    expect(resolveReference({ kind: 'agent', name: 'zelda' }, resolvers)).toEqual({
      kind: 'agent',
      sessionId: 'ms-zelda',
      name: 'zelda',
    });
    expect(resolveReference({ kind: 'file', path: 'src/api.ts', line: 12 }, resolvers)).toEqual({
      kind: 'file',
      path: 'src/api.ts',
      line: 12,
    });
    expect(resolveReference({ kind: 'task', id: 'F99' }, resolvers)).toBeNull();
    expect(
      resolveReference(
        { kind: 'attention', id: 'A3' },
        {
          attention: () => {
            throw new Error('offline');
          },
        },
      ),
    ).toBeNull();
  });

  test('round-trips only valid resolved hrefs', () => {
    const references: ResolvedReference[] = [
      { kind: 'agent', sessionId: 'ms-zelda', name: 'zelda' },
      { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 },
      { kind: 'task', id: 'F12' },
      { kind: 'attention', id: 'A3' },
    ];
    for (const reference of references) {
      expect(parseReferenceHref(referenceHref(reference))).toEqual(reference);
      expect(referenceIdentity(reference)).toMatch(new RegExp(`^${reference.kind}:`));
    }
    expect(parseReferenceHref('#kteam-reference?kind=task&id=F12&id=F13')).toBeNull();
    expect(parseReferenceHref('#kteam-reference?kind=file&path=src%2Fapi.ts&end=4')).toBeNull();
    expect(parseReferenceHref('#kteam-reference?kind=pin&id=one')).toBeNull();
  });

  test('re-proves transformed identity and refreshes an agent callsign', () => {
    expect(
      revalidateReference(
        { kind: 'agent', sessionId: 'ms-zelda', name: 'old-name' },
        {
          ...resolvers,
          agent: lookup => (lookup.sessionId === 'ms-zelda' ? { sessionId: 'ms-zelda', name: 'zelda' } : null),
        },
      ),
    ).toEqual({ kind: 'agent', sessionId: 'ms-zelda', name: 'zelda' });
    expect(
      revalidateReference({ kind: 'file', path: 'src/api.ts' }, { ...resolvers, file: () => 'different/path.ts' }),
    ).toBeNull();
  });
});

describe('one remark transform', () => {
  test('linkifies every proven kind in one ordered pass and leaves unresolved text plain', () => {
    const tree: Tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Ping :zelda @src/api.ts:12 &F12 !A3 &F99.' }],
        },
      ],
    };
    remarkReferences({ resolvers })(tree);
    const children = tree.children?.[0]?.children ?? [];
    expect(children.filter(node => node.type === 'link')).toHaveLength(4);
    expect(children.map(node => node.children?.[0]?.value ?? node.value).join('')).toBe(
      'Ping :zelda @src/api.ts:12 &F12 !A3 &F99.',
    );
    expect(children.at(-1)).toEqual({ type: 'text', value: ' &F99.' });
  });

  test('does not transform existing links, code, or HTML', () => {
    const tree: Tree = {
      type: 'root',
      children: [
        { type: 'inlineCode', value: ':zelda @src/api.ts &F12 !A3' },
        { type: 'html', value: '<b>&F12</b>' },
        {
          type: 'link',
          url: referenceHref({ kind: 'task', id: 'F12' }),
          children: [{ type: 'text', value: '&F12' }],
        },
      ],
    };
    const before = structuredClone(tree);
    remarkReferences({ resolvers })(tree);
    expect(tree).toEqual(before);
  });

  test('without resolvers nothing becomes a link', () => {
    const tree: Tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: ':zelda @src/api.ts &F12 !A3' }] }],
    };
    const before = structuredClone(tree);
    remarkReferences()(tree);
    expect(tree).toEqual(before);
  });
});
