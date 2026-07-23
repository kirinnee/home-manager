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
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-phase-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import { sessionDir } from "../../core/artifacts";
import { runComplete, runNext, runRevise } from "../../core/driver";
import { readOrchestration } from "../../core/orchestration";
import type { Phase } from "../../core/phase-plan";
import { createSession } from "../../core/session-create";
import { readSessionMeta, updateSessionMeta } from "../../core/session-meta";
import type { Config } from "../../core/types";
import { DEFAULT_CONFIG } from "../../core/types";

const config: Config = DEFAULT_CONFIG;

let seq = 0;
function newSession(opts?: {
	phases?: Phase[];
	ticketId?: string | null;
	request?: string;
}): string {
	seq += 1;
	const meta = createSession({
		ticketId: opts?.ticketId ?? null,
		request: opts?.request ?? "do the thing",
		org: "liftoff",
		folder: `/tmp/phase-repo-${seq}`,
		phases: opts?.phases,
	});
	return meta.sessionId;
}

function writeFile(p: string, body: string): void {
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, body);
}

describe("phase set: pinning + heuristics", () => {
	it("pins an explicit phase set (normalized, plan forced in)", () => {
		const id = newSession({ phases: ["spec"] as Phase[] });
		expect(readSessionMeta(id)?.phases).toEqual(["spec", "plan"]);
	});

	it("auto-proposes plan-only from a 'quick' request", () => {
		const id = newSession({ request: "a quick tiny fix" });
		expect(readSessionMeta(id)?.phases).toEqual(["plan"]);
	});

	it("auto-proposes the full set from a 'big risky' request", () => {
		const id = newSession({ request: "a big risky migration" });
		expect(readSessionMeta(id)?.phases).toEqual([
			"brainstorm",
			"triage",
			"spec",
			"plan",
		]);
	});
});

describe("plan-only shape: one artifact, one PR", () => {
	it("resolve_org routes straight to plan_only", async () => {
		const id = newSession({ phases: ["plan"] as Phase[] });
		const d = await runNext(id, config);
		if (d.done) throw new Error("unexpected done");
		expect(d.step).toBe("plan_only");
		expect(d.contract.completionEvent).toBe("plan_only:approved");
		expect(d.execution).toBe("inline");
	});

	it("completing plan_only freezes ONE PR + ONE plan, hands to schedule/record", async () => {
		const id = newSession({ phases: ["plan"] as Phase[] });
		await runNext(id, config);
		const dir = sessionDir(id);
		const plansDir = join(dir, "epoch", "1", "plans", "default");
		writeFile(join(plansDir, "plan-1", "v1.md"), "repo: default\n# Plan 1");
		const res = await runComplete(id, config, "plan_only", {
			output: plansDir,
			metadata: {
				repoPath: "/tmp/phase-repo",
				branchSlug: "quick",
				prTitle: "Quick",
			},
		});
		expect(res.ok).toBe(true);

		const orch = readOrchestration(id);
		expect(orch?.master.prs).toHaveLength(1);
		expect(orch?.master.nodes).toHaveLength(1);
		expect(orch?.progress).toHaveLength(1);

		// The earlier-phase artifacts were never created (no empty placeholders).
		expect(existsSync(join(dir, "brainstorm"))).toBe(false);
		expect(existsSync(join(dir, "epoch", "1", "triage"))).toBe(false);
		expect(existsSync(join(dir, "epoch", "1", "spec"))).toBe(false);
		expect(existsSync(join(dir, "epoch", "1", "master_plan"))).toBe(false);

		const after = await runNext(id, config);
		expect(after.done).toBe(true);
		if (!after.done) return;
		expect(after.reason).toContain("kautopilot schedule");
	});

	it("plan_only defers to the writer session when writerMode is deferred", async () => {
		const id = newSession({ phases: ["plan"] as Phase[] });
		updateSessionMeta(id, (m) => {
			m.writerMode = "deferred";
		});
		const d = await runNext(id, config);
		if (d.done) throw new Error("unexpected done");
		expect(d.step).toBe("plan_only");
		expect(d.execution).toBe("deferred");
		expect(d.prompt).toContain("DEFERRED");
	});

	it("rejects a second authored plan (structural single-plan/single-PR enforcement)", async () => {
		const id = newSession({ phases: ["plan"] as Phase[] });
		await runNext(id, config);
		const dir = sessionDir(id);
		const plansDir = join(dir, "epoch", "1", "plans", "default");
		// The agent tries to sneak a second plan past the one-artifact/one-PR shape.
		writeFile(join(plansDir, "plan-1", "v1.md"), "repo: default\n# Plan 1");
		writeFile(join(plansDir, "plan-2", "v1.md"), "repo: default\n# Plan 2");
		await expect(
			runComplete(id, config, "plan_only", {
				output: plansDir,
				metadata: { repoPath: "/tmp/x", branchSlug: "s", prTitle: "T" },
			}),
		).rejects.toThrow("plan-1");
		// Rejection mutated NOTHING: no orchestration, no repo, step still pending.
		expect(readOrchestration(id)).toBeNull();
		expect(readSessionMeta(id)?.repos ?? []).toHaveLength(0);
		const again = await runNext(id, config);
		expect(again.done).toBe(false);
		if (!again.done) expect(again.step).toBe("plan_only");
	});

	it("completing plan_only assigns exactly plan-1 to the single repo", async () => {
		const id = newSession({ phases: ["plan"] as Phase[] });
		await runNext(id, config);
		const plansDir = join(sessionDir(id), "epoch", "1", "plans", "default");
		writeFile(join(plansDir, "plan-1", "v1.md"), "repo: default\n# Plan 1");
		await runComplete(id, config, "plan_only", {
			output: plansDir,
			metadata: { repoPath: "/tmp/x", branchSlug: "s", prTitle: "T" },
		});
		const meta = readSessionMeta(id);
		expect(meta?.repos).toHaveLength(1);
		expect(meta?.repos[0]?.plans).toEqual(["plan-1"]);
		const orch = readOrchestration(id);
		expect(orch?.master.prs).toHaveLength(1);
		expect(orch?.master.prs[0]?.plans).toEqual(["plan-1"]);
	});

	it("plan_only is revisable as a plan-set artifact", async () => {
		const id = newSession({ phases: ["plan"] as Phase[] });
		await runNext(id, config);
		const plansDir = join(sessionDir(id), "epoch", "1", "plans", "default");
		writeFile(join(plansDir, "plan-1", "v1.md"), "repo: default\n# Plan 1");
		const r = await runRevise(id, config);
		expect(r.ok).toBe(true);
		expect(r.version).toBe(1);
	});
});

/** Drive a subset that starts from a ticket, asserting the exact step sequence. */
async function driveSubset(id: string, expectedSteps: string[]): Promise<void> {
	const dir = sessionDir(id);
	// fetch_ticket (ticket sessions always fetch first).
	const ft = await runNext(id, config);
	if (ft.done) throw new Error("unexpected done at fetch_ticket");
	expect(ft.step).toBe("fetch_ticket");
	writeFile(join(dir, "ticket.md"), "# ticket");
	await runComplete(id, config, "fetch_ticket", {
		output: join(dir, "ticket.md"),
	});

	for (const step of expectedSteps) {
		const d = await runNext(id, config);
		if (d.done) throw new Error(`unexpected done, wanted ${step}`);
		expect(d.step).toBe(step);
		if (step === "triage") {
			writeFile(join(dir, "epoch", "1", "triage", "v1.md"), "moderate");
			await runComplete(id, config, "triage", {
				output: join(dir, "epoch", "1", "triage", "v1.md"),
				metadata: { repos: ["default"], dependsOn: {} },
			});
		} else if (step === "write_spec") {
			writeFile(join(dir, "epoch", "1", "spec", "v1.md"), "# Spec");
			await runComplete(id, config, "write_spec", {
				output: join(dir, "epoch", "1", "spec", "v1.md"),
			});
		} else if (step === "write_master_plan") {
			writeFile(
				join(dir, "epoch", "1", "master_plan", "v1.md"),
				"# Master plan",
			);
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
			});
		} else if (step === "write_plans") {
			const plansDir = join(dir, "epoch", "1", "plans", "default");
			writeFile(join(plansDir, "plan-1", "v1.md"), "repo: default\n# Plan 1");
			await runComplete(id, config, "write_plans", { output: plansDir });
		}
	}
}

describe("arbitrary subsets execute + skip omitted artifacts", () => {
	it("[spec, plan] runs spec → master_plan → plans, skipping triage/brainstorm", async () => {
		const id = newSession({
			phases: ["spec", "plan"] as Phase[],
			ticketId: "PE-1",
		});
		await driveSubset(id, ["write_spec", "write_master_plan", "write_plans"]);
		const dir = sessionDir(id);
		// Omitted phases left NO artifact directories behind.
		expect(existsSync(join(dir, "brainstorm"))).toBe(false);
		expect(existsSync(join(dir, "epoch", "1", "triage"))).toBe(false);
		// The included artifacts exist.
		expect(existsSync(join(dir, "epoch", "1", "spec", "v1.md"))).toBe(true);
		// Reached the schedule/record handoff.
		const after = await runNext(id, config);
		expect(after.done).toBe(true);
	});

	it("[triage, plan] runs triage → master_plan → plans, skipping spec/brainstorm", async () => {
		const id = newSession({
			phases: ["triage", "plan"] as Phase[],
			ticketId: "PE-2",
		});
		await driveSubset(id, ["triage", "write_master_plan", "write_plans"]);
		const dir = sessionDir(id);
		expect(existsSync(join(dir, "brainstorm"))).toBe(false);
		expect(existsSync(join(dir, "epoch", "1", "spec"))).toBe(false);
		expect(existsSync(join(dir, "epoch", "1", "triage", "v1.md"))).toBe(true);
		const after = await runNext(id, config);
		expect(after.done).toBe(true);
	});

	it("[triage, spec, plan] runs the full non-brainstorm chain", async () => {
		const id = newSession({
			phases: ["triage", "spec", "plan"] as Phase[],
			ticketId: "PE-3",
		});
		await driveSubset(id, [
			"triage",
			"write_spec",
			"write_master_plan",
			"write_plans",
		]);
		expect(existsSync(join(sessionDir(id), "brainstorm"))).toBe(false);
		const after = await runNext(id, config);
		expect(after.done).toBe(true);
	});

	it("default (no phases) still fetches the ticket then triages, unchanged", async () => {
		const id = newSession({ ticketId: "PE-4", request: "do the thing" });
		// No trigger words → default full set.
		expect(readSessionMeta(id)?.phases).toEqual([
			"brainstorm",
			"triage",
			"spec",
			"plan",
		]);
		const d = await runNext(id, config);
		if (d.done) throw new Error("unexpected done");
		expect(d.step).toBe("fetch_ticket");
	});
});
