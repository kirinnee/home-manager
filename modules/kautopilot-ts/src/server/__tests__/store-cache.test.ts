import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origHome = process.env.HOME;

// The store cache is process-global and keyed by session id, so tests use fresh
// ids to avoid cross-test bleed and call clearStoreCache in afterEach.

describe("store-cache", () => {
	let tempDir: string;
	let mod: typeof import("../store-cache");

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kautopilot-cache-"));
		process.env.HOME = tempDir;
		mod = require("../store-cache") as typeof import("../store-cache");
		mod.clearStoreCache();
	});

	afterEach(() => {
		mod.clearStoreCache();
		process.env.HOME = origHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(id: string, ticket: string): void {
		const dir = join(tempDir, ".kautopilot", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "session.json"),
			`${JSON.stringify({
				sessionId: id,
				folder: "/tmp",
				ticketId: ticket,
				org: "liftoff",
				ticketSystem: "jira",
				commitSpec: false,
				baseBranch: "master",
				epoch: 1,
				runMode: "current-session",
				execMode: "kloop",
				maxParallelRepos: 1,
				repos: [],
			})}\n`,
		);
		writeFileSync(join(dir, "log.jsonl"), "");
	}

	it("returns summaries and reflects a changed session.json (cache invalidation)", async () => {
		writeSession("c1", "PE-100");
		let list = await mod.listSessionSummariesCached();
		expect(list).toHaveLength(1);
		expect(list[0].ticketId).toBe("PE-100");

		// A repeat call (nothing changed) still returns the same value.
		list = await mod.listSessionSummariesCached();
		expect(list[0].ticketId).toBe("PE-100");

		// Mutate session.json → the mtime key changes → cache recomputes.
		await Bun.sleep(10);
		writeSession("c1", "PE-200");
		list = await mod.listSessionSummariesCached();
		expect(list[0].ticketId).toBe("PE-200");
	});

	it("drops cache entries for removed sessions", async () => {
		writeSession("c2", "PE-1");
		expect(await mod.listSessionSummariesCached()).toHaveLength(1);
		rmSync(join(tempDir, ".kautopilot", "c2"), {
			recursive: true,
			force: true,
		});
		expect(await mod.listSessionSummariesCached()).toHaveLength(0);
	});

	it("fingerprint changes when the store changes and is stable otherwise", async () => {
		writeSession("c3", "PE-1");
		const a = await mod.storeFingerprintAsync();
		expect(a).toBeGreaterThan(0);
		const b = await mod.storeFingerprintAsync();
		expect(b).toBe(a);
		await Bun.sleep(10);
		writeFileSync(
			join(tempDir, ".kautopilot", "c3", "log.jsonl"),
			'{"ts":"t","event":"x"}\n',
		);
		const c = await mod.storeFingerprintAsync();
		expect(c).toBeGreaterThan(a);
	});

	it("shared fingerprint is throttled within the window", async () => {
		writeSession("c4", "PE-1");
		const t = 1_000_000;
		const first = await mod.getStoreFingerprint(t);
		// A change lands but we poll again inside the throttle window → cached value.
		await Bun.sleep(10);
		writeFileSync(join(tempDir, ".kautopilot", "c4", "log.jsonl"), "changed\n");
		const cached = await mod.getStoreFingerprint(t + 100);
		expect(cached).toBe(first);
		// Past the throttle window → recomputed, reflects the change.
		const fresh = await mod.getStoreFingerprint(t + 1000);
		expect(fresh).toBeGreaterThan(first);
	});

	it("getSessionDetailCached returns detail and null for unknown", async () => {
		writeSession("c5", "PE-9");
		const d = await mod.getSessionDetailCached("c5");
		expect(d?.meta.sessionId).toBe("c5");
		expect(d?.modes.run).toBe("current-session");
		expect(await mod.getSessionDetailCached("nope")).toBeNull();
	});

	it("detail cache invalidates on a NEW nested revision (spec/v2)", async () => {
		// Regression for the stale-detail finding: writing epoch/1/spec/v2.md bumps
		// the nested spec dir, NOT the epoch root — the detail key must still change.
		writeSession("c6", "PE-1");
		const specDir = join(tempDir, ".kautopilot", "c6", "epoch", "1", "spec");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "v1.md"), "# Spec v1\n");
		const first = await mod.getSessionDetailCached("c6");
		expect(first?.artifacts.spec.map((r) => r.version)).toEqual([1]);

		await Bun.sleep(10);
		writeFileSync(join(specDir, "v2.md"), "# Spec v2\n");
		const second = await mod.getSessionDetailCached("c6");
		expect(second?.artifacts.spec.map((r) => r.version)).toEqual([1, 2]);
	});
});
