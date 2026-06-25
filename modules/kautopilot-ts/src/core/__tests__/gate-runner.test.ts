import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME as string;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-gate-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import { reconcileGates, repoGateBlockers } from "../gate-runner";
import {
	initOrchestration,
	type MasterPlan,
	type Orchestration,
	readOrchestration,
	recordPlanProgress,
} from "../orchestration";
import type { SessionMeta } from "../session-meta";

function orch(
	apiStatus: Orchestration["progress"][number]["status"],
): Orchestration {
	return {
		sessionId: "x",
		epoch: 1,
		mergeMode: "manual",
		master: {
			prs: [],
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
		progress: [
			{ plan: "plan-1", repo: "api", status: apiStatus },
			{ plan: "plan-1", repo: "web", status: "pending" },
		],
	};
}

describe("gate-runner: repoGateBlockers", () => {
	it("blocks the downstream repo until the upstream PR is merged", () => {
		const blocked = repoGateBlockers(orch("pr_open"), "web");
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toContain("web/plan-1");
		expect(blocked[0]).toContain("api/plan-1");
		expect(blocked[0]).toContain("merged");
	});

	it("clears the downstream repo once the upstream is merged", () => {
		expect(repoGateBlockers(orch("merged"), "web")).toHaveLength(0);
	});

	it("never blocks the upstream repo on its own dependents", () => {
		expect(repoGateBlockers(orch("pr_open"), "api")).toHaveLength(0);
	});

	it("does not gate a downstream plan that is already in flight", () => {
		// web/plan-1 is `running` (worktree seeded, mid-implementation) — even though
		// its upstream api/plan-1 is only pr_open, the repo must NOT be blocked or it
		// would stall its own commit/PR. Only `pending` plans gate the repo.
		const o = orch("pr_open");
		const web = o.progress.find((p) => p.repo === "web");
		if (web) web.status = "running";
		expect(repoGateBlockers(o, "web")).toHaveLength(0);
	});
});

// --- reconcileGates (disk-backed, sandbox-safe) ------------------------------

let seq = 0;
function newId(): string {
	seq += 1;
	return `gate${String(seq).padStart(4, "0")}`;
}

function masterMerged(): MasterPlan {
	return {
		prs: [],
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
	};
}

function metaFor(id: string): SessionMeta {
	return {
		sessionId: id,
		folder: "/tmp/gate",
		ticketId: "T-1",
		org: "liftoff",
		ticketSystem: "jira",
		commitSpec: false,
		baseBranch: "master",
		epoch: 1,
		runMode: "current-session",
		execMode: "kloop",
		mergeMode: "manual",
		maxParallelRepos: 2,
		repos: [
			{
				repo: "api",
				repoPath: null,
				// A path that is not a git repo, so every `gh` call degrades to a failure
				// (→ ghIsPrMerged false), making the sandbox test deterministic regardless
				// of the process cwd / any real PR.
				worktree: join(tempHome, "no-such-repo"),
				branch: null,
				plans: ["plan-1"],
				dependsOn: [],
				prNumber: 7,
				prUrl: null,
				status: "active",
			},
			{
				repo: "web",
				repoPath: null,
				worktree: null,
				branch: null,
				plans: ["plan-1"],
				dependsOn: ["api"],
				prNumber: null,
				prUrl: null,
				status: "pending",
			},
		],
	};
}

describe("gate-runner: reconcileGates", () => {
	it("returns null when the session has no orchestration record", async () => {
		const meta = metaFor(newId());
		expect(await reconcileGates(meta)).toBeNull();
	});

	it("does not promote a pr_open plan when the merge can't be observed (sandbox)", async () => {
		const id = newId();
		const meta = metaFor(id);
		initOrchestration(id, 1, "manual", masterMerged());
		recordPlanProgress(id, "api", "plan-1", { status: "pr_open", prNumber: 7 });
		// No real PR #7 exists / gh degrades → the plan must stay pr_open, never falsely
		// promoted to merged, so the downstream gate stays closed.
		await reconcileGates(meta);
		const api = readOrchestration(id)?.progress.find((p) => p.repo === "api");
		expect(api?.status).toBe("pr_open");
		expect(repoGateBlockers(readOrchestration(id)!, "web")).toHaveLength(1);
	});
});
