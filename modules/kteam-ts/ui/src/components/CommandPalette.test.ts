import { describe, expect, test } from 'bun:test';
import {
  matchesBrowserLoginCommand,
  paletteDestinations,
  paletteFocusPolicy,
  settingsDestinationHrefs,
} from './CommandPalette';
import { APP_BAR_DESTINATIONS } from './AppBar';
import { destinationExists } from '../lib/palette-destinations';
import { settingsPaletteEntries } from '../lib/settings';

describe('CommandPalette focus policy', () => {
  test('lands on the non-text dialog surface for touch-affected input', () => {
    expect(paletteFocusPolicy(true)).toEqual({ dialogAutoFocus: true, inputAutoFocus: false });
  });

  test('keeps search-first keyboard flow for unambiguous desktop input', () => {
    expect(paletteFocusPolicy(false)).toEqual({ dialogAutoFocus: false, inputAutoFocus: true });
  });
});

describe('CommandPalette destinations', () => {
  test('every top-bar destination is searchable by name', () => {
    for (const destination of APP_BAR_DESTINATIONS) {
      const hrefs = paletteDestinations(destination.label).map(entry => entry.href);
      expect(hrefs).toContain(destination.route);
    }
  });

  test('opening cold shows where you can go — the bar’s destinations included', () => {
    const hrefs = paletteDestinations('').map(entry => entry.href);
    for (const destination of APP_BAR_DESTINATIONS) expect(hrefs).toContain(destination.route);
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/new');
  });

  test('nothing is offered that the router would not resolve to itself', () => {
    for (const query of ['', 'a', 'settings', 'warden', 'learning', 'analytics', 'new']) {
      for (const entry of paletteDestinations(query)) {
        expect(destinationExists(entry.href)).toBe(true);
      }
    }
  });

  test('the Settings row the settings group already owns is not duplicated', () => {
    const settings = settingsPaletteEntries('settings');
    const taken = settingsDestinationHrefs(settings);
    expect(taken).toContain('/settings');
    expect(paletteDestinations('settings', taken).map(entry => entry.href)).not.toContain('/settings');
  });

  test('a settings SECTION does not suppress the Settings page itself', () => {
    const taken = settingsDestinationHrefs(settingsPaletteEntries('density'));
    expect(taken.every(href => href !== '/settings')).toBe(true);
    expect(paletteDestinations('settings', taken).map(entry => entry.href)).toContain('/settings');
  });

  test('the warden config link and the warden page stay distinct destinations', () => {
    const taken = settingsDestinationHrefs(settingsPaletteEntries('warden'));
    expect(taken).toContain('/warden#config');
    expect(paletteDestinations('warden', taken).map(entry => entry.href)).toContain('/warden');
  });
});

describe('CommandPalette browser login command', () => {
  test('is discoverable from every advertised search phrase', () => {
    for (const query of ['', 'browser', 'login', 'sign in', 'shared Chrome']) {
      expect(matchesBrowserLoginCommand(query)).toBe(true);
    }
    expect(matchesBrowserLoginCommand('analytics')).toBe(false);
  });
});
