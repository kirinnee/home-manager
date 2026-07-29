import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WebTerminals, type WebTerminalsDependencies } from './WebTerminals';
import { webTerminalApi } from '../lib/web-terminals';

const dependencies: WebTerminalsDependencies = {
  api: webTerminalApi,
  streamUrl: () => 'ws://example.test/terminal',
  loadXterm: async () => {
    throw new Error('effects do not run during static rendering');
  },
};

describe('WebTerminals shell', () => {
  test('starts as an honest on-demand terminal deck and never steals focus', () => {
    const html = renderToStaticMarkup(
      <WebTerminals sessionId="ms-test" cwd="/repo/worktree" dependencies={dependencies} />,
    );
    expect(html).toContain('Shell terminals');
    expect(html).toContain('No shell terminals open');
    expect(html).toContain('New terminal');
    expect(html).toContain('/repo/worktree');
    expect(html).toContain('survives page reloads');
    expect(html).not.toContain('autofocus');
  });

  test('terminal tabs and their create control keep the 44px target floor', async () => {
    const css = await Bun.file(new URL('./web-terminals.css', import.meta.url).pathname).text();
    const source = await Bun.file(new URL('./WebTerminals.tsx', import.meta.url).pathname).text();
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('width: 44px');
    expect(source).toContain('await dependencies.api.close(sessionId, active.id)');
    expect(source).toContain('This ends its shell process.');
  });
});
