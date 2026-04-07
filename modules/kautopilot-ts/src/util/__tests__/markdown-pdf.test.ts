import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('markdownToPdf (spec section 11.4)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-pdf-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates HTML intermediate from markdown', () => {
    const { markdownToPdf } = require('../markdown');
    const mdContent = '# Test Report\n\nThis is a test report.\n\n## Section 1\n\n- Item A\n- Item B';
    const pdfPath = join(tempDir, 'report.pdf');

    // Even if no PDF converter is available, the HTML intermediate should be created
    markdownToPdf(mdContent, pdfPath, 'Test Report');

    const htmlPath = join(tempDir, 'report.html');
    expect(existsSync(htmlPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf-8');
    expect(html).toContain('Test Report');
    expect(html).toContain('<h1');
    expect(html).toContain('<li');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('markdownToPdf returns null when no converter available', () => {
    const { markdownToPdf } = require('../markdown');
    const mdContent = '# Minimal';
    const pdfPath = join(tempDir, 'minimal.pdf');

    // In most test environments, no PDF converter is available
    const result = markdownToPdf(mdContent, pdfPath, 'Minimal');
    // Result is null if no converter found, or the path if one is available
    expect(result === null || result === pdfPath).toBe(true);
  });

  it('markdown remains the editable artifact', () => {
    // Spec section 11.4: Markdown remains the editable review artifact. PDF is a delivery/export format.
    const mdContent = '# Editable Report\n\nThis content can be edited.';
    const pdfPath = join(tempDir, 'report.pdf');

    const { markdownToPdf } = require('../markdown');
    markdownToPdf(mdContent, pdfPath, 'Editable Report');

    // HTML intermediate preserves markdown content
    const htmlPath = join(tempDir, 'report.html');
    const html = readFileSync(htmlPath, 'utf-8');
    expect(html).toContain('Editable Report');
    expect(html).toContain('This content can be edited');
  });
});
