import { describe, expect, test } from 'bun:test';
import { SETTINGS_DEFINITIONS, isSettingId, settingsHref, settingsPaletteEntries } from './settings';

describe('shared settings catalog', () => {
  test('owns the rendered controls in stable order', () => {
    expect(SETTINGS_DEFINITIONS.map(setting => setting.id)).toEqual([
      'text-size',
      'density',
      'chat-width',
      'theme',
      'dictation',
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
        description: 'Appearance, text size, theme, and dashboard density.',
        settingId: null,
      },
    ]);
  });

  test('searches the same catalog and targets the matching control', () => {
    expect(settingsPaletteEntries('text size')[0]?.settingId).toBe('text-size');
    expect(settingsPaletteEntries('density')[0]?.settingId).toBe('density');
    expect(settingsPaletteEntries('dark').map(entry => entry.settingId)).toContain('theme');
    expect(settingsPaletteEntries('microphone').map(entry => entry.settingId)).toContain('dictation');
  });

  test('builds deep links only for known setting ids', () => {
    expect(isSettingId('theme')).toBe(true);
    expect(isSettingId('dictation')).toBe(true);
    expect(isSettingId('unknown')).toBe(false);
    expect(settingsHref()).toBe('/settings');
    expect(settingsHref('density')).toBe('/settings#density');
  });
});
