import { describe, expect, test } from 'bun:test';
import {
  fetchRuntimeModelCatalog,
  parseRuntimeModelCatalog,
  requireRuntimeModelCatalogHarness,
  type RuntimeModelCatalog,
} from './runtime-models';

describe('runtime model catalog client', () => {
  const catalog: RuntimeModelCatalog = {
    harness: 'codex',
    source: 'codex-app-server',
    choices: [
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Frontier',
        isDefault: true,
        reasoningEfforts: [
          { value: 'medium', description: 'Balanced' },
          { value: 'ultra', description: 'Delegates' },
        ],
        defaultReasoningEffort: 'medium',
      },
    ],
  };

  test('preserves opaque ids and advertised effort order', () => {
    expect(parseRuntimeModelCatalog(catalog)).toEqual(catalog);
  });

  test('rejects malformed choices instead of rendering guessed values', () => {
    expect(() =>
      parseRuntimeModelCatalog({ harness: 'codex', source: 'codex-app-server', choices: [{ value: 'm' }] }),
    ).toThrow('invalid runtime model choice');
  });

  test('refuses a catalog for a different harness before rendering it', () => {
    expect(() => requireRuntimeModelCatalogHarness(parseRuntimeModelCatalog(catalog), 'claude')).toThrow(
      'codex model catalog for a claude session',
    );
  });

  test('uses the session-scoped route and encodes an awkward id', async () => {
    let requested = '';
    const result = await fetchRuntimeModelCatalog('session/odd', async input => {
      requested = String(input);
      return new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } });
    });
    expect(requested).toBe('/v1/sessions/session%2Fodd/runtime-models');
    expect(result.choices[0]?.reasoningEfforts.map(item => item.value)).toEqual(['medium', 'ultra']);
  });

  test('surfaces the daemon reason when probing fails', async () => {
    await expect(
      fetchRuntimeModelCatalog(
        's',
        async () =>
          new Response(JSON.stringify({ error: 'Codex model catalog probe timed out', code: 'catalog_timeout' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ).rejects.toThrow('Codex model catalog probe timed out');
  });
});
