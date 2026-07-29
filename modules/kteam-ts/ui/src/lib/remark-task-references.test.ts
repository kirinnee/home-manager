import { describe, expect, test } from 'bun:test';
import {
  findTaskReferences,
  parseTaskReferenceHref,
  remarkTaskReferences,
  taskReferenceHref,
} from './remark-task-references';

type TaskReferenceTree = Parameters<ReturnType<typeof remarkTaskReferences>>[0];

describe('remark task references', () => {
  test('linkifies standalone legacy references while preserving their authored display', () => {
    const tree: TaskReferenceTree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'See #f12, #B7.' }] }],
    };
    remarkTaskReferences({ resolveTask: () => true })(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: 'See ' },
      {
        type: 'link',
        url: '#kteam-task-reference?id=F12',
        title: 'Open task #F12',
        data: { hProperties: { 'data-task-reference': 'F12' } },
        children: [{ type: 'text', value: '#f12' }],
      },
      { type: 'text', value: ', ' },
      {
        type: 'link',
        url: '#kteam-task-reference?id=B7',
        title: 'Open task #B7',
        data: { hProperties: { 'data-task-reference': 'B7' } },
        children: [{ type: 'text', value: '#B7' }],
      },
      { type: 'text', value: '.' },
    ]);
  });

  test('never nests links or changes inline/fenced code and word fragments', () => {
    const tree: TaskReferenceTree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'word#F1' }] },
        { type: 'inlineCode', value: '#F2' },
        { type: 'code', value: '#F3\nopaque' },
        { type: 'link', url: '/elsewhere', children: [{ type: 'text', value: '#F4' }] },
      ],
    };
    const before = structuredClone(tree);
    remarkTaskReferences({ resolveTask: () => true })(tree);
    expect(tree).toEqual(before);
  });

  test('exposes byte ranges from the same grammar and refuses unresolved ids', () => {
    expect(findTaskReferences('See #f12, word#B7 and #I3.')).toEqual([
      { id: 'F12', raw: '#f12', start: 4, end: 8 },
      { id: 'I3', raw: '#I3', start: 22, end: 25 },
    ]);
    const tree: TaskReferenceTree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '#F1 #F2' }] }],
    };
    remarkTaskReferences({ resolveTask: id => id === 'F2' })(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: '#F1 ' },
      {
        type: 'link',
        url: '#kteam-task-reference?id=F2',
        title: 'Open task #F2',
        data: { hProperties: { 'data-task-reference': 'F2' } },
        children: [{ type: 'text', value: '#F2' }],
      },
    ]);
  });

  test('round-trips only bounded task hrefs', () => {
    expect(taskReferenceHref('i42')).toBe('#kteam-task-reference?id=I42');
    expect(parseTaskReferenceHref('#kteam-task-reference?id=I42')).toBe('I42');
    expect(parseTaskReferenceHref('#kteam-task-reference?id=F1234567890')).toBeNull();
    expect(parseTaskReferenceHref('#kteam-task-reference?id=F1&id=F2')).toBeNull();
    expect(parseTaskReferenceHref('#kteam-task-reference?other=F1')).toBeNull();
  });
});
