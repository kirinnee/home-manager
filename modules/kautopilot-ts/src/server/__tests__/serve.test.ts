import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origHome = process.env.HOME;

describe("serve", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kautopilot-serve-test-"));
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		process.env.HOME = origHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(id: string): void {
		const dir = join(tempDir, ".kautopilot", id);
		// epoch/<E>/spec is per-epoch (numbering resets each epoch); brainstorm is global.
		mkdirSync(join(dir, "epoch", "2", "spec"), { recursive: true });
		mkdirSync(join(dir, "brainstorm"), { recursive: true });
		const meta = {
			sessionId: id,
			folder: "/tmp/hub",
			ticketId: "PE-9999",
			org: "liftoff",
			ticketSystem: "jira",
			commitSpec: false,
			baseBranch: "master",
			epoch: 2,
			runMode: "current-session",
			execMode: "kloop",
			maxParallelRepos: 2,
			repos: [
				{
					repo: "api",
					repoPath: "/tmp/repo",
					worktree: "/tmp/wt",
					branch: "feat/x",
					plans: [],
					dependsOn: [],
					prNumber: 42,
					prUrl: "https://example.com/pr/42",
					status: "running",
				},
			],
		};
		writeFileSync(join(dir, "session.json"), `${JSON.stringify(meta)}\n`);
		writeFileSync(join(dir, "ticket.md"), "# PE-9999\nDo the thing.");
		// Current epoch is 2; the UI surfaces this epoch's spec (per-epoch numbering
		// resets, so the latest epoch's first+second revisions are v1/v2 of epoch 2).
		writeFileSync(
			join(dir, "epoch", "2", "spec", "v1.md"),
			"# Spec\n\nFirst version.\n",
		);
		writeFileSync(
			join(dir, "epoch", "2", "spec", "v2.md"),
			"# Spec\n\nSecond version.\n",
		);
		// Brainstorm precedes any epoch: two versions, no brainstorm:approved
		// events, so they must surface with epoch: null.
		writeFileSync(
			join(dir, "brainstorm", "v1.md"),
			"# Brainstorm\n\nFirst idea.\n",
		);
		writeFileSync(
			join(dir, "brainstorm", "v2.md"),
			"# Brainstorm\n\nSecond idea.\n",
		);
		// Two spec approvals in epoch 2: v1 and v2 both tagged epoch 2.
		const log = [
			{ ts: "2026-01-01T00:00:00Z", event: "spec:approved", version: 2 },
			{ ts: "2026-01-02T00:00:00Z", event: "spec:approved", version: 2 },
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		writeFileSync(join(dir, "log.jsonl"), `${log}\n`);
	}

	it("serves the API and the SPA shell against a temp HOME", async () => {
		const id = "test-serve-1";
		writeSession(id);

		const { handleRequest } =
			require("../routes") as typeof import("../routes");
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: handleRequest,
		});
		const base = `http://127.0.0.1:${server.port}`;

		try {
			// /api/sessions
			const list = (await (await fetch(`${base}/api/sessions`)).json()) as any;
			expect(Array.isArray(list)).toBe(true);
			expect(list).toHaveLength(1);
			expect(list[0].id).toBe(id);
			expect(list[0].ticketId).toBe("PE-9999");
			expect(list[0].org).toBe("liftoff");
			expect(list[0].ticketSystem).toBe("jira");
			// Modes surfaced as opaque strings (mode-as-data; pipeline null today).
			expect(list[0].modes).toEqual({
				run: "current-session",
				exec: "kloop",
				merge: null,
				writer: null,
				pipeline: null,
			});
			// Index repos carry the PR number + url for the clickable PR link.
			expect(list[0].repos[0]).toEqual({
				repo: "api",
				status: "running",
				prNumber: 42,
				prUrl: "https://example.com/pr/42",
			});

			// /api/sessions/:id
			const detail = (await (
				await fetch(`${base}/api/sessions/${id}`)
			).json()) as any;
			expect(detail.meta.sessionId).toBe(id);
			expect(detail.meta.epoch).toBe(2);
			expect(detail.artifacts.ticket).toBe(true);
			// spec versions surface the CURRENT epoch (2), per-epoch numbered v1/v2.
			expect(detail.artifacts.spec).toEqual([
				{ version: 1, epoch: 2 },
				{ version: 2, epoch: 2 },
			]);
			// brainstorm is epoch-agnostic (it precedes any epoch): epoch null.
			expect(detail.artifacts.brainstorm).toEqual([
				{ version: 1, epoch: null },
				{ version: 2, epoch: null },
			]);

			// /api/sessions/:id/doc/brainstorm — versions carry null epochs.
			const bsRes = await fetch(`${base}/api/sessions/${id}/doc/brainstorm`);
			expect(bsRes.status).toBe(200);
			const bs = (await bsRes.json()) as any;
			expect(bs.version).toBe(2);
			expect(bs.versions).toEqual([
				{ version: 1, epoch: null },
				{ version: 2, epoch: null },
			]);
			expect(bs.markdown).toContain("Second idea.");

			// /api/sessions/:id/doc/spec — latest is v2, versions carry epochs.
			const docRes = await fetch(`${base}/api/sessions/${id}/doc/spec`);
			expect(docRes.status).toBe(200);
			const doc = (await docRes.json()) as any;
			expect(doc.version).toBe(2);
			expect(doc.versions).toEqual([
				{ version: 1, epoch: 2 },
				{ version: 2, epoch: 2 },
			]);
			expect(doc.markdown).toContain("Second version.");

			// page route returns the SPA shell (built React app, or legacy fallback);
			// either way it's a full HTML document titled kautopilot for the client
			// to boot from — the same shell for every deep link (reload-safe URLs).
			const pageRes = await fetch(`${base}/sessions/${id}`);
			expect(pageRes.status).toBe(200);
			expect(pageRes.headers.get("content-type")).toContain("text/html");
			const pageHtml = await pageRes.text();
			expect(pageHtml.toLowerCase()).toContain("<!doctype html>");
			expect(pageHtml).toContain("kautopilot");

			// unknown session → API 404
			const missing = await fetch(`${base}/api/sessions/test-nope`);
			expect(missing.status).toBe(404);

			// /api/events — SSE live-reload stream.
			const events = await fetch(`${base}/api/events`);
			expect(events.status).toBe(200);
			expect(events.headers.get("content-type")).toBe("text/event-stream");
			// Don't drain the (infinite) stream; just cancel it.
			await events.body?.cancel();
		} finally {
			server.stop(true);
		}
	});

	it("renders an empty session list for an empty HOME without crashing", async () => {
		const { handleRequest } =
			require("../routes") as typeof import("../routes");
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: handleRequest,
		});
		try {
			const list = await (
				await fetch(`http://127.0.0.1:${server.port}/api/sessions`)
			).json();
			expect(list).toEqual([]);
		} finally {
			server.stop(true);
		}
	});
});
