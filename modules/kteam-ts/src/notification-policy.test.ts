import { describe, expect, test } from 'bun:test';
import { notificationCreatesAttention, notificationPolicyForAttention } from './notification-policy';

describe('attention and notifications stay separate', () => {
  test('question reuses its existing session transition; its board write never presents twice', () => {
    expect(notificationPolicyForAttention('question')).toEqual({
      notifyViaSessionTransition: true,
      notifyOnNewItem: false,
      kind: 'question',
    });
  });

  test('task blockers and explicit agent requests notify when the durable item is created', () => {
    expect(notificationPolicyForAttention('task')).toEqual({
      notifyViaSessionTransition: false,
      notifyOnNewItem: true,
      kind: 'attention',
    });
    expect(notificationPolicyForAttention('agent-raised')).toEqual({
      notifyViaSessionTransition: false,
      notifyOnNewItem: true,
      kind: 'attention',
    });
  });

  test('every source presents through exactly one path', () => {
    for (const source of ['question', 'task', 'agent-raised'] as const) {
      const policy = notificationPolicyForAttention(source);
      expect(policy.notifyViaSessionTransition && policy.notifyOnNewItem).toBe(false);
    }
  });

  test('informational notification kinds do not invent durable blockers', () => {
    expect(notificationCreatesAttention('completed')).toBe(false);
    expect(notificationCreatesAttention('failed')).toBe(false);
    expect(notificationCreatesAttention('attention')).toBe(false);
    expect(notificationCreatesAttention('question')).toBe(true);
  });
});
