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
	readOrchestration,
	recordPlanProgress,
} from "../orchestration";
import { computeSchedule, plansInPr } from "../scheduler";

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

	it("an open upstream PR appears in toMerge and lists what it unblocks", () => {
		const s = computeSchedule(orch("pr_open", "pending"));
		expect(s.toMerge).toHaveLength(1);
		expect(s.toMerge[0].pr).toBe("pr-1");
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

	it("allReady when every plan is pr_open; done when every plan merged", () => {
		expect(computeSchedule(orch("pr_open", "pr_open")).allReady).toBe(true);
		expect(computeSchedule(orch("pr_open", "pr_open")).done).toBe(false);
		expect(computeSchedule(orch("merged", "merged")).done).toBe(true);
	});

	it("gate-clearing merges are sorted ahead of terminal ones", () => {
		// api pr-1 unblocks web; web pr-2 is terminal (nothing depends on it).
		const s = computeSchedule(orch("pr_open", "pr_open"));
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

	it("a `failed` upstream leaves the downstream blocked and the DAG not done", () => {
		const s = computeSchedule(orch("failed", "pending"));
		// failed ranks 0 → the merged gate is unsatisfied → downstream blocked.
		expect(s.blocked.map((b) => `${b.repo}/${b.plan}`)).toEqual(["web/plan-2"]);
		expect(s.ready).toHaveLength(0);
		expect(s.running).toHaveLength(0);
		expect(s.done).toBe(false);
		expect(s.allReady).toBe(false);
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

		// Agent records the upstream through to pr_open → it's the PR to merge.
		recordPlanProgress(id, "api", "plan-1", {
			status: "running",
			kloopRunId: "r1",
		});
		recordPlanProgress(id, "api", "plan-1", { status: "implemented" });
		recordPlanProgress(id, "api", "plan-1", { status: "pr_open", prNumber: 9 });
		let s = computeSchedule(read());
		expect(s.toMerge.map((m) => m.pr)).toEqual(["pr-1"]);
		expect(s.toMerge[0].unblocks).toEqual(["web/plan-2"]);
		expect(s.ready).toHaveLength(0); // web still gated

		// Record the merge → the downstream becomes runnable.
		recordPlanProgress(id, "api", "plan-1", { status: "merged" });
		s = computeSchedule(read());
		expect(s.ready.map((r) => r.plan)).toEqual(["plan-2"]);
		expect(s.toMerge).toHaveLength(0);

		// Finish web → DAG done.
		recordPlanProgress(id, "web", "plan-2", { status: "merged" });
		expect(computeSchedule(read()).done).toBe(true);
	});
});
