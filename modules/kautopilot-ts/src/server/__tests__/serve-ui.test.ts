import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";

// Covers the redesign's serve-layer additions: mode-as-data, /api/meta, the
// /api/config GET/PUT surface (with wrapper validation), and the SPA/legacy
// fallback. Each test runs against a throwaway $HOME so the real store is never
// touched. The store-cache is process-global, so we vary session ids per test.

const origHome = process.env.HOME;
const origKteamUrl = process.env.KTEAM_URL;

describe("serve — redesign additions", () => {
	let tempDir: string;
	let server: ReturnType<typeof Bun.serve>;
	let base: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "kautopilot-serveui-"));
		process.env.HOME = tempDir;
		const { handleRequest } =
			require("../routes") as typeof import("../routes");
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: handleRequest,
		});
		base = `http://127.0.0.1:${server.port}`;
	});

	afterEach(() => {
		server.stop(true);
		process.env.HOME = origHome;
		if (origKteamUrl === undefined) delete process.env.KTEAM_URL;
		else process.env.KTEAM_URL = origKteamUrl;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(id: string, extra: Record<string, unknown> = {}): void {
		const dir = join(tempDir, ".kautopilot", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "session.json"),
			`${JSON.stringify({
				sessionId: id,
				folder: "/tmp/hub",
				ticketId: "PE-1",
				org: "liftoff",
				ticketSystem: "jira",
				commitSpec: false,
				baseBranch: "master",
				epoch: 1,
				runMode: "current-session",
				execMode: "kloop",
				mergeMode: "auto",
				writerMode: "deferred",
				maxParallelRepos: 2,
				repos: [],
				...extra,
			})}\n`,
		);
		writeFileSync(join(dir, "log.jsonl"), "");
	}

	it("surfaces modes as opaque strings, incl. a forward-compat pipeline field", async () => {
		writeSession("modes-1", { pipelineMode: "fast" });
		const list = (await (await fetch(`${base}/api/sessions`)).json()) as any;
		expect(list[0].modes).toEqual({
			run: "current-session",
			exec: "kloop",
			merge: "auto",
			writer: "deferred",
			pipeline: "fast",
		});
	});

	it("serves /api/meta with kloop + kteam bases", async () => {
		process.env.KTEAM_URL = "http://127.0.0.1:9999";
		const meta = (await (await fetch(`${base}/api/meta`)).json()) as any;
		expect(meta.kteamBase).toBe("http://127.0.0.1:9999");
		expect(typeof meta.kloopBase).toBe("string");
	});

	it("GET /api/config returns editable config + wrappers", async () => {
		const r = await fetch(`${base}/api/config`);
		expect(r.status).toBe(200);
		const body = (await r.json()) as any;
		expect(body.config.settings.runMode).toBeDefined();
		expect(body.config.writer.pool).toBeDefined();
		expect(Array.isArray(body.config.writerSteps)).toBe(true);
		expect(Array.isArray(body.wrappers)).toBe(true);
	});

	it("PUT /api/config persists a settings + writer patch to config.yaml", async () => {
		// Seed a valid global config first (so the merge base is complete).
		const getRes = (await (await fetch(`${base}/api/config`)).json()) as any;
		// A wrapper the pool can reference: fake ~/.kfleet/bin.
		mkdirSync(join(tempDir, ".kfleet", "bin"), { recursive: true });
		writeFileSync(
			join(tempDir, ".kfleet", "bin", "claude-auto-test"),
			"#!/bin/sh\n",
		);

		const put = await fetch(`${base}/api/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				settings: { ...getRes.config.settings, maxPushCycles: 7 },
				writer: {
					...getRes.config.writer,
					turnTimeoutMins: 45,
					pool: { "claude-auto-test": 3 },
				},
			}),
		});
		const result = (await put.json()) as any;
		expect(put.status).toBe(200);
		expect(result.ok).toBe(true);

		const raw = readFileSync(
			join(tempDir, ".kautopilot", "config.yaml"),
			"utf-8",
		);
		const parsed = YAML.parse(raw);
		expect(parsed.settings.maxPushCycles).toBe(7);
		expect(parsed.writer.turnTimeoutMins).toBe(45);
		expect(parsed.writer.pool["claude-auto-test"]).toBe(3);
	});

	it("PUT /api/config rejects an unknown writer-pool wrapper", async () => {
		const getRes = (await (await fetch(`${base}/api/config`)).json()) as any;
		mkdirSync(join(tempDir, ".kfleet", "bin"), { recursive: true });
		writeFileSync(join(tempDir, ".kfleet", "bin", "claude-auto-real"), "x");

		const put = await fetch(`${base}/api/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				writer: { ...getRes.config.writer, pool: { "claude-auto-ghost": 1 } },
			}),
		});
		expect(put.status).toBe(400);
		const result = (await put.json()) as any;
		expect(result.ok).toBe(false);
		expect(result.errors.join(" ")).toContain("claude-auto-ghost");
	});

	it("lists only claude-*/codex-* wrappers", async () => {
		mkdirSync(join(tempDir, ".kfleet", "bin"), { recursive: true });
		for (const n of ["claude-auto-a", "codex-b", "crc-c", "kfleet"])
			writeFileSync(join(tempDir, ".kfleet", "bin", n), "x");
		const body = (await (await fetch(`${base}/api/config`)).json()) as any;
		expect(body.wrappers).toEqual(["claude-auto-a", "codex-b"]);
	});

	it("refuses a config PUT from a non-loopback client (403)", async () => {
		// Call the handler directly with a server whose requestIP is remote — the
		// loopback gate must refuse the write before it touches disk.
		const { handleRequest } =
			require("../routes") as typeof import("../routes");
		const remote = {
			requestIP: () => ({ address: "203.0.113.7" }),
		} as unknown as Parameters<typeof handleRequest>[1];
		const res = await handleRequest(
			new Request("http://example/api/config", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ settings: { maxPushCycles: 5 } }),
			}),
			remote,
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(false);
		expect(body.errors.join(" ")).toContain("localhost-only");
		// A loopback caller with the same body is allowed through the gate.
		const local = {
			requestIP: () => ({ address: "127.0.0.1" }),
		} as unknown as Parameters<typeof handleRequest>[1];
		const ok = await handleRequest(
			new Request("http://example/api/config", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ settings: { maxPushCycles: 5 } }),
			}),
			local,
		);
		expect(ok.status).toBe(200);
	});

	it("returns 400 (not 500) for a malformed writer.pool", async () => {
		const put = await fetch(`${base}/api/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ writer: { pool: null } }),
		});
		expect(put.status).toBe(400);
		const body = (await put.json()) as any;
		expect(body.ok).toBe(false);
		expect(body.errors.join(" ")).toContain("writer.pool");
	});

	it("rejects a stale PUT with 409 (optimistic concurrency)", async () => {
		mkdirSync(join(tempDir, ".kfleet", "bin"), { recursive: true });
		writeFileSync(join(tempDir, ".kfleet", "bin", "claude-auto-test"), "x");
		const first = (await (await fetch(`${base}/api/config`)).json()) as any;
		// First write creates the file (expectedRevision matches the absent-file
		// null); it succeeds and returns a fresh revision.
		const put1 = await fetch(`${base}/api/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				writer: { ...first.config.writer, pool: { "claude-auto-test": 1 } },
				expectedRevision: first.revision,
			}),
		});
		expect(put1.status).toBe(200);
		// Re-submitting with the now-stale original revision is a conflict.
		const put2 = await fetch(`${base}/api/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				writer: { ...first.config.writer, pool: { "claude-auto-test": 2 } },
				expectedRevision: first.revision,
			}),
		});
		expect(put2.status).toBe(409);
		const body = (await put2.json()) as any;
		expect(body.conflict).toBe(true);
	});
});
