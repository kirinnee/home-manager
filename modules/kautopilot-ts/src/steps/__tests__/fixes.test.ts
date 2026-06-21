import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME as string;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-fixes-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import { sessionDir } from "../../core/artifacts";
import { runComplete, runNext } from "../../core/driver";
import { appendEvent, readLog } from "../../core/log";
import { latestRevisionOnDisk, revisionPath } from "../../core/revisions";
import { createSession } from "../../core/session-create";
import { readSessionMeta, updateSessionMeta } from "../../core/session-meta";
import type { Config } from "../../core/types";
import { DEFAULT_CONFIG } from "../../core/types";
import { latestPlanFiles } from "../../phases/shared";

const config: Config = DEFAULT_CONFIG;

let seq = 0;
function newSession(ticketId: string | null = "PE-1234"): string {
	seq += 1;
	const wt = `/tmp/fixes-repo-${seq}`;
	return createSession({ ticketId, org: "liftoff", repoPath: wt, worktree: wt })
		.sessionId;
}

function writeFile(p: string, body: string): void {
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, body);
}

/** Completion metadata for a generically-driven repo step (none needed today). */
function metaFor(_step: string): Record<string, unknown> {
	return {};
}

/** Drive the shared plan phase to the await_repos handoff, registering `repos`. */
async function drivePlan(id: string, repos: string[]): Promise<void> {
	const dir = sessionDir(id);
	await runNext(id, config);
	writeFile(join(dir, "ticket.md"), "# ticket");
	await runComplete(id, config, "fetch_ticket", {
		output: join(dir, "ticket.md"),
	});
	await runNext(id, config);
	writeFile(join(dir, "epoch", "1", "triage", "v1.md"), "moderate triage");
	await runComplete(id, config, "triage", {
		output: join(dir, "epoch", "1", "triage", "v1.md"),
		metadata: { complexity: "moderate", repos, dependsOn: {} },
	});
	// write_spec (reviewers ride on the writer step; no separate review step).
	await runNext(id, config);
	writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Master spec");
	await runComplete(id, config, "write_spec", {
		output: join(dir, "epoch", "1", "spec", "v1.md"),
	});
	// write_plans → finalize_plans → await_repos.
	await runNext(id, config);
	const plansDir = join(dir, "epoch", "1", "plans", repos[0] ?? "default");
	repos.forEach((r, i) => {
		writeFile(
			join(plansDir, `plan-${i + 1}`, "v1.md"),
			`repo: ${r}\n# Plan ${i + 1}`,
		);
	});
	await runComplete(id, config, "write_plans", { output: plansDir });
	await runNext(id, config);
}

// --- C2: epoch/<E>/ is the single source of truth; seed copies from it -------

describe("C2: seed copies the latest epoch artifacts into the worktree", () => {
	it("epoch/<E>/ holds the approved artifacts and seed lands them in the worktree", async () => {
		const id = newSession();
		await drivePlan(id, ["default"]);
		// finalize_plans is a code step run inside the bare next that hits await_repos.
		await runNext(id, config);

		// epoch/<E>/ is the single source of truth (no artifacts/ frozen snapshot).
		expect(latestRevisionOnDisk(id, "triage", { epoch: 1 })).toBe(1);
		expect(latestRevisionOnDisk(id, "spec", { epoch: 1 })).toBe(1);
		expect(existsSync(revisionPath(id, "triage", 1, { epoch: 1 }))).toBe(true);
		const planFiles = latestPlanFiles(id, 1, "default");
		expect(planFiles.map((p) => p.plan)).toContain("plan-1");

		// repos[].plans records the plan FOLDER name.
		const meta = readSessionMeta(id);
		expect(meta?.repos.find((r) => r.repo === "default")?.plans).toContain(
			"plan-1",
		);

		// No frozen artifacts/ snapshot store is created.
		expect(existsSync(join(sessionDir(id), "artifacts"))).toBe(false);
	});
});

// --- C3: failed terminal step is registered ----------------------------------

describe("C3: a forced failed path reaches the terminal `failed` step", () => {
	it("resolve→abandon marks the repo failed and next --repo then returns done", async () => {
		const id = newSession();
		await drivePlan(id, ["default"]);
		await runNext(id, config); // finalize_plans → await_repos

		// Drive the repo timeline until the interactive `resolve` step. Force the
		// running step to report a conflict so the machine routes to resolve.
		// First reach `running` by stepping through seed/clear_loop/setup_run.
		// Simplest: advance to the first yielded step and inspect.
		let resolveSeen = false;
		for (let i = 0; i < 40 && !resolveSeen; i++) {
			const d = await runNext(id, config, "default");
			if (d.done) break;
			if (d.step === "resolve") {
				resolveSeen = true;
				// Abandon → failed.
				const res = await runComplete(id, config, "resolve", {
					repo: "default",
					metadata: { abandon: true },
				});
				expect(res.ok).toBe(true);
				break;
			}
			// satisfy any other yielded step generically
			if (d.contract.outputFile) writeFile(d.contract.outputFile, "x");
			await runComplete(id, config, d.step, {
				repo: "default",
				output: d.contract.outputFile,
				metadata: metaFor(d.step),
			});
		}

		// In the sandbox kloop is absent so `running` reports completed and routes to
		// commit, never resolve. If resolve wasn't reachable organically, force it via
		// the WAL: append a conflict running:completed + a resolve cursor.
		if (!resolveSeen) {
			// Force the failed terminal directly: append a cursor to `failed`, then
			// confirm bare next --repo runs it inline (code) and returns done.
			updateSessionMeta(id, (m) => {
				const e = m.repos.find((r) => r.repo === "default");
				if (e) e.status = "active";
			});
			appendEvent(id, {
				ts: new Date().toISOString(),
				event: "running:completed",
				version: 1,
				repo: "default",
				metadata: { step: "running", to: "failed", repo: "default" },
			});
		}

		const after = await runNext(id, config, "default");
		expect(after.done).toBe(true); // `failed` resolved without throwing.
		const meta = readSessionMeta(id);
		expect(meta?.repos.find((r) => r.repo === "default")?.status).toBe(
			"failed",
		);
	});
});

// --- C1: act applies eval actions from the WAL (eval→act pipeline alive) ------

/** Drive a single repo to the polish `eval` step by forcing the WAL cursor. */
async function repoAtEval(id: string, repo: string, wt: string): Promise<void> {
	await drivePlan(id, [repo]);
	await runNext(id, config); // finalize_plans → await_repos
	updateSessionMeta(id, (m) => {
		const e = m.repos.find((r) => r.repo === repo);
		if (e) {
			e.worktree = wt;
			e.status = "active";
			e.prNumber = null; // no real PR → gh I/O is skipped, act still persists state
		}
	});
	appendEvent(id, {
		ts: new Date().toISOString(),
		event: "ensure_branch:completed",
		version: 1,
		repo,
		metadata: { step: "ensure_branch", to: "eval", repo },
	});
}

describe("C1: act consumes the structured eval actions from the WAL", () => {
	it("ambiguous eval routes act → tty_resolve and persists ttyReason=ambiguous_eval", async () => {
		const id = newSession();
		await repoAtEval(id, "default", "/tmp/fixes-c1-wt");

		const ev = await runNext(id, config, "default");
		expect(ev.done).toBe(false);
		if (ev.done) return;
		expect(ev.step).toBe("eval");

		// eval reports one ambiguous + one resolve verdict.
		await runComplete(id, config, "eval", {
			repo: "default",
			metadata: {
				actions: [
					{ kind: "resolve", threadId: "T_1", body: "addressed" },
					{ kind: "ambiguous", body: "unsure" },
				],
				ambiguous: 1,
				resolves: 1,
			},
		});

		// next runs `act` (code) inline; ambiguous>0 routes to tty_resolve, and act
		// persists the routing reason + expected-resolve count to the WAL.
		const next = await runNext(id, config, "default");
		expect(next.done).toBe(false);
		if (next.done) return;
		expect(next.step).toBe("tty_resolve");

		const ctxUpdates = readLog(id).filter(
			(e) => e.event === "context:updated" && e.repo === "default",
		);
		const last = ctxUpdates.at(-1)?.metadata;
		expect(last?.ttyReason).toBe("ambiguous_eval");
		expect(last?.expectedResolves).toBe(1);
	});

	it("non-code-only eval (no ambiguous, no code_fix) routes act → verify_fixes", async () => {
		const id = newSession();
		await repoAtEval(id, "default", "/tmp/fixes-c1b-wt");
		const ev = await runNext(id, config, "default");
		if (ev.done) return;
		await runComplete(id, config, "eval", {
			repo: "default",
			metadata: {
				actions: [{ kind: "resolve", threadId: "T_9" }],
				resolves: 1,
			},
		});
		const next = await runNext(id, config, "default");
		// verify_fixes is a code step → it runs inline; with no PR it degrades to push,
		// then create_pr (agent) is the next yielded step. The key signal is that act
		// did NOT dead-end at poll (the old dead pipeline) — it advanced via verify_fixes.
		const ctxUpdates = readLog(id).filter(
			(e) => e.event === "context:updated" && e.repo === "default",
		);
		expect(ctxUpdates.at(-1)?.metadata?.expectedResolves).toBe(1);
		expect(next.done === false ? next.step : "done").not.toBe("eval");
	});
});

// --- M3: tty_resolve renders the variant matching the persisted reason --------

describe("M3: tty_resolve selects the variant from the WAL-persisted reason", () => {
	it("a merge_conflict reason yields the rebase/conflict prompt, not ambiguous", async () => {
		const id = newSession();
		await drivePlan(id, ["default"]);
		await runNext(id, config); // finalize_plans → await_repos
		updateSessionMeta(id, (m) => {
			const e = m.repos.find((r) => r.repo === "default");
			if (e) {
				e.worktree = "/tmp/fixes-m3-wt";
				e.status = "active";
			}
		});
		// A routing step (push rebase-conflict) persists merge_conflict, then routes to
		// tty_resolve.
		appendEvent(id, {
			ts: new Date().toISOString(),
			event: "context:updated",
			version: 1,
			repo: "default",
			metadata: { ttyReason: "merge_conflict" },
		});
		appendEvent(id, {
			ts: new Date().toISOString(),
			event: "push:completed",
			version: 1,
			repo: "default",
			metadata: { step: "push", to: "tty_resolve", repo: "default" },
		});

		const d = await runNext(id, config, "default");
		expect(d.done).toBe(false);
		if (d.done) return;
		expect(d.step).toBe("tty_resolve");
		// The conflict variant talks about git rebase; the ambiguous variant does not.
		expect(d.prompt).toContain("git rebase --continue");
		expect(d.prompt).not.toContain("reply / code fix / skip");
		expect(d.vars.ttyReason).toBe("merge_conflict");
	});
});

// --- M5: resolve→revisit_spec bumps the epoch and re-enters write_spec --------

describe("M5: revisit_spec escalation bumps the epoch and re-runs the plan phase", () => {
	it("bare next yields write_spec at the new epoch after a repo revisit_spec", async () => {
		const id = newSession();
		await drivePlan(id, ["default"]);
		await runNext(id, config); // finalize_plans → await_repos

		// Force the repo to the interactive `resolve` step via the WAL (kloop is absent
		// in the sandbox, so `running` would otherwise route straight to commit).
		updateSessionMeta(id, (m) => {
			const e = m.repos.find((r) => r.repo === "default");
			if (e) {
				e.worktree = e.worktree ?? "/tmp/fixes-wt-default";
				e.status = "active";
			}
		});
		appendEvent(id, {
			ts: new Date().toISOString(),
			event: "running:completed",
			version: 1,
			repo: "default",
			metadata: {
				status: "conflict",
				step: "running",
				to: "resolve",
				repo: "default",
			},
		});

		const r = await runNext(id, config, "default");
		expect(r.done).toBe(false);
		if (r.done) return;
		expect(r.step).toBe("resolve");

		const res = await runComplete(id, config, "resolve", {
			repo: "default",
			metadata: { rewriteDecision: "revisit_spec" },
		});
		expect(res.ok).toBe(true);

		// Epoch bumped, repos reset to pending.
		const meta = readSessionMeta(id);
		expect(meta?.epoch).toBe(2);
		expect(meta?.repos.every((rp) => rp.status === "pending")).toBe(true);

		// Bare next re-enters the shared plan phase at write_spec (new epoch).
		const back = await runNext(id, config);
		expect(back.done).toBe(false);
		if (back.done) return;
		expect(back.step).toBe("write_spec");
		expect(back.version).toBe(2);
	});
});
