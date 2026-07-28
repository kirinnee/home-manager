import { describe, expect, test } from 'bun:test';
import { RuntimeModelsApi, matchRuntimeModelsRoute, runtimeModelsWardenDenial } from './runtime-models-api';

// The human-admin predicate itself is covered in actor-context.test.ts, where it
// now lives. What matters HERE is only that this route applies it.
describe('runtime model catalog API', () => {
  test('matches only exact, traversal-safe session routes', () => {
    expect(matchRuntimeModelsRoute('/v1/sessions/ms1abc-1234/runtime-models')).toEqual({
      sessionId: 'ms1abc-1234',
    });
    expect(matchRuntimeModelsRoute('/v1/sessions/ms1abc-1234/runtime-models/')).toEqual({
      sessionId: 'ms1abc-1234',
    });
    for (const pathname of [
      '/v1/sessions/..%2Fsecret/runtime-models',
      '/v1/sessions/session%2Fodd/runtime-models',
      '/v1/sessions/%2Ehidden/runtime-models',
      '/v1/sessions/bad%ZZ/runtime-models',
      '/v1/sessions/s1/runtime-models/extra',
    ]) {
      expect(matchRuntimeModelsRoute(pathname)).toBeNull();
    }
  });

  test('marks the entire catalog surface admin-only before generic warden GET access', () => {
    expect(runtimeModelsWardenDenial('GET', '/v1/sessions/s1/runtime-models')).toBe('enumerate session runtime models');
    expect(runtimeModelsWardenDenial('POST', '/v1/sessions/s1/runtime-models/refresh')).toBe(
      'enumerate session runtime models',
    );
    expect(runtimeModelsWardenDenial('GET', '/v1/sessions/s1')).toBeNull();
  });

  test('serves the catalog only to a server-resolved human admin actor', async () => {
    let calls = 0;
    const api = new RuntimeModelsApi({
      runtimeModels: async id => {
        calls++;
        return {
          harness: 'codex',
          source: 'codex-app-server',
          choices: [{ value: id, label: 'Selected account model', reasoningEfforts: [{ value: 'high' }] }],
        };
      },
    });
    const url = new URL('http://localhost/v1/sessions/s1/runtime-models');

    expect(await api.handle({ method: 'GET', url, actor: 'admin-ui' })).toEqual({
      status: 200,
      body: {
        harness: 'codex',
        source: 'codex-app-server',
        choices: [{ value: 's1', label: 'Selected account model', reasoningEfforts: [{ value: 'high' }] }],
      },
    });
    expect((await api.handle({ method: 'GET', url, actor: 'peer:s1' }))?.status).toBe(403);
    expect((await api.handle({ method: 'GET', url, actor: 'warden:s1' }))?.status).toBe(403);
    expect(calls).toBe(1);
  });

  test('returns a retryable catalog error without disguising it as a missing route', async () => {
    const timeout = new RuntimeModelsApi({
      runtimeModels: async () => {
        throw new Error('Codex model catalog probe timed out after 10s');
      },
    });
    const response = await timeout.handle({
      method: 'GET',
      url: new URL('http://localhost/v1/sessions/s1/runtime-models'),
      actor: 'admin-cli',
    });
    expect(response).toEqual({
      status: 503,
      body: { error: 'Codex model catalog probe timed out after 10s', code: 'catalog_timeout' },
    });
  });
});
