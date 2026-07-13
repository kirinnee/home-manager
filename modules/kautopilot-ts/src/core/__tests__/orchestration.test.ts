import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME as string;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-orch-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import { sessionDir } from "../artifacts";
import {
	initOrchestration,
	isGateLevel,
	type MasterPlan,
	type Orchestration,
	readOrchestration,
	recordPlanProgress,
	toMermaid,
	unsatisfiedDeps,
} from "../orchestration";
import { computeSchedule } from "../scheduler";

let seq = 0;
function newId(): string {
	seq += 1;
	return `orch${String(seq).padStart(4, "0")}`;
}

/** Two repos: api/plan-1 → web/plan-1 (gate `merged`). */
function sampleMaster(gate: "completed" | "merged" | "released"): MasterPlan {
	return {
		prs: [
			{
				id: "pr-1",
				repo: "api",
				branch: "u/T-1-api",
				title: "API",
				plans: ["plan-1"],
			},
			{
				id: "pr-2",
				repo: "web",
				branch: "u/T-1-web",
				title: "Web",
				plans: ["plan-1"],
			},
		],
		nodes: [
			{ plan: "plan-1", repo: "api", pr: "pr-1", title: "contract" },
			{ plan: "plan-1", repo: "web", pr: "pr-2", title: "consume" },
		],
		deps: [
			{
				plan: "plan-1",
				repo: "web",
				dependsOn: "plan-1",
				dependsOnRepo: "api",
				gate,
			},
		],
	};
}

describe("orchestration: init + progress round-trip", () => {
	it("initOrchestration seeds one pending progress entry per node", () => {
		const id = newId();
		const orch = initOrchestration(id, 1, "manual", sampleMaster("merged"));
		expect(orch.progress).toHaveLength(2);
		expect(orch.progress.every((p) => p.status === "pending")).toBe(true);
		// Persisted + re-readable.
		const read = readOrchestration(id);
		expect(read?.mergeMode).toBe("manual");
		expect(read?.master.deps[0]?.gate).toBe("merged");
	});

	it("normalizes legacy records without prProgress using old pr_open-as-ready semantics", () => {
		const id = newId();
		const legacy = {
			sessionId: id,
			epoch: 1,
			mergeMode: "manual",
			master: sampleMaster("merged"),
			progress: [
				{
					plan: "plan-1",
					repo: "api",
					status: "pr_open",
					prNumber: 7,
					prUrl: "u7",
				},
				{ plan: "plan-1", repo: "web", status: "pending" },
			],
		};
		const dir = sessionDir(id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "orchestration.yaml"), YAML.stringify(legacy));

		const read = readOrchestration(id);
		expect(read?.prProgress?.find((p) => p.pr === "pr-1")).toMatchObject({
			status: "ready",
			prNumber: 7,
			prUrl: "u7",
		});
		expect(read?.progress.find((p) => p.repo === "api")?.status).toBe(
			"pr_ready",
		);
		expect(computeSchedule(read as Orchestration).toMerge[0]?.pr).toBe("pr-1");
		expect(computeSchedule(read as Orchestration).toPolish).toHaveLength(0);
	});

	it("normalizes mixed legacy pr_open/merged PRs as ready, not back to polish", () => {
		const id = newId();
		const master: MasterPlan = {
			prs: [
				{
					id: "pr-1",
					repo: "api",
					branch: "u/T-1-api",
					title: "API",
					plans: ["plan-1", "plan-2"],
				},
			],
			nodes: [
				{ plan: "plan-1", repo: "api", pr: "pr-1", title: "one" },
				{ plan: "plan-2", repo: "api", pr: "pr-1", title: "two" },
			],
			deps: [],
		};
		const legacy = {
			sessionId: id,
			epoch: 1,
			mergeMode: "manual",
			master,
			progress: [
				{
					plan: "plan-1",
					repo: "api",
					status: "pr_open",
					prNumber: 7,
				},
				{ plan: "plan-2", repo: "api", status: "merged" },
			],
		};
		const dir = sessionDir(id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "orchestration.yaml"), YAML.stringify(legacy));

		const read = readOrchestration(id) as Orchestration;
		expect(read.progress.find((p) => p.plan === "plan-1")?.status).toBe(
			"pr_ready",
		);
		const s = computeSchedule(read);
		expect(s.toPolish).toHaveLength(0);
		expect(s.toMerge.map((m) => m.pr)).toEqual(["pr-1"]);
	});

	it("recordPlanProgress updates status + kloop run id, preserved on re-read", () => {
		const id = newId();
		initOrchestration(id, 1, "auto", sampleMaster("merged"));
		recordPlanProgress(id, "api", "plan-1", {
			status: "running",
			kloopRunId: "run-abc",
		});
		const read = readOrchestration(id);
		const api = read?.progress.find((p) => p.repo === "api");
		expect(api?.status).toBe("running");
		expect(api?.kloopRunId).toBe("run-abc");
	});

	it("re-init after an epoch bump preserves prior progress for same plan ids", () => {
		const id = newId();
		initOrchestration(id, 1, "manual", sampleMaster("merged"));
		recordPlanProgress(id, "api", "plan-1", { status: "merged" });
		// Epoch 2 re-init with the same nodes carries the merged status forward.
		const next = initOrchestration(id, 2, "manual", sampleMaster("merged"));
		expect(next.progress.find((p) => p.repo === "api")?.status).toBe("merged");
	});
});

describe("orchestration: gate evaluation", () => {
	function orchWith(
		gate: "completed" | "merged" | "released",
		apiStatus: Orchestration["progress"][number]["status"],
	): Orchestration {
		return {
			sessionId: "x",
			epoch: 1,
			mergeMode: "manual",
			master: sampleMaster(gate),
			progress: [
				{ plan: "plan-1", repo: "api", status: apiStatus },
				{ plan: "plan-1", repo: "web", status: "pending" },
			],
		};
	}

	it("a `completed` gate is satisfied once the upstream is implemented", () => {
		expect(
			unsatisfiedDeps(orchWith("completed", "implemented"), "web", "plan-1"),
		).toHaveLength(0);
		expect(
			unsatisfiedDeps(orchWith("completed", "running"), "web", "plan-1"),
		).toHaveLength(1);
	});

	it("a `merged` gate needs the upstream merged, not merely implemented", () => {
		expect(
			unsatisfiedDeps(orchWith("merged", "implemented"), "web", "plan-1"),
		).toHaveLength(1);
		expect(
			unsatisfiedDeps(orchWith("merged", "pr_open"), "web", "plan-1"),
		).toHaveLength(1);
		expect(
			unsatisfiedDeps(orchWith("merged", "merged"), "web", "plan-1"),
		).toHaveLength(0);
		expect(
			unsatisfiedDeps(orchWith("merged", "released"), "web", "plan-1"),
		).toHaveLength(0);
	});

	it("a `released` gate needs the upstream fully released", () => {
		expect(
			unsatisfiedDeps(orchWith("released", "merged"), "web", "plan-1"),
		).toHaveLength(1);
		expect(
			unsatisfiedDeps(orchWith("released", "released"), "web", "plan-1"),
		).toHaveLength(0);
	});
});

describe("orchestration: mermaid + gate-level guard", () => {
	it("toMermaid renders a node per plan and a gate-labelled edge", () => {
		const m = toMermaid(sampleMaster("released"));
		expect(m).toContain("graph TD");
		expect(m).toContain("api__plan_1");
		expect(m).toContain("web__plan_1");
		// Edge from upstream → downstream labelled with the gate.
		expect(m).toContain("|released|");
	});

	it("isGateLevel only accepts the three gate levels", () => {
		expect(isGateLevel("merged")).toBe(true);
		expect(isGateLevel("released")).toBe(true);
		expect(isGateLevel("completed")).toBe(true);
		expect(isGateLevel("done")).toBe(false);
		expect(isGateLevel(undefined)).toBe(false);
	});
});
