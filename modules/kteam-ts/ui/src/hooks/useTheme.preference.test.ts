import { describe, expect, test } from 'bun:test';
import { TEXT_SCALE_FACTORS, applyTextScale, parseThemePref, supportsTextScale } from './useTheme';

describe('theme-owned text scale preference', () => {
  test('parses the additive field without breaking an older JSON preference', () => {
    expect(parseThemePref(JSON.stringify({ family: 'ember', mode: 'dark' }))).toEqual({
      family: 'ember',
      mode: 'dark',
      textScale: 'default',
    });
    expect(parseThemePref(JSON.stringify({ family: 'contrast', mode: 'light', textScale: 'larger' }))).toEqual({
      family: 'contrast',
      mode: 'light',
      textScale: 'larger',
    });
  });

  test('keeps every legacy theme spelling and defaults its scale', () => {
    expect(parseThemePref('dark')).toEqual({ family: 'studio', mode: 'dark', textScale: 'default' });
    expect(parseThemePref('mission-light')).toEqual({
      family: 'mission',
      mode: 'light',
      textScale: 'default',
    });
  });

  test('rejects an unknown scale without discarding valid theme fields', () => {
    expect(parseThemePref(JSON.stringify({ family: 'neo', mode: 'system', textScale: 'tiny' }))).toEqual({
      family: 'neo',
      mode: 'system',
      textScale: 'default',
    });
  });

  test('never shrinks the interface below its existing touch-target floor', () => {
    expect(TEXT_SCALE_FACTORS).toEqual({ default: 1, large: 1.125, larger: 1.25 });
    expect(Math.min(...Object.values(TEXT_SCALE_FACTORS))).toBeGreaterThanOrEqual(1);
  });

  test('feature-detects percentage support, including WebKit, and rejects name-only support', () => {
    expect(supportsTextScale((property, value) => property === 'text-size-adjust' && value === '125%')).toBe(true);
    expect(supportsTextScale((property, value) => property === '-webkit-text-size-adjust' && value === '125%')).toBe(
      true,
    );
    expect(supportsTextScale((_property, value) => value === 'auto')).toBe(false);
  });

  test('publishes both the named choice and its root scale', () => {
    const dataset: Record<string, string> = {};
    const properties = new Map<string, string>();
    const root = {
      dataset,
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    } as unknown as HTMLElement;

    applyTextScale(root, 'large');

    expect(dataset.textScale).toBe('large');
    expect(properties.get('text-size-adjust')).toBe('112.5%');
    expect(properties.get('-webkit-text-size-adjust')).toBe('112.5%');
    expect(properties.has('zoom')).toBe(false);
  });

  test('the pre-paint bootstrap uses the same key, choices, and factors', async () => {
    const html = await Bun.file(new URL('../../index.html', import.meta.url).pathname).text();
    expect(html).toContain("var KEY = 'kteam-theme'");
    expect(html).toContain('var TEXT_SCALES = { default: 1, large: 1.125, larger: 1.25 }');
    expect(html).toContain("setAttribute('data-text-scale', textScale)");
    expect(html).toContain("style.setProperty('text-size-adjust', TEXT_SCALES[textScale] * 100 + '%')");
    expect(html).toContain("style.setProperty('-webkit-text-size-adjust', TEXT_SCALES[textScale] * 100 + '%')");
  });
});
