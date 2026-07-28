import { describe, expect, test } from 'bun:test';
import { parseTaskReferenceHref, remarkTaskReferences, taskReferenceHref } from './remark-task-references';

type TaskReferenceTree = Parameters<ReturnType<typeof remarkTaskReferences>>[0];

describe('remark task references', () => {
  test('linkifies standalone legacy references while preserving their authored display', () => {
    const tree: TaskReferenceTree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'See #f12, #B7.' }] }],
    };
    remarkTaskReferences()(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: 'See ' },
      {
        type: 'link',
        url: '/tasks/F12',
        title: 'Open task #F12',
        children: [{ type: 'text', value: '#f12' }],
      },
      { type: 'text', value: ', ' },
      {
        type: 'link',
        url: '/tasks/B7',
        title: 'Open task #B7',
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
    remarkTaskReferences()(tree);
    expect(tree).toEqual(before);
  });

  test('round-trips only bounded task hrefs', () => {
    expect(taskReferenceHref('i42')).toBe('/tasks/I42');
    expect(parseTaskReferenceHref('/tasks/I42')).toBe('I42');
    expect(parseTaskReferenceHref('/tasks/F1234567890')).toBeNull();
    expect(parseTaskReferenceHref('/tasks/not-a-task')).toBeNull();
  });
});
