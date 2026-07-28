import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Quota } from '../lib/usage';
import { ComposerQuota, composerQuotaSpoken, quotaPercentLabel } from './ComposerQuota';

function render(quota: Quota | null): string {
  return renderToStaticMarkup(<ComposerQuota quota={quota} />);
}

/** The visible (aria-hidden) tokens, stripped of markup — what the eye reads
 *  on the context line. */
function visibleText(html: string): string {
  const withoutSrOnly = html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, '');
  return withoutSrOnly
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('quotaPercentLabel', () => {
  test('unknown is an em-dash, never a number', () => {
    expect(quotaPercentLabel(undefined)).toBe('—');
    expect(quotaPercentLabel(Number.NaN)).toBe('—');
    expect(quotaPercentLabel(Number.POSITIVE_INFINITY)).toBe('—');
  });

  test('zero is a real reading and renders as 0%', () => {
    expect(quotaPercentLabel(0)).toBe('0%');
  });

  test('clamps impossible values into [0,100] and rounds', () => {
    expect(quotaPercentLabel(107)).toBe('100%');
    expect(quotaPercentLabel(-3)).toBe('0%');
    expect(quotaPercentLabel(12.6)).toBe('13%');
  });
});

describe('ComposerQuota', () => {
  test('both windows known: labelled pair, not a bare riddle', () => {
    const html = render({ fiveHourPercent: 7, weeklyPercent: 12 });
    expect(visibleText(html)).toBe('5h 7% · wk 12%');
    // The words are carried for AT and the tooltip.
    expect(html).toContain('5-hour window 7% used');
    expect(html).toContain('weekly window 12% used');
  });

  test('FIXED SHAPE: null quota still renders the pair, with dashes', () => {
    expect(visibleText(render(null))).toBe('5h — · wk —');
  });

  test('unknown is never zero: an absent window is a dash beside a known one', () => {
    const html = render({ fiveHourPercent: 42 });
    expect(visibleText(html)).toBe('5h 42% · wk —');
    expect(html).not.toContain('wk 0%');
    expect(html).toContain('weekly window unknown');
  });

  test('0% used renders as 0%, not as a dash', () => {
    expect(visibleText(render({ fiveHourPercent: 0, weeklyPercent: 0 }))).toBe('5h 0% · wk 0%');
  });

  test('the shape is identical known vs unknown (height-stability proxy)', () => {
    // Same element structure either way: one outer span, one sr-only, one
    // aria-hidden pair. Only text and tone classes change — never the number
    // or nesting of elements, which is what layout height keys off.
    const shape = (html: string) =>
      html
        .replace(/>[^<]*</g, '><')
        .replace(/ title="[^"]*"/g, '')
        .replace(/ class="[^"]*"/g, '');
    expect(shape(render(null))).toBe(shape(render({ fiveHourPercent: 88, weeklyPercent: 3 })));
  });

  test('tone ramp matches ctx%: quiet, warn at 75, err at 90', () => {
    expect(render({ fiveHourPercent: 50, weeklyPercent: 50 })).not.toMatch(/text-(warn|err)/);
    expect(render({ fiveHourPercent: 75, weeklyPercent: 10 })).toContain('text-warn');
    expect(render({ fiveHourPercent: 92, weeklyPercent: 10 })).toContain('text-err');
  });

  test('at limit takes err tone and says so in the spoken text', () => {
    const html = render({ fiveHourPercent: 100, weeklyPercent: 40, atLimit: true });
    expect(html).toContain('text-err');
    expect(html).toContain('AT LIMIT');
  });

  test('an auth failure is not a quota: says login, shows no percentages', () => {
    const html = render({ authOk: false, fiveHourPercent: 55, weeklyPercent: 55 });
    expect(visibleText(html)).toBe('quota auth!');
    expect(html).not.toContain('55%');
    expect(html).toContain('needs logging in');
  });

  test('single-line contract: nowrap + shrink-0 on the readout', () => {
    const html = render({ fiveHourPercent: 7, weeklyPercent: 12 });
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('shrink-0');
  });

  test('the tooltip carries the full-words explanation', () => {
    const html = render({ fiveHourPercent: 7, weeklyPercent: 12 });
    expect(html).toMatch(/title="account usage: 5-hour window 7% used, weekly window 12% used"/);
  });
});

describe('composerQuotaSpoken', () => {
  test('spells out both windows in words', () => {
    expect(composerQuotaSpoken({ fiveHourPercent: 7, weeklyPercent: 12 })).toBe(
      'account usage: 5-hour window 7% used, weekly window 12% used',
    );
  });

  test('null quota is spoken as unknown, never as zero', () => {
    expect(composerQuotaSpoken(null)).toBe('account usage: 5-hour window unknown, weekly window unknown');
  });

  test('auth failure replaces the readings entirely', () => {
    expect(composerQuotaSpoken({ authOk: false })).toBe('account usage unavailable: this wrapper needs logging in');
  });
});
