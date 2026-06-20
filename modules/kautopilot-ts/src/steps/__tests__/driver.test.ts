import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME as string;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-driver-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import { sessionDir } from "../../core/artifacts";
import { runComplete, runNext } from "../../core/driver";
import { diffRevisions } from "../../core/revisions";
import { createSession } from "../../core/session-create";
import { readSessionMeta } from "../../core/session-meta";
import type { Config } from "../../core/types";
import { DEFAULT_CONFIG } from "../../core/types";

const config: Config = DEFAULT_CONFIG;

let seq = 0;
function newSession(ticketId: string | null = "PE-1234"): string {
	seq += 1;
	const wt = `/tmp/repo-${seq}`;
	const meta = createSession({
		ticketId,
		org: "liftoff",
		repoPath: wt,
		worktree: wt,
	});
	return meta.sessionId;
}

function writeFile(p: string, body: string): void {
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, body);
}

describe("host-driven driver: next/complete", () => {
	beforeEach(() => {
		// each test makes its own session id, so no cross-talk
	});

	it("runs resolve_org (code) inline and yields fetch_ticket (agent)", async () => {
		const id = newSession();
		const d = await runNext(id, config);
		expect(d.done).toBe(false);
		if (d.done) return;
		expect(d.step).toBe("fetch_ticket");
		expect(d.kind).toBe("agent");
		expect(d.phase).toBe("plan");
		expect(d.contract.completionEvent).toBe("fetch_ticket:done");
	});

	it("is idempotent — re-calling next yields the same step until complete", async () => {
		const id = newSession();
		const a = await runNext(id, config);
		const b = await runNext(id, config);
		expect(a.done).toBe(false);
		expect(b.done).toBe(false);
		if (a.done || b.done) return;
		expect(a.step).toBe(b.step);
		expect(a.step).toBe("fetch_ticket");
	});

	it("rejects a stale complete (step != pending)", async () => {
		const id = newSession();
		await runNext(id, config);
		const res = await runComplete(id, config, "write_spec", {});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("stale");
	});

	it("completes the pending step when no step name is passed", async () => {
		const id = newSession();
		const dir = sessionDir(id);
		await runNext(id, config); // pending = fetch_ticket
		writeFile(join(dir, "ticket.md"), "# PE-1234\nDo the thing.");
		const res = await runComplete(id, config, undefined, {
			output: join(dir, "ticket.md"),
		});
		expect(res.ok).toBe(true);
		expect(res.recorded).toBe("fetch_ticket:done");
	});

	it("walks the plan phase to execution, seeding repos from triage metadata", async () => {
		const id = newSession();
		const dir = sessionDir(id);

		// fetch_ticket
		await runNext(id, config);
		writeFile(join(dir, "ticket.md"), "# PE-1234\nDo the thing.");
		expect(
			(
				await runComplete(id, config, "fetch_ticket", {
					output: join(dir, "ticket.md"),
				})
			).ok,
		).toBe(true);

		// triage
		const t = await runNext(id, config);
		expect(t.done).toBe(false);
		if (t.done) return;
		expect(t.step).toBe("triage");
		writeFile(
			join(dir, "epoch", "1", "triage", "v1.md"),
			"## Complexity\nmoderate",
		);
		expect(
			(
				await runComplete(id, config, "triage", {
					output: join(dir, "epoch", "1", "triage", "v1.md"),
					metadata: {
						complexity: "moderate",
						repos: ["default"],
						dependsOn: {},
					},
				})
			).ok,
		).toBe(true);
		const meta = readSessionMeta(id);
		expect(meta?.repos.map((r) => r.repo)).toContain("default");

		// write_spec
		const s = await runNext(id, config);
		if (s.done) throw new Error("unexpected done");
		expect(s.step).toBe("write_spec");
		writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec v1");
		expect(
			(
				await runComplete(id, config, "write_spec", {
					output: join(dir, "epoch", "1", "spec", "v1.md"),
				})
			).ok,
		).toBe(true);

		// spec_review (agent fan-out, carries review payload)
		const sr = await runNext(id, config);
		if (sr.done) throw new Error("unexpected done");
		expect(sr.step).toBe("spec_review");
		expect(sr.review?.reviewers.length).toBeGreaterThan(0);
		expect(sr.review?.gate).toBe("all_approve");
		expect(
			(
				await runComplete(id, config, "spec_review", {
					metadata: { approved: true },
				})
			).ok,
		).toBe(true);

		// write_plans
		const p = await runNext(id, config);
		if (p.done) throw new Error("unexpected done");
		expect(p.step).toBe("write_plans");
		writeFile(
			join(dir, "epoch", "1", "plans", "default", "plan-1", "v1.md"),
			"repo: default\n# Plan 1",
		);
		expect(
			(
				await runComplete(id, config, "write_plans", {
					output: join(dir, "epoch", "1", "plans", "default"),
				})
			).ok,
		).toBe(true);

		// plan_review
		const pr = await runNext(id, config);
		if (pr.done) throw new Error("unexpected done");
		expect(pr.step).toBe("plan_review");
		expect(
			(
				await runComplete(id, config, "plan_review", {
					metadata: { approved: true },
				})
			).ok,
		).toBe(true);

		// finalize_plans (code) → await_repos gate: bare next stops and tells the
		// controller to drive each repo via `next --repo`.
		const afterPlan = await runNext(id, config);
		expect(afterPlan.done).toBe(true);
		if (!afterPlan.done) return;
		expect(afterPlan.reason).toContain("next --repo default");
		const m2 = readSessionMeta(id);
		expect(m2?.repos[0]?.plans).toContain("plan-1");

		// `next --repo default` drives that repo's execution/polish timeline.
		const repoStep = await runNext(id, config, "default");
		if (repoStep.done) throw new Error("repo timeline should not be done yet");
		expect(repoStep.repo).toBe("default");
		expect(repoStep.phase === "execution" || repoStep.phase === "polish").toBe(
			true,
		);
	});

	it("spec_review not approved loops back to write_spec and bumps the revision", async () => {
		const id = newSession();
		const dir = sessionDir(id);
		await runNext(id, config);
		writeFile(join(dir, "ticket.md"), "# t");
		await runComplete(id, config, "fetch_ticket", {
			output: join(dir, "ticket.md"),
		});
		await runNext(id, config);
		writeFile(join(dir, "epoch", "1", "triage", "v1.md"), "moderate");
		await runComplete(id, config, "triage", {
			output: join(dir, "epoch", "1", "triage", "v1.md"),
			metadata: { repos: ["default"] },
		});
		await runNext(id, config);
		writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec v1\nline");
		await runComplete(id, config, "write_spec", {
			output: join(dir, "epoch", "1", "spec", "v1.md"),
		});
		await runNext(id, config); // spec_review
		await runComplete(id, config, "spec_review", {
			metadata: { approved: false },
		});
		const back = await runNext(id, config);
		if (back.done) throw new Error("unexpected done");
		expect(back.step).toBe("write_spec");
		// second revision path
		expect(back.contract.outputFile).toContain("v2.md");
		writeFile(
			join(dir, "epoch", "1", "spec", "v2.md"),
			"# Spec v2\nline changed",
		);
		await runComplete(id, config, "write_spec", {
			output: join(dir, "epoch", "1", "spec", "v2.md"),
		});
		const d = diffRevisions(id, "spec", { from: 1, to: 2 });
		expect(d).toContain("v1 → v2");
	});
});

// --- multi-repo (Phase 4) ----------------------------------------------------

function metaFor(step: string): Record<string, unknown> {
	switch (step) {
		case "spec_review":
		case "plan_review":
			return { approved: true };
		case "feedback_check":
			return { choice: "done", fullyMerged: false };
		default:
			return {};
	}
}

/** Drive the shared plan phase to the await_repos handoff, registering `repos`. */
async function drivePlan(id: string, repos: string[]): Promise<void> {
	const dir = sessionDir(id);
	// fetch_ticket
	await runNext(id, config);
	writeFile(join(dir, "ticket.md"), "# ticket");
	await runComplete(id, config, "fetch_ticket", {
		output: join(dir, "ticket.md"),
	});
	// triage → repo set
	await runNext(id, config);
	writeFile(join(dir, "epoch", "1", "triage", "v1.md"), "moderate");
	await runComplete(id, config, "triage", {
		output: join(dir, "epoch", "1", "triage", "v1.md"),
		metadata: { complexity: "moderate", repos, dependsOn: {} },
	});
	// write_spec → spec_review
	await runNext(id, config);
	writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec");
	await runComplete(id, config, "write_spec", {
		output: join(dir, "epoch", "1", "spec", "v1.md"),
	});
	await runNext(id, config);
	await runComplete(id, config, "spec_review", {
		metadata: { approved: true },
	});
	// write_plans (one plan per repo, tagged) → plan_review. The writer authors
	// every plan folder under epoch/<E>/plans/<authoringRepo>/<plan>/v<M>.md.
	await runNext(id, config);
	// Plans are authored under the primary (first-registered) repo's bucket.
	const plansDir = join(dir, "epoch", "1", "plans", repos[0] ?? "default");
	repos.forEach((r, i) => {
		writeFile(
			join(plansDir, `plan-${i + 1}`, "v1.md"),
			`repo: ${r}\n# Plan ${i + 1}`,
		);
	});
	await runComplete(id, config, "write_plans", { output: plansDir });
	await runNext(id, config);
	await runComplete(id, config, "plan_review", {
		metadata: { approved: true },
	});
}

/** Drive one repo's execution/polish timeline to completion (ready-to-merge). */
async function driveRepo(id: string, repo: string): Promise<void> {
	for (let i = 0; i < 80; i++) {
		const d = await runNext(id, config, repo);
		if (d.done) return;
		expect(d.repo).toBe(repo);
		if (d.contract.outputFile) writeFile(d.contract.outputFile, "artifact");
		const res = await runComplete(id, config, d.step, {
			repo,
			output: d.contract.outputFile,
			metadata: metaFor(d.step),
		});
		expect(res.ok).toBe(true);
	}
	throw new Error(`repo ${repo} timeline did not finish`);
}

describe("multi-repo: identical flat flow, serialized interaction", () => {
	it("a two-repo ticket runs two independent repo timelines, then one feedback gate", async () => {
		const id = newSession("PE-2000");
		await drivePlan(id, ["api", "infra"]);

		// Bare next now gates on the repos.
		const gate = await runNext(id, config);
		expect(gate.done).toBe(true);
		if (!gate.done) return;
		expect(gate.reason).toContain("next --repo api");
		expect(gate.reason).toContain("next --repo infra");

		// Each repo is registered with its own plan partition.
		const meta = readSessionMeta(id);
		expect(meta?.repos.map((r) => r.repo).sort()).toEqual(["api", "infra"]);

		// The two repo timelines are independent: drive api fully; infra is untouched.
		await driveRepo(id, "api");
		const mid = readSessionMeta(id);
		expect(mid?.repos.find((r) => r.repo === "api")?.status).toBe("ready");
		expect(mid?.repos.find((r) => r.repo === "infra")?.status).toBe("pending");

		// Bare next still gates (infra not ready) — feedback is not reached yet.
		const stillGated = await runNext(id, config);
		expect(stillGated.done).toBe(true);

		// Drive infra; now both are ready.
		await driveRepo(id, "infra");
		const after = readSessionMeta(id);
		expect(after?.repos.every((r) => r.status === "ready")).toBe(true);

		// Distinct worktrees per repo (the "two worktrees" DoD).
		const wts = after?.repos.map((r) => r.worktree) ?? [];
		expect(new Set(wts).size).toBe(2);

		// With every repo ready, bare next advances the shared timeline to feedback.
		const fb = await runNext(id, config);
		expect(fb.done).toBe(false);
		if (fb.done) return;
		expect(fb.step).toBe("feedback_check");
		expect(fb.phase).toBe("feedback");
	});

	it("bounds concurrency to maxParallelRepos — extra repos are queued", async () => {
		seq += 1;
		const wt = `/tmp/mp-${seq}`;
		const meta = createSession({
			ticketId: "PE-3000",
			org: "liftoff",
			repoPath: wt,
			worktree: wt,
			maxParallelRepos: 1,
		});
		const id = meta.sessionId;
		await drivePlan(id, ["alpha", "beta"]);
		// Bare next runs finalize_plans → await_repos (approving plans for the epoch).
		await runNext(id, config);

		// First repo starts and becomes active (0 < cap of 1).
		const a = await runNext(id, config, "alpha");
		expect(a.done).toBe(false);
		expect(
			readSessionMeta(id)?.repos.find((r) => r.repo === "alpha")?.status,
		).toBe("active");

		// Second repo is queued while the first is in progress (cap = 1).
		const b = await runNext(id, config, "beta");
		expect(b.done).toBe(true);
		if (!b.done) return;
		expect(b.reason).toContain("queued");

		// Once the first reaches ready-to-merge, the queued repo may proceed.
		await driveRepo(id, "alpha");
		const c = await runNext(id, config, "beta");
		expect(c.done).toBe(false);
		if (c.done) return;
		expect(c.repo).toBe("beta");
	});
});
