import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
import { runComplete, runNext, runRevise } from "../../core/driver";
import {
	readOrchestration,
	recordPlanProgress,
	recordPrProgress,
} from "../../core/orchestration";
import {
	diffRevisions,
	latestRevisionOnDisk,
	readRevision,
} from "../../core/revisions";
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
		folder: wt,
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

		// write_spec — carries its reviewer fan-out so reviewers run BEFORE the
		// version is presented (no separate spec_review step).
		const s = await runNext(id, config);
		if (s.done) throw new Error("unexpected done");
		expect(s.step).toBe("write_spec");
		expect(s.review?.reviewers.length ?? 0).toBeGreaterThan(0);
		expect(s.review?.gate).toBe("all_approve");
		writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec v1");
		expect(
			(
				await runComplete(id, config, "write_spec", {
					output: join(dir, "epoch", "1", "spec", "v1.md"),
				})
			).ok,
		).toBe(true);

		// write_master_plan — orchestration artifact, approved BEFORE sub-plans.
		const mp = await runNext(id, config);
		if (mp.done) throw new Error("unexpected done");
		expect(mp.step).toBe("write_master_plan");
		writeFile(join(dir, "epoch", "1", "master_plan", "v1.md"), "# Master plan");
		expect(
			(
				await runComplete(id, config, "write_master_plan", {
					output: join(dir, "epoch", "1", "master_plan", "v1.md"),
					metadata: {
						prs: [
							{
								id: "pr-1",
								repo: "default",
								branch: "u/default",
								title: "Default",
								plans: ["plan-1"],
							},
						],
						nodes: [{ plan: "plan-1", repo: "default", pr: "pr-1" }],
						deps: [],
					},
				})
			).ok,
		).toBe(true);

		// write_plans — also carries its reviewer fan-out.
		const p = await runNext(id, config);
		if (p.done) throw new Error("unexpected done");
		expect(p.step).toBe("write_plans");
		expect(p.review?.reviewers.length ?? 0).toBeGreaterThan(0);
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

		// finalize_plans (code) → await_repos gate: bare next stops and tells the
		// controller to drive the DAG with schedule/record.
		const afterPlan = await runNext(id, config);
		expect(afterPlan.done).toBe(true);
		if (!afterPlan.done) return;
		expect(afterPlan.reason).toContain("kautopilot schedule");
		expect(afterPlan.reason).toContain("record");
		const m2 = readSessionMeta(id);
		expect(m2?.repos[0]?.plans).toContain("plan-1");

		// Repo-scoped next is gone; execution/polish is driven by schedule/record.
		await expect(runNext(id, config, "default")).rejects.toThrow("schedule");
	});

	it("first revise presents the working copy (v1); a later revise mints v2", async () => {
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

		// write_spec: the writer edits the CURRENT version (v1).
		const s = await runNext(id, config);
		if (s.done) throw new Error("unexpected done");
		expect(s.step).toBe("write_spec");
		expect(s.contract.outputFile).toContain("v1.md");
		writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec v1\nline");

		// First presentation: `revise` returns the working copy (v1) as-is — it does
		// NOT copy forward (that would make a redundant, empty-diff v2 == v1).
		const r1 = await runRevise(id, config);
		expect(r1.ok).toBe(true);
		expect(r1.version).toBe(1);
		expect(r1.path).toContain("v1.md");
		// `revise` returns FULL viewer URLs: the configured viewerBaseUrl is prefixed
		// here so the harness never has to guess a host or hand-build a version URL.
		expect(r1.url).toBe(
			`${config.settings.viewerBaseUrl}/sessions/${id}/spec/v1`,
		);
		// No v2 was created by the first revise.
		expect(latestRevisionOnDisk(id, "spec", { epoch: 1 })).toBe(1);

		// A user-feedback round: `revise` now copies v1 → v2 (preserving the shown v1)
		// and returns the new file + viewer links.
		const r = await runRevise(id, config);
		expect(r.ok).toBe(true);
		expect(r.version).toBe(2);
		expect(r.path).toContain("v2.md");
		expect(r.url).toBe(
			`${config.settings.viewerBaseUrl}/sessions/${id}/spec/v2`,
		);
		expect(r.diffUrl).toContain(config.settings.viewerBaseUrl);
		expect(r.diffUrl).toContain("from=1&to=2");
		expect(r.visualUrl).toBe(
			`${config.settings.viewerBaseUrl}/sessions/${id}/html/spec/v/2`,
		);
		// v2 is a copy of v1 until edited.
		expect(readRevision(id, "spec", 2, { epoch: 1 })).toBe("# Spec v1\nline");
		writeFile(
			join(dir, "epoch", "1", "spec", "v2.md"),
			"# Spec v2\nline changed",
		);
		const d = diffRevisions(id, "spec", { from: 1, to: 2 });
		expect(d).toContain("v1 → v2");

		// Approve the latest (v2) — completes whatever step is pending.
		expect(
			(
				await runComplete(id, config, undefined, {
					output: join(dir, "epoch", "1", "spec", "v2.md"),
				})
			).ok,
		).toBe(true);
		const next = await runNext(id, config);
		if (next.done) throw new Error("unexpected done");
		// After the spec is approved the next writer step is the master plan
		// (orchestration), which is approved before the per-repo sub-plans.
		expect(next.step).toBe("write_master_plan");
	});
});

/** Drive the shared plan phase to the await_repos handoff, registering `repos`. */
async function drivePlan(
	id: string,
	repos: string[],
	repoPaths?: Record<string, string>,
): Promise<void> {
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
		metadata: {
			complexity: "moderate",
			repos,
			dependsOn: {},
			...(repoPaths ? { repoPaths } : {}),
		},
	});
	// write_spec (reviewers ride on the writer step).
	await runNext(id, config);
	writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec");
	await runComplete(id, config, "write_spec", {
		output: join(dir, "epoch", "1", "spec", "v1.md"),
	});
	// write_master_plan (orchestration artifact, approved before sub-plans).
	await runNext(id, config);
	writeFile(join(dir, "epoch", "1", "master_plan", "v1.md"), "# Master plan");
	await runComplete(id, config, "write_master_plan", {
		output: join(dir, "epoch", "1", "master_plan", "v1.md"),
		metadata: {
			prs: repos.map((repo, i) => ({
				id: `pr-${i + 1}`,
				repo,
				branch: `u/${repo}`,
				title: repo,
				plans: [`plan-${i + 1}`],
			})),
			nodes: repos.map((repo, i) => ({
				plan: `plan-${i + 1}`,
				repo,
				pr: `pr-${i + 1}`,
			})),
			deps: [],
		},
	});
	// write_plans (one plan per repo, tagged) → finalize_plans. The writer authors
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
}

// --- master plan → orchestration.yaml ----------------------------------------

describe("master plan freezes orchestration.yaml + gates a downstream repo", () => {
	it("write_master_plan metadata seeds the DAG, mergeMode, and blocks the gated repo", async () => {
		const id = newSession("PE-4000");
		const dir = sessionDir(id);
		// fetch_ticket
		await runNext(id, config);
		writeFile(join(dir, "ticket.md"), "# t");
		await runComplete(id, config, "fetch_ticket", {
			output: join(dir, "ticket.md"),
		});
		// triage: two repos, web depends on api.
		await runNext(id, config);
		writeFile(join(dir, "epoch", "1", "triage", "v1.md"), "moderate");
		await runComplete(id, config, "triage", {
			output: join(dir, "epoch", "1", "triage", "v1.md"),
			metadata: { repos: ["api", "web"], dependsOn: { web: ["api"] } },
		});
		// write_spec
		await runNext(id, config);
		writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec");
		await runComplete(id, config, "write_spec", {
			output: join(dir, "epoch", "1", "spec", "v1.md"),
		});
		// write_master_plan — structured orchestration metadata with a `merged` gate.
		const mp = await runNext(id, config);
		if (mp.done) throw new Error("unexpected done");
		expect(mp.step).toBe("write_master_plan");
		writeFile(join(dir, "epoch", "1", "master_plan", "v1.md"), "# Master plan");
		const res = await runComplete(id, config, "write_master_plan", {
			output: join(dir, "epoch", "1", "master_plan", "v1.md"),
			metadata: {
				mergeMode: "auto",
				prs: [
					{
						id: "pr-1",
						repo: "api",
						branch: "u/api",
						title: "API",
						plans: ["plan-1"],
					},
					{
						id: "pr-2",
						repo: "web",
						branch: "u/web",
						title: "Web",
						plans: ["plan-1"],
					},
				],
				nodes: [
					{ plan: "plan-1", repo: "api", pr: "pr-1" },
					{ plan: "plan-1", repo: "web", pr: "pr-2" },
				],
				deps: [
					{
						plan: "plan-1",
						repo: "web",
						dependsOn: "plan-1",
						dependsOnRepo: "api",
						gate: "merged",
					},
				],
			},
		});
		expect(res.ok).toBe(true);

		// The master plan is frozen into orchestration.yaml with the gate + progress.
		const orch = readOrchestration(id);
		expect(orch?.mergeMode).toBe("auto");
		expect(orch?.master.deps[0]?.gate).toBe("merged");
		expect(orch?.progress).toHaveLength(2);
		expect(orch?.progress.every((p) => p.status === "pending")).toBe(true);
		// The session's mergeMode was updated from the confirmed master plan.
		expect(readSessionMeta(id)?.mergeMode).toBe("auto");
	});

	it("after plan approval, execution is delegated to schedule/record", async () => {
		const id = newSession("PE-4100");
		await drivePlan(id, ["api", "web"]);
		const gate = await runNext(id, config);
		expect(gate.done).toBe(true);
		if (!gate.done) return;
		expect(gate.reason).toContain("kautopilot schedule");
		await expect(runNext(id, config, "web")).rejects.toThrow("removed");
		const res = await runComplete(id, config, "running", { repo: "web" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("removed");
	});

	it("enters feedback only after the schedule/record DAG is clear", async () => {
		const id = newSession("PE-4101");
		await drivePlan(id, ["api", "web"]);
		recordPlanProgress(id, "api", "plan-1", { status: "merged" });
		recordPrProgress(id, "pr-1", { status: "merged" });
		recordPlanProgress(id, "web", "plan-2", { status: "merged" });
		recordPrProgress(id, "pr-2", { status: "merged" });

		const feedback = await runNext(id, config);
		expect(feedback.done).toBe(false);
		if (feedback.done) return;
		expect(feedback.step).toBe("feedback_check");
		expect(feedback.phase).toBe("feedback");

		const completed = await runComplete(id, config, "feedback_check", {
			metadata: { choice: "done" },
		});
		expect(completed.ok).toBe(true);
		const done = await runNext(id, config);
		expect(done.done).toBe(true);
		if (!done.done) return;
		expect(done.phase).toBe("done");
	});
});

// --- feedback_check choice gate + feedback rules persistence -------------------

/** Drive plan + record the single pr-1/plan-1 as merged so next → feedback_check. */
async function driveToFeedbackCheck(
	id: string,
	repoPaths?: Record<string, string>,
): Promise<void> {
	await drivePlan(id, ["api"], repoPaths);
	recordPlanProgress(id, "api", "plan-1", { status: "merged" });
	recordPrProgress(id, "pr-1", { status: "merged" });
	const fc = await runNext(id, config);
	expect(fc.done).toBe(false);
	if (!fc.done) expect(fc.step).toBe("feedback_check");
}

describe("feedback_check requires an explicit choice", () => {
	it("rejects complete without metadata (never silently ends the session)", async () => {
		const id = newSession("PE-4200");
		await driveToFeedbackCheck(id);
		const res = await runComplete(id, config, undefined, {});
		expect(res.ok).toBe(false);
		expect(res.error).toContain('"choice"');
		// The step is still pending — nothing was recorded.
		const again = await runNext(id, config);
		expect(again.done).toBe(false);
		if (!again.done) expect(again.step).toBe("feedback_check");
	});

	it("rejects an invalid choice value", async () => {
		const id = newSession("PE-4201");
		await driveToFeedbackCheck(id);
		const res = await runComplete(id, config, undefined, {
			metadata: { choice: "maybe" },
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("invalid metadata");
		const again = await runNext(id, config);
		expect(again.done).toBe(false);
		if (!again.done) expect(again.step).toBe("feedback_check");
	});

	it("choice=feedback advances to the feedback step", async () => {
		const id = newSession("PE-4202");
		await driveToFeedbackCheck(id);
		const res = await runComplete(id, config, undefined, {
			metadata: { choice: "feedback" },
		});
		expect(res.ok).toBe(true);
		const fb = await runNext(id, config);
		expect(fb.done).toBe(false);
		if (!fb.done) expect(fb.step).toBe("feedback");
	});
});

describe("feedback rules persistence", () => {
	it("appends confirmed rules to rules.md in each repo's repoPath (worktree null)", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "kautopilot-rules-"));
		try {
			const id = newSession("PE-4210");
			await driveToFeedbackCheck(id, { api: repoDir });
			await runComplete(id, config, undefined, {
				metadata: { choice: "feedback" },
			});
			const fb = await runNext(id, config);
			if (fb.done) throw new Error("unexpected done");
			expect(fb.step).toBe("feedback");
			const out = fb.contract.outputFile as string;
			writeFile(out, "# Feedback\nchange X");
			const res = await runComplete(id, config, "feedback", {
				output: out,
				metadata: { rules: ["Always use bun, never python"] },
			});
			expect(res.ok).toBe(true);
			const rules = readFileSync(join(repoDir, "rules.md"), "utf-8");
			expect(rules).toContain("- Always use bun, never python");
		} finally {
			rmSync(repoDir, { recursive: true, force: true });
		}
	});

	it("fails loudly (step stays pending) when no repo path is writable", async () => {
		const id = newSession("PE-4211");
		await driveToFeedbackCheck(id, {
			api: join(tempHome, "nope", "missing-repo"),
		});
		await runComplete(id, config, undefined, {
			metadata: { choice: "feedback" },
		});
		const fb = await runNext(id, config);
		if (fb.done) throw new Error("unexpected done");
		const out = fb.contract.outputFile as string;
		writeFile(out, "# Feedback");
		await expect(
			runComplete(id, config, "feedback", {
				output: out,
				metadata: { rules: ["some rule"] },
			}),
		).rejects.toThrow("rules.md");
		// No completion event was appended — feedback is still the pending step.
		const again = await runNext(id, config);
		expect(again.done).toBe(false);
		if (!again.done) expect(again.step).toBe("feedback");
	});
});
