import { describe, expect, test } from 'bun:test';
import {
  attentionReferenceHref,
  findAttentionReferences,
  parseAttentionReferenceHref,
  parsePinReferenceHref,
  pinReferenceHref,
  pinReferenceMarkdown,
  remarkSessionReferences,
} from './remark-session-references';

type Tree = Parameters<ReturnType<typeof remarkSessionReferences>>[0];

describe('remark session references', () => {
  test('finds bounded attention ids and linkifies only resolver-proven items', () => {
    expect(findAttentionReferences('Open ?A3; not foo?A4, ??A5, ?A0 or ?A6x.')).toEqual([
      { id: 'A3', raw: '?A3', start: 5, end: 8 },
    ]);
    const tree: Tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '?A3 ?A8' }] }],
    };
    remarkSessionReferences({ resolveAttention: id => id === 'A8' })(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: '?A3 ' },
      {
        type: 'link',
        url: '#kteam-attention-reference?id=A8',
        title: 'Open attention ?A8',
        data: { hProperties: { 'data-attention-reference': 'A8' } },
        children: [{ type: 'text', value: '?A8' }],
      },
    ]);
  });

  test('skips existing links, inline/fenced code, and raw HTML', () => {
    const tree: Tree = {
      type: 'root',
      children: [
        { type: 'link', url: '/elsewhere', children: [{ type: 'text', value: '?A3' }] },
        { type: 'inlineCode', value: '?A3' },
        { type: 'code', value: '?A3' },
        { type: 'html', value: '<b>?A3</b>' },
      ],
    };
    const before = structuredClone(tree);
    remarkSessionReferences({ resolveAttention: () => true })(tree);
    expect(tree).toEqual(before);
  });

  test('round-trips only one valid reserved id', () => {
    expect(attentionReferenceHref('A12')).toBe('#kteam-attention-reference?id=A12');
    expect(parseAttentionReferenceHref('#kteam-attention-reference?id=A12')).toBe('A12');
    expect(parseAttentionReferenceHref('#kteam-attention-reference?id=A0')).toBeNull();
    expect(parseAttentionReferenceHref('#kteam-attention-reference?id=A1&id=A2')).toBeNull();
    expect(parseAttentionReferenceHref('#kteam-attention-reference?pin=A1')).toBeNull();
  });

  test('round-trips canonical pin identity without defining a bare UUID grammar', () => {
    const reference = { sessionId: 'ms-one', pinId: '19fafe4d-59f5-4e43-9bfd-cedb3d67831b' };
    expect(pinReferenceHref(reference)).toBe(
      '#kteam-pin-reference?session=ms-one&id=19fafe4d-59f5-4e43-9bfd-cedb3d67831b',
    );
    expect(parsePinReferenceHref(pinReferenceHref(reference))).toEqual(reference);
    expect(pinReferenceMarkdown({ ...reference, label: 'Deploy [production]' })).toBe(
      '[pin: Deploy \\[production\\]](#kteam-pin-reference?session=ms-one&id=19fafe4d-59f5-4e43-9bfd-cedb3d67831b)',
    );
    expect(parsePinReferenceHref('#kteam-pin-reference?session=ms-one&id=one&id=two')).toBeNull();
    expect(parsePinReferenceHref('#kteam-pin-reference?session=..&id=one')).toBeNull();
  });

  test('stamps only resolver-proven canonical pin links and refreshes their label', () => {
    const lookup = { sessionId: 'ms-one', pinId: 'pin-1' };
    const tree: Tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'link', url: pinReferenceHref(lookup), children: [{ type: 'text', value: 'pin: stale' }] },
            { type: 'text', value: ' ' },
            { type: 'link', url: pinReferenceHref(lookup), children: [{ type: 'text', value: 'forged' }] },
            { type: 'text', value: ' 19fafe4d-59f5-4e43-9bfd-cedb3d67831b' },
          ],
        },
      ],
    };
    remarkSessionReferences({
      resolvePin: reference =>
        reference.sessionId === lookup.sessionId && reference.pinId === lookup.pinId
          ? { ...reference, label: 'Current decision' }
          : null,
    })(tree);
    expect(tree.children?.[0]?.children).toEqual([
      {
        type: 'link',
        url: pinReferenceHref(lookup),
        title: 'Open pin: Current decision',
        data: { hProperties: { 'data-pin-reference': 'pin-1', 'data-pin-session': 'ms-one' } },
        children: [{ type: 'text', value: 'pin: Current decision' }],
      },
      { type: 'text', value: ' ' },
      { type: 'link', url: pinReferenceHref(lookup), children: [{ type: 'text', value: 'forged' }] },
      { type: 'text', value: ' 19fafe4d-59f5-4e43-9bfd-cedb3d67831b' },
    ]);
  });

  test('leaves a canonical-looking pin inert without authoritative proof', () => {
    const tree: Tree = {
      type: 'root',
      children: [
        {
          type: 'link',
          url: pinReferenceHref({ sessionId: 'ms-one', pinId: 'gone' }),
          children: [{ type: 'text', value: 'pin: missing' }],
        },
      ],
    };
    const before = structuredClone(tree);
    remarkSessionReferences({ resolvePin: () => null })(tree);
    expect(tree).toEqual(before);
  });
});
