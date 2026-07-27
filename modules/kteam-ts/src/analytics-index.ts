import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import {
  type AnalyticsAggregateResult,
  type AnalyticsAggregateResponse,
  type AnalyticsIndexStatus,
  type AnalyticsLabel,
  type AnalyticsMeasure,
  type AnalyticsRawResponse,
  type AnalyticsRawSession,
  type AnalyticsRefreshResult,
  type AnalyticsResponse,
} from './analytics-types';
import { AnalyticsQueryError, matcherLikePattern, parseAnalyticsQuery } from './analytics-query';

export const ANALYTICS_SCHEMA_VERSION = 4;
export const ANALYTICS_RAW_LIMIT = 200;
export const ANALYTICS_GROUP_LIMIT = 500;

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_REFRESH_BYTES = 32 * 1024 * 1024;
const DEFAULT_REFRESH_SOURCES = 64;
const MAX_TRANSCRIPT_LINE_BYTES = 16 * 1024 * 1024;
const SOURCE_RETRY_MS = 5 * 60 * 1000;
const BACKGROUND_REFRESH_MS = 60 * 1000;

const OUTPUT_TYPES_SQL = "'chat.assistant.text','chat.assistant.thinking','chat.assistant.reasoning','tool.use'";
const FAILURE_TYPES_SQL = "'session.failed','session.crashed'";

export interface AnalyticsIndexOptions {
  databasePath: string;
  rawLimit?: number;
  groupLimit?: number;
}

interface ExpectedSourceRow {
  session_id: string;
  source_file: string;
  harness: string;
  source_size: number;
  source_mtime_ms: number;
  device: string | null;
  inode: string | null;
  byte_offset: number | null;
  indexed_size: number | null;
  indexed_mtime_ms: number | null;
  indexed_device: string | null;
  indexed_inode: string | null;
  anchor_hash: string | null;
  has_usage: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  codex_base_input: number | null;
  codex_base_output: number | null;
  codex_base_cached: number | null;
  codex_base_cache_write: number | null;
  codex_last_input: number | null;
  codex_last_output: number | null;
  codex_last_cached: number | null;
  codex_last_cache_write: number | null;
  error: string | null;
  retry_at: string | null;
}

interface ClaudeUsageRow {
  id: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

interface CodexAccumulator {
  baseInput: number;
  baseOutput: number;
  baseCached: number;
  baseCacheWrite: number;
  lastInput: number;
  lastOutput: number;
  lastCached: number;
  lastCacheWrite: number;
  seen: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanNumber(value: unknown): boolean {
  return value === 1 || value === true;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const LABEL_COLUMNS: Record<AnalyticsLabel, string> = {
  wrapper: 'wrapper',
  binary: 'wrapper',
  model: 'model',
  harness: 'harness',
  mode: 'mode',
  status: 'status',
  label: 'label',
  cwd: 'cwd',
  repo: 'cwd',
  parent: 'parent',
  day: 'day',
  week: 'week',
  token_data: 'token_data',
};

const SESSION_COLUMNS = `
  session_id, wrapper, model, harness, mode, status, label, cwd, parent,
  day, week, created_at, started_at, finished_at, turns, context_percent,
  first_output_at, had_stall, had_failure, indexed_at
`;

/**
 * Rebuildable fleet analytics over kteam's authoritative SQLite pointer index.
 *
 * Metadata and lifecycle measures are materialized by SQLite triggers on the
 * existing `sessions`, `events`, `chat_pointers`, and `chat_sources` tables.
 * Total token usage is intentionally separate: a background, byte-cursor
 * scanner streams transcript sources into derived rows. Queries only read the
 * SQLite materialization and therefore never open a transcript.
 */
export class AnalyticsIndex {
  private readonly database: Database;
  private readonly rawLimit: number;
  private readonly groupLimit: number;
  private refreshing = false;
  private refreshPromise?: Promise<AnalyticsRefreshResult>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: AnalyticsIndexOptions) {
    this.rawLimit = options.rawLimit ?? ANALYTICS_RAW_LIMIT;
    this.groupLimit = options.groupLimit ?? ANALYTICS_GROUP_LIMIT;
    this.database = new Database(options.databasePath, { create: true, strict: true });
    try {
      this.database.exec('PRAGMA journal_mode = WAL');
      this.database.exec('PRAGMA synchronous = NORMAL');
      this.database.exec('PRAGMA foreign_keys = ON');
      this.database.exec('PRAGMA busy_timeout = 5000');
      this.initialize();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private initialize(): void {
    const source = this.database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() as { name?: string } | null;
    if (!source) throw new Error('kteam analytics requires the daemon session index (sessions table is missing)');

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS analytics_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const stored = this.database.query("SELECT value FROM analytics_meta WHERE key = 'schema_version'").get() as {
      value?: string;
    } | null;
    const schemaCurrent = stored?.value === String(ANALYTICS_SCHEMA_VERSION);
    if (!schemaCurrent) {
      this.dropSchema();
      this.database.exec(`CREATE TABLE analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    }

    this.createSchema();
    if (!schemaCurrent || this.needsColdIndexSync()) this.syncColdIndex();
    this.database
      .query("INSERT OR REPLACE INTO analytics_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(ANALYTICS_SCHEMA_VERSION));
    this.invalidateIncompleteTokens();
    this.recomputeAllTokenTotals();
  }

  /** Persistent triggers keep a warm index current even while this connection
   *  is closed. Only reconcile when its session coverage proves incomplete. */
  private needsColdIndexSync(): boolean {
    const row = this.database
      .query(
        `
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM sessions) <> (SELECT COUNT(*) FROM analytics_sessions)
          OR EXISTS (
            SELECT 1 FROM sessions source
            LEFT JOIN analytics_sessions derived ON derived.session_id = source.id
            WHERE derived.session_id IS NULL
          )
        THEN 1 ELSE 0 END AS needed
      `,
      )
      .get() as { needed: number };
    return booleanNumber(row.needed);
  }

  private dropSchema(): void {
    this.database.exec(`
      DROP TRIGGER IF EXISTS analytics_sessions_insert;
      DROP TRIGGER IF EXISTS analytics_sessions_update;
      DROP TRIGGER IF EXISTS analytics_session_source_update;
      DROP TRIGGER IF EXISTS analytics_events_insert;
      DROP TRIGGER IF EXISTS analytics_chat_insert;
      DROP TRIGGER IF EXISTS analytics_chat_source_insert;
      DROP TRIGGER IF EXISTS analytics_chat_source_update;
      DROP TABLE IF EXISTS analytics_usage_messages;
      DROP TABLE IF EXISTS analytics_usage_sources;
      DROP TABLE IF EXISTS analytics_expected_sources;
      DROP TABLE IF EXISTS analytics_sessions;
      DROP TABLE IF EXISTS analytics_meta;
    `);
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS analytics_sessions (
        session_id TEXT PRIMARY KEY,
        wrapper TEXT,
        model TEXT,
        harness TEXT,
        mode TEXT,
        status TEXT,
        label TEXT,
        cwd TEXT,
        parent TEXT,
        day TEXT,
        week TEXT,
        created_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        turns INTEGER,
        context_percent REAL,
        first_output_at TEXT,
        had_stall INTEGER NOT NULL DEFAULT 0,
        had_failure INTEGER NOT NULL DEFAULT 0,
        token_known INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        indexed_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS analytics_wrapper_idx ON analytics_sessions(wrapper);
      CREATE INDEX IF NOT EXISTS analytics_model_idx ON analytics_sessions(model);
      CREATE INDEX IF NOT EXISTS analytics_harness_idx ON analytics_sessions(harness);
      CREATE INDEX IF NOT EXISTS analytics_mode_idx ON analytics_sessions(mode);
      CREATE INDEX IF NOT EXISTS analytics_status_idx ON analytics_sessions(status);
      CREATE INDEX IF NOT EXISTS analytics_label_idx ON analytics_sessions(label);
      CREATE INDEX IF NOT EXISTS analytics_cwd_idx ON analytics_sessions(cwd);
      CREATE INDEX IF NOT EXISTS analytics_parent_idx ON analytics_sessions(parent);
      CREATE INDEX IF NOT EXISTS analytics_day_idx ON analytics_sessions(day);
      CREATE INDEX IF NOT EXISTS analytics_week_idx ON analytics_sessions(week);

      CREATE TABLE IF NOT EXISTS analytics_expected_sources (
        session_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        harness TEXT NOT NULL,
        source_size INTEGER NOT NULL DEFAULT 0,
        source_mtime_ms REAL NOT NULL DEFAULT 0,
        device TEXT,
        inode TEXT,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (session_id, source_file),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS analytics_expected_pending_idx
        ON analytics_expected_sources(source_mtime_ms DESC, session_id);

      CREATE TABLE IF NOT EXISTS analytics_usage_sources (
        session_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        harness TEXT NOT NULL,
        device TEXT,
        inode TEXT,
        anchor_hash TEXT,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        source_size INTEGER NOT NULL DEFAULT 0,
        source_mtime_ms REAL NOT NULL DEFAULT 0,
        has_usage INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        codex_base_input INTEGER NOT NULL DEFAULT 0,
        codex_base_output INTEGER NOT NULL DEFAULT 0,
        codex_base_cached INTEGER NOT NULL DEFAULT 0,
        codex_base_cache_write INTEGER NOT NULL DEFAULT 0,
        codex_last_input INTEGER NOT NULL DEFAULT 0,
        codex_last_output INTEGER NOT NULL DEFAULT 0,
        codex_last_cached INTEGER NOT NULL DEFAULT 0,
        codex_last_cache_write INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        retry_at TEXT,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (session_id, source_file),
        FOREIGN KEY (session_id, source_file)
          REFERENCES analytics_expected_sources(session_id, source_file) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS analytics_usage_messages (
        session_id TEXT NOT NULL,
        usage_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_input_tokens INTEGER NOT NULL,
        PRIMARY KEY (session_id, usage_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS analytics_usage_messages_source_idx
        ON analytics_usage_messages(session_id, source_file);

      CREATE TRIGGER IF NOT EXISTS analytics_sessions_insert
      AFTER INSERT ON sessions
      BEGIN
        INSERT INTO analytics_sessions (${SESSION_COLUMNS}) VALUES (
          NEW.id,
          json_extract(NEW.config_json, '$.binary'),
          COALESCE(json_extract(NEW.state_json, '$.observedModel'), json_extract(NEW.config_json, '$.model')),
          json_extract(NEW.config_json, '$.harness'),
          json_extract(NEW.config_json, '$.mode'),
          COALESCE(NEW.status, json_extract(NEW.state_json, '$.status')),
          json_extract(NEW.config_json, '$.label'),
          json_extract(NEW.config_json, '$.cwd'),
          json_extract(NEW.config_json, '$.parent'),
          substr(json_extract(NEW.config_json, '$.createdAt'), 1, 10),
          strftime('%G-W%V', json_extract(NEW.config_json, '$.createdAt')),
          json_extract(NEW.config_json, '$.createdAt'),
          json_extract(NEW.config_json, '$.createdAt'),
          json_extract(NEW.state_json, '$.finishedAt'),
          json_extract(NEW.state_json, '$.turn'),
          CASE WHEN json_extract(NEW.state_json, '$.contextPercent') BETWEEN 0 AND 100
            THEN json_extract(NEW.state_json, '$.contextPercent') ELSE NULL END,
          NULL,
          CASE WHEN COALESCE(NEW.status, json_extract(NEW.state_json, '$.status')) = 'stalled' THEN 1 ELSE 0 END,
          CASE WHEN COALESCE(NEW.status, json_extract(NEW.state_json, '$.status')) = 'failed' THEN 1 ELSE 0 END,
          CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO analytics_expected_sources
          (session_id, source_file, harness, source_size, source_mtime_ms, seen_at)
        SELECT NEW.id, json_extract(NEW.config_json, '$.transcriptFile'),
          COALESCE(json_extract(NEW.config_json, '$.harness'), 'unknown'), 0, 0, CURRENT_TIMESTAMP
        WHERE json_extract(NEW.config_json, '$.transcriptFile') IS NOT NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS analytics_sessions_update
      AFTER UPDATE ON sessions
      BEGIN
        INSERT INTO analytics_sessions (${SESSION_COLUMNS}) VALUES (
          NEW.id,
          json_extract(NEW.config_json, '$.binary'),
          COALESCE(json_extract(NEW.state_json, '$.observedModel'), json_extract(NEW.config_json, '$.model')),
          json_extract(NEW.config_json, '$.harness'),
          json_extract(NEW.config_json, '$.mode'),
          COALESCE(NEW.status, json_extract(NEW.state_json, '$.status')),
          json_extract(NEW.config_json, '$.label'),
          json_extract(NEW.config_json, '$.cwd'),
          json_extract(NEW.config_json, '$.parent'),
          substr(json_extract(NEW.config_json, '$.createdAt'), 1, 10),
          strftime('%G-W%V', json_extract(NEW.config_json, '$.createdAt')),
          json_extract(NEW.config_json, '$.createdAt'),
          json_extract(NEW.config_json, '$.createdAt'),
          json_extract(NEW.state_json, '$.finishedAt'),
          json_extract(NEW.state_json, '$.turn'),
          CASE WHEN json_extract(NEW.state_json, '$.contextPercent') BETWEEN 0 AND 100
            THEN json_extract(NEW.state_json, '$.contextPercent') ELSE NULL END,
          NULL,
          CASE WHEN COALESCE(NEW.status, json_extract(NEW.state_json, '$.status')) = 'stalled' THEN 1 ELSE 0 END,
          CASE WHEN COALESCE(NEW.status, json_extract(NEW.state_json, '$.status')) = 'failed' THEN 1 ELSE 0 END,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(session_id) DO UPDATE SET
          wrapper = excluded.wrapper,
          model = excluded.model,
          harness = excluded.harness,
          mode = excluded.mode,
          status = excluded.status,
          label = excluded.label,
          cwd = excluded.cwd,
          parent = excluded.parent,
          day = excluded.day,
          week = excluded.week,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          turns = excluded.turns,
          context_percent = excluded.context_percent,
          had_stall = MAX(analytics_sessions.had_stall, excluded.had_stall),
          had_failure = MAX(analytics_sessions.had_failure, excluded.had_failure),
          indexed_at = excluded.indexed_at;
      END;

      CREATE TRIGGER IF NOT EXISTS analytics_session_source_update
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
          token_known = 0,
          input_tokens = NULL,
          output_tokens = NULL,
          cached_input_tokens = NULL,
          cache_write_input_tokens = NULL
        WHERE session_id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS analytics_events_insert
      AFTER INSERT ON events
      BEGIN
        UPDATE analytics_sessions SET
          had_stall = CASE WHEN NEW.type = 'session.stalled' THEN 1 ELSE had_stall END,
          had_failure = CASE WHEN NEW.type IN (${FAILURE_TYPES_SQL}) THEN 1 ELSE had_failure END,
          first_output_at = CASE
            WHEN NEW.type IN (${OUTPUT_TYPES_SQL})
              AND (first_output_at IS NULL OR NEW.time < first_output_at) THEN NEW.time
            ELSE first_output_at
          END
        WHERE session_id = NEW.session_id;
      END;

      CREATE TRIGGER IF NOT EXISTS analytics_chat_insert
      AFTER INSERT ON chat_pointers
      WHEN NEW.type IN (${OUTPUT_TYPES_SQL})
      BEGIN
        UPDATE analytics_sessions SET
          first_output_at = CASE
            WHEN first_output_at IS NULL OR NEW.time < first_output_at THEN NEW.time
            ELSE first_output_at
          END
        WHERE session_id = NEW.session_id;
      END;

      CREATE TRIGGER IF NOT EXISTS analytics_chat_source_insert
      AFTER INSERT ON chat_sources
      BEGIN
        INSERT INTO analytics_expected_sources
          (session_id, source_file, harness, source_size, source_mtime_ms, device, inode, seen_at)
        SELECT NEW.session_id, NEW.source_file,
          COALESCE(json_extract(s.config_json, '$.harness'), 'unknown'),
          NEW.source_size, CAST(NEW.source_mtime_ms AS INTEGER), NEW.device, NEW.inode, CURRENT_TIMESTAMP
        FROM sessions s WHERE s.id = NEW.session_id
        ON CONFLICT(session_id, source_file) DO UPDATE SET
          harness = excluded.harness,
          source_size = CASE
            WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
              THEN excluded.source_size ELSE analytics_expected_sources.source_size END,
          source_mtime_ms = MAX(analytics_expected_sources.source_mtime_ms, excluded.source_mtime_ms),
          device = CASE
            WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
              THEN excluded.device ELSE analytics_expected_sources.device END,
          inode = CASE
            WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
              THEN excluded.inode ELSE analytics_expected_sources.inode END,
          seen_at = excluded.seen_at;
        UPDATE analytics_sessions SET
          token_known = 0,
          input_tokens = NULL,
          output_tokens = NULL,
          cached_input_tokens = NULL,
          cache_write_input_tokens = NULL
        WHERE session_id = NEW.session_id AND EXISTS (
          SELECT 1 FROM analytics_expected_sources expected
          LEFT JOIN analytics_usage_sources usage_index
            ON usage_index.session_id = expected.session_id AND usage_index.source_file = expected.source_file
          WHERE expected.session_id = NEW.session_id AND expected.source_file = NEW.source_file
            AND (
              usage_index.session_id IS NULL OR usage_index.error IS NOT NULL
              OR usage_index.byte_offset < expected.source_size
              OR usage_index.source_size <> expected.source_size
              OR usage_index.source_mtime_ms <> expected.source_mtime_ms
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS analytics_chat_source_update
      AFTER UPDATE ON chat_sources
      WHEN OLD.source_size <> NEW.source_size
        OR OLD.source_mtime_ms <> NEW.source_mtime_ms
        OR OLD.device <> NEW.device
        OR OLD.inode <> NEW.inode
      BEGIN
        UPDATE analytics_expected_sources SET
          source_size = NEW.source_size,
          source_mtime_ms = CAST(NEW.source_mtime_ms AS INTEGER),
          device = NEW.device,
          inode = NEW.inode,
          seen_at = CURRENT_TIMESTAMP
        WHERE session_id = NEW.session_id AND source_file = NEW.source_file
          AND CAST(NEW.source_mtime_ms AS INTEGER) >= source_mtime_ms;
        UPDATE analytics_sessions SET
          token_known = 0,
          input_tokens = NULL,
          output_tokens = NULL,
          cached_input_tokens = NULL,
          cache_write_input_tokens = NULL
        WHERE session_id = NEW.session_id AND EXISTS (
          SELECT 1 FROM analytics_expected_sources expected
          LEFT JOIN analytics_usage_sources usage_index
            ON usage_index.session_id = expected.session_id AND usage_index.source_file = expected.source_file
          WHERE expected.session_id = NEW.session_id AND expected.source_file = NEW.source_file
            AND (
              usage_index.session_id IS NULL OR usage_index.error IS NOT NULL
              OR usage_index.byte_offset < expected.source_size
              OR usage_index.source_size <> expected.source_size
              OR usage_index.source_mtime_ms <> expected.source_mtime_ms
            )
        );
      END;
    `);
  }

  /** Populate a missing/cold analytics materialization from SQLite only. */
  private syncColdIndex(): void {
    this.database.transaction(() => {
      this.database.exec(`
        INSERT INTO analytics_sessions (${SESSION_COLUMNS})
        SELECT
          s.id,
          json_extract(s.config_json, '$.binary'),
          COALESCE(json_extract(s.state_json, '$.observedModel'), json_extract(s.config_json, '$.model')),
          json_extract(s.config_json, '$.harness'),
          json_extract(s.config_json, '$.mode'),
          COALESCE(s.status, json_extract(s.state_json, '$.status')),
          json_extract(s.config_json, '$.label'),
          json_extract(s.config_json, '$.cwd'),
          json_extract(s.config_json, '$.parent'),
          substr(json_extract(s.config_json, '$.createdAt'), 1, 10),
          strftime('%G-W%V', json_extract(s.config_json, '$.createdAt')),
          json_extract(s.config_json, '$.createdAt'),
          json_extract(s.config_json, '$.createdAt'),
          json_extract(s.state_json, '$.finishedAt'),
          json_extract(s.state_json, '$.turn'),
          CASE WHEN json_extract(s.state_json, '$.contextPercent') BETWEEN 0 AND 100
            THEN json_extract(s.state_json, '$.contextPercent') ELSE NULL END,
          (SELECT MIN(output.time) FROM (
            SELECT e.time FROM events e
              WHERE e.session_id = s.id AND e.type IN (${OUTPUT_TYPES_SQL})
            UNION ALL
            SELECT c.time FROM chat_pointers c
              WHERE c.session_id = s.id AND c.type IN (${OUTPUT_TYPES_SQL})
          ) output),
          CASE WHEN COALESCE(s.status, json_extract(s.state_json, '$.status')) = 'stalled'
            OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type = 'session.stalled')
            THEN 1 ELSE 0 END,
          CASE WHEN COALESCE(s.status, json_extract(s.state_json, '$.status')) = 'failed'
            OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type IN (${FAILURE_TYPES_SQL}))
            THEN 1 ELSE 0 END,
          CURRENT_TIMESTAMP
        FROM sessions s WHERE 1
        ON CONFLICT(session_id) DO UPDATE SET
          wrapper = excluded.wrapper,
          model = excluded.model,
          harness = excluded.harness,
          mode = excluded.mode,
          status = excluded.status,
          label = excluded.label,
          cwd = excluded.cwd,
          parent = excluded.parent,
          day = excluded.day,
          week = excluded.week,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          turns = excluded.turns,
          context_percent = excluded.context_percent,
          first_output_at = COALESCE(excluded.first_output_at, analytics_sessions.first_output_at),
          had_stall = MAX(analytics_sessions.had_stall, excluded.had_stall),
          had_failure = MAX(analytics_sessions.had_failure, excluded.had_failure),
          indexed_at = excluded.indexed_at;

        DELETE FROM analytics_sessions WHERE session_id NOT IN (SELECT id FROM sessions);

        INSERT INTO analytics_expected_sources
          (session_id, source_file, harness, source_size, source_mtime_ms, device, inode, seen_at)
        SELECT c.session_id, c.source_file,
          COALESCE(json_extract(s.config_json, '$.harness'), 'unknown'),
          c.source_size, CAST(c.source_mtime_ms AS INTEGER), c.device, c.inode, CURRENT_TIMESTAMP
        FROM chat_sources c JOIN sessions s ON s.id = c.session_id WHERE 1
        ON CONFLICT(session_id, source_file) DO UPDATE SET
          harness = excluded.harness,
          source_size = CASE
            WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
              THEN excluded.source_size ELSE analytics_expected_sources.source_size END,
          source_mtime_ms = MAX(analytics_expected_sources.source_mtime_ms, excluded.source_mtime_ms),
          device = CASE
            WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
              THEN excluded.device ELSE analytics_expected_sources.device END,
          inode = CASE
            WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
              THEN excluded.inode ELSE analytics_expected_sources.inode END,
          seen_at = excluded.seen_at;

        INSERT OR IGNORE INTO analytics_expected_sources
          (session_id, source_file, harness, source_size, source_mtime_ms, seen_at)
        SELECT s.id, json_extract(s.config_json, '$.transcriptFile'),
          COALESCE(json_extract(s.config_json, '$.harness'), 'unknown'), 0, 0, CURRENT_TIMESTAMP
        FROM sessions s
        WHERE json_extract(s.config_json, '$.transcriptFile') IS NOT NULL;
      `);
    })();
  }

  private invalidateIncompleteTokens(): void {
    this.database.exec(`
      UPDATE analytics_sessions SET
        token_known = 0,
        input_tokens = NULL,
        output_tokens = NULL,
        cached_input_tokens = NULL,
        cache_write_input_tokens = NULL
      WHERE EXISTS (
        SELECT 1 FROM analytics_expected_sources expected
        LEFT JOIN analytics_usage_sources usage_index
          ON usage_index.session_id = expected.session_id AND usage_index.source_file = expected.source_file
        WHERE expected.session_id = analytics_sessions.session_id
          AND (
            usage_index.session_id IS NULL OR usage_index.error IS NOT NULL
            OR usage_index.byte_offset < expected.source_size
            OR usage_index.source_size <> expected.source_size
            OR usage_index.source_mtime_ms <> expected.source_mtime_ms
          )
      );
    `);
  }

  query(source?: string): AnalyticsResponse {
    this.assertOpen();
    const parsed = parseAnalyticsQuery(source);
    const filter = this.filterSql(parsed.matchers);
    const commonParameters = filter.parameters;
    const matchedRow = this.database
      .query(`${this.baseCte()} SELECT COUNT(*) AS count FROM base b ${filter.where}`)
      .get(...commonParameters) as { count: number };
    const matched = asCount(matchedRow?.count);
    const index = this.indexStatus();
    const responseBase = {
      query: parsed.canonical,
      parsed: { aggregation: parsed.aggregation, groupBy: parsed.groupBy, matchers: parsed.matchers },
      scope: { allSessions: true as const, indexed: index.sessions, matched },
      index,
    };

    if (!parsed.aggregation) {
      const rows = this.database
        .query(
          `
          ${this.baseCte()}
          SELECT * FROM base b ${filter.where}
          ORDER BY created_at DESC, session_id
          LIMIT ${this.rawLimit + 1}
        `,
        )
        .all(...commonParameters) as Array<Record<string, unknown>>;
      const response: AnalyticsRawResponse = {
        ...responseBase,
        kind: 'raw',
        limit: this.rawLimit,
        truncated: rows.length > this.rawLimit,
        results: rows.slice(0, this.rawLimit).map(row => this.rawSession(row)),
      };
      return response;
    }

    const grouping = parsed.groupBy.map((label, index) => {
      const column = LABEL_COLUMNS[label];
      return { label, expression: `b.${column}`, alias: `group_${index}` };
    });
    const selectGroups = grouping.length
      ? `${grouping.map(group => `${group.expression} AS ${group.alias}`).join(', ')},`
      : '';
    const groupSql = grouping.length ? `GROUP BY ${grouping.map(group => group.expression).join(', ')}` : '';
    const orderSql = grouping.length
      ? `ORDER BY ${grouping.map(group => `${group.alias} IS NULL, ${group.alias}`).join(', ')}`
      : '';
    const operation = parsed.aggregation;
    const metric = (column: string, alias: string): string => {
      if (operation === 'count') return `NULL AS ${alias}_value, 0 AS ${alias}_known`;
      const aggregate = `${operation.toUpperCase()}(${column})`;
      return `
        CASE WHEN COUNT(${column}) = COUNT(*) THEN ${aggregate} ELSE NULL END AS ${alias}_value,
        COUNT(${column}) AS ${alias}_known
      `;
    };
    const rows = this.database
      .query(
        `
        ${this.baseCte()}
        SELECT
          ${selectGroups}
          COUNT(*) AS sessions,
          100.0 * SUM(had_stall) / COUNT(*) AS stall_rate,
          100.0 * SUM(had_failure) / COUNT(*) AS failure_rate,
          100.0 * SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) / COUNT(*) AS completion_rate,
          ${metric('total_tokens', 'tokens')},
          ${metric('input_tokens', 'input_tokens')},
          ${metric('output_tokens', 'output_tokens')},
          ${metric('cached_input_tokens', 'cached_input_tokens')},
          ${metric('cache_write_input_tokens', 'cache_write_input_tokens')},
          ${metric('turns', 'turns')},
          ${metric('duration_ms', 'duration_ms')},
          ${metric('ttfo_ms', 'ttfo_ms')},
          ${metric('context_percent', 'context_percent')}
        FROM base b ${filter.where}
        ${groupSql}
        ${orderSql}
        LIMIT ${this.groupLimit + 1}
      `,
      )
      .all(...commonParameters) as Array<Record<string, unknown>>;
    if (rows.length > this.groupLimit)
      throw new AnalyticsQueryError(
        `query produces more than ${this.groupLimit} groups; add a matcher` +
          `${parsed.groupBy.includes('label') ? ' such as {label=batch-*}' : ''} or use fewer grouping labels`,
      );
    const results: AnalyticsAggregateResult[] = rows.map(row => {
      const sessions = asCount(row.sessions);
      const measureTotal = operation === 'count' ? 0 : sessions;
      const labels: Record<string, string | null> = {};
      for (const [index, group] of grouping.entries()) {
        const value = row[`group_${index}`];
        labels[group.label] = value === null || value === undefined ? null : String(value);
      }
      return {
        labels,
        sessions,
        rates: {
          stall: nullableNumber(row.stall_rate) ?? 0,
          failure: nullableNumber(row.failure_rate) ?? 0,
          completion: nullableNumber(row.completion_rate) ?? 0,
        },
        tokens: this.measure(row, 'tokens', measureTotal),
        inputTokens: this.measure(row, 'input_tokens', measureTotal),
        outputTokens: this.measure(row, 'output_tokens', measureTotal),
        cachedInputTokens: this.measure(row, 'cached_input_tokens', measureTotal),
        cacheWriteInputTokens: this.measure(row, 'cache_write_input_tokens', measureTotal),
        turns: this.measure(row, 'turns', measureTotal),
        durationMs: this.measure(row, 'duration_ms', measureTotal),
        timeToFirstOutputMs: this.measure(row, 'ttfo_ms', measureTotal),
        contextEndPercent: this.measure(row, 'context_percent', measureTotal),
      };
    });
    const response: AnalyticsAggregateResponse = {
      ...responseBase,
      kind: 'aggregate',
      aggregation: parsed.aggregation,
      results,
    };
    return response;
  }

  private baseCte(): string {
    return `
      WITH base AS (
        SELECT
          analytics.*,
          CASE WHEN token_known = 1 THEN 'known' ELSE 'unknown' END AS token_data,
          CASE WHEN token_known = 1 THEN input_tokens + output_tokens ELSE NULL END AS total_tokens,
          CASE
            WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
              THEN MAX(0, (julianday(finished_at) - julianday(started_at)) * 86400000.0)
            ELSE NULL
          END AS duration_ms,
          CASE
            WHEN started_at IS NOT NULL AND first_output_at IS NOT NULL
              THEN MAX(0, (julianday(first_output_at) - julianday(started_at)) * 86400000.0)
            ELSE NULL
          END AS ttfo_ms
        FROM analytics_sessions analytics
      )
    `;
  }

  private filterSql(matchers: ReturnType<typeof parseAnalyticsQuery>['matchers']): {
    where: string;
    parameters: string[];
  } {
    if (!matchers.length) return { where: '', parameters: [] };
    const conditions: string[] = [];
    const parameters: string[] = [];
    for (const matcher of matchers) {
      const column = `b.${LABEL_COLUMNS[matcher.label]}`;
      if (matcher.wildcard) {
        conditions.push(`LOWER(COALESCE(CAST(${column} AS TEXT), '')) LIKE LOWER(?) ESCAPE '\\'`);
        parameters.push(matcherLikePattern(matcher.value));
      } else {
        conditions.push(`COALESCE(CAST(${column} AS TEXT), '') = ?`);
        parameters.push(matcher.value);
      }
    }
    return { where: `WHERE ${conditions.join(' AND ')}`, parameters };
  }

  private measure(row: Record<string, unknown>, prefix: string, total: number): AnalyticsMeasure {
    return {
      value: nullableNumber(row[`${prefix}_value`]),
      known: asCount(row[`${prefix}_known`]),
      total,
    };
  }

  private rawSession(row: Record<string, unknown>): AnalyticsRawSession {
    const nullableText = (field: string): string | null => {
      const value = row[field];
      return value === null || value === undefined ? null : String(value);
    };
    return {
      id: String(row.session_id),
      wrapper: nullableText('wrapper'),
      model: nullableText('model'),
      harness: nullableText('harness'),
      mode: nullableText('mode'),
      status: nullableText('status'),
      label: nullableText('label'),
      cwd: nullableText('cwd'),
      parent: nullableText('parent'),
      day: nullableText('day'),
      week: nullableText('week'),
      createdAt: nullableText('created_at'),
      tokens: nullableNumber(row.total_tokens),
      inputTokens: nullableNumber(row.input_tokens),
      outputTokens: nullableNumber(row.output_tokens),
      cachedInputTokens: nullableNumber(row.cached_input_tokens),
      cacheWriteInputTokens: nullableNumber(row.cache_write_input_tokens),
      turns: nullableNumber(row.turns),
      durationMs: nullableNumber(row.duration_ms),
      timeToFirstOutputMs: nullableNumber(row.ttfo_ms),
      contextEndPercent: nullableNumber(row.context_percent),
      stalled: booleanNumber(row.had_stall),
      failed: booleanNumber(row.had_failure),
      completed: row.status === 'completed',
    };
  }

  indexStatus(): AnalyticsIndexStatus {
    this.assertOpen();
    const sessions = this.database
      .query('SELECT COUNT(*) AS sessions, SUM(token_known) AS token_sessions FROM analytics_sessions')
      .get() as { sessions: number; token_sessions: number | null };
    const sources = this.database
      .query(
        `
        SELECT
          COUNT(*) AS sources,
          SUM(CASE WHEN usage_index.error IS NULL
            AND usage_index.byte_offset >= expected.source_size
            AND usage_index.source_size = expected.source_size
            AND usage_index.source_mtime_ms = expected.source_mtime_ms
            THEN 1 ELSE 0 END) AS indexed_sources,
          SUM(CASE WHEN usage_index.error IS NOT NULL THEN 1 ELSE 0 END) AS errors
        FROM analytics_expected_sources expected
        LEFT JOIN analytics_usage_sources usage_index
          ON usage_index.session_id = expected.session_id AND usage_index.source_file = expected.source_file
      `,
      )
      .get() as { sources: number; indexed_sources: number | null; errors: number | null };
    const last = this.database.query("SELECT value FROM analytics_meta WHERE key = 'last_token_refresh_at'").get() as {
      value?: string;
    } | null;
    const sourceCount = asCount(sources.sources);
    const indexedSources = asCount(sources.indexed_sources);
    return {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      sessions: asCount(sessions.sessions),
      tokenSessions: asCount(sessions.token_sessions),
      transcriptSources: sourceCount,
      indexedTranscriptSources: indexedSources,
      pendingTranscriptSources: Math.max(0, sourceCount - indexedSources),
      sourceErrors: asCount(sources.errors),
      refreshing: this.refreshing,
      ...(last?.value ? { lastTokenRefreshAt: last.value } : {}),
    };
  }

  /** Start the low-priority transcript-usage backfill. Query paths never call it. */
  start(): void {
    this.assertOpen();
    if (this.refreshTimer || this.refreshPromise) return;
    const run = async (): Promise<void> => {
      if (this.closed) return;
      let result: AnalyticsRefreshResult | undefined;
      try {
        result = await this.refreshTokens();
      } catch (error) {
        console.error(
          `kteam analytics token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.closed) return;
      const soon = result !== undefined && result.pending > 0 && result.sources > 0 && result.bytes > 0;
      this.refreshTimer = setTimeout(() => void run(), soon ? 100 : BACKGROUND_REFRESH_MS);
    };
    this.refreshTimer = setTimeout(() => void run(), 0);
  }

  refreshTokens(options: { byteBudget?: number; sourceLimit?: number } = {}): Promise<AnalyticsRefreshResult> {
    this.assertOpen();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshing = true;
    const promise = this.performRefresh({
      byteBudget: Math.max(READ_CHUNK_BYTES, options.byteBudget ?? DEFAULT_REFRESH_BYTES),
      sourceLimit: Math.max(1, options.sourceLimit ?? DEFAULT_REFRESH_SOURCES),
    }).finally(() => {
      this.refreshing = false;
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  private async performRefresh(options: { byteBudget: number; sourceLimit: number }): Promise<AnalyticsRefreshResult> {
    this.syncExpectedSources();
    const candidates = this.pendingSources(options.sourceLimit);
    let bytes = 0;
    let sources = 0;
    let errors = 0;
    for (const candidate of candidates) {
      if (this.closed || bytes >= options.byteBudget) break;
      try {
        bytes += await this.scanSource(candidate, options.byteBudget - bytes);
      } catch (error) {
        errors += 1;
        this.recordSourceError(candidate, error);
      }
      sources += 1;
      if (bytes > 0 && bytes % (4 * 1024 * 1024) < READ_CHUNK_BYTES) await Bun.sleep(0);
    }
    const refreshedAt = new Date().toISOString();
    this.database
      .query("INSERT OR REPLACE INTO analytics_meta (key, value) VALUES ('last_token_refresh_at', ?)")
      .run(refreshedAt);
    const status = this.indexStatus();
    return { sources, bytes, pending: status.pendingTranscriptSources, errors };
  }

  private syncExpectedSources(): void {
    this.database.exec(`
      INSERT INTO analytics_expected_sources
        (session_id, source_file, harness, source_size, source_mtime_ms, device, inode, seen_at)
      SELECT source.session_id, source.source_file,
        COALESCE(json_extract(session.config_json, '$.harness'), 'unknown'),
        source.source_size, CAST(source.source_mtime_ms AS INTEGER), source.device, source.inode, CURRENT_TIMESTAMP
      FROM chat_sources source JOIN sessions session ON session.id = source.session_id WHERE 1
      ON CONFLICT(session_id, source_file) DO UPDATE SET
        harness = excluded.harness,
        source_size = CASE
          WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
            THEN excluded.source_size ELSE analytics_expected_sources.source_size END,
        source_mtime_ms = MAX(analytics_expected_sources.source_mtime_ms, excluded.source_mtime_ms),
        device = CASE
          WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
            THEN excluded.device ELSE analytics_expected_sources.device END,
        inode = CASE
          WHEN excluded.source_mtime_ms >= analytics_expected_sources.source_mtime_ms
            THEN excluded.inode ELSE analytics_expected_sources.inode END,
        seen_at = excluded.seen_at;

      INSERT OR IGNORE INTO analytics_expected_sources
        (session_id, source_file, harness, source_size, source_mtime_ms, seen_at)
      SELECT session.id, json_extract(session.config_json, '$.transcriptFile'),
        COALESCE(json_extract(session.config_json, '$.harness'), 'unknown'), 0, 0, CURRENT_TIMESTAMP
      FROM sessions session
      WHERE json_extract(session.config_json, '$.transcriptFile') IS NOT NULL;
    `);
    this.invalidateIncompleteTokens();
  }

  private pendingSources(limit: number): ExpectedSourceRow[] {
    return this.database
      .query(
        `
        SELECT
          expected.session_id, expected.source_file, expected.harness,
          expected.source_size, expected.source_mtime_ms, expected.device, expected.inode,
          usage_index.byte_offset, usage_index.source_size AS indexed_size,
          usage_index.source_mtime_ms AS indexed_mtime_ms,
          usage_index.device AS indexed_device, usage_index.inode AS indexed_inode,
          usage_index.anchor_hash,
          usage_index.has_usage, usage_index.input_tokens, usage_index.output_tokens,
          usage_index.cached_input_tokens, usage_index.cache_write_input_tokens,
          usage_index.codex_base_input, usage_index.codex_base_output,
          usage_index.codex_base_cached, usage_index.codex_base_cache_write,
          usage_index.codex_last_input, usage_index.codex_last_output,
          usage_index.codex_last_cached, usage_index.codex_last_cache_write,
          usage_index.error, usage_index.retry_at
        FROM analytics_expected_sources expected
        LEFT JOIN analytics_usage_sources usage_index
          ON usage_index.session_id = expected.session_id AND usage_index.source_file = expected.source_file
        WHERE usage_index.session_id IS NULL
          OR (usage_index.error IS NULL AND (
            usage_index.byte_offset < expected.source_size
            OR usage_index.source_size <> expected.source_size
            OR usage_index.source_mtime_ms <> expected.source_mtime_ms
          ))
          OR (usage_index.error IS NOT NULL AND (
            usage_index.retry_at IS NULL OR julianday(usage_index.retry_at) <= julianday('now')
          ))
        ORDER BY
          CASE WHEN usage_index.session_id IS NULL THEN 0 WHEN usage_index.error IS NULL THEN 1 ELSE 2 END,
          expected.source_mtime_ms DESC,
          expected.session_id
        LIMIT ${Math.max(1, limit)}
      `,
      )
      .all() as ExpectedSourceRow[];
  }

  private async scanSource(source: ExpectedSourceRow, byteBudget: number): Promise<number> {
    let handle;
    try {
      handle = await open(source.source_file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('transcript source is missing');
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error('transcript source is not a regular file');
      const device = before.dev.toString();
      const inode = before.ino.toString();
      const beforeMtimeMs = Math.trunc(before.mtimeMs);
      const previousOffset = source.byte_offset ?? 0;
      const previousAnchor = previousOffset > 0 ? await this.sourceAnchor(handle, previousOffset) : null;
      const reset =
        (source.indexed_device !== null && source.indexed_device !== device) ||
        (source.indexed_inode !== null && source.indexed_inode !== inode) ||
        before.size < previousOffset ||
        (previousOffset > 0 && (source.anchor_hash === null || source.anchor_hash !== previousAnchor)) ||
        (source.indexed_size === before.size && source.indexed_mtime_ms !== beforeMtimeMs);
      const offset = reset ? 0 : previousOffset;
      const claudeMessages = new Map<string, ClaudeUsageRow>();
      const codex: CodexAccumulator = {
        baseInput: reset ? 0 : (source.codex_base_input ?? 0),
        baseOutput: reset ? 0 : (source.codex_base_output ?? 0),
        baseCached: reset ? 0 : (source.codex_base_cached ?? 0),
        baseCacheWrite: reset ? 0 : (source.codex_base_cache_write ?? 0),
        lastInput: reset ? 0 : (source.codex_last_input ?? 0),
        lastOutput: reset ? 0 : (source.codex_last_output ?? 0),
        lastCached: reset ? 0 : (source.codex_last_cached ?? 0),
        lastCacheWrite: reset ? 0 : (source.codex_last_cache_write ?? 0),
        seen: reset ? false : booleanNumber(source.has_usage),
      };
      let carry = Buffer.alloc(0);
      let carryOffset = offset;
      let readPosition = offset;
      let bytes = 0;
      while (readPosition < before.size) {
        if (this.closed) break;
        if (bytes >= byteBudget && carry.length === 0) break;
        const readSize = Math.min(READ_CHUNK_BYTES, before.size - readPosition);
        const chunk = Buffer.allocUnsafe(readSize);
        const result = await handle.read(chunk, 0, readSize, readPosition);
        if (result.bytesRead === 0) break;
        const actual = chunk.subarray(0, result.bytesRead);
        readPosition += result.bytesRead;
        bytes += result.bytesRead;
        const combined = carry.length ? Buffer.concat([carry, actual]) : actual;
        let lineStart = 0;
        for (let index = 0; index < combined.length; index += 1) {
          if (combined[index] !== 0x0a) continue;
          let line = combined.subarray(lineStart, index);
          if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
          if (line.length > MAX_TRANSCRIPT_LINE_BYTES)
            throw new Error(`transcript line exceeds ${MAX_TRANSCRIPT_LINE_BYTES} bytes`);
          if (line.length) this.parseUsageLine(line, source.harness, claudeMessages, codex);
          lineStart = index + 1;
        }
        carryOffset += lineStart;
        carry = combined.subarray(lineStart);
        if (carry.length > MAX_TRANSCRIPT_LINE_BYTES)
          throw new Error(`transcript line exceeds ${MAX_TRANSCRIPT_LINE_BYTES} bytes`);
      }
      const after = await stat(source.source_file);
      if (after.dev.toString() !== device || after.ino.toString() !== inode)
        throw new Error('transcript source changed identity while it was being indexed');
      const afterMtimeMs = Math.trunc(after.mtimeMs);
      if (after.size < before.size || (after.size === before.size && afterMtimeMs !== beforeMtimeMs))
        throw new Error('transcript source was rewritten while it was being indexed');
      const anchorHash = await this.sourceAnchor(handle, carryOffset);

      const hasUsage = (reset ? false : booleanNumber(source.has_usage)) || claudeMessages.size > 0 || codex.seen;
      const inputTokens = source.harness === 'codex' && codex.seen ? codex.baseInput + codex.lastInput : null;
      const outputTokens = source.harness === 'codex' && codex.seen ? codex.baseOutput + codex.lastOutput : null;
      const cachedTokens = source.harness === 'codex' && codex.seen ? codex.baseCached + codex.lastCached : null;
      const cacheWriteTokens =
        source.harness === 'codex' && codex.seen ? codex.baseCacheWrite + codex.lastCacheWrite : null;
      this.database.transaction(() => {
        if (reset) {
          this.database.query('DELETE FROM analytics_usage_messages WHERE session_id = ?').run(source.session_id);
          this.database.query('DELETE FROM analytics_usage_sources WHERE session_id = ?').run(source.session_id);
        }
        const upsertMessage = this.database.query(`
          INSERT INTO analytics_usage_messages
            (session_id, usage_id, source_file, input_tokens, output_tokens,
             cached_input_tokens, cache_write_input_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, usage_id) DO UPDATE SET
            source_file = excluded.source_file,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            cache_write_input_tokens = excluded.cache_write_input_tokens
        `);
        for (const usage of claudeMessages.values())
          upsertMessage.run(
            source.session_id,
            usage.id,
            source.source_file,
            usage.inputTokens,
            usage.outputTokens,
            usage.cachedInputTokens,
            usage.cacheWriteInputTokens,
          );
        this.database
          .query(
            `
            INSERT INTO analytics_usage_sources (
              session_id, source_file, harness, device, inode, anchor_hash, byte_offset,
              source_size, source_mtime_ms, has_usage,
              input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens,
              codex_base_input, codex_base_output, codex_base_cached, codex_base_cache_write,
              codex_last_input, codex_last_output, codex_last_cached, codex_last_cache_write,
              error, retry_at, indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
            ON CONFLICT(session_id, source_file) DO UPDATE SET
              harness = excluded.harness,
              device = excluded.device,
              inode = excluded.inode,
              anchor_hash = excluded.anchor_hash,
              byte_offset = excluded.byte_offset,
              source_size = excluded.source_size,
              source_mtime_ms = excluded.source_mtime_ms,
              has_usage = excluded.has_usage,
              input_tokens = excluded.input_tokens,
              output_tokens = excluded.output_tokens,
              cached_input_tokens = excluded.cached_input_tokens,
              cache_write_input_tokens = excluded.cache_write_input_tokens,
              codex_base_input = excluded.codex_base_input,
              codex_base_output = excluded.codex_base_output,
              codex_base_cached = excluded.codex_base_cached,
              codex_base_cache_write = excluded.codex_base_cache_write,
              codex_last_input = excluded.codex_last_input,
              codex_last_output = excluded.codex_last_output,
              codex_last_cached = excluded.codex_last_cached,
              codex_last_cache_write = excluded.codex_last_cache_write,
              error = NULL,
              retry_at = NULL,
              indexed_at = excluded.indexed_at
          `,
          )
          .run(
            source.session_id,
            source.source_file,
            source.harness,
            device,
            inode,
            anchorHash,
            carryOffset,
            after.size,
            afterMtimeMs,
            hasUsage ? 1 : 0,
            inputTokens,
            outputTokens,
            cachedTokens,
            cacheWriteTokens,
            codex.baseInput,
            codex.baseOutput,
            codex.baseCached,
            codex.baseCacheWrite,
            codex.lastInput,
            codex.lastOutput,
            codex.lastCached,
            codex.lastCacheWrite,
            new Date().toISOString(),
          );
        this.database
          .query(
            `
            UPDATE analytics_expected_sources SET
              harness = ?, source_size = ?, source_mtime_ms = ?, device = ?, inode = ?, seen_at = ?
            WHERE session_id = ? AND source_file = ?
          `,
          )
          .run(
            source.harness,
            after.size,
            afterMtimeMs,
            device,
            inode,
            new Date().toISOString(),
            source.session_id,
            source.source_file,
          );
      })();
      this.recomputeSessionTokens(source.session_id);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  /** Fingerprint the bytes immediately before a committed line cursor. Appends
   *  preserve it; in-place compaction/rewrite does not, so stale token totals
   *  are discarded before the new source is scanned. */
  private async sourceAnchor(handle: FileHandle, offset: number): Promise<string | null> {
    if (offset <= 0) return null;
    const length = Math.min(512, offset);
    const bytes = Buffer.allocUnsafe(length);
    const result = await handle.read(bytes, 0, length, offset - length);
    if (result.bytesRead !== length) return null;
    return createHash('sha256').update(bytes).digest('base64url');
  }

  private parseUsageLine(
    bytes: Buffer,
    harness: string,
    claudeMessages: Map<string, ClaudeUsageRow>,
    codex: CodexAccumulator,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('invalid JSON in transcript source');
    }
    const root = record(parsed);
    if (!root) return;
    if (harness === 'claude') {
      const message = record(root.message);
      const usage = record(message?.usage);
      if (root.type !== 'assistant' || !message || !usage) return;
      const id = text(message.id);
      if (!id) throw new Error('Claude usage record has no stable message id');
      const direct = tokenNumber(usage.input_tokens);
      const output = tokenNumber(usage.output_tokens);
      if (direct === undefined || output === undefined)
        throw new Error('Claude usage record has invalid required token counts');
      const cached = tokenNumber(usage.cache_read_input_tokens ?? 0);
      const cacheWrite = tokenNumber(usage.cache_creation_input_tokens ?? 0);
      if (cached === undefined || cacheWrite === undefined)
        throw new Error('Claude usage record has invalid cache token counts');
      claudeMessages.set(id, {
        id,
        inputTokens: direct + cached + cacheWrite,
        outputTokens: output,
        cachedInputTokens: cached,
        cacheWriteInputTokens: cacheWrite,
      });
      return;
    }
    if (harness !== 'codex') return;
    const payload = record(root.payload);
    const info = record(payload?.info);
    const total = record(info?.total_token_usage);
    if (root.type !== 'event_msg' || payload?.type !== 'token_count' || !total) return;
    const input = tokenNumber(total.input_tokens);
    const output = tokenNumber(total.output_tokens);
    if (input === undefined || output === undefined)
      throw new Error('Codex usage record has invalid required token counts');
    const cached = tokenNumber(total.cached_input_tokens ?? 0);
    const cacheWrite = tokenNumber(total.cache_write_input_tokens ?? 0);
    if (cached === undefined || cacheWrite === undefined)
      throw new Error('Codex usage record has invalid cache token counts');
    // A resumed/compacted Codex stream may restart its cumulative counter.
    // Preserve the completed segment before accepting the smaller new one.
    if (codex.seen && (input < codex.lastInput || output < codex.lastOutput)) {
      codex.baseInput += codex.lastInput;
      codex.baseOutput += codex.lastOutput;
      codex.baseCached += codex.lastCached;
      codex.baseCacheWrite += codex.lastCacheWrite;
    }
    codex.lastInput = input;
    codex.lastOutput = output;
    codex.lastCached = cached;
    codex.lastCacheWrite = cacheWrite;
    codex.seen = true;
  }

  private recordSourceError(source: ExpectedSourceRow, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const retryAt = new Date(Date.now() + SOURCE_RETRY_MS).toISOString();
    this.database
      .query(
        `
        INSERT INTO analytics_usage_sources
          (session_id, source_file, harness, byte_offset, source_size, source_mtime_ms,
           has_usage, error, retry_at, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, source_file) DO UPDATE SET
          error = excluded.error,
          retry_at = excluded.retry_at,
          indexed_at = excluded.indexed_at
      `,
      )
      .run(
        source.session_id,
        source.source_file,
        source.harness,
        source.byte_offset ?? 0,
        source.indexed_size ?? 0,
        source.indexed_mtime_ms ?? 0,
        source.has_usage ?? 0,
        message.slice(0, 500),
        retryAt,
        new Date().toISOString(),
      );
    this.database
      .query(
        `
        UPDATE analytics_sessions SET token_known = 0, input_tokens = NULL,
          output_tokens = NULL, cached_input_tokens = NULL, cache_write_input_tokens = NULL
        WHERE session_id = ?
      `,
      )
      .run(source.session_id);
  }

  private recomputeSessionTokens(sessionId: string): void {
    const coverage = this.database
      .query(
        `
        SELECT
          COUNT(*) AS expected,
          SUM(CASE WHEN usage_index.error IS NULL
            AND usage_index.byte_offset >= expected.source_size
            AND usage_index.source_size = expected.source_size
            AND usage_index.source_mtime_ms = expected.source_mtime_ms
            THEN 1 ELSE 0 END) AS complete,
          SUM(CASE WHEN usage_index.has_usage = 1 THEN 1 ELSE 0 END) AS with_usage
        FROM analytics_expected_sources expected
        LEFT JOIN analytics_usage_sources usage_index
          ON usage_index.session_id = expected.session_id AND usage_index.source_file = expected.source_file
        WHERE expected.session_id = ?
      `,
      )
      .get(sessionId) as { expected: number; complete: number | null; with_usage: number | null };
    const expected = asCount(coverage.expected);
    const complete = asCount(coverage.complete);
    const withUsage = asCount(coverage.with_usage);
    if (expected === 0 || complete !== expected || withUsage === 0) {
      this.database
        .query(
          `
          UPDATE analytics_sessions SET token_known = 0, input_tokens = NULL,
            output_tokens = NULL, cached_input_tokens = NULL, cache_write_input_tokens = NULL
          WHERE session_id = ?
        `,
        )
        .run(sessionId);
      return;
    }
    const totals = this.database
      .query(
        `
        SELECT
          COALESCE((SELECT SUM(input_tokens) FROM analytics_usage_messages WHERE session_id = ?), 0)
            + COALESCE((SELECT SUM(input_tokens) FROM analytics_usage_sources
                WHERE session_id = ? AND harness = 'codex' AND has_usage = 1), 0) AS input_tokens,
          COALESCE((SELECT SUM(output_tokens) FROM analytics_usage_messages WHERE session_id = ?), 0)
            + COALESCE((SELECT SUM(output_tokens) FROM analytics_usage_sources
                WHERE session_id = ? AND harness = 'codex' AND has_usage = 1), 0) AS output_tokens,
          COALESCE((SELECT SUM(cached_input_tokens) FROM analytics_usage_messages WHERE session_id = ?), 0)
            + COALESCE((SELECT SUM(cached_input_tokens) FROM analytics_usage_sources
                WHERE session_id = ? AND harness = 'codex' AND has_usage = 1), 0) AS cached_input_tokens,
          COALESCE((SELECT SUM(cache_write_input_tokens) FROM analytics_usage_messages WHERE session_id = ?), 0)
            + COALESCE((SELECT SUM(cache_write_input_tokens) FROM analytics_usage_sources
                WHERE session_id = ? AND harness = 'codex' AND has_usage = 1), 0) AS cache_write_input_tokens
      `,
      )
      .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as {
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      cache_write_input_tokens: number;
    };
    this.database
      .query(
        `
        UPDATE analytics_sessions SET token_known = 1, input_tokens = ?, output_tokens = ?,
          cached_input_tokens = ?, cache_write_input_tokens = ? WHERE session_id = ?
      `,
      )
      .run(
        totals.input_tokens,
        totals.output_tokens,
        totals.cached_input_tokens,
        totals.cache_write_input_tokens,
        sessionId,
      );
  }

  private recomputeAllTokenTotals(): void {
    const rows = this.database
      .query(
        `
        SELECT expected.session_id
        FROM analytics_expected_sources expected
        JOIN analytics_sessions session ON session.session_id = expected.session_id
        LEFT JOIN analytics_usage_sources source
          ON source.session_id = expected.session_id AND source.source_file = expected.source_file
        WHERE session.token_known = 0
        GROUP BY expected.session_id
        HAVING COUNT(*) = SUM(CASE WHEN source.error IS NULL
            AND source.byte_offset >= expected.source_size
            AND source.source_size = expected.source_size
            AND source.source_mtime_ms = expected.source_mtime_ms
            THEN 1 ELSE 0 END)
          AND SUM(CASE WHEN source.has_usage = 1 THEN 1 ELSE 0 END) > 0
      `,
      )
      .all() as Array<{ session_id: string }>;
    for (const row of rows) this.recomputeSessionTokens(row.session_id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.refreshPromise?.catch(() => undefined);
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('analytics index is closed');
  }
}
