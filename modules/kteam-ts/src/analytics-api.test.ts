import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startApiServer } from './api-server';
import { AnalyticsIndex } from './analytics-index';
import { AnalyticsQueryError } from './analytics-query';
import type { AnalyticsResponse } from './analytics-types';
import type { KTeamService } from './service';

const servers: Array<ReturnType<typeof startApiServer>> = [];
const indexes: AnalyticsIndex[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(indexes.splice(0).map(index => index.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
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

async function indexedFixture(ids: readonly string[]): Promise<AnalyticsIndex> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-analytics-api-'));
  roots.push(root);
  const databasePath = path.join(root, 'kteam.sqlite');
  const source = new Database(databasePath, { create: true, strict: true });
  source.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      config_json TEXT,
      state_json TEXT,
      journal_size INTEGER,
      journal_mtime_ms INTEGER,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      PRIMARY KEY (session_id, sequence)
    );
    CREATE TABLE chat_pointers (
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      turn INTEGER NOT NULL,
      source_file TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      record_index INTEGER NOT NULL,
      event_fingerprint TEXT NOT NULL,
      PRIMARY KEY (session_id, ordinal)
    );
    CREATE TABLE chat_sources (
      session_id TEXT NOT NULL,
      source_file TEXT NOT NULL,
      device TEXT NOT NULL,
      inode TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      source_mtime_ms INTEGER NOT NULL,
      pointer_count INTEGER NOT NULL,
      PRIMARY KEY (session_id, source_file)
    );
  `);
  const insert = source.query(`
    INSERT INTO sessions
      (id, directory, status, created_at, updated_at, config_json, state_json, indexed_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
  `);
  for (const id of ids) {
    const createdAt = '2026-07-01T00:00:00.000Z';
    insert.run(
      id,
      `/tmp/${id}`,
      createdAt,
      createdAt,
      JSON.stringify({ id, binary: 'claude-auto-loge', harness: 'claude', createdAt }),
      JSON.stringify({ id, status: 'completed', startedAt: createdAt, finishedAt: createdAt }),
      createdAt,
    );
  }
  const index = new AnalyticsIndex({ databasePath });
  indexes.push(index);
  source.close();
  return index;
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

  test('server-scopes a session query and replaces a caller-supplied id matcher', async () => {
    const seen: Array<string | undefined> = [];
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service,
      analytics: {
        query: query => {
          seen.push(query);
          return response(query ?? 'sum by (day)');
        },
      },
    });
    servers.push(server);
    const params = new URLSearchParams({
      q: 'sum by (model) {status=completed, id=someone-else}',
      session: 'session/odd ?',
    });
    const http = await fetch(`http://127.0.0.1:${server.port}/v1/analytics?${params}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(http.status).toBe(200);
    expect(seen).toEqual(['sum by (model) {status=completed, id=="session/odd ?"}']);
  });

  test('keeps wildcard-shaped session ids exact through HTTP and the real index', async () => {
    const index = await indexedFixture(['session-*', 'session-other', 'session/odd ?', 'session/odd X']);
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service, analytics: index });
    servers.push(server);

    for (const sessionId of ['session-*', 'session/odd ?']) {
      const params = new URLSearchParams({ q: '{}', session: sessionId });
      const http = await fetch(`http://127.0.0.1:${server.port}/v1/analytics?${params}`, {
        headers: { authorization: 'Bearer secret' },
      });
      expect(http.status).toBe(200);
      const body = (await http.json()) as AnalyticsResponse;
      expect(body.kind).toBe('raw');
      if (body.kind !== 'raw') throw new Error('expected raw session rows');
      expect(body.scope.matched).toBe(1);
      expect(body.results.map(row => row.id)).toEqual([sessionId]);
    }
  });

  test('rejects an empty session scope instead of falling back to the fleet', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service,
      analytics: { query: query => response(query ?? 'sum by (day)') },
    });
    servers.push(server);
    const http = await fetch('http://127.0.0.1:' + server.port + '/v1/analytics?session=', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(http.status).toBe(400);
    expect(await http.json()).toEqual({ error: 'session analytics scope needs an exact session id' });
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
