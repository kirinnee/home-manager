import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import {
  MOBILE_BACK,
  MOBILE_SETTINGS,
  compactCallsignFits,
  openTerminalFromTabs,
  sessionHeaderIdentity,
  viewSwitcherForSheet,
} from './SessionHeader';

describe('mobile Settings entry', () => {
  test('is a visible labelled sheet action in the existing details overflow', async () => {
    expect(MOBILE_SETTINGS).toEqual({
      label: 'Open settings',
      title: 'Open appearance and density settings',
    });
    const source = await Bun.file(new URL('./SessionHeader.tsx', import.meta.url).pathname).text();
    expect(source).toContain('actions={compact ? compactActions : undefined}');
    expect(source).toContain('requestAnimationFrame(() => store.openSettings())');
    expect(source).toContain('min-h-[44px]');
    expect(source).toContain('viewSwitcher={compactViewSwitcher}');
    expect(source).not.toContain('<ThemeToggle');
  });

  test('restores labels and closes the sheet after a view is selected', () => {
    let selected = '';
    let closed = false;
    const original = createElement('div', {
      iconOnly: true,
      onChange: (id: string) => {
        selected = id;
      },
    });
    const cloned = viewSwitcherForSheet(original, () => {
      closed = true;
    }) as ReactElement<{ iconOnly: boolean; onChange: (id: string) => void }>;

    expect(cloned.props.iconOnly).toBe(false);
    cloned.props.onChange('terminal');
    expect(selected).toBe('terminal');
    expect(closed).toBe(true);
  });

  test('reuses the page-owned tab callback to open Codex native pickers in Terminal', () => {
    let selected = '';
    const tabs = createElement('div', { onChange: (id: string) => (selected = id) });

    expect(openTerminalFromTabs(tabs)).toBe(true);
    expect(selected).toBe('terminal');
    expect(openTerminalFromTabs(createElement('div'))).toBe(false);
  });
});

describe('session top-bar identity', () => {
  test('makes the task primary and the callsign secondary on named sessions', () => {
    expect(sessionHeaderIdentity('Fix transcript scrolling', 'ada', 'session-id', 'batch')).toEqual({
      renderName: 'Fix transcript scrolling',
      primaryLabel: 'Fix transcript scrolling',
      callsign: 'Ada',
      hasNamedTask: true,
      hasDistinctCallsign: true,
      desktopSecondary: 'Ada',
    });
  });

  test('falls back to callsign and then id without duplicating the callsign', () => {
    expect(sessionHeaderIdentity(undefined, 'ada', 'session-id').renderName).toBe('Ada');
    expect(sessionHeaderIdentity('', undefined, 'session-id').renderName).toBe('session-id');
    expect(sessionHeaderIdentity('ada', 'ada', 'session-id').hasDistinctCallsign).toBe(false);
    expect(sessionHeaderIdentity('[Ada] Fix parser', 'ada', 'session-id').primaryLabel).toBe('Fix parser');
  });

  test('only admits secondary callsign text below 60% when the pair fits its slot', () => {
    expect(compactCallsignFits(59, 100, 80, 80)).toBe(true);
    expect(compactCallsignFits(60, 100, 80, 80)).toBe(false);
    expect(compactCallsignFits(40, 100, 81, 80)).toBe(false);
    expect(compactCallsignFits(40, 100, 70, 80, false)).toBe(false);
  });

  test('keeps the compact link name aligned with the visible task and optional callsign', () => {
    expect(MOBILE_BACK.label('Fix transcript scrolling')).toBe(
      'Back to all sessions. Currently Fix transcript scrolling',
    );
    expect(MOBILE_BACK.label('Fix transcript scrolling', 'Ada')).toBe(
      'Back to all sessions. Currently Fix transcript scrolling, Ada',
    );
  });

  test('keeps the task-bearing back target at the phone touch floor', async () => {
    const source = await Bun.file(new URL('./SessionHeader.tsx', import.meta.url).pathname).text();
    expect(source).toContain('inline-flex min-h-[44px] min-w-0 flex-1');
  });

  test('centres the fleet glyph inside an explicit 44px touch box', async () => {
    const source = await Bun.file(new URL('./SessionHeader.tsx', import.meta.url).pathname).text();
    expect(source).toContain('h-[44px] w-[44px]');
    expect(source).toContain('items-center justify-center');
  });
});
