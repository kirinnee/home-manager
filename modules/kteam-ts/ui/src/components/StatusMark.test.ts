import { describe, expect, test } from 'bun:test';
import type { SessionView } from '../types';
import { statusMark, nameToneClass } from './StatusMark';

function view(status: string, waiting?: unknown): SessionView {
  return { config: {}, state: { status, waiting } } as unknown as SessionView;
}

describe('statusMark shape vocabulary', () => {
  test('active work is a circle, terminal is a square, parked/waiting is a diamond', () => {
    expect(statusMark(view('running')).shape).toBe('circle');
    expect(statusMark(view('completed')).shape).toBe('square');
    expect(statusMark(view('failed')).shape).toBe('square');
    expect(statusMark(view('awaiting_user')).shape).toBe('diamond');
    // A declared wait parks an otherwise-running session.
    expect(statusMark(view('running', { condition: 'CI' })).shape).toBe('diamond');
  });
});

describe('nameToneClass — the lean-row name treatment', () => {
  test('a finished session recedes to muted; live and waiting stay at full strength', () => {
    // Finished (terminal) → receded. This is the greyscale-safe half of the row
    // variation: a lightness step, never a hue.
    expect(nameToneClass(view('completed'))).toBe('text-muted');
    expect(nameToneClass(view('failed'))).toBe('text-muted');
    expect(nameToneClass(view('stalled'))).toBe('text-muted');
    // Live and waiting anchor the eye, so they stay at --fg.
    expect(nameToneClass(view('running'))).toBe('text-fg');
    expect(nameToneClass(view('thinking'))).toBe('text-fg');
    expect(nameToneClass(view('awaiting_user'))).toBe('text-fg');
    expect(nameToneClass(view('running', { condition: 'CI' }))).toBe('text-fg');
  });
});
