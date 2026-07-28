import { describe, expect, test } from 'bun:test';
import { notificationCreatesAttention, notificationPolicyForAttention } from './notification-policy';

describe('attention and notifications stay separate', () => {
  test('question/permission reuse an existing session transition; board writes never present', () => {
    expect(notificationPolicyForAttention('question')).toEqual({
      notifyViaSessionTransition: true,
      kind: 'question',
    });
    expect(notificationPolicyForAttention('permission')).toEqual({
      notifyViaSessionTransition: true,
      kind: 'attention',
    });
  });

  test('task blockers and explicit agent requests are durable but quiet by default', () => {
    expect(notificationPolicyForAttention('task')).toEqual({ notifyViaSessionTransition: false, kind: null });
    expect(notificationPolicyForAttention('agent-raised')).toEqual({ notifyViaSessionTransition: false, kind: null });
  });

  test('informational notification kinds do not invent durable blockers', () => {
    expect(notificationCreatesAttention('completed')).toBe(false);
    expect(notificationCreatesAttention('failed')).toBe(false);
    expect(notificationCreatesAttention('attention')).toBe(false);
    expect(notificationCreatesAttention('question')).toBe(true);
  });
});
