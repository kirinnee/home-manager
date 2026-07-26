import { describe, expect, test } from 'bun:test';
import type { ProjectInfo, SessionView } from '../types';
import { parseRouteScope, resolveScopePrecedence, scopeRecoveryDecision } from './useProjectScope';

function session(id: string, cwd: string): SessionView {
  return {
    config: {
      id,
      name: `task ${id}`,
      binary: 'codex',
      harness: 'codex',
      modelHint: 'gpt-5.6',
      mode: 'auto',
      cwd,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      turn: 1,
      harnessSessionId: id,
      tmuxSession: id,
      watcherSession: id,
      intervalSeconds: 60,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 3,
      systemPromptFile: '',
      originalPromptFile: '',
    },
    state: { id, status: 'running', turn: 1, lastActivityAt: '2026-07-25T00:00:00.000Z' },
    directory: cwd,
  };
}
const proj = (name: string, path: string): ProjectInfo => ({ name, path });

describe('parseRouteScope — the URL tri-state', () => {
  test('a real path decodes to that scope', () => {
    expect(parseRouteScope('?project=%2Fhome%2Fk%2Frepo')).toBe('/home/k/repo');
  });

  test('present-but-empty is an unambiguous clear', () => {
    expect(parseRouteScope('?project=')).toBeNull();
  });

  test('no param means the URL says nothing', () => {
    expect(parseRouteScope('')).toBe('absent');
    expect(parseRouteScope('?other=1')).toBe('absent');
  });

  test('encode/decode round-trips paths with spaces and unicode', () => {
    const path = '/home/k/my project/café';
    expect(parseRouteScope('?project=' + encodeURIComponent(path))).toBe(path);
  });
});

describe('resolveScopePrecedence — the R2-P0 precedence table', () => {
  test('row 1: own history state (a string) wins', () => {
    expect(
      resolveScopePrecedence({ pathname: '/', historyState: { projectScope: '/a' }, search: '?project=%2Fb' }),
    ).toEqual({ apply: true, scope: '/a' });
  });

  test('row 1: own state EXPLICIT NULL beats a conflicting ?project=A URL (the R2-P0 case)', () => {
    // The forward-after-clear entry: state.projectScope === null must restore
    // null even though the URL of the earlier entry might still say A.
    expect(
      resolveScopePrecedence({ pathname: '/', historyState: { projectScope: null }, search: '?project=%2Fa' }),
    ).toEqual({ apply: true, scope: null });
  });

  test('row 2: no own state, a ?project=path URL applies (deep link)', () => {
    expect(resolveScopePrecedence({ pathname: '/', historyState: null, search: '?project=%2Fa' })).toEqual({
      apply: true,
      scope: '/a',
    });
    // A bare `{}` state (every non-scope push writes this) has no field, so it
    // falls through to the URL exactly like a null state.
    expect(resolveScopePrecedence({ pathname: '/', historyState: {}, search: '?project=%2Fa' })).toEqual({
      apply: true,
      scope: '/a',
    });
  });

  test('row 3: no own state, ?project= empty clears', () => {
    expect(resolveScopePrecedence({ pathname: '/', historyState: {}, search: '?project=' })).toEqual({
      apply: true,
      scope: null,
    });
  });

  test('row 4: no own state, no param — leave the persisted store value alone', () => {
    expect(resolveScopePrecedence({ pathname: '/', historyState: {}, search: '' })).toEqual({ apply: false });
    expect(resolveScopePrecedence({ pathname: '/', historyState: null, search: '' })).toEqual({ apply: false });
  });

  test('off the dashboard route, scope is never parsed', () => {
    expect(
      resolveScopePrecedence({ pathname: '/session/x', historyState: { projectScope: '/a' }, search: '?project=%2Fa' }),
    ).toEqual({ apply: false });
  });

  test('an own-state empty string degrades to null (mirrors the store parse)', () => {
    expect(resolveScopePrecedence({ pathname: '/', historyState: { projectScope: '' }, search: '' })).toEqual({
      apply: true,
      scope: null,
    });
  });
});

describe('scopeRecoveryDecision — one-shot missing-folder recovery', () => {
  const projects = [proj('nitroso', '/home/k/nitroso')];
  const inScope = [session('a', '/home/k/nitroso')];

  test('never fires before hydration (sessions === null)', () => {
    expect(scopeRecoveryDecision({ scope: '/home/k/gone', sessions: null, projects, alreadyRecovered: false })).toBe(
      false,
    );
  });

  test('never fires when there is no scope', () => {
    expect(scopeRecoveryDecision({ scope: null, sessions: inScope, projects, alreadyRecovered: false })).toBe(false);
  });

  test('fires exactly once — the ref guard suppresses the repeat', () => {
    const missing = { scope: '/home/k/gone', sessions: [] as SessionView[], projects, alreadyRecovered: false };
    expect(scopeRecoveryDecision(missing)).toBe(true);
    expect(scopeRecoveryDecision({ ...missing, alreadyRecovered: true })).toBe(false);
  });

  test('a resolvable scope is kept — a filtered-empty folder is NOT recovered', () => {
    // The folder is registered (resolvable) even though the passed session list
    // is empty after filters; recovery must not clear it.
    expect(scopeRecoveryDecision({ scope: '/home/k/nitroso', sessions: [], projects, alreadyRecovered: false })).toBe(
      false,
    );
    // And a scope backed by a live session is likewise kept.
    expect(
      scopeRecoveryDecision({ scope: '/home/k/nitroso', sessions: inScope, projects, alreadyRecovered: false }),
    ).toBe(false);
  });
});
