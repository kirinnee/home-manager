import { describe, expect, test } from 'bun:test';
import { MAX_TASK_TITLE_WORDS, TASK_TITLE_GUIDANCE, taskTitleIssue, taskTitleWordCount } from './task-title';

describe('short task titles', () => {
  test('accepts up to five whitespace-delimited words', () => {
    expect(MAX_TASK_TITLE_WORDS).toBe(5);
    expect(taskTitleWordCount('  Build   task DAG filters  ')).toBe(4);
    expect(taskTitleIssue('Build the task DAG filters')).toBeNull();
  });

  test('directs excess detail into the description', () => {
    const issue = taskTitleIssue('Build the task DAG filters for phones');
    expect(issue).toContain('7 words');
    expect(issue).toContain(TASK_TITLE_GUIDANCE);
    expect(issue).toContain('description');
  });

  test('counts a hyphenated phrase as one predictable CLI word', () => {
    expect(taskTitleWordCount('Add phone-first pan and zoom')).toBe(5);
  });
});
