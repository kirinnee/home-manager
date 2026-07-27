import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Stats } from 'node:fs';
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalyticsIndex } from './analytics-index';

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
    transcriptFile?: string;
    createdAt?: string;
    startedAt?: string;
    finishedAt?: string;
    turn?: number;
    contextPercent?: number;
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
    parent: 'lead',
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

    const state = { id: 's2', status: 'completed', startedAt: '2026-07-01T00:00:00.000Z', turn: 3 };
    source.query(`UPDATE sessions SET status = 'completed', state_json = ? WHERE id = 's2'`).run(JSON.stringify(state));
    const filtered = index.query('count by (status) {status=completed}');
    expect(filtered.scope.matched).toBe(2);
    expect(filtered.kind === 'aggregate' && filtered.results[0]?.rates.completion).toBe(100);
    expect(filtered.kind === 'aggregate' && filtered.results[0]?.tokens).toEqual({ value: null, known: 0, total: 0 });
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
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 7,
        },
      },
    });
    const claudeB = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg-b', usage: { input_tokens: 1, output_tokens: 2 } },
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
    await writeFile(codexFile, `${codex(10, 2)}\n${codex(20, 5, 8)}\n`);
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

    const claudeRaw = index.query('{model=claude-opus-5}');
    expect(claudeRaw.kind).toBe('raw');
    if (claudeRaw.kind !== 'raw') throw new Error('expected raw');
    // msg-a occurs twice in the transcript but counts once: input 35+1, output 7+2.
    expect(claudeRaw.results[0]?.inputTokens).toBe(36);
    expect(claudeRaw.results[0]?.outputTokens).toBe(9);
    expect(claudeRaw.results[0]?.tokens).toBe(45);

    const codexRaw = index.query('{model=gpt-5.6-sol}');
    expect(codexRaw.kind === 'raw' && codexRaw.results[0]?.tokens).toBe(25);

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
    const unknown = index.query('{model=gpt-5.6-sol}');
    expect(unknown.kind === 'raw' && unknown.results[0]?.tokens).toBeNull();
    await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    const updated = index.query('{model=gpt-5.6-sol}');
    expect(updated.kind === 'raw' && updated.results[0]?.tokens).toBe(38);

    // Rewriting a transcript in place can preserve its inode and byte length.
    // The cursor anchor must still invalidate and rebuild the cumulative total.
    const rewrittenTranscript = `${codex(11, 1)}\n${codex(22, 4, 7)}\n${codex(50, 9, 13)}\n`;
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
    const unknownAfterRewrite = index.query('{model=gpt-5.6-sol}');
    expect(unknownAfterRewrite.kind === 'raw' && unknownAfterRewrite.results[0]?.tokens).toBeNull();
    await index.refreshTokens({ byteBudget: 1024 * 1024, sourceLimit: 10 });
    const afterRewrite = index.query('{model=gpt-5.6-sol}');
    expect(afterRewrite.kind === 'raw' && afterRewrite.results[0]?.tokens).toBe(59);
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
});
