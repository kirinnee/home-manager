import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEXT_SCALE_OPTIONS, SettingsPage, SettingsSheet } from './SettingsPage';
import { SETTINGS_DEFINITIONS } from '../lib/settings';

describe('SettingsPage', () => {
  test('renders the requested settings as visible labelled groups', () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain('>Settings</h1>');
    expect(html).toContain('aria-label="Text size"');
    expect(html).toContain('aria-label="Dashboard density"');
    expect(html).toContain('aria-label="Conversation width"');
    expect(html).toContain('aria-label="Colour mode"');
    expect(html).toContain('aria-label="Theme family"');
    expect(html).toContain('aria-label="Where speech is transcribed"');
    for (const label of ['Default', 'Large', 'Larger', 'Full', 'Compact', 'Minimal', 'Full-bleed', 'Readable column']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('Full-bleed · default');
    expect(html).toContain('Choosing it again will not change the conversation.');
  });

  test('keeps every direct settings action at the 44px touch floor', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    const radioButtons = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map(match => match[0]);
    expect(radioButtons.length).toBeGreaterThanOrEqual(9);
    for (const button of radioButtons) {
      // Text-size/density buttons state the floor directly; theme buttons use
      // h-control-sm, whose coarse-pointer token resolves to 44px.
      expect(button.includes('min-h-[44px]') || button.includes('h-control-sm') || button.includes('p-panel')).toBe(
        true,
      );
    }
  });

  test('uses a quiet 44px icon-only back target instead of a raised text button', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    const back = html.match(/<a[^>]*aria-label="Back to sessions"[^>]*>/)?.[0] ?? '';

    expect(back).toContain('href="/"');
    expect(back).toContain('title="All sessions"');
    expect(back).toContain('min-h-[44px]');
    expect(back).toContain('min-w-[44px]');
    expect(back).toContain('rounded-control');
    expect(back).not.toContain('kt-btn');
    expect(html).not.toContain('>Sessions</a>');
  });

  test('renders the Warden & failover link row pointing at the warden page', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('Warden &amp; failover');
    expect(html).toContain('href="/warden#config"');
  });

  test('has no autofocus path on touch', () => {
    const html = renderToStaticMarkup(<SettingsPage />).toLowerCase();
    expect(html).not.toContain('autofocus');
  });

  test('keeps text choices visible but disabled with an explanation when feature detection fails', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('id="text-scale-unsupported"');
    expect(html).toContain('Text sizing is unavailable in this browser');
    expect(html.match(/<button[^>]*role="radio"[^>]*disabled/g)?.length).toBe(3);
  });

  test('uses discrete non-shrinking text choices', () => {
    expect(TEXT_SCALE_OPTIONS.map(option => option.id)).toEqual(['default', 'large', 'larger']);
  });

  test('reuses the same catalog-driven controls in the mobile bottom sheet', () => {
    const html = renderToStaticMarkup(<SettingsSheet open target="density" onClose={() => undefined} />);
    expect(html).toContain('data-bottom-sheet="kt-settings-sheet"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Close settings"');
    expect(html).not.toContain('Back to sessions');
    expect(html).toContain('height:min(90dvh');
    expect(html).toContain('data-settings-sheet-scroller');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('overscroll-contain');
    expect(html).toContain('[touch-action:pan-y]');
    for (const definition of SETTINGS_DEFINITIONS) {
      expect(html).toContain(`data-setting-id="${definition.id}"`);
      expect(html).toContain(`>${definition.label}<`);
    }
  });
});
