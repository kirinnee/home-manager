import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRow } from "../types";

// The folder-based schema, mirroring core/db.ts. A session is associated with a
// FOLDER (where `start` ran), never a repo/worktree.
function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      folder      TEXT NOT NULL,
      ticket_id   TEXT,
      local       INTEGER NOT NULL DEFAULT 0,
      state       TEXT NOT NULL DEFAULT 'init',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder);
  `);
	return db;
}

const UPSERT_SQL = `
  INSERT INTO sessions (id, folder, ticket_id, local, state, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT(id) DO UPDATE SET
    folder = $2,
    ticket_id = $3,
    local = $4,
    state = $5,
    updated_at = $7
`;

function rowToParams(row: SessionRow): (string | number | null)[] {
	return [
		row.id,
		row.folder,
		row.ticket_id,
		row.local,
		row.state,
		row.created_at,
		row.updated_at,
	];
}

const sampleRow = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
	id,
	folder: "/Users/me/platforms/nitroso",
	ticket_id: "PE-1234",
	local: 0,
	state: "ready",
	created_at: "2026-03-24T10:00:00Z",
	updated_at: "2026-03-24T10:00:00Z",
	...over,
});

describe("Database operations (folder schema)", () => {
	let db: Database;

	beforeEach(() => {
		db = createTestDb();
	});

	afterEach(() => {
		db.close();
	});

	it("inserts and retrieves a session", () => {
		const row = sampleRow("test1234");
		db.query(UPSERT_SQL).run(...rowToParams(row));

		const result = db
			.query("SELECT * FROM sessions WHERE id = $1")
			.get(row.id) as SessionRow;
		expect(result).not.toBeNull();
		expect(result?.folder).toBe("/Users/me/platforms/nitroso");
		expect(result?.ticket_id).toBe("PE-1234");
		expect(result?.local).toBe(0);
		expect(result?.state).toBe("ready");
	});

	it("upserts a session", () => {
		const row = sampleRow("test1234", { state: "init" });
		db.query(UPSERT_SQL).run(...rowToParams(row));

		const updated = sampleRow("test1234", {
			ticket_id: "PE-5678",
			state: "ready",
			updated_at: "2026-03-24T11:00:00Z",
		});
		db.query(UPSERT_SQL).run(...rowToParams(updated));

		const result = db
			.query("SELECT * FROM sessions WHERE id = $1")
			.get(row.id) as SessionRow;
		expect(result?.ticket_id).toBe("PE-5678");
		expect(result?.state).toBe("ready");
		expect(result?.updated_at).toBe("2026-03-24T11:00:00Z");
	});

	it("lists all sessions", () => {
		db.query(UPSERT_SQL).run(...rowToParams(sampleRow("a1", { folder: "/a" })));
		db.query(UPSERT_SQL).run(...rowToParams(sampleRow("b2", { folder: "/b" })));

		const results = db
			.query("SELECT * FROM sessions ORDER BY created_at DESC")
			.all() as SessionRow[];
		expect(results).toHaveLength(2);
	});

	it("deletes a session", () => {
		db.query(UPSERT_SQL).run(...rowToParams(sampleRow("del1")));
		db.query("DELETE FROM sessions WHERE id = $1").run("del1");
		const result = db.query("SELECT * FROM sessions WHERE id = $1").get("del1");
		expect(result).toBeNull();
	});

	it("defaults state to init", () => {
		db.query(UPSERT_SQL).run(
			"s1",
			"/s",
			null,
			0,
			"init",
			"2026-03-24T10:00:00Z",
			"2026-03-24T10:00:00Z",
		);
		const result = db
			.query("SELECT * FROM sessions WHERE id = $1")
			.get("s1") as SessionRow;
		expect(result.state).toBe("init");
	});

	it("allows multiple sessions in the SAME folder (no 1-per-folder limit)", () => {
		db.query(UPSERT_SQL).run(
			...rowToParams(sampleRow("s1", { folder: "/hub" })),
		);
		db.query(UPSERT_SQL).run(
			...rowToParams(sampleRow("s2", { folder: "/hub" })),
		);
		const results = db
			.query("SELECT * FROM sessions WHERE folder = $1")
			.all("/hub") as SessionRow[];
		expect(results).toHaveLength(2);
	});
});

// Exercise the REAL module's legacy→folder migration on a pre-seeded old-schema DB.
describe("legacy → folder migration (real module)", () => {
	let origHome: string;
	let tmp: string;

	beforeEach(() => {
		origHome = process.env.HOME as string;
		tmp = mkdtempSync(join(tmpdir(), "kauto-dbmig-"));
		process.env.HOME = tmp;
	});

	afterEach(() => {
		process.env.HOME = origHome;
		rmSync(tmp, { recursive: true, force: true });
	});

	it("backfills folder from repo_path and serves it via getSessionsByFolder", () => {
		const dir = join(tmp, ".kautopilot");
		mkdirSync(dir, { recursive: true });
		const legacy = new Database(join(dir, "index.db"));
		legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, worktree TEXT NOT NULL,
        git_root TEXT NOT NULL, git_root_host TEXT NOT NULL, ticket_id TEXT,
        branch TEXT, local INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'init', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
		legacy
			.query(
				"INSERT INTO sessions (id, repo_path, worktree, git_root, git_root_host, ticket_id, branch, local, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				"leg1",
				"/Users/me/runbook",
				"/Users/me/runbook",
				"x",
				"x",
				"CU-1",
				"br",
				0,
				"running",
				"t",
				"t",
			);
		legacy.close();

		// Touching the real module opens index.db → runs the migration.
		const { getSessionById, getSessionsByFolder } =
			require("../db") as typeof import("../db");
		const row = getSessionById("leg1");
		expect(row?.folder).toBe("/Users/me/runbook");
		// The legacy repo/worktree columns are gone from the row shape.
		expect(
			(row as unknown as Record<string, unknown>).repo_path,
		).toBeUndefined();
		expect(getSessionsByFolder("/Users/me/runbook")).toHaveLength(1);
	});
});
