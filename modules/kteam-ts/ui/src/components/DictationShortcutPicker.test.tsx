import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_DICTATION_SHORTCUT } from '../lib/stt/dictation-shortcut';
import { DictationShortcutPicker } from './DictationShortcutPicker';

function render() {
  return renderToStaticMarkup(
    <DictationShortcutPicker binding={{ ...DEFAULT_DICTATION_SHORTCUT, modifiers: [] }} onChange={() => {}} />,
  );
}

describe('DictationShortcutPicker', () => {
  test('shows the real default, hybrid gesture, phone fallback and never-send promise', () => {
    const html = render();
    expect(html).toContain('Alt (either side)');
    expect(html).toContain('Hold to record and release to finish');
    expect(html).toContain('tap once to latch');
    expect(html).toContain('On a phone, use the mic button');
    expect(html).toContain('never sends the message');
  });

  test('warns about bare Alt before the reader relies on it', () => {
    const html = render();
    expect(html).toContain('Bare Alt can be intercepted');
    expect(html).toContain('window manager');
  });

  test('is a key-capture button, not a shortcut spelling field', () => {
    const html = render();
    expect(html).toContain('Change shortcut');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('autofocus');
  });

  test('keeps the interactive target at least 44px', () => {
    expect(render()).toMatch(/<button[^>]*min-h-\[44px\][^>]*>/u);
  });
});
