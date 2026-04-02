import { existsSync, writeFileSync } from 'node:fs';
import { marked, Marked } from 'marked';
import markedTerminal from 'marked-terminal';

let configured = false;

/**
 * Render markdown string to terminal-friendly ANSI output.
 * Tables, headings, bold, code etc. are rendered with colors.
 * Uses terminal width for reflow.
 */
export function renderMarkdown(text: string): string {
  if (!configured) {
    marked.use({
      renderer: new (markedTerminal as any)({
        width: process.stdout.columns || 80,
        reflowText: true,
        showSectionPrefix: true,
        emoji: true,
        tab: 2,
      }),
    });
    configured = true;
  }

  return marked.parse(text) as string;
}

/**
 * Convert markdown to HTML (intermediate step for PDF conversion).
 * Uses a separate marked instance without terminal extensions.
 */
function markdownToHtml(mdContent: string, title?: string): string {
  const htmlMarked = new Marked();
  const body = htmlMarked.parse(mdContent) as string;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title ?? 'Document'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 8px; }
    h2 { border-bottom: 1px solid #eee; padding-bottom: 4px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f5f5f5; padding: 16px; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
    blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 16px; color: #666; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Convert markdown file to PDF.
 * Spec section 11.4: Built-in markdown to PDF conversion.
 *
 * Strategy: markdown → HTML → PDF via system tools.
 * Tries (in order): wkhtmltopdf, pandoc, chromium/chrome headless print.
 * Returns the output PDF path on success, or null if no converter is available.
 */
export function markdownToPdf(mdContent: string, outputPath: string, title?: string): string | null {
  const html = markdownToHtml(mdContent, title);
  const htmlPath = outputPath.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, html);

  // Helper to try a command and return true if it succeeded
  function tryConvert(cmd: string[]): boolean {
    try {
      const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
      return result.exitCode === 0 && existsSync(outputPath);
    } catch {
      return false; // executable not found
    }
  }

  // Try wkhtmltopdf
  if (tryConvert(['wkhtmltopdf', '--quiet', htmlPath, outputPath])) return outputPath;

  // Try pandoc
  if (tryConvert(['pandoc', htmlPath, '-o', outputPath])) return outputPath;

  // Try Chrome/Chromium headless
  for (const browser of [
    'chromium',
    'google-chrome',
    'chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (tryConvert([browser, '--headless', '--disable-gpu', `--print-to-pdf=${outputPath}`, htmlPath])) {
      return outputPath;
    }
  }

  // No converter available — return null but keep the HTML
  return null;
}
