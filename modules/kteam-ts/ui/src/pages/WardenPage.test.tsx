import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';
import { WardenPage } from './WardenPage';

describe('WardenPage', () => {
  test('is a labelled, full-width destination without duplicate route chrome', () => {
    const html = renderToStaticMarkup(<WardenPage />);
    expect(html).toContain('>Warden</h1>');
    expect(html).toContain('Fleet sweeps, anomalies, and recent supervision verdicts.');
    expect(html).not.toContain('href="/"');
  });

  test('leaves the legacy dashboard mounts inert', () => {
    expect(renderToStaticMarkup(<WardenStrip />)).toBe('');
    expect(renderToStaticMarkup(<WardenVerdicts />)).toBe('');
  });
});
