import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';
import { WardenPage } from './WardenPage';

describe('WardenPage', () => {
  test('is a labelled, full-width destination without duplicate route chrome', () => {
    const html = renderToStaticMarkup(<WardenPage />);
    expect(html).toContain('>Warden</h1>');
    expect(html).toContain('Who needs you, then sweeps, accounts, and recent verdicts.');
    expect(html).not.toContain('href="/"');
  });

  test('leads with who needs you, in ADHD-friendly point form', () => {
    const html = renderToStaticMarkup(<WardenPage />);
    // The section is present and speaks before it has data — the reader must
    // never meet a blank space where the answer goes.
    expect(html).toContain('Who needs you');
    expect(html).toContain('Checking which agents need you');
  });

  // The sweep strip, the account editor and the verdict list all render nothing
  // until their fetches land, so a rendered-markup assertion cannot see the
  // order they are mounted in. The mount order IS the requirement here — the
  // outcome must lead the page — so it is pinned at the source.
  test('mounts attention above the strip, configuration and verdict history', () => {
    const source = readFileSync(new URL('./WardenPage.tsx', import.meta.url), 'utf8');
    const at = (needle: string) => {
      const index = source.indexOf(needle);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('<WardenStrip page />')).toBeGreaterThan(at('<WardenAttention />'));
    expect(at('<WardenConfigCard />')).toBeGreaterThan(at('<WardenAttention />'));
    expect(at('<WardenVerdicts page />')).toBeGreaterThan(at('<WardenAttention />'));
  });

  test('leaves the legacy dashboard mounts inert', () => {
    expect(renderToStaticMarkup(<WardenStrip />)).toBe('');
    expect(renderToStaticMarkup(<WardenVerdicts />)).toBe('');
  });
});
