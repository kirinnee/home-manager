import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME as string;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-sched-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import {
	initOrchestration,
	type Orchestration,
	type PlanExecStatus,
	type PrLifecycleStatus,
	readOrchestration,
	recordPlanProgress,
	recordPrProgress,
} from "../orchestration";
import { computeSchedule, plansInPr } from "../scheduler";

function prStatusFromPlan(status: PlanExecStatus): PrLifecycleStatus {
	if (status === "pr_open") return "open";
	if (status === "pr_ready") return "ready";
	if (status === "merged") return "merged";
	if (status === "released") return "released";
	if (status === "failed") return "failed";
	return "pending";
}

// Two PRs: api/plan-1 (pr-1) → web/plan-2 (pr-2), gate `merged`.
function orch(
	apiStatus: PlanExecStatus,
	webStatus: PlanExecStatus,
	mergeMode: "manual" | "auto" = "manual",
): Orchestration {
	return {
		sessionId: "x",
		epoch: 1,
		mergeMode,
		master: {
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
					plans: ["plan-2"],
				},
			],
			nodes: [
				{ plan: "plan-1", repo: "api", pr: "pr-1" },
				{ plan: "plan-2", repo: "web", pr: "pr-2" },
			],
			deps: [
				{
					plan: "plan-2",
					repo: "web",
					dependsOn: "plan-1",
					dependsOnRepo: "api",
					gate: "merged",
				},
			],
		},
		progress: [
			{
				plan: "plan-1",
				repo: "api",
				status: apiStatus,
				prNumber: 11,
				prUrl: "u11",
			},
			{
				plan: "plan-2",
				repo: "web",
				status: webStatus,
				prNumber: null,
				prUrl: null,
			},
		],
		prProgress: [
			{
				pr: "pr-1",
				status: prStatusFromPlan(apiStatus),
				prNumber: 11,
				prUrl: "u11",
			},
			{
				pr: "pr-2",
				status: prStatusFromPlan(webStatus),
				prNumber: null,
				prUrl: null,
			},
		],
	};
}

describe("scheduler: frontier", () => {
	it("ready = the upstream plan; downstream is blocked until merged", () => {
		const s = computeSchedule(orch("pending", "pending"));
		expect(s.ready.map((r) => `${r.repo}/${r.plan}`)).toEqual(["api/plan-1"]);
		expect(s.blocked).toHaveLength(1);
		expect(s.blocked[0].repo).toBe("web");
		expect(s.blocked[0].waitingOn[0]).toEqual({
			repo: "api",
			plan: "plan-1",
			gate: "merged",
		});
		expect(s.allReady).toBe(false);
		expect(s.done).toBe(false);
	});

	it("running plan is reported in flight, not ready", () => {
		const s = computeSchedule(orch("running", "pending"));
		expect(s.running.map((r) => `${r.repo}/${r.plan}`)).toEqual(["api/plan-1"]);
		expect(s.ready).toHaveLength(0);
	});

	it("implemented plans surface their PR for opening and polish", () => {
		const s = computeSchedule(orch("implemented", "pending"));
		expect(s.toPolish).toHaveLength(1);
		expect(s.toPolish[0]).toMatchObject({
			pr: "pr-1",
			repo: "api",
			branch: "u/api",
			status: "pending",
		});
		expect(s.toMerge).toHaveLength(0);
	});

	it("an open upstream PR does not enter toMerge before PR polish is ready", () => {
		const s = computeSchedule(orch("pr_open", "pending"));
		expect(s.toPolish).toHaveLength(1);
		expect(s.toPolish[0]).toMatchObject({ pr: "pr-1", status: "open" });
		expect(s.toMerge).toHaveLength(0);
		expect(s.allReady).toBe(false);
		// web is still blocked until the merge is recorded.
		expect(s.blocked.map((b) => `${b.repo}/${b.plan}`)).toEqual(["web/plan-2"]);
	});

	it("a ready upstream PR appears in toMerge and lists what it unblocks", () => {
		const s = computeSchedule(orch("pr_ready", "pending"));
		expect(s.toMerge).toHaveLength(1);
		expect(s.toMerge[0].pr).toBe("pr-1");
		expect(s.toMerge[0].gate).toBe("merged");
		expect(s.toMerge[0].prNumber).toBe(11);
		expect(s.toMerge[0].unblocks).toEqual(["web/plan-2"]);
		// web is still blocked until the merge is recorded.
		expect(s.blocked.map((b) => `${b.repo}/${b.plan}`)).toEqual(["web/plan-2"]);
	});

	it("once upstream merged, downstream becomes ready and the merged PR leaves toMerge", () => {
		const s = computeSchedule(orch("merged", "pending"));
		expect(s.ready.map((r) => `${r.repo}/${r.plan}`)).toEqual(["web/plan-2"]);
		expect(s.toMerge).toHaveLength(0); // pr-1 fully merged
		expect(s.blocked).toHaveLength(0);
	});

	it("allReady waits for scheduled ready PRs to be merged", () => {
		expect(computeSchedule(orch("pr_open", "pr_open")).allReady).toBe(false);
		expect(computeSchedule(orch("pr_ready", "pr_ready")).allReady).toBe(false);
		expect(computeSchedule(orch("pr_ready", "pr_ready")).toMerge).toHaveLength(
			2,
		);
		expect(computeSchedule(orch("merged", "merged")).allReady).toBe(true);
		expect(computeSchedule(orch("pr_ready", "pr_ready")).done).toBe(false);
		expect(computeSchedule(orch("merged", "merged")).done).toBe(true);
	});

	it("gate-clearing merges are sorted ahead of terminal ones", () => {
		// api pr-1 unblocks web; web pr-2 is terminal (nothing depends on it).
		const s = computeSchedule(orch("pr_ready", "pr_ready"));
		expect(s.toMerge[0].pr).toBe("pr-1"); // unblocks web → first
		expect(s.toMerge[0].unblocks.length).toBeGreaterThan(0);
	});

	it("plansInPr returns the plans that ship in a PR", () => {
		expect(plansInPr(orch("pending", "pending"), "pr-2")).toEqual([
			{ repo: "web", plan: "plan-2" },
		]);
	});

	it("a `released` upstream satisfies a merged gate and the DAG can be done", () => {
		// released outranks merged, so a merged-gated downstream is unblocked.
		const s = computeSchedule(orch("released", "pending"));
		expect(s.ready.map((r) => `${r.repo}/${r.plan}`)).toEqual(["web/plan-2"]);
		expect(computeSchedule(orch("released", "released")).done).toBe(true);
	});

	it("a merged upstream with a release gate stays scheduled until released", () => {
		const o = orch("merged", "pending");
		if (o.master.deps[0]) o.master.deps[0].gate = "released";
		const s = computeSchedule(o);
		expect(s.toMerge).toHaveLength(1);
		expect(s.toMerge[0]).toMatchObject({
			pr: "pr-1",
			gate: "released",
			unblocks: ["web/plan-2"],
		});
		expect(s.ready).toHaveLength(0);
		expect(s.blocked.map((b) => `${b.repo}/${b.plan}`)).toEqual([
			"web/plan-2",
		]);
	});

	it("keeps the strongest gate when one downstream has merged and released deps from a PR", () => {
		const o = orch("merged", "pending");
		o.master.nodes.unshift({ plan: "plan-0", repo: "api", pr: "pr-1" });
		o.master.prs[0].plans.unshift("plan-0");
		o.progress.unshift({ plan: "plan-0", repo: "api", status: "merged" });
		o.master.deps = [
			{
				plan: "plan-2",
				repo: "web",
				dependsOn: "plan-1",
				dependsOnRepo: "api",
				gate: "released",
			},
			{
				plan: "plan-2",
				repo: "web",
				dependsOn: "plan-0",
				dependsOnRepo: "api",
				gate: "merged",
			},
		];
		const s = computeSchedule(o);
		expect(s.toMerge).toHaveLength(1);
		expect(s.toMerge[0]).toMatchObject({
			pr: "pr-1",
			gate: "released",
			unblocks: ["web/plan-2"],
		});
	});

	it("a `failed` upstream leaves the downstream blocked and the DAG not done", () => {
		const s = computeSchedule(orch("failed", "pending"));
		// failed ranks 0 → the merged gate is unsatisfied → downstream blocked.
		expect(s.blocked.map((b) => `${b.repo}/${b.plan}`)).toEqual(["web/plan-2"]);
		expect(s.ready).toHaveLength(0);
		expect(s.running).toHaveLength(0);
		expect(s.done).toBe(false);
		expect(s.allReady).toBe(false);
	});

	it("multi-plan PRs are not done until every plan in the PR is merged", () => {
		const o = orch("merged", "pending");
		o.master.prs = [
			{
				id: "pr-1",
				repo: "api",
				branch: "u/api",
				title: "API",
				plans: ["plan-1", "plan-2"],
			},
		];
		o.master.nodes = [
			{ plan: "plan-1", repo: "api", pr: "pr-1" },
			{ plan: "plan-2", repo: "api", pr: "pr-1" },
		];
		o.master.deps = [];
		o.progress = [
			{ plan: "plan-1", repo: "api", status: "merged" },
			{ plan: "plan-2", repo: "api", status: "pr_ready" },
		];
		o.prProgress = [{ pr: "pr-1", status: "merged" }];
		expect(computeSchedule(o).done).toBe(false);

		o.progress[1].status = "merged";
		expect(computeSchedule(o).done).toBe(true);
	});

	it("only one pending plan per PR is ready at a time", () => {
		const o = orch("pending", "pending");
		o.master.prs = [
			{
				id: "pr-1",
				repo: "api",
				branch: "u/api",
				title: "API",
				plans: ["plan-1", "plan-2"],
			},
		];
		o.master.nodes = [
			{ plan: "plan-1", repo: "api", pr: "pr-1" },
			{ plan: "plan-2", repo: "api", pr: "pr-1" },
		];
		o.master.deps = [];
		o.progress = [
			{ plan: "plan-1", repo: "api", status: "pending" },
			{ plan: "plan-2", repo: "api", status: "pending" },
		];

		let s = computeSchedule(o);
		expect(s.ready.map((r) => r.plan)).toEqual(["plan-1"]);
		expect(s.blocked.map((b) => b.plan)).toEqual(["plan-2"]);
		expect(s.blocked[0].waitingOn).toEqual([
			{ repo: "api", plan: "plan-1", gate: "completed" },
		]);

		o.progress[0].status = "implemented";
		s = computeSchedule(o);
		expect(s.ready.map((r) => r.plan)).toEqual(["plan-2"]);
	});

	it("stale persisted PR readiness is clamped by current plan progress", () => {
		const o = orch("implemented", "pending");
		o.prProgress = [{ pr: "pr-1", status: "ready", prNumber: 11 }];
		let s = computeSchedule(o);
		expect(s.toPolish.map((p) => p.pr)).toEqual(["pr-1"]);
		expect(s.toMerge).toHaveLength(0);
		expect(s.allReady).toBe(false);

		o.progress[0].status = "pr_open";
		s = computeSchedule(o);
		expect(s.toPolish.map((p) => p.pr)).toEqual(["pr-1"]);
		expect(s.toMerge).toHaveLength(0);

		o.progress[0].status = "pr_ready";
		s = computeSchedule(o);
		expect(s.toPolish).toHaveLength(0);
		expect(s.toMerge.map((m) => m.pr)).toEqual(["pr-1"]);
	});

	it("stale persisted PR readiness is clamped to released when all plans are released", () => {
		const o = orch("released", "released");
		o.prProgress = [
			{ pr: "pr-1", status: "ready", prNumber: 11 },
			{ pr: "pr-2", status: "ready", prNumber: 22 },
		];
		const s = computeSchedule(o);
		expect(s.toMerge).toHaveLength(0);
		expect(s.done).toBe(true);
	});

	it("stale persisted terminal PR state is clamped back to ready until plans are terminal", () => {
		const o = orch("pr_ready", "merged");
		o.prProgress = [
			{ pr: "pr-1", status: "released", prNumber: 11 },
			{ pr: "pr-2", status: "merged", prNumber: 22 },
		];
		const s = computeSchedule(o);
		expect(s.toMerge.map((m) => m.pr)).toEqual(["pr-1"]);
		expect(s.allReady).toBe(false);
		expect(s.done).toBe(false);
	});
});

describe("scheduler: record → schedule round-trip (the ledger drives the frontier)", () => {
	it("recording lifecycle transitions reopens the frontier as the DAG advances", () => {
		const id = "sched-rt-1";
		const master = orch("pending", "pending").master;
		initOrchestration(id, 1, "auto", master);

		// Re-read the on-disk ledger each step (proves the frontier is recomputed
		// purely from what's recorded — i.e. resumable).
		const read = (): Orchestration => {
			const o = readOrchestration(id);
			if (!o) throw new Error("orchestration missing");
			return o;
		};
		// Start: only the upstream is runnable.
		expect(computeSchedule(read()).ready.map((r) => r.plan)).toEqual([
			"plan-1",
		]);

		// Agent records the upstream PR as opened. It is not mergeable yet because
		// PR-level polish/checks have not completed.
		recordPlanProgress(id, "api", "plan-1", {
			status: "running",
			kloopRunId: "r1",
		});
		recordPlanProgress(id, "api", "plan-1", { status: "implemented" });
		let s = computeSchedule(read());
		expect(s.toPolish.map((p) => p.pr)).toEqual(["pr-1"]);
		expect(s.toPolish[0].status).toBe("pending");

		recordPlanProgress(id, "api", "plan-1", { status: "pr_open", prNumber: 9 });
		recordPrProgress(id, "pr-1", { status: "open", prNumber: 9 });
		s = computeSchedule(read());
		expect(s.toPolish.map((p) => p.pr)).toEqual(["pr-1"]);
		expect(s.toPolish[0].status).toBe("open");
		expect(s.toMerge).toHaveLength(0);
		expect(s.ready).toHaveLength(0); // web still gated

		// Once polish marks the PR ready, it becomes the PR to merge.
		recordPlanProgress(id, "api", "plan-1", { status: "pr_ready" });
		recordPrProgress(id, "pr-1", { status: "ready" });
		s = computeSchedule(read());
		expect(s.toPolish).toHaveLength(0);
		expect(s.toMerge.map((m) => m.pr)).toEqual(["pr-1"]);
		expect(s.toMerge[0].unblocks).toEqual(["web/plan-2"]);
		expect(s.ready).toHaveLength(0); // web still gated

		// Record the merge → the downstream becomes runnable.
		recordPlanProgress(id, "api", "plan-1", { status: "merged" });
		recordPrProgress(id, "pr-1", { status: "merged" });
		s = computeSchedule(read());
		expect(s.ready.map((r) => r.plan)).toEqual(["plan-2"]);
		expect(s.toMerge).toHaveLength(0);

		// Finish web → DAG done.
		recordPlanProgress(id, "web", "plan-2", { status: "merged" });
		recordPrProgress(id, "pr-2", { status: "merged" });
		expect(computeSchedule(read()).done).toBe(true);
	});
});
