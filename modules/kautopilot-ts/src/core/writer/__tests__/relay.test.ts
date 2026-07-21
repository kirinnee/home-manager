import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionDir } from "../../artifacts";
import {
	alreadyPresented,
	artifactScope,
	mintOrReuseWorkingVersion,
} from "../../driver";
import { readLog } from "../../log";
import { writeSessionMeta } from "../../session-meta";
import { DEFAULT_CONFIG } from "../../types";
import { readDiscussion, runRelay } from "../relay";
import {
	hashMessage,
	turnPaths,
	writerJsonPath,
	writeTurnMeta,
	writeTurnReply,
	writeWriterState,
} from "../scratch";

// ============================================================================
// Relay engine tests with a FAKE kteam harness (no daemon, no real claude). The
// fake simulates the writer by materializing reply.json (the completion marker)
// per a scripted behavior when runTurn is called, and mints/reuses a kteam
// session id the way `kteam start`/`send` would.
// ============================================================================

const SID = "test-relay-unit";

function cleanup() {
	rmSync(sessionDir(SID), { recursive: true, force: true });
}

function seedSession(): void {
	mkdirSync(sessionDir(SID), { recursive: true });
	writeSessionMeta({
		sessionId: SID,
		folder: "/tmp",
		ticketId: "PE-1",
		org: "liftoff",
		ticketSystem: "jira",
		commitSpec: false,
		baseBranch: "master",
		epoch: 1,
		runMode: "current-session",
		execMode: "kloop",
		writerMode: "deferred",
		mergeMode: "manual",
		maxParallelRepos: 2,
		repos: [],
	});
	// WAL cursor: land the session on write_spec.
	appendCursor("resolve_org", "fetch_ticket");
	appendCursor("fetch_ticket", "triage");
	appendCursor("triage", "write_spec");
}

function appendCursor(step: string, to: string): void {
	const { appendEvent } = require("../../log") as typeof import("../../log");
	appendEvent(SID, {
		ts: new Date().toISOString(),
		event: `${step}:completed`,
		metadata: { step, to, repo: null },
	});
}

const CONFIG = {
	...DEFAULT_CONFIG,
	writer: {
		...DEFAULT_CONFIG.writer,
		mode: "deferred" as const,
		pool: { "fake-claude": 1 },
		turnTimeoutMins: 1,
		maxTurnRetries: 1,
	},
};

type FakeOutcome = "done" | "needs_attention" | "failed" | "timeout";

interface FakeCall {
	kteamSessionId?: string;
	messageFile: string;
	account: string;
	label: string;
	name: string;
}

/** A fake WriterKteam whose runTurn executes a scripted behavior and mints/reuses
 *  a kteam session id (start when none was passed, send otherwise). */
function fakeKteam(
	behavior: (params: {
		markerFile: string;
		messageFile: string;
		kteamSessionId?: string;
		account: string;
	}) => Promise<FakeOutcome>,
	opts: { daemonReachable?: boolean } = {},
) {
	const calls: FakeCall[] = [];
	let idCounter = 0;
	let minted: string | undefined;
	return {
		calls,
		daemonReachable: async () => opts.daemonReachable ?? true,
		stopByLabel: async () => 0,
		stop: async () => {},
		snapshot: async () => "fake snapshot",
		runTurn: async (params: {
			kteamSessionId?: string;
			account: string;
			name: string;
			label: string;
			cwd: string;
			messageFile: string;
			markerFile: string;
			timeoutMins: number;
			onSessionCreated?: (id: string) => void;
			onTick?: () => void;
		}) => {
			calls.push({
				kteamSessionId: params.kteamSessionId,
				messageFile: params.messageFile,
				account: params.account,
				label: params.label,
				name: params.name,
			});
			// start (no id) mints one; send reuses the passed id.
			if (!params.kteamSessionId && !minted) {
				idCounter += 1;
				minted = `kt-${idCounter}`;
			}
			const id = params.kteamSessionId ?? (minted as string);
			// Mirror the real harness: a fresh start persists the id BEFORE the wait.
			if (!params.kteamSessionId) params.onSessionCreated?.(id);
			// `behavior` may throw (e.g. DaemonUnavailableError during the wait) —
			// AFTER onSessionCreated, exactly like the real runTurn ordering.
			const outcome = await behavior(params);
			return {
				outcome,
				kteamSessionId: id,
				status: outcome === "done" ? "completed" : "stalled",
				snapshot: outcome === "done" ? undefined : "fake snapshot",
				durationMs: 1,
			};
		},
	};
}

/** Writer-side simulation: write a valid spec revision + visual + reply.json
 *  (the marker). `version` = the working version the relay handed out. */
function writerProducesValidReply(turn: number, revised = true, version = 1) {
	const specDir = join(sessionDir(SID), "epoch", "1", "spec");
	return async () => {
		if (revised) {
			mkdirSync(specDir, { recursive: true });
			writeFileSync(
				join(specDir, `v${version}.md`),
				"# Spec: enough real content to clear the blank-artifact check.",
			);
			writeFileSync(join(specDir, `v${version}.html`), "<html>visual</html>");
		}
		writeTurnReply(SID, "spec@1", turn, {
			summary: "Drafted the spec.",
			answers: [],
			questions: [{ id: "q1", text: "Scope A or B?" }],
			openItems: [],
			artifact: { kind: "spec", version, revised },
		});
		return "done" as const;
	};
}

beforeEach(() => {
	cleanup();
	seedSession();
});
afterEach(cleanup);

describe("runRelay", () => {
	test("rejects when the step is not deferred", async () => {
		writeSessionMeta({
			...(
				require("../../session-meta") as typeof import("../../session-meta")
			).readSessionMeta(SID)!,
			writerMode: "inline",
		});
		const result = await runRelay(SID, CONFIG, {
			message: "go",
			harness: fakeKteam(async () => "done") as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not deferred");
	});

	test("daemon down: fails loudly without writing turn state", async () => {
		const result = await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(async () => "done", {
				daemonReachable: false,
			}) as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error?.toLowerCase()).toContain("daemon");
		expect(result.remediation?.join(" ")).toContain("kteam daemon start");
		// No turn was composed (state uncorrupted).
		const d = readDiscussion(SID, "spec@1");
		expect(d.turns.length).toBe(0);
	});

	test("start succeeds then daemon down during wait: id persisted before the wait, turn stays re-attachable (no orphan)", async () => {
		const { DaemonUnavailableError } =
			require("../kteam") as typeof import("../kteam");
		// The session is created (onSessionCreated fires), then the wait dies.
		const kteam = fakeKteam(async () => {
			throw new DaemonUnavailableError(
				"kteam daemon is unreachable; start it with: kteam daemon start",
			);
		});
		const result = await runRelay(SID, CONFIG, {
			message: "",
			harness: kteam as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error?.toLowerCase()).toContain("daemon");
		const { readWriterState, readTurnMeta } =
			require("../scratch") as typeof import("../scratch");
		// The just-created id was persisted BEFORE the failing wait — a re-attach
		// (kteam send) targets the SAME session instead of starting a rival.
		const w = readWriterState(SID, "spec@1");
		expect(w?.kteamSessionId).toBe("kt-1");
		expect(w?.status).toBe("interrupted");
		// The turn is left re-attachable ("sent"), never marked "failed".
		expect(readTurnMeta(SID, "spec@1", 1)?.state).toBe("sent");
		// A follow-up relay with no message re-attaches to kt-1 (send, not start).
		const kteam2 = fakeKteam(writerProducesValidReply(1));
		const again = await runRelay(SID, CONFIG, { harness: kteam2 as never });
		expect(again.ok).toBe(true);
		expect(kteam2.calls[0].kteamSessionId).toBe("kt-1");
	});

	test("old-format (tmux-era) writer.json: refuses to start a competing writer (migration required)", async () => {
		// A pre-kteam writer.json: harnessSessionId + started, NO schemaVersion.
		// Written raw (bypassing writeWriterState, which would stamp schemaVersion).
		const statePath = writerJsonPath(SID, "spec@1");
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({
				phaseKey: "spec@1",
				account: "claude-auto-writer",
				harnessSessionId: "uuid-old",
				cwd: "/tmp",
				status: "running",
				turns: 0,
				started: true,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		);
		// …with an in-flight turn from the old harness.
		const paths = turnPaths(SID, "spec@1", 1);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.message, "old turn");
		writeTurnMeta(SID, "spec@1", {
			turn: 1,
			state: "running",
			sentAt: new Date().toISOString(),
			attempts: 1,
			userMessageHash: hashMessage("old turn"),
			userMessage: "old turn",
			workingVersion: 1,
		});

		const kteam = fakeKteam(writerProducesValidReply(1));
		const result = await runRelay(SID, CONFIG, {
			message: "",
			harness: kteam as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("pre-kteam");
		// Remediation names the concrete state path so the operator can act.
		expect(result.remediation?.join("\n")).toContain(statePath);
		// Never started a competing writer.
		expect(kteam.calls.length).toBe(0);
	});

	test("turn 1: pins account, starts a fresh kteam session (no prior id), accepts a valid revised reply, marks presented, enriches links", async () => {
		const kteam = fakeKteam(writerProducesValidReply(1));
		const result = await runRelay(SID, CONFIG, {
			message: "",
			harness: kteam as never,
		});
		expect(result.ok).toBe(true);
		expect(kteam.calls[0].kteamSessionId).toBeUndefined(); // start, not send
		expect(kteam.calls[0].label).toBe(`kauto-${SID}`);
		expect(kteam.calls[0].name).toBe("writer-spec");
		expect(result.envelope?.links.read).toContain(`/sessions/${SID}/spec/v1`);
		expect(result.envelope?.links.diff).toBeNull(); // v1 has no diff
		expect(result.envelope?.account).toBe("fake-claude");
		expect(alreadyPresented(SID, artifactScope("spec", 1, null), 1)).toBe(true);
		// The kteam session id is persisted for later turns.
		const { readWriterState } =
			require("../scratch") as typeof import("../scratch");
		expect(readWriterState(SID, "spec@1")?.kteamSessionId).toBe("kt-1");
		// WAL: relay events present and non-cursor (pendingStep still write_spec).
		const events = readLog(SID).map((e) => e.event);
		expect(events).toContain("relay:sent");
		expect(events).toContain("relay:reply");
		const { pendingStep } =
			require("../../driver") as typeof import("../../driver");
		expect(pendingStep(SID)).toBe("write_spec");
	});

	test("turn 2 reuses the same kteam session via send (not a new start)", async () => {
		await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(writerProducesValidReply(1)) as never,
		});
		const kteam = fakeKteam(writerProducesValidReply(2, false, 2));
		const result = await runRelay(SID, CONFIG, {
			message: "answering A",
			harness: kteam as never,
		});
		expect(result.ok).toBe(true);
		expect(result.turn).toBe(2);
		// Reused the turn-1 session (send), never started a second one.
		expect(kteam.calls[0].kteamSessionId).toBe("kt-1");
	});

	test("idempotent re-invoke: same/no message returns the accepted reply without re-sending", async () => {
		const kteam1 = fakeKteam(writerProducesValidReply(1));
		await runRelay(SID, CONFIG, { message: "", harness: kteam1 as never });
		const kteam2 = fakeKteam(async () => "done");
		const again = await runRelay(SID, CONFIG, { harness: kteam2 as never });
		expect(again.ok).toBe(true);
		expect(again.turn).toBe(1);
		expect(kteam2.calls.length).toBe(0); // no re-send
	});

	test("idempotent re-invoke with the SAME user message never composes a duplicate turn", async () => {
		await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(writerProducesValidReply(1)) as never,
		});
		await runRelay(SID, CONFIG, {
			message: "my answer",
			harness: fakeKteam(writerProducesValidReply(2, false, 2)) as never,
		});
		// Skill crashed before recording — re-sends the identical message.
		const kteam = fakeKteam(async () => "done");
		const again = await runRelay(SID, CONFIG, {
			message: "my answer",
			harness: kteam as never,
		});
		expect(again.ok).toBe(true);
		expect(again.turn).toBe(2); // returned, not re-composed as turn 3
		expect(kteam.calls.length).toBe(0);
		// A DIFFERENT message does compose turn 3.
		const next = await runRelay(SID, CONFIG, {
			message: "a new different answer",
			harness: fakeKteam(writerProducesValidReply(3, false, 2)) as never,
		});
		expect(next.ok).toBe(true);
		expect(next.turn).toBe(3);
	});

	test("re-attach preserves the crashed turn's approval-ness (no phantom mint)", async () => {
		// Presented v1.
		await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(writerProducesValidReply(1)) as never,
		});
		// Approval turn 2 crashes mid-turn (harness returns failed, no reply).
		const crashed = await runRelay(SID, CONFIG, {
			message: "the user approved",
			approval: true,
			harness: fakeKteam(async () => "failed") as never,
		});
		expect(crashed.ok).toBe(false);
		// Recovery per relay.md: re-run with NO flags. Must still be an approval
		// turn (workingVersion pinned to presented v1, no v2 minted).
		const result = await runRelay(SID, CONFIG, {
			harness: fakeKteam(writerProducesValidReply(2, false, 1)) as never,
		});
		expect(result.ok).toBe(true);
		const { latestRevisionOnDisk } =
			require("../../revisions") as typeof import("../../revisions");
		expect(latestRevisionOnDisk(SID, "spec", { epoch: 1 })).toBe(1);
	});

	test("Q&A turn (revised:false) does NOT burn a presentation and links stay at last presented", async () => {
		// Turn 1: revised.
		await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(writerProducesValidReply(1)) as never,
		});
		// Turn 2: pure Q&A (working version is the freshly-minted, unpresented v2).
		const result = await runRelay(SID, CONFIG, {
			message: "answering your question: A",
			harness: fakeKteam(writerProducesValidReply(2, false, 2)) as never,
		});
		expect(result.ok).toBe(true);
		// The Q&A turn minted a working v2 but did not present it.
		expect(alreadyPresented(SID, artifactScope("spec", 1, null), 2)).toBe(
			false,
		);
		expect(result.envelope?.links.read).toContain("/spec/v1");
		// Next mint reuses the unpresented v2 (no churn).
		const next = mintOrReuseWorkingVersion(SID, "spec", 1, null);
		expect(next.n).toBe(2);
	});

	test("new message while a turn is in flight is refused", async () => {
		// Simulate an in-flight turn: message + meta present, not accepted.
		const paths = turnPaths(SID, "spec@1", 1);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.message, "original");
		writeTurnMeta(SID, "spec@1", {
			turn: 1,
			state: "running",
			sentAt: new Date().toISOString(),
			attempts: 1,
			userMessageHash: hashMessage("original"),
			userMessage: "original",
			workingVersion: 1,
		});
		writeWriterState(SID, {
			phaseKey: "spec@1",
			account: "fake-claude",
			kteamSessionId: "kt-1",
			cwd: "/tmp",
			status: "running",
			turns: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		const result = await runRelay(SID, CONFIG, {
			message: "a different new message",
			harness: fakeKteam(async () => "done") as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("in flight");
	});

	test("adoption: finished-on-disk turn is accepted without re-sending", async () => {
		// Simulate: controller died after the writer finished turn 1.
		const paths = turnPaths(SID, "spec@1", 1);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.message, "kick");
		writeTurnMeta(SID, "spec@1", {
			turn: 1,
			state: "running",
			sentAt: new Date().toISOString(),
			attempts: 1,
			userMessageHash: hashMessage("kick"),
			userMessage: "kick",
			workingVersion: 1,
		});
		writeWriterState(SID, {
			phaseKey: "spec@1",
			account: "fake-claude",
			kteamSessionId: "kt-1",
			cwd: "/tmp",
			status: "running",
			turns: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		// Writer's output is on disk (reply.json = the marker).
		const specDir = join(sessionDir(SID), "epoch", "1", "spec");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(
			join(specDir, "v1.md"),
			"# Spec: enough real content to clear the blank-artifact check.",
		);
		writeFileSync(join(specDir, "v1.html"), "<html/>");
		writeTurnReply(SID, "spec@1", 1, {
			summary: "Done while you were away.",
			artifact: { kind: "spec", version: 1, revised: true },
		});

		const kteam = fakeKteam(async () => "done");
		const result = await runRelay(SID, CONFIG, { harness: kteam as never });
		expect(result.ok).toBe(true);
		expect(result.turn).toBe(1);
		expect(kteam.calls.length).toBe(0); // adopted, not re-sent
		expect(alreadyPresented(SID, artifactScope("spec", 1, null), 1)).toBe(true);
	});

	test("invalid reply → corrective retry via send (addendum); failure after retries", async () => {
		let attempt = 0;
		const kteam = fakeKteam(async () => {
			attempt++;
			// Always writes an INVALID reply (missing artifact fields).
			writeTurnReply(SID, "spec@1", 1, { summary: "bad" });
			return "done";
		});
		const result = await runRelay(SID, CONFIG, {
			message: "",
			harness: kteam as never,
		});
		expect(result.ok).toBe(false);
		expect(attempt).toBe(2); // 1 + maxTurnRetries(1)
		// Attempt 1 started (no id); attempt 2 sent the corrective addendum.
		expect(kteam.calls[0].kteamSessionId).toBeUndefined();
		expect(kteam.calls[1].kteamSessionId).toBe("kt-1");
		expect(kteam.calls[1].messageFile).toContain("addendum");
		expect(result.remediation?.length).toBeGreaterThan(0);
		const events = readLog(SID).map((e) => e.event);
		expect(events).toContain("relay:invalid");
		expect(events).toContain("relay:failed");
	});

	test("timeout/needs-attention → nudge + retry via send, then fails with remediation", async () => {
		let attempt = 0;
		const kteam = fakeKteam(async () => {
			attempt++;
			return attempt === 1 ? "timeout" : "needs_attention";
		});
		const result = await runRelay(SID, CONFIG, {
			message: "",
			harness: kteam as never,
		});
		expect(result.ok).toBe(false);
		expect(attempt).toBe(2); // 1 + maxTurnRetries(1)
		expect(kteam.calls[1].messageFile).toContain("addendum");
		expect(result.remediation?.length).toBeGreaterThan(0);
		// Failure snapshot is persisted (points at meta.json).
		expect(result.snapshotPath).toBeDefined();
		expect(readLog(SID).map((e) => e.event)).toContain("relay:failed");
	});

	test("approval turn skips version prep (no phantom trailing version)", async () => {
		await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(writerProducesValidReply(1)) as never,
		});
		const result = await runRelay(SID, CONFIG, {
			message: "approve",
			approval: true,
			harness: fakeKteam(writerProducesValidReply(2, false)) as never,
		});
		expect(result.ok).toBe(true);
		// No v2 was minted by the approval turn.
		const { latestRevisionOnDisk } =
			require("../../revisions") as typeof import("../../revisions");
		expect(latestRevisionOnDisk(SID, "spec", { epoch: 1 })).toBe(1);
	});

	test("fallback-inline flips writerMode and records the WAL event", async () => {
		const result = await runRelay(SID, CONFIG, { fallbackInline: true });
		expect(result.ok).toBe(true);
		const { readSessionMeta } =
			require("../../session-meta") as typeof import("../../session-meta");
		expect(readSessionMeta(SID)?.writerMode).toBe("inline");
		expect(readLog(SID).map((e) => e.event)).toContain("relay:fallback_inline");
	});

	test("discussion surfaces accepted envelopes only", async () => {
		await runRelay(SID, CONFIG, {
			message: "",
			harness: fakeKteam(writerProducesValidReply(1)) as never,
		});
		const d = readDiscussion(SID, "spec@1");
		expect(d.turns.length).toBe(1);
		expect(d.turns[0].state).toBe("replied");
		expect((d.turns[0].envelope as { summary: string }).summary).toBe(
			"Drafted the spec.",
		);
	});
});
