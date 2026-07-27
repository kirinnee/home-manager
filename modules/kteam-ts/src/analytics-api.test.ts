import { afterEach, describe, expect, test } from 'bun:test';
import { startApiServer } from './api-server';
import { AnalyticsQueryError } from './analytics-query';
import type { AnalyticsResponse } from './analytics-types';
import type { KTeamService } from './service';

const servers: Array<ReturnType<typeof startApiServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const service = {
  subscribe: () => () => undefined,
} as unknown as KTeamService;

function response(query: string): AnalyticsResponse {
  return {
    kind: 'aggregate',
    query,
    aggregation: 'count',
    parsed: { aggregation: 'count', groupBy: ['status'], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 2 },
    index: {
      schemaVersion: 1,
      sessions: 2,
      tokenSessions: 0,
      transcriptSources: 0,
      indexedTranscriptSources: 0,
      pendingTranscriptSources: 0,
      sourceErrors: 0,
      refreshing: false,
    },
    results: [],
  };
}

describe('analytics API', () => {
  test('reports a transient unavailable response while the daemon initializes the index', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const http = await fetch(`http://127.0.0.1:${server.port}/v1/analytics`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(http.status).toBe(503);
    expect(await http.json()).toEqual({ error: 'analytics index is initializing or unavailable' });
  });

  test('serves the indexed query contract and forwards q exactly once', async () => {
    const seen: Array<string | undefined> = [];
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service,
      analytics: {
        query: query => {
          seen.push(query);
          return response(query ?? 'count by (status)');
        },
      },
    });
    servers.push(server);
    const query = 'avg by (model) {status=completed}';
    const http = await fetch(`http://127.0.0.1:${server.port}/v1/analytics?q=${encodeURIComponent(query)}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(http.status).toBe(200);
    expect(seen).toEqual([query]);
    const body = (await http.json()) as AnalyticsResponse;
    expect(body.scope.allSessions).toBeTrue();
  });

  test('maps query validation to HTTP 400', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service,
      analytics: {
        query: () => {
          throw new AnalyticsQueryError('bad label');
        },
      },
    });
    servers.push(server);
    const http = await fetch(`http://127.0.0.1:${server.port}/v1/analytics`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(http.status).toBe(400);
    expect(await http.json()).toEqual({ error: 'bad label' });
  });
});
