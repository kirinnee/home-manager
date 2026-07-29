import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Stats } from 'node:fs';
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalyticsIndex, ANALYTICS_SCHEMA_VERSION, canonicalAnalyticsModelId } from './analytics-index';
import { scopeAnalyticsQuery } from './analytics-query';
import { estimateEquivalentApiCost } from './model-cost';

const opened: AnalyticsIndex[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(index => index.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; file: string; source: Database }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-analytics-'));
  roots.push(root);
  const file = path.join(root, 'kteam.sqlite');
  const source = new Database(file, { create: true, strict: true });
  source.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
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
  return { root, file, source };
}

function insertSession(
  database: Database,
  input: {
    id: string;
    status: string;
    wrapper?: string;
    model?: string;
    harness?: 'claude' | 'codex';
    label?: string;
    /** Defaults to a dangling `lead`, which sanitizes to a session's own root. */
    parent?: string | null;
    transcriptFile?: string;
    createdAt?: string;
    startedAt?: string;
    finishedAt?: string;
    turn?: number;
    contextPercent?: number;
    contextWindow?: number;
    observedModel?: string;
  },
): void {
  const createdAt = input.createdAt ?? '2026-07-01T00:00:00.000Z';
  const config = {
    id: input.id,
    binary: input.wrapper ?? 'claude-auto-loge',
    model: input.model ?? 'claude-opus-5',
    harness: input.harness ?? 'claude',
    mode: 'auto',
    cwd: '/work/repo',
    label: input.label ?? 'batch-a',
    parent: input.parent === undefined ? 'lead' : input.parent,
    createdAt,
    ...(input.transcriptFile ? { transcriptFile: input.transcriptFile } : {}),
  };
  const state = {
    id: input.id,
    status: input.status,
    startedAt: input.startedAt ?? createdAt,
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    turn: input.turn ?? 1,
    ...(input.contextPercent === undefined ? {} : { contextPercent: input.contextPercent }),
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(input.observedModel === undefined ? {} : { observedModel: input.observedModel }),
  };
  database
    .query(
      `
      INSERT INTO sessions
        (id, directory, status, created_at, updated_at, config_json, state_json, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.id,
      `/tmp/${input.id}`,
      input.status,
      createdAt,
      createdAt,
      JSON.stringify(config),
      JSON.stringify(state),
      createdAt,
    );
}

function addChatSource(database: Database, sessionId: string, file: string, info: Stats): void {
  database
    .query(
      `
      INSERT INTO chat_sources
        (session_id, source_file, device, inode, source_size, source_mtime_ms, pointer_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `,
    )
    // Legacy daemon rows retain fractional REAL values despite INTEGER affinity.
    .run(sessionId, file, info.dev.toString(), info.ino.toString(), info.size, Math.trunc(info.mtimeMs) + 0.75);
}

describe('AnalyticsIndex', () => {
  test('keeps wildcard-shaped enforced session ids literal at the index boundary', async () => {
    const { file, source } = await fixture();
    for (const id of ['session-*', 'session-other', 'session/odd ?', 'session/odd X'])
      insertSession(source, { id, status: 'completed' });

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    for (const id of ['session-*', 'session/odd ?']) {
      const response = index.query(scopeAnalyticsQuery('{}', id));
      expect(response.kind).toBe('raw');
      if (response.kind !== 'raw') throw new Error('expected raw session rows');
      expect(response.scope.matched).toBe(1);
      expect(response.results.map(row => row.id)).toEqual([id]);
    }
    source.close();
  });

  test('groups fleet history by its existing indexed day dimension', async () => {
    const { file, source } = await fixture();
    insertSession(source, { id: 'day-one', status: 'completed', createdAt: '2026-07-01T23:59:59.000Z' });
    insertSession(source, { id: 'day-two-a', status: 'completed', createdAt: '2026-07-02T00:00:00.000Z' });
    insertSession(source, { id: 'day-two-b', status: 'failed', createdAt: '2026-07-02T18:00:00.000Z' });

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const response = index.query('sum by (day)');
    expect(response.kind).toBe('aggregate');
    if (response.kind !== 'aggregate') throw new Error('expected aggregate');
    expect(response.results.map(result => ({ day: result.labels.day, sessions: result.sessions }))).toEqual([
      { day: '2026-07-01', sessions: 1 },
      { day: '2026-07-02', sessions: 2 },
    ]);
    source.close();
  });

  test('reopens a complete warm materialization without rebuilding every session', async () => {
    const { file, source } = await fixture();
    insertSession(source, {
      id: 'warm',
      status: 'completed',
      createdAt: '2027-01-01T00:00:00.000Z',
      finishedAt: '2027-01-01T00:01:00.000Z',
    });

    const first = new AnalyticsIndex({ databasePath: file });
    await first.close();
    const sentinel = '2000-01-01T00:00:00.000Z';
    source.query(`UPDATE analytics_sessions SET indexed_at = ? WHERE session_id = 'warm'`).run(sentinel);

    const reopened = new AnalyticsIndex({ databasePath: file });
    opened.push(reopened);
    const row = source.query(`SELECT indexed_at FROM analytics_sessions WHERE session_id = 'warm'`).get() as {
      indexed_at: string;
    };
    expect(row.indexed_at).toBe(sentinel);
    const raw = reopened.query('{status=completed}');
    expect(raw.kind === 'raw' && raw.results[0]?.week).toBe('2026-W53');
    source.close();
  });

  test('cold-builds all sessions and incrementally tracks lifecycle data', async () => {
    const { file, source } = await fixture();
    insertSession(source, {
      id: 's1',
      status: 'completed',
      turn: 2,
      contextPercent: 50,
      startedAt: '2026-07-01T00:00:02.000Z',
      finishedAt: '2026-07-01T00:10:02.000Z',
    });
    insertSession(source, { id: 's2', status: 'failed', turn: 1, contextPercent: 25 });
    source.query(`INSERT INTO events VALUES ('s1', 1, '2026-07-01T00:05:00.000Z', 'session.stalled', 0, 1)`).run();
    source.query(`INSERT INTO events VALUES ('s1', 2, '2026-07-01T00:06:00.000Z', 'session.migrated', 1, 1)`).run();
    source
      .query(
        `
        INSERT INTO chat_pointers VALUES
          ('s1', 1, '2026-07-01T00:00:05.000Z', 'tool.use', 1, '/missing', 0, 1, 0, 'x')
      `,
      )
      .run();

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const response = index.query('avg by (wrapper)');
    expect(response.kind).toBe('aggregate');
    if (response.kind !== 'aggregate') throw new Error('expected aggregate');
    expect(response.scope).toEqual({ allSessions: true, indexed: 2, matched: 2 });
    expect(response.results).toHaveLength(1);
    const result = response.results[0]!;
    expect(result.labels).toEqual({ wrapper: 'claude-auto-loge' });
    expect(result.sessions).toBe(2);
    expect(result.rates).toEqual({ stall: 50, failure: 50, completion: 50 });
    expect(result.turns).toEqual({ value: 1.5, known: 2, total: 2 });
    // s2 has no terminal finishedAt: no confident fleet average is emitted.
    expect(result.durationMs.value).toBeNull();
    expect(result.durationMs.known).toBe(1);
    expect(result.timeToFirstOutputMs.value).toBeNull();
    expect(result.timeToFirstOutputMs.known).toBe(1);
    expect(result.tokens).toEqual({ value: null, known: 0, total: 2 });
    const raw = index.query('{status=completed}');
    expect(raw.kind).toBe('raw');
    if (raw.kind !== 'raw') throw new Error('expected raw');
    // Wall time and TTFO are anchored to stable session creation, not the
    // state.startedAt value that is overwritten on every resume.
    expect(raw.results[0]?.durationMs).toBeCloseTo(602_000, -1);
    expect(raw.results[0]?.timeToFirstOutputMs).toBeCloseTo(5_000, -1);
    expect(raw.results[0]?.week).toBe('2026-W27');
    expect(raw.results[0]?.migrated).toBe(true);
    const selected = index.query('{id=s1}');
    expect(selected.scope.matched).toBe(1);
    expect(selected.kind === 'raw' && selected.results[0]?.id).toBe('s1');

    const state = { id: 's2', status: 'completed', startedAt: '2026-07-01T00:00:00.000Z', turn: 3 };
    source.query(`UPDATE sessions SET status = 'completed', state_json = ? WHERE id = 's2'`).run(JSON.stringify(state));
    const filtered = index.query('count by (status) {status=completed}');
    expect(filtered.scope.matched).toBe(2);
    expect(filtered.kind === 'aggregate' && filtered.results[0]?.rates.completion).toBe(100);
    expect(filtered.kind === 'aggregate' && filtered.results[0]?.tokens).toEqual({ value: null, known: 0, total: 0 });

    const beforeMigration = index.query('{id=s2}');
    expect(beforeMigration.kind === 'raw' && beforeMigration.results[0]?.migrated).toBe(false);
    source.query(`INSERT INTO events VALUES ('s2', 1, '2026-07-01T00:07:00.000Z', 'session.started', 0, 1)`).run();
    // In-flight and failed migration evidence must NOT mark a session migrated —
    // only a successful session.migrated is durable evidence.
    source.query(`UPDATE events SET type = 'session.migrating' WHERE session_id = 's2' AND sequence = 1`).run();
    const midMigration = index.query('{id=s2}');
    expect(midMigration.kind === 'raw' && midMigration.results[0]?.migrated).toBe(false);
    source.query(`UPDATE events SET type = 'session.migrate_failed' WHERE session_id = 's2' AND sequence = 1`).run();
    const failedMigration = index.query('{id=s2}');
    expect(failedMigration.kind === 'raw' && failedMigration.results[0]?.migrated).toBe(false);
    source.query(`UPDATE events SET type = 'session.migrated' WHERE session_id = 's2' AND sequence = 1`).run();
    const afterMigration = index.query('{id=s2}');
    expect(afterMigration.kind === 'raw' && afterMigration.results[0]?.migrated).toBe(true);
    source.close();
  });

  test('does not invent a growing duration for an unfinished historical session', async () => {
    const { file, source } = await fixture();
    insertSession(source, {
      id: 'unfinished',
      status: 'running',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const raw = index.query('{status=running}');
    expect(raw.kind === 'raw' && raw.results[0]?.durationMs).toBeNull();
    source.close();
  });

  test('streams and deduplicates exact Claude/Codex token totals', async () => {
    const { root, file, source } = await fixture();
    const claudeFile = path.join(root, 'claude.jsonl');
    const codexFile = path.join(root, 'codex.jsonl');
    const claudeA = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-a',
        model: 'claude-transcript-model',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_creation: {
            ephemeral_5m_input_tokens: 3,
            ephemeral_1h_input_tokens: 2,
          },
          output_tokens: 7,
        },
      },
    });
    const claudeB = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-b',
        model: 'claude-transcript-model',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    await writeFile(claudeFile, `${claudeA}\n${claudeA}\n${claudeB}\n`);
    const codex = (input: number, output: number, cached = 0) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached } },
        },
      });
    const codexContext = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
    await writeFile(codexFile, `${codexContext('gpt-transcript-1')}\n${codex(10, 2)}\n${codex(20, 5, 8)}\n`);
    insertSession(source, {
      id: 'claude',
      status: 'completed',
      model: 'claude-opus-5',
      harness: 'claude',
      transcriptFile: claudeFile,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    insertSession(source, {
      id: 'codex',
      status: 'completed',
      wrapper: 'codex-auto-loge',
      model: 'gpt-5.6-sol',
      harness: 'codex',
      transcriptFile: codexFile,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    addChatSource(source, 'claude', claudeFile, await stat(claudeFile));
    addChatSource(source, 'codex', codexFile, await stat(codexFile));
    // The transcript can advance ahead of the daemon's last chat-source
    // observation. A later reconciliation must not regress this stale row over
    // the scanner's newer stat and invalidate completed token work.
    source.query(`UPDATE chat_sources SET source_size = 0, source_mtime_ms = 0 WHERE session_id = 'codex'`).run();

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const refreshed = await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    expect(refreshed.errors).toBe(0);
    expect(index.indexStatus().tokenSessions).toBe(2);
    const unchanged = await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    expect(unchanged.sources).toBe(0);
    expect(index.indexStatus().tokenSessions).toBe(2);

    const claudeRaw = index.query('{id=claude}');
    expect(claudeRaw.kind).toBe('raw');
    if (claudeRaw.kind !== 'raw') throw new Error('expected raw');
    // msg-a occurs twice in the transcript but counts once: input 35+1, output 7+2.
    expect(claudeRaw.results[0]?.inputTokens).toBe(36);
    expect(claudeRaw.results[0]?.outputTokens).toBe(9);
    expect(claudeRaw.results[0]?.tokens).toBe(45);
    expect(claudeRaw.results[0]?.cacheWriteInputTokens).toBe(5);
    expect(claudeRaw.results[0]?.cacheWrite5mInputTokens).toBe(3);
    expect(claudeRaw.results[0]?.cacheWrite1hInputTokens).toBe(2);
    expect(claudeRaw.results[0]?.pricingModel).toBe('claude-transcript-model');
    expect(claudeRaw.results[0]?.model).toBe('claude-transcript-model');

    const codexRaw = index.query('{id=codex}');
    expect(codexRaw.kind === 'raw' && codexRaw.results[0]?.tokens).toBe(25);
    expect(codexRaw.kind === 'raw' && codexRaw.results[0]?.pricingModel).toBe('gpt-transcript-1');
    expect(codexRaw.kind === 'raw' && codexRaw.results[0]?.model).toBe('gpt-transcript-1');
    expect(codexRaw.kind === 'raw' && codexRaw.results[0]?.cacheWrite5mInputTokens).toBeNull();

    // A source growth invalidates the confident value until its byte cursor catches up.
    await appendFile(codexFile, `${codex(30, 8, 12)}\n`);
    const grown = await stat(codexFile);
    source
      .query(
        `
        UPDATE chat_sources SET source_size = ?, source_mtime_ms = ?, device = ?, inode = ?
        WHERE session_id = 'codex' AND source_file = ?
      `,
      )
      .run(grown.size, grown.mtimeMs, grown.dev.toString(), grown.ino.toString(), codexFile);
    const unknown = index.query('{id=codex}');
    expect(unknown.kind === 'raw' && unknown.results[0]?.tokens).toBeNull();
    await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    const updated = index.query('{id=codex}');
    expect(updated.kind === 'raw' && updated.results[0]?.tokens).toBe(38);
    expect(updated.kind === 'raw' && updated.results[0]?.pricingModel).toBe('gpt-transcript-1');

    // Rewriting a transcript in place can preserve its inode and byte length.
    // The cursor anchor must still invalidate and rebuild the cumulative total.
    const rewrittenTranscript = `${codexContext('gpt-transcript-2')}\n${codex(11, 1)}\n${codex(22, 4, 7)}\n${codex(50, 9, 13)}\n`;
    expect(Buffer.byteLength(rewrittenTranscript)).toBe(grown.size);
    await writeFile(codexFile, rewrittenTranscript);
    const rewriteTime = new Date(grown.mtimeMs + 2_000);
    await utimes(codexFile, rewriteTime, rewriteTime);
    const rewrittenStat = await stat(codexFile);
    source
      .query(
        `
        UPDATE chat_sources SET source_size = ?, source_mtime_ms = ?, device = ?, inode = ?
        WHERE session_id = 'codex' AND source_file = ?
      `,
      )
      .run(
        rewrittenStat.size,
        rewrittenStat.mtimeMs,
        rewrittenStat.dev.toString(),
        rewrittenStat.ino.toString(),
        codexFile,
      );
    const unknownAfterRewrite = index.query('{id=codex}');
    expect(unknownAfterRewrite.kind === 'raw' && unknownAfterRewrite.results[0]?.tokens).toBeNull();
    await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    const afterRewrite = index.query('{id=codex}');
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.tokens).toBe(59);
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.pricingModel).toBe('gpt-transcript-2');
    source.close();
  });

  test('terminal ingestion makes Claude and Codex fixtures queryable with canonical model ids', async () => {
    const { file, source } = await fixture();
    const claudeFile = path.join(import.meta.dir, 'fixtures', 'analytics-claude-terminal.jsonl');
    const codexFile = path.join(import.meta.dir, 'fixtures', 'analytics-codex-terminal.jsonl');
    insertSession(source, {
      id: 'claude-terminal',
      status: 'completed',
      model: 'fable[1m]',
      observedModel: 'fable[1m]',
      harness: 'claude',
      transcriptFile: claudeFile,
      finishedAt: '2026-07-29T08:00:03.000Z',
    });
    insertSession(source, {
      id: 'codex-terminal',
      status: 'completed',
      wrapper: 'codex-auto-loge',
      model: 'gpt-5.6-sol[1m]',
      harness: 'codex',
      transcriptFile: codexFile,
      finishedAt: '2026-07-29T08:00:03.000Z',
    });
    addChatSource(source, 'claude-terminal', claudeFile, await stat(claudeFile));
    addChatSource(source, 'codex-terminal', codexFile, await stat(codexFile));

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    expect(canonicalAnalyticsModelId(' FABLE[1M] ')).toBe('FABLE');
    expect((await index.ingestSession('claude-terminal')).errors).toBe(0);
    expect((await index.ingestSession('codex-terminal')).errors).toBe(0);

    const claude = index.query('{id=claude-terminal}');
    expect(claude.kind).toBe('raw');
    if (claude.kind !== 'raw') throw new Error('expected raw Claude analytics');
    expect(claude.results[0]).toMatchObject({
      model: 'fable',
      pricingModel: 'fable',
      contextWindow: 1_000_000,
      inputTokens: 35,
      outputTokens: 7,
      tokens: 42,
    });

    const codex = index.query('{id=codex-terminal}');
    expect(codex.kind).toBe('raw');
    if (codex.kind !== 'raw') throw new Error('expected raw Codex analytics');
    expect(codex.results[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      pricingModel: 'gpt-5.6-sol',
      contextWindow: 1_000_000,
      inputTokens: 20,
      outputTokens: 5,
      cachedInputTokens: 8,
      tokens: 25,
    });

    const grouped = index.query('count by (model, context_window)');
    expect(grouped.kind).toBe('aggregate');
    expect(
      grouped.kind === 'aggregate'
        ? grouped.results.map(result => result.labels).sort((a, b) => String(a.model).localeCompare(String(b.model)))
        : [],
    ).toEqual([
      { model: 'fable', context_window: '1000000' },
      { model: 'gpt-5.6-sol', context_window: '1000000' },
    ]);
    source.close();
  });

  test('keeps gross cache writes known while tracking exact Claude TTL splits', async () => {
    const { root, file, source } = await fixture();
    const exactFile = path.join(root, 'ttl-exact.jsonl');
    const unknownFile = path.join(root, 'ttl-unknown.jsonl');
    const zeroFile = path.join(root, 'ttl-zero.jsonl');
    const claudeUsage = (id: string, model: string, cacheWrite: number, cacheCreation?: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          model,
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            cache_creation_input_tokens: cacheWrite,
            ...(cacheCreation === undefined ? {} : { cache_creation: cacheCreation }),
          },
        },
      });
    const exact = claudeUsage('exact', 'claude-price-model', 10, {
      ephemeral_5m_input_tokens: 4,
      ephemeral_1h_input_tokens: 6,
    });
    await writeFile(exactFile, `${exact}\n${exact}\n`);
    await writeFile(
      unknownFile,
      `${claudeUsage('known-prefix', 'claude-price-model', 1, {
        ephemeral_5m_input_tokens: 1,
        ephemeral_1h_input_tokens: 0,
      })}\n${claudeUsage('unknown', 'claude-price-model', 9)}\n`,
    );
    await writeFile(zeroFile, `${claudeUsage('zero', 'claude-price-model', 0)}\n`);
    insertSession(source, {
      id: 'ttl-exact',
      status: 'completed',
      model: 'config-exact',
      transcriptFile: exactFile,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    insertSession(source, {
      id: 'ttl-unknown',
      status: 'completed',
      model: 'config-unknown',
      transcriptFile: unknownFile,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    insertSession(source, {
      id: 'ttl-zero',
      status: 'completed',
      model: 'config-zero',
      transcriptFile: zeroFile,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    addChatSource(source, 'ttl-exact', exactFile, await stat(exactFile));

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const refreshed = await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    expect(refreshed.errors).toBe(0);

    const exactRaw = index.query('{id=ttl-exact}');
    expect(exactRaw.kind === 'raw' && exactRaw.results[0]?.cacheWriteInputTokens).toBe(10);
    expect(exactRaw.kind === 'raw' && exactRaw.results[0]?.cacheWrite5mInputTokens).toBe(4);
    expect(exactRaw.kind === 'raw' && exactRaw.results[0]?.cacheWrite1hInputTokens).toBe(6);
    const unknownRaw = index.query('{id=ttl-unknown}');
    expect(unknownRaw.kind === 'raw' && unknownRaw.results[0]?.cacheWriteInputTokens).toBe(10);
    expect(unknownRaw.kind === 'raw' && unknownRaw.results[0]?.cacheWrite5mInputTokens).toBeNull();
    expect(unknownRaw.kind === 'raw' && unknownRaw.results[0]?.cacheWrite1hInputTokens).toBeNull();
    const zeroRaw = index.query('{id=ttl-zero}');
    expect(zeroRaw.kind === 'raw' && zeroRaw.results[0]?.cacheWriteInputTokens).toBe(0);
    expect(zeroRaw.kind === 'raw' && zeroRaw.results[0]?.cacheWrite5mInputTokens).toBe(0);
    expect(zeroRaw.kind === 'raw' && zeroRaw.results[0]?.cacheWrite1hInputTokens).toBe(0);

    const aggregate = index.query('sum by (wrapper)');
    expect(aggregate.kind).toBe('aggregate');
    if (aggregate.kind !== 'aggregate') throw new Error('expected aggregate');
    expect(aggregate.results[0]?.cacheWriteInputTokens).toEqual({ value: 20, known: 3, total: 3 });
    expect(aggregate.results[0]?.cacheWrite5mInputTokens).toEqual({ value: null, known: 2, total: 3 });
    expect(aggregate.results[0]?.cacheWrite1hInputTokens).toEqual({ value: null, known: 2, total: 3 });

    await writeFile(exactFile, `${claudeUsage('replacement', 'claude-new-model', 0)}\n`);
    const rewritten = await stat(exactFile);
    source
      .query(
        `
        UPDATE chat_sources SET source_size = ?, source_mtime_ms = ?, device = ?, inode = ?
        WHERE session_id = 'ttl-exact' AND source_file = ?
      `,
      )
      .run(rewritten.size, rewritten.mtimeMs, rewritten.dev.toString(), rewritten.ino.toString(), exactFile);
    const invalidated = index.query('{id=ttl-exact}');
    expect(invalidated.kind === 'raw' && invalidated.results[0]?.pricingModel).toBeNull();
    expect(invalidated.kind === 'raw' && invalidated.results[0]?.cacheWrite5mInputTokens).toBeNull();
    await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    const afterRewrite = index.query('{id=ttl-exact}');
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.cacheWriteInputTokens).toBe(0);
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.cacheWrite5mInputTokens).toBe(0);
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.cacheWrite1hInputTokens).toBe(0);
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.pricingModel).toBe('claude-new-model');
    source.close();
  });

  test('does not price mixed or model-less Claude and Codex usage', async () => {
    const { root, file, source } = await fixture();
    const claudeMixedFile = path.join(root, 'claude-mixed.jsonl');
    const claudeMissingFile = path.join(root, 'claude-missing.jsonl');
    const codexMixedFile = path.join(root, 'codex-mixed.jsonl');
    const codexMissingFile = path.join(root, 'codex-missing.jsonl');
    const claude = (id: string, model?: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          ...(model === undefined ? {} : { model }),
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      });
    const context = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
    const codex = (input: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
      });
    await writeFile(claudeMixedFile, `${claude('a', 'claude-a')}\n${claude('b', 'claude-b')}\n`);
    await writeFile(claudeMissingFile, `${claude('missing')}\n`);
    await writeFile(codexMixedFile, `${context('gpt-a')}\n${codex(2, 1)}\n${context('gpt-b')}\n${codex(5, 2)}\n`);
    await writeFile(codexMissingFile, `${codex(2, 1)}\n${context('gpt-late')}\n${codex(5, 2)}\n`);
    const cases = [
      { id: 'claude-mixed', harness: 'claude' as const, transcriptFile: claudeMixedFile },
      { id: 'claude-missing', harness: 'claude' as const, transcriptFile: claudeMissingFile },
      { id: 'codex-mixed', harness: 'codex' as const, transcriptFile: codexMixedFile },
      { id: 'codex-missing', harness: 'codex' as const, transcriptFile: codexMissingFile },
    ];
    for (const item of cases)
      insertSession(source, {
        ...item,
        status: 'completed',
        model: `mutable-config-${item.id}`,
        finishedAt: '2026-07-01T00:01:00.000Z',
      });

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const refreshed = await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    expect(refreshed.errors).toBe(0);
    for (const item of cases) {
      const raw = index.query(`{id=${item.id}}`);
      expect(raw.kind === 'raw' && raw.results[0]?.tokens).not.toBeNull();
      expect(raw.kind === 'raw' && raw.results[0]?.pricingModel).toBeNull();
    }
    source.close();
  });

  test('persists Codex model evidence across bounded cursors and clears it on reset', async () => {
    const { root, file, source } = await fixture();
    const transcript = path.join(root, 'codex-cursor.jsonl');
    const context = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-cursor-model' } });
    const codex = (input: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
      });
    const prefixStart = `${context}\n${codex(2, 1)}\n`;
    const emptyPaddingLine = `${JSON.stringify({ padding: '' })}\n`;
    const firstCursorBytes = 64 * 1024;
    const paddingLength = firstCursorBytes - Buffer.byteLength(prefixStart) - Buffer.byteLength(emptyPaddingLine);
    expect(paddingLength).toBeGreaterThan(0);
    const prefix = `${prefixStart}${JSON.stringify({ padding: 'x'.repeat(paddingLength) })}\n`;
    expect(Buffer.byteLength(prefix)).toBe(firstCursorBytes);
    await writeFile(transcript, `${prefix}${codex(9, 3)}\n`);
    insertSession(source, {
      id: 'codex-cursor',
      status: 'completed',
      harness: 'codex',
      model: 'mutable-config-model',
      transcriptFile: transcript,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    addChatSource(source, 'codex-cursor', transcript, await stat(transcript));

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const first = await index.refreshTokens({ byteBudget: firstCursorBytes, sourceLimit: 1 });
    expect(first.bytes).toBe(firstCursorBytes);
    expect(first.pending).toBe(1);
    const incomplete = index.query('{id=codex-cursor}');
    expect(incomplete.kind === 'raw' && incomplete.results[0]?.pricingModel).toBeNull();
    const cursorState = source
      .query(
        `
        SELECT byte_offset, codex_current_model, pricing_model, pricing_model_ambiguous
        FROM analytics_usage_sources WHERE session_id = 'codex-cursor'
      `,
      )
      .get() as {
      byte_offset: number;
      codex_current_model: string | null;
      pricing_model: string | null;
      pricing_model_ambiguous: number;
    };
    expect(cursorState).toEqual({
      byte_offset: firstCursorBytes,
      codex_current_model: 'gpt-cursor-model',
      pricing_model: 'gpt-cursor-model',
      pricing_model_ambiguous: 0,
    });

    await index.refreshTokens({ byteBudget: firstCursorBytes, sourceLimit: 1 });
    const complete = index.query('{id=codex-cursor}');
    expect(complete.kind === 'raw' && complete.results[0]?.tokens).toBe(12);
    expect(complete.kind === 'raw' && complete.results[0]?.pricingModel).toBe('gpt-cursor-model');

    await writeFile(transcript, `${codex(4, 2)}\n`);
    const rewritten = await stat(transcript);
    source
      .query(
        `
        UPDATE chat_sources SET source_size = ?, source_mtime_ms = ?, device = ?, inode = ?
        WHERE session_id = 'codex-cursor' AND source_file = ?
      `,
      )
      .run(rewritten.size, rewritten.mtimeMs, rewritten.dev.toString(), rewritten.ino.toString(), transcript);
    const invalidated = index.query('{id=codex-cursor}');
    expect(invalidated.kind === 'raw' && invalidated.results[0]?.pricingModel).toBeNull();
    await index.refreshTokens({ byteBudget: firstCursorBytes, sourceLimit: 1 });
    const afterReset = index.query('{id=codex-cursor}');
    expect(afterReset.kind === 'raw' && afterReset.results[0]?.tokens).toBe(6);
    expect(afterReset.kind === 'raw' && afterReset.results[0]?.pricingModel).toBeNull();
    source.close();
  });

  test('never substitutes zero or a partial aggregate for missing token data', async () => {
    const { root, file, source } = await fixture();
    const transcript = path.join(root, 'known.jsonl');
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        message: { id: 'known', usage: { input_tokens: 10, output_tokens: 5 } },
      })}\n`,
    );
    insertSession(source, {
      id: 'known',
      status: 'completed',
      model: 'same-model',
      transcriptFile: transcript,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    insertSession(source, {
      id: 'unknown',
      status: 'completed',
      model: 'same-model',
      transcriptFile: path.join(root, 'missing.jsonl'),
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    addChatSource(source, 'known', transcript, await stat(transcript));
    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    const response = index.query('sum by (model)');
    expect(response.kind).toBe('aggregate');
    if (response.kind !== 'aggregate') throw new Error('expected aggregate');
    expect(response.results[0]?.tokens).toEqual({ value: null, known: 1, total: 2 });
    expect(response.index.sourceErrors).toBe(1);
    source.close();
  });

  test('distinguishes explicit zero usage from malformed partial usage', async () => {
    const { root, file, source } = await fixture();
    const zeroTranscript = path.join(root, 'zero.jsonl');
    const malformedTranscript = path.join(root, 'malformed.jsonl');
    await writeFile(
      zeroTranscript,
      `${JSON.stringify({
        type: 'assistant',
        message: { id: 'zero', usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n`,
    );
    await writeFile(
      malformedTranscript,
      `${JSON.stringify({
        type: 'assistant',
        message: { id: 'valid-prefix', usage: { input_tokens: 10, output_tokens: 5 } },
      })}\n${JSON.stringify({
        type: 'assistant',
        message: { id: 'partial', usage: { input_tokens: 7 } },
      })}\n`,
    );
    insertSession(source, {
      id: 'zero',
      status: 'completed',
      model: 'zero-model',
      transcriptFile: zeroTranscript,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    insertSession(source, {
      id: 'malformed',
      status: 'completed',
      model: 'malformed-model',
      transcriptFile: malformedTranscript,
      finishedAt: '2026-07-01T00:01:00.000Z',
    });
    // Most historical sessions have only config.transcriptFile and no
    // chat_sources row; the scanner must stat and enroll that path itself.
    addChatSource(source, 'malformed', malformedTranscript, await stat(malformedTranscript));

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    const refreshed = await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    expect(refreshed.errors).toBe(1);
    const zero = index.query('{model=zero-model}');
    expect(zero.kind === 'raw' && zero.results[0]?.tokens).toBe(0);
    const malformed = index.query('{model=malformed-model}');
    expect(malformed.kind === 'raw' && malformed.results[0]?.tokens).toBeNull();
    source
      .query(`UPDATE analytics_usage_sources SET retry_at = ? WHERE session_id = 'malformed'`)
      .run(new Date(Date.now() - 60_000).toISOString());
    const retried = await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    expect(retried.sources).toBe(1);
    expect(retried.errors).toBe(1);
    source.close();
  });

  test('roots lineages exactly like the client, including cycles and broken parents', async () => {
    const { file, source } = await fixture();
    const tree = (id: string, parent: string | null) =>
      insertSession(source, { id, status: 'completed', parent, label: id });
    tree('root', null);
    tree('mid', 'root');
    tree('leaf', 'mid');
    // A parent edge that closes a loop is dropped from BOTH members, but an
    // ordinary child hanging off a loop member keeps its edge and lands in
    // that member's tree rather than rooting itself.
    tree('loop-a', 'loop-b');
    tree('loop-b', 'loop-a');
    tree('loop-child', 'loop-a');
    tree('selfie', 'selfie');
    tree('orphan', 'no-such-session');

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);

    const rooted = index.query('count by (tree)');
    expect(rooted.kind).toBe('aggregate');
    if (rooted.kind !== 'aggregate') throw new Error('expected aggregate');
    expect(rooted.results.map(result => [result.labels.tree, result.sessions])).toEqual([
      ['loop-a', 2],
      ['loop-b', 1],
      ['orphan', 1],
      ['root', 3],
      ['selfie', 1],
    ]);

    const ids = (query: string): string[] => {
      const response = index.query(query);
      if (response.kind !== 'raw') throw new Error('expected raw');
      return response.results.map(result => result.id).sort();
    };
    // The anchor is part of its own subtree at every depth.
    expect(ids('{tree=root}')).toEqual(['leaf', 'mid', 'root']);
    expect(ids('{tree=mid}')).toEqual(['leaf', 'mid']);
    expect(ids('{tree=leaf}')).toEqual(['leaf']);
    expect(ids('{tree=loop-a}')).toEqual(['loop-a', 'loop-child']);
    expect(ids('{tree=loop-b}')).toEqual(['loop-b']);
    expect(ids('{tree=selfie}')).toEqual(['selfie']);
    expect(ids('{tree=no-such-session}')).toEqual([]);

    const raw = index.query('{tree=root}');
    if (raw.kind !== 'raw') throw new Error('expected raw');
    expect(raw.results.every(result => result.tree === 'root')).toBe(true);
    // Queries that never mention `tree` must not imply a lineage placement.
    const untreed = index.query('{status=completed}');
    expect(untreed.kind === 'raw' && untreed.results[0]?.tree).toBeUndefined();

    const narrow = new AnalyticsIndex({ databasePath: file, groupLimit: 2 });
    opened.push(narrow);
    expect(() => narrow.query('count by (tree)')).toThrow('{tree=<session-id>}');
    source.close();
  });

  test('keeps deep chains and long cycles complete beyond the former 64-edge cutoff', async () => {
    const { file, source } = await fixture();
    const add = (id: string, parent: string | null) =>
      insertSession(source, { id, status: 'completed', parent, label: id });

    const chainIds = ['deep-root'];
    add(chainIds[0]!, null);
    for (let depth = 1; depth <= 70; depth += 1) {
      const id = `deep-${String(depth).padStart(3, '0')}`;
      add(id, chainIds.at(-1)!);
      chainIds.push(id);
    }

    // buildLineage drops every edge within this 65-member cycle, but keeps the
    // ordinary child edge into cycle-000. Thus every cycle member is a root,
    // and only cycle-000 owns the child.
    const cycleIds = Array.from({ length: 65 }, (_, index) => `cycle-${String(index).padStart(3, '0')}`);
    for (const [index, id] of cycleIds.entries()) add(id, cycleIds[(index + 1) % cycleIds.length]!);
    add('cycle-child', cycleIds[0]!);

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);

    const rooted = index.query('count by (tree)');
    if (rooted.kind !== 'aggregate') throw new Error('expected aggregate');
    const counts = new Map(rooted.results.map(result => [result.labels.tree, result.sessions]));
    expect(counts.size).toBe(66);
    expect(counts.get('deep-root')).toBe(chainIds.length);
    expect(counts.get(cycleIds[0]!)).toBe(2);
    expect(cycleIds.slice(1).every(id => counts.get(id) === 1)).toBe(true);

    const subtree = (anchor: string): Set<string> => {
      const response = index.query(`{tree=${anchor}}`);
      if (response.kind !== 'raw') throw new Error('expected raw');
      expect(response.truncated).toBe(false);
      return new Set(response.results.map(result => result.id));
    };
    expect(subtree('deep-root')).toEqual(new Set(chainIds));
    expect(subtree(cycleIds[0]!)).toEqual(new Set([cycleIds[0]!, 'cycle-child']));
    expect(subtree(cycleIds[1]!)).toEqual(new Set([cycleIds[1]!]));
    source.close();
  });

  test('prices equivalent API cost in SQL exactly as the shared registry does', async () => {
    const { root, file, source } = await fixture();
    const priced = '2026-07-28T12:00:00.000Z';
    const codexFile = path.join(root, 'cost-codex.jsonl');
    const anthropicFile = path.join(root, 'cost-anthropic.jsonl');
    const unpricedFile = path.join(root, 'cost-unpriced.jsonl');
    const splitFile = path.join(root, 'cost-split.jsonl');
    await writeFile(
      codexFile,
      `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } })}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1_000,
              output_tokens: 200,
              cached_input_tokens: 300,
              cache_write_input_tokens: 100,
            },
          },
        },
      })}\n`,
    );
    const claudeUsage = (id: string, model: string, cacheCreation?: Record<string, number>) =>
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id,
          model,
          usage: {
            input_tokens: 600,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
            ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
            output_tokens: 200,
          },
        },
      })}\n`;
    await writeFile(
      anthropicFile,
      claudeUsage('cost-anthropic', 'claude-opus-5', {
        ephemeral_5m_input_tokens: 60,
        ephemeral_1h_input_tokens: 40,
      }),
    );
    await writeFile(
      unpricedFile,
      claudeUsage('cost-unpriced', 'claude-transcript-model', {
        ephemeral_5m_input_tokens: 60,
        ephemeral_1h_input_tokens: 40,
      }),
    );
    // Anthropic cache writes without an exact TTL breakdown cannot be priced.
    await writeFile(splitFile, claudeUsage('cost-split', 'claude-opus-5'));

    const sessions: Array<{ id: string; harness: 'claude' | 'codex'; transcriptFile?: string; createdAt: string }> = [
      { id: 'openai', harness: 'codex', transcriptFile: codexFile, createdAt: priced },
      // Same usage, but created before this rate identity took effect.
      { id: 'stale-window', harness: 'codex', transcriptFile: codexFile, createdAt: '2026-07-01T00:00:00.000Z' },
      { id: 'anthropic', harness: 'claude', transcriptFile: anthropicFile, createdAt: priced },
      { id: 'unpriced', harness: 'claude', transcriptFile: unpricedFile, createdAt: priced },
      { id: 'split', harness: 'claude', transcriptFile: splitFile, createdAt: priced },
      { id: 'no-tokens', harness: 'claude', createdAt: priced },
    ];
    for (const session of sessions) {
      insertSession(source, {
        id: session.id,
        status: 'completed',
        label: session.id,
        harness: session.harness,
        wrapper: session.harness === 'codex' ? 'codex-auto-loge' : 'claude-auto-loge',
        model: `display-${session.id}`,
        createdAt: session.createdAt,
        finishedAt: session.createdAt,
        ...(session.transcriptFile ? { transcriptFile: session.transcriptFile } : {}),
      });
      if (session.transcriptFile)
        addChatSource(source, session.id, session.transcriptFile, await stat(session.transcriptFile));
    }

    const index = new AnalyticsIndex({ databasePath: file });
    opened.push(index);
    expect((await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 20 })).errors).toBe(0);

    const rows = index.query('{}');
    if (rows.kind !== 'raw') throw new Error('expected raw');
    const byId = new Map(rows.results.map(result => [result.id, result]));
    // Hand-checked against the published rates so SQL and TypeScript cannot be
    // wrong together: (1000-300-100)*$5 + 300*$0.50 + 100*$6.25 + 200*$30 per
    // million tokens is 9_775 USD micros.
    expect(byId.get('openai')?.equivalentApiCostUsdMicros).toBe(9_775);
    // Claude reports uncached input separately, so gross input is 600+300+100.
    // (1000-300-100)*$5 + 300*$0.50 + 60*$6.25 + 40*$10 + 200*$25 per million.
    expect(byId.get('anthropic')?.equivalentApiCostUsdMicros).toBe(8_925);
    for (const id of ['stale-window', 'unpriced', 'split', 'no-tokens']) {
      expect(byId.get(id)?.equivalentApiCostUsdMicros).toBeNull();
    }
    // An unpriced model still reports every token it does know.
    expect(byId.get('unpriced')?.tokens).toBe(1_200);
    expect(byId.get('split')?.cacheWriteInputTokens).toBe(100);

    for (const result of rows.results) {
      const expected = estimateEquivalentApiCost(result);
      expect(result.equivalentApiCostUsdMicros).toBe(expected.kind === 'known' ? Number(expected.usdMicros) : null);
    }

    const single = index.query('sum {label=openai}');
    expect(single.kind === 'aggregate' && single.results[0]?.equivalentApiCostUsdMicros).toEqual({
      value: 9_775,
      known: 1,
      total: 1,
    });
    // One unpriceable session makes the whole group unknown, never a partial sum.
    const whole = index.query('sum');
    expect(whole.kind === 'aggregate' && whole.results[0]?.equivalentApiCostUsdMicros).toEqual({
      value: null,
      known: 2,
      total: 6,
    });
    const counted = index.query('count');
    expect(counted.kind === 'aggregate' && counted.results[0]?.equivalentApiCostUsdMicros).toEqual({
      value: null,
      known: 0,
      total: 0,
    });
    source.close();
  });

  test('replaces a stale pre-fix migration trigger and survives a transcript path round-trip', async () => {
    const { root, file, source } = await fixture();
    const OLD = path.join(root, 'old.jsonl');
    const NEW = path.join(root, 'new.jsonl');
    const AUTHORITATIVE_SIZE = 4242;

    insertSession(source, { id: 's1', status: 'running', harness: 'claude', transcriptFile: OLD });
    // An authoritative chat_sources row for OLD carries real fingerprint metadata,
    // so we can prove the 0/0 config placeholder never clobbers it.
    addChatSource(source, 's1', OLD, {
      dev: 66,
      ino: 99,
      size: AUTHORITATIVE_SIZE,
      mtimeMs: 1_000,
    } as unknown as Stats);

    // Open once so the current (fixed) schema materializes and OLD is enrolled from
    // the authoritative chat_sources row.
    const first = new AnalyticsIndex({ databasePath: file });
    await first.close();
    expect(
      source
        .query<
          { source_size: number },
          [string]
        >(`SELECT source_size FROM analytics_expected_sources WHERE session_id = 's1' AND source_file = ?`)
        .get(OLD)?.source_size,
    ).toBe(AUTHORITATIVE_SIZE);

    // Simulate a DEPLOYED pre-fix daemon DB: restore the legacy INSERT OR IGNORE
    // trigger body and stamp the previous schema version, so the next open is
    // forced to drop and recreate the persistent trigger.
    source.exec(`DROP TRIGGER analytics_session_source_update`);
    source.exec(`
      CREATE TRIGGER analytics_session_source_update
      AFTER UPDATE OF config_json ON sessions
      WHEN COALESCE(json_extract(OLD.config_json, '$.transcriptFile'), '')
        <> COALESCE(json_extract(NEW.config_json, '$.transcriptFile'), '')
      BEGIN
        INSERT OR IGNORE INTO analytics_expected_sources
          (session_id, source_file, harness, source_size, source_mtime_ms, seen_at)
        SELECT NEW.id, json_extract(NEW.config_json, '$.transcriptFile'),
          COALESCE(json_extract(NEW.config_json, '$.harness'), 'unknown'), 0, 0, CURRENT_TIMESTAMP
        WHERE json_extract(NEW.config_json, '$.transcriptFile') IS NOT NULL;
        UPDATE analytics_sessions SET
          token_known = 0, input_tokens = NULL, output_tokens = NULL,
          cached_input_tokens = NULL, cache_write_input_tokens = NULL,
          cache_write_5m_input_tokens = NULL, cache_write_1h_input_tokens = NULL, pricing_model = NULL
        WHERE session_id = NEW.id;
      END;
    `);
    source
      .query(`UPDATE analytics_meta SET value = ? WHERE key = 'schema_version'`)
      .run(String(ANALYTICS_SCHEMA_VERSION - 1));

    // EventStore persists session metadata with an outer conflict clause. That
    // outer policy overrides a trigger-body OR IGNORE, turning a duplicate-key hit
    // into an ABORT.
    const persist = (transcriptFile: string): void => {
      const config = {
        id: 's1',
        binary: 'claude-auto-loge',
        model: 'claude-opus-5',
        harness: 'claude',
        mode: 'auto',
        cwd: '/work/repo',
        label: 'batch-a',
        parent: 'lead',
        createdAt: '2026-07-01T00:00:00.000Z',
        transcriptFile,
      };
      const state = { id: 's1', status: 'running', startedAt: '2026-07-01T00:00:00.000Z', turn: 1 };
      source
        .query(
          `
          INSERT INTO sessions
            (id, directory, status, created_at, updated_at, config_json, state_json, indexed_at)
          VALUES ('s1', '/tmp/s1', 'running', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', ?, ?, '2026-07-01T00:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at,
            indexed_at = excluded.indexed_at
        `,
        )
        .run(JSON.stringify(config), JSON.stringify(state));
    };

    // RED: with the stale OR IGNORE trigger, moving the transcript path back to an
    // already-enrolled value throws the exact UNIQUE error.
    persist(NEW);
    expect(() => persist(OLD)).toThrow(/UNIQUE constraint failed: analytics_expected_sources/);

    // Reopen: the version mismatch drops and recreates the persistent trigger with
    // the fixed DO NOTHING upsert, then cold-resyncs enrolment.
    const second = new AnalyticsIndex({ databasePath: file });
    opened.push(second);

    // GREEN: the full old -> new -> old round-trip no longer throws.
    expect(() => {
      persist(OLD);
      persist(NEW);
      persist(OLD);
    }).not.toThrow();

    // Both sources stay enrolled and OLD's authoritative fingerprint is intact —
    // the 0/0 placeholder never overwrote it.
    const rows = source
      .query<
        { source_file: string; source_size: number },
        []
      >(`SELECT source_file, source_size FROM analytics_expected_sources WHERE session_id = 's1' ORDER BY source_file`)
      .all();
    const bySource = new Map(rows.map(row => [row.source_file, row.source_size]));
    expect([...bySource.keys()].sort()).toEqual([NEW, OLD].sort());
    expect(bySource.get(OLD)).toBe(AUTHORITATIVE_SIZE);
    expect(bySource.get(NEW)).toBe(0);
    source.close();
  });

  test('bootstrap re-import survives orphaned warm analytics rows without aborting', async () => {
    const { file, source } = await fixture();
    const T = '/transcripts/s1.jsonl';
    const AUTHORITATIVE_SIZE = 4242;
    insertSession(source, { id: 's1', status: 'running', harness: 'claude', transcriptFile: T });
    addChatSource(source, 's1', T, { dev: 66, ino: 99, size: AUTHORITATIVE_SIZE, mtimeMs: 1_000 } as unknown as Stats);

    // Materialize the warm analytics index and install the current triggers.
    const first = new AnalyticsIndex({ databasePath: file });
    await first.close();

    // The warm analytics materialization outlives a pointer-index rebuild that
    // drops and recreates `sessions`. DROP TABLE does not fire ON DELETE CASCADE,
    // so the derived analytics_sessions and analytics_expected_sources rows are
    // left orphaned. Reproduce that state directly by deleting the session with
    // foreign keys off (a cascade would otherwise clear the derived rows).
    source.exec('PRAGMA foreign_keys = OFF');
    source.query(`DELETE FROM sessions WHERE id = 's1'`).run();
    source.exec('PRAGMA foreign_keys = ON');
    expect(
      source.query<{ c: number }, []>(`SELECT COUNT(*) c FROM analytics_sessions WHERE session_id = 's1'`).get()?.c,
    ).toBe(1);
    expect(
      source.query<{ c: number }, []>(`SELECT COUNT(*) c FROM analytics_expected_sources WHERE session_id = 's1'`).get()
        ?.c,
    ).toBe(1);

    // EventStore re-imports each session via INSERT ... ON CONFLICT(id) DO UPDATE.
    // The row is absent, so the INSERT branch fires analytics_sessions_insert while
    // the orphaned derived rows still exist. A plain trigger body would ABORT here
    // (the outer conflict policy overrides a trigger-body OR IGNORE, and a bare
    // INSERT collides outright). The fixed idempotent trigger must not throw.
    const config = {
      id: 's1',
      binary: 'claude-auto-loge',
      model: 'claude-opus-5',
      harness: 'claude',
      mode: 'auto',
      cwd: '/work/repo',
      label: 'batch-a',
      parent: 'lead',
      createdAt: '2026-07-01T00:00:00.000Z',
      transcriptFile: T,
    };
    const state = { id: 's1', status: 'running', startedAt: '2026-07-01T00:00:00.000Z', turn: 1 };
    const reimport = (): void => {
      source
        .query(
          `
          INSERT INTO sessions
            (id, directory, status, created_at, updated_at, config_json, state_json, indexed_at)
          VALUES ('s1', '/tmp/s1', 'running', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', ?, ?, '2026-07-01T00:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            config_json = excluded.config_json,
            state_json = excluded.state_json,
            indexed_at = excluded.indexed_at
        `,
        )
        .run(JSON.stringify(config), JSON.stringify(state));
    };
    expect(() => reimport()).not.toThrow();

    // The derived session row is refreshed and the authoritative expected-source
    // fingerprint survived the placeholder DO NOTHING intact.
    expect(
      source.query<{ status: string }, []>(`SELECT status FROM analytics_sessions WHERE session_id = 's1'`).get()
        ?.status,
    ).toBe('running');
    expect(
      source
        .query<
          { source_size: number },
          [string]
        >(`SELECT source_size FROM analytics_expected_sources WHERE session_id = 's1' AND source_file = ?`)
        .get(T)?.source_size,
    ).toBe(AUTHORITATIVE_SIZE);
    source.close();
  });
});
