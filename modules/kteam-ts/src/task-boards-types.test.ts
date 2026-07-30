import { describe, expect, test } from 'bun:test';
import {
  TASK_BOARD_ROLE_ACTIONS,
  TASK_BOARD_CURRENT_COORDINATOR_ACTIONS,
  taskBoardActionForTaskAction,
  taskBoardActionsForRole,
} from './task-boards-types';

describe('task-board role contract', () => {
  test('roles expose the complete explicit action matrix without mark_done inheritance', () => {
    expect(taskBoardActionsForRole('none')).toEqual([]);
    expect(TASK_BOARD_ROLE_ACTIONS.read).toEqual(['read']);
    expect(TASK_BOARD_ROLE_ACTIONS.worker).toEqual(['read', 'status', 'note', 'feedback', 'file', 'link']);
    expect(TASK_BOARD_ROLE_ACTIONS.coordinator).not.toContain('grant_request');
    expect(TASK_BOARD_ROLE_ACTIONS.coordinator).not.toContain('grant_approve');
    expect(TASK_BOARD_CURRENT_COORDINATOR_ACTIONS).toContain('grant_approve');
    expect(TASK_BOARD_ROLE_ACTIONS.coordinator).not.toContain('mark_done');
    expect(TASK_BOARD_ROLE_ACTIONS.top_agent).not.toContain('mark_done');
    expect(Object.values(TASK_BOARD_ROLE_ACTIONS).flat()).not.toContain('acl_admin');
    expect(Object.values(TASK_BOARD_ROLE_ACTIONS).flat()).not.toContain('cutover');
  });

  test('phase and reopen are authorized through the status capability', () => {
    expect(taskBoardActionForTaskAction('phase')).toBe('status');
    expect(taskBoardActionForTaskAction('reopen')).toBe('status');
    expect(taskBoardActionForTaskAction('assign')).toBe('assign');
  });
});
