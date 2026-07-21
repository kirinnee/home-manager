import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../../artifacts";
import { artifactScope } from "../../driver";
import { DEFAULT_CONFIG, envelopeSchema } from "../../types";
import { validateEnvelope } from "../envelope";
import { writerLabel, writerSessionName } from "../kteam";
import { isWriterStep, stepExecution } from "../mode";
import { hasAlternative, pickAccount } from "../pool";
import {
	clearReply,
	hashMessage,
	isLegacyWriterState,
	lastTurn,
	listPhases,
	listTurns,
	phaseKeySafe,
	readTurnMeta,
	readWriterState,
	replyExists,
	turnPaths,
	type WriterState,
	writeTurnMeta,
	writeWriterState,
} from "../scratch";

const SID = "test-writer-unit";

function cleanup() {
	rmSync(sessionDir(SID), { recursive: true, force: true });
}

beforeEach(cleanup);
afterEach(cleanup);

// ---------------------------------------------------------------------------
// mode.ts — execution resolution
// ---------------------------------------------------------------------------

describe("stepExecution", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		writer: {
			...DEFAULT_CONFIG.writer,
			steps: [...DEFAULT_CONFIG.writer.steps],
		},
	};

	test("inline when session writerMode is absent (pre-feature sessions)", () => {
		expect(stepExecution("write_spec", {}, cfg)).toBe("inline");
	});

	test("inline when session writerMode is inline", () => {
		expect(stepExecution("write_spec", { writerMode: "inline" }, cfg)).toBe(
			"inline",
		);
	});

	test("deferred writer step when session opted in and step enabled", () => {
		expect(stepExecution("write_spec", { writerMode: "deferred" }, cfg)).toBe(
			"deferred",
		);
	});

	test("inline when the step is not in config.writer.steps (staged rollout)", () => {
		const staged = {
			...cfg,
			writer: { ...cfg.writer, steps: ["write_spec" as const] },
		};
		expect(stepExecution("triage", { writerMode: "deferred" }, staged)).toBe(
			"inline",
		);
		expect(
			stepExecution("write_spec", { writerMode: "deferred" }, staged),
		).toBe("deferred");
	});

	test("non-writer steps are always inline", () => {
		for (const step of ["create_ticket", "feedback_check", "fetch_ticket"]) {
			expect(stepExecution(step, { writerMode: "deferred" }, cfg)).toBe(
				"inline",
			);
		}
	});

	test("isWriterStep matches exactly the six STEP_ARTIFACT steps", () => {
		for (const s of [
			"brainstorm",
			"triage",
			"write_spec",
			"write_master_plan",
			"write_plans",
			"feedback",
		])
			expect(isWriterStep(s)).toBe(true);
		expect(isWriterStep("feedback_check")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// pool.ts
// ---------------------------------------------------------------------------

describe("pickAccount", () => {
	test("single-entry pool is a fixed pick", () => {
		expect(pickAccount({ "claude-auto-writer": 1 })).toBe("claude-auto-writer");
	});

	test("weighted pick is deterministic under a seeded rand", () => {
		const pool = { a: 1, b: 3 };
		expect(pickAccount(pool, [], () => 0.0)).toBe("a");
		expect(pickAccount(pool, [], () => 0.9)).toBe("b");
	});

	test("exclusion drops the failed account when alternatives exist", () => {
		expect(pickAccount({ a: 1, b: 1 }, ["a"], () => 0.0)).toBe("b");
	});

	test("exclusion falls back to the full pool when it would empty it", () => {
		expect(pickAccount({ a: 1 }, ["a"])).toBe("a");
	});

	test("empty pool throws", () => {
		expect(() => pickAccount({})).toThrow();
	});

	test("hasAlternative", () => {
		expect(hasAlternative({ a: 1 }, "a")).toBe(false);
		expect(hasAlternative({ a: 1, b: 1 }, "a")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// scratch.ts
// ---------------------------------------------------------------------------

describe("scratch", () => {
	test("phaseKeySafe slugs the plans scope", () => {
		expect(phaseKeySafe("plans@1:api")).toBe("plans_1_api");
		expect(phaseKeySafe("spec@1")).toBe("spec_1");
	});

	test("writer.json round-trip", () => {
		writeWriterState(SID, {
			phaseKey: "spec@1",
			account: "claude-auto-writer",
			kteamSessionId: "kt-abc",
			cwd: "/tmp",
			status: "idle",
			turns: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		const state = readWriterState(SID, "spec@1");
		expect(state?.account).toBe("claude-auto-writer");
		expect(state?.kteamSessionId).toBe("kt-abc");
		expect(state?.schemaVersion).toBe(2); // stamped on write
		expect(listPhases(SID)).toEqual(["spec_1"]);
	});

	test("isLegacyWriterState detects tmux-era state, not fresh kteam state", () => {
		// tmux era: harnessSessionId + started, no schemaVersion.
		const legacy = {
			phaseKey: "spec@1",
			account: "claude-auto-writer",
			harnessSessionId: "uuid",
			cwd: "/tmp",
			status: "running",
			turns: 0,
			started: true,
			createdAt: "",
			updatedAt: "",
		} as unknown as WriterState;
		expect(isLegacyWriterState(legacy)).toBe(true);
		// A written (schemaVersion-stamped) state is never legacy.
		writeWriterState(SID, {
			phaseKey: "spec@1",
			account: "claude-auto-writer",
			cwd: "/tmp",
			status: "idle",
			turns: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		expect(isLegacyWriterState(readWriterState(SID, "spec@1"))).toBe(false);
		// A fresh kteam state before turn 1 (no kteamSessionId yet) is NOT legacy.
		const fresh = {
			schemaVersion: 2,
			phaseKey: "spec@1",
			account: "claude-auto-writer",
			cwd: "/tmp",
			status: "idle" as const,
			turns: 0,
			createdAt: "",
			updatedAt: "",
		};
		expect(isLegacyWriterState(fresh)).toBe(false);
		expect(isLegacyWriterState(null)).toBe(false);
	});

	test("turn indexing + meta round-trip", () => {
		expect(lastTurn(SID, "spec@1")).toBe(0);
		writeTurnMeta(SID, "spec@1", {
			turn: 1,
			state: "sent",
			sentAt: new Date().toISOString(),
			attempts: 0,
			userMessageHash: hashMessage("hello"),
			userMessage: "hello",
			workingVersion: 1,
		});
		expect(listTurns(SID, "spec@1")).toEqual([1]);
		expect(lastTurn(SID, "spec@1")).toBe(1);
		expect(readTurnMeta(SID, "spec@1", 1)?.userMessageHash).toBe(
			hashMessage("hello"),
		);
	});

	test("reply-marker hygiene: clear + exists", () => {
		const paths = turnPaths(SID, "spec@1", 1);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.reply, "{}");
		expect(replyExists(SID, "spec@1", 1)).toBe(true);
		clearReply(SID, "spec@1", 1);
		expect(replyExists(SID, "spec@1", 1)).toBe(false);
		clearReply(SID, "spec@1", 1); // idempotent
	});

	test("turnPaths has no `done` sentinel (reply.json is the marker)", () => {
		const paths = turnPaths(SID, "spec@1", 1);
		expect(paths.reply.endsWith("reply.json")).toBe(true);
		expect(paths).not.toHaveProperty("sentinel");
	});
});

// ---------------------------------------------------------------------------
// envelope.ts — schema + side effects
// ---------------------------------------------------------------------------

function specRevisionDir(): string {
	return join(sessionDir(SID), "epoch", "1", "spec");
}

function validSpecEnvelope(revised: boolean) {
	return {
		summary: "Drafted the spec around two goals.",
		answers: [],
		questions: [],
		openItems: [],
		artifact: { kind: "spec", version: 1, revised },
	};
}

describe("envelope validation", () => {
	test("schema rejects an over-cap payload", () => {
		const tooMany = {
			...validSpecEnvelope(false),
			questions: Array.from({ length: 6 }, (_, i) => ({
				id: `q${i}`,
				text: "x",
			})),
		};
		expect(envelopeSchema.safeParse(tooMany).success).toBe(false);
	});

	test("schema rejects a 601-char summary", () => {
		const long = { ...validSpecEnvelope(false), summary: "x".repeat(601) };
		expect(envelopeSchema.safeParse(long).success).toBe(false);
	});

	test("Q&A turn (revised:false) validates with no artifact on disk", () => {
		const check = validateEnvelope({
			raw: validSpecEnvelope(false),
			sessionId: SID,
			kind: "spec",
			epoch: 1,
			repo: null,
			workingVersion: 1,
		});
		expect(check.ok).toBe(true);
	});

	test("revised turn fails without the artifact + visual on disk", () => {
		const check = validateEnvelope({
			raw: validSpecEnvelope(true),
			sessionId: SID,
			kind: "spec",
			epoch: 1,
			repo: null,
			workingVersion: 1,
		});
		expect(check.ok).toBe(false);
		expect(check.errors.join("\n")).toContain("revision file not found");
	});

	test("revised turn passes once vN.md (non-trivial) + vN.html exist", () => {
		mkdirSync(specRevisionDir(), { recursive: true });
		writeFileSync(
			join(specRevisionDir(), "v1.md"),
			"# Spec: real content\n\nGoals: G1 — do the thing properly.\n",
		);
		writeFileSync(join(specRevisionDir(), "v1.html"), "<html></html>");
		const check = validateEnvelope({
			raw: validSpecEnvelope(true),
			sessionId: SID,
			kind: "spec",
			epoch: 1,
			repo: null,
			workingVersion: 1,
		});
		expect(check.ok).toBe(true);
	});

	test("revised turn fails on a blank/near-empty artifact", () => {
		mkdirSync(specRevisionDir(), { recursive: true });
		writeFileSync(join(specRevisionDir(), "v1.md"), "# Spec\n");
		writeFileSync(join(specRevisionDir(), "v1.html"), "<html></html>");
		const check = validateEnvelope({
			raw: validSpecEnvelope(true),
			sessionId: SID,
			kind: "spec",
			epoch: 1,
			repo: null,
			workingVersion: 1,
		});
		expect(check.ok).toBe(false);
	});

	test("wrong kind / wrong version are rejected", () => {
		const wrongKind = {
			...validSpecEnvelope(false),
			artifact: { kind: "triage", version: 1, revised: false },
		};
		expect(
			validateEnvelope({
				raw: wrongKind,
				sessionId: SID,
				kind: "spec",
				epoch: 1,
				repo: null,
				workingVersion: 1,
			}).ok,
		).toBe(false);
		const wrongVersion = {
			...validSpecEnvelope(false),
			artifact: { kind: "spec", version: 3, revised: false },
		};
		expect(
			validateEnvelope({
				raw: wrongVersion,
				sessionId: SID,
				kind: "spec",
				epoch: 1,
				repo: null,
				workingVersion: 1,
			}).ok,
		).toBe(false);
	});

	test("plans: every plan folder with vN.md needs its vN.html", () => {
		const plansDir = join(sessionDir(SID), "epoch", "1", "plans", "api");
		mkdirSync(join(plansDir, "plan-1"), { recursive: true });
		writeFileSync(
			join(plansDir, "plan-1", "v1.md"),
			"# Plan 1: real content with enough length to pass the blank check.",
		);
		const env = {
			...validSpecEnvelope(true),
			artifact: { kind: "plans", version: 1, revised: true },
		};
		const missing = validateEnvelope({
			raw: env,
			sessionId: SID,
			kind: "plans",
			epoch: 1,
			repo: "api",
			workingVersion: 1,
		});
		expect(missing.ok).toBe(false);
		expect(missing.errors.join("\n")).toContain("missing its visual");
		writeFileSync(join(plansDir, "plan-1", "v1.html"), "<html></html>");
		const good = validateEnvelope({
			raw: env,
			sessionId: SID,
			kind: "plans",
			epoch: 1,
			repo: "api",
			workingVersion: 1,
		});
		expect(good.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// kteam naming — ownership label + session name (safe from kloop filters)
// ---------------------------------------------------------------------------

describe("writer kteam naming", () => {
	test("label is kauto-<sessionId> (never a kloop label)", () => {
		expect(writerLabel("abc123")).toBe("kauto-abc123");
		expect(writerLabel("abc123").startsWith("kloop-")).toBe(false);
	});

	test("session name is writer-<kind>", () => {
		expect(writerSessionName("spec")).toBe("writer-spec");
		expect(writerSessionName("plans")).toBe("writer-plans");
	});
});

// ---------------------------------------------------------------------------
// artifactScope — phaseKey derivation (incl. plans@E:repo)
// ---------------------------------------------------------------------------

describe("artifactScope", () => {
	test("brainstorm is epoch-agnostic; others carry epoch; plans carry repo", () => {
		expect(artifactScope("brainstorm", 2, null)).toBe("brainstorm");
		expect(artifactScope("spec", 2, null)).toBe("spec@2");
		expect(artifactScope("plans", 1, "api")).toBe("plans@1:api");
		expect(artifactScope("plans", 1, null)).toBe("plans@1:default");
	});
});
