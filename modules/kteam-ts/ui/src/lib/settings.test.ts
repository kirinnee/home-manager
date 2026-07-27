import { describe, expect, test } from 'bun:test';
import { SETTINGS_DEFINITIONS, SETTINGS_LINKS, isSettingId, settingsHref, settingsPaletteEntries } from './settings';

describe('shared settings catalog', () => {
  test('owns the rendered controls in stable order', () => {
    expect(SETTINGS_DEFINITIONS.map(setting => setting.id)).toEqual([
      'text-size',
      'density',
      'chat-width',
      'theme',
      'dictation',
      'notifications',
    ]);
    expect(new Set(SETTINGS_DEFINITIONS.map(setting => setting.id)).size).toBe(SETTINGS_DEFINITIONS.length);
    for (const setting of SETTINGS_DEFINITIONS) {
      expect(setting.label.length).toBeGreaterThan(0);
      expect(setting.description.length).toBeGreaterThan(0);
      expect(setting.keywords.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('offers an explicit Open settings command before any query', () => {
    expect(settingsPaletteEntries('')).toEqual([
      {
        id: 'open-settings',
        label: 'Open settings',
        description: 'Appearance, text size, conversation width, theme, and dashboard density.',
        settingId: null,
      },
    ]);
  });

  test('searches the same catalog and targets the matching control', () => {
    expect(settingsPaletteEntries('text size')[0]?.settingId).toBe('text-size');
    expect(settingsPaletteEntries('density')[0]?.settingId).toBe('density');
    expect(settingsPaletteEntries('conversation width')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries('full-bleed')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries('dark').map(entry => entry.settingId)).toContain('theme');
    expect(settingsPaletteEntries('microphone').map(entry => entry.settingId)).toContain('dictation');
  });

  test("the enhancement feature is findable by its own names, not just dictation's", () => {
    // These are the words someone who knows the FEATURE (but not where it
    // lives) actually types. Each must reach the dictation section.
    for (const query of ['enhance', 'enhancement', 'dictionary', 'vocabulary', 'glossary', 'jargon', 'correction']) {
      expect(settingsPaletteEntries(query).map(entry => entry.settingId)).toContain('dictation');
    }
  });

  test('link rows: warden & failover is findable and points at /warden#config', () => {
    const warden = SETTINGS_LINKS.find(link => link.id === 'warden');
    expect(warden?.href).toBe('/warden#config');
    for (const query of ['failover', 'round robin', 'warden', 'fallback']) {
      const entry = settingsPaletteEntries(query).find(item => item.id === 'setting-link-warden');
      expect(entry?.href).toBe('/warden#config');
      expect(entry?.settingId).toBeNull();
    }
    // Link rows never appear in the unfiltered palette (only the open command does).
    expect(settingsPaletteEntries('').some(item => item.id === 'setting-link-warden')).toBe(false);
  });

  test('link row ids never collide with the control catalog', () => {
    const ids = new Set(SETTINGS_DEFINITIONS.map(setting => setting.id as string));
    for (const link of SETTINGS_LINKS) expect(ids.has(link.id)).toBe(false);
  });

  test('builds deep links only for known setting ids', () => {
    expect(isSettingId('theme')).toBe(true);
    expect(isSettingId('dictation')).toBe(true);
    expect(isSettingId('unknown')).toBe(false);
    expect(settingsHref()).toBe('/settings');
    expect(settingsHref('density')).toBe('/settings#density');
  });
});
