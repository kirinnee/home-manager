import { describe, expect, test } from 'bun:test';
import { parseRoute } from './router';

describe('parseRoute', () => {
  test('recognises the static Settings route', () => {
    expect(parseRoute('/settings')).toEqual({ path: '/settings', isSettings: true });
  });

  test('recognises Warden as a first-class static route', () => {
    expect(parseRoute('/warden')).toEqual({ path: '/warden', isWarden: true });
  });

  test('keeps the existing session and new-session routes', () => {
    expect(parseRoute('/new')).toEqual({ path: '/new', isNew: true });
    expect(parseRoute('/session/ms123')).toEqual({ path: '/session/ms123', sessionId: 'ms123' });
  });

  test('unknown paths still fall back to the dashboard', () => {
    expect(parseRoute('/not-a-page')).toEqual({ path: '/' });
  });
});
