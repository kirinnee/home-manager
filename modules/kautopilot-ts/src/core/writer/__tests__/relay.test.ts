import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../../artifacts";
import {
	alreadyPresented,
	artifactScope,
	markPresented,
	mintOrReuseWorkingVersion,
} from "../../driver";
import { readLog } from "../../log";
import { writeSessionMeta } from "../../session-meta";
import { DEFAULT_CONFIG } from "../../types";
import { readDiscussion, runRelay } from "../relay";
import {
	hashMessage,
	turnPaths,
	writeTurnMeta,
	writeTurnReply,
	writeWriterState,
} from "../scratch";

// ============================================================================
// Relay engine tests with a FAKE tmux (no real tmux server, no real claude).
// The fake simulates the writer by materializing the reply/sentinel per a
// scripted behavior when runTurn is called.
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

type FakeOutcome =
	| "done"
	| "died"
	| "timeout"
	| { outcome: "fatal"; fatalKind: string; delivered?: boolean };

/** A fake WriterTmux whose runTurn executes a scripted behavior. */
function fakeTmux(
	behavior: (params: {
		sentinelFile: string;
		messageFile: string;
		resume: boolean;
		harnessSessionId: string;
		binary: string;
	}) => Promise<FakeOutcome>,
) {
	const calls: Array<{
		resume: boolean;
		messageFile: string;
		harnessSessionId: string;
		binary: string;
	}> = [];
	return {
		calls,
		isSessionAlive: async () => false,
		killSession: async () => {},
		gracefulClose: async () => {},
		killSessionsWithPrefix: async () => 0,
		runTurn: async (params: {
			sessionName: string;
			binary: string;
			harnessSessionId: string;
			resume: boolean;
			cwd: string;
			messageFile: string;
			sentinelFile: string;
			timeoutMins: number;
		}) => {
			calls.push({
				resume: params.resume,
				messageFile: params.messageFile,
				harnessSessionId: params.harnessSessionId,
				binary: params.binary,
			});
			const res = await behavior(params);
			if (typeof res === "object") {
				return {
					outcome: "fatal" as const,
					fatalKind: res.fatalKind,
					pane: "fake fatal pane",
					delivered: res.delivered ?? false,
					durationMs: 1,
				};
			}
			return {
				outcome: res,
				pane: res === "done" ? "" : "fake pane",
				delivered: res !== "died",
				durationMs: 1,
			};
		},
	};
}

/** Writer-side simulation: write a valid spec revision + visual + reply.
 *  `version` = the working version the relay handed out for this turn. */
function writerProducesValidReply(turn: number, revised = true, version = 1) {
	const specDir = join(sessionDir(SID), "epoch", "1", "spec");
	return async (params: { sentinelFile: string }) => {
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
		writeFileSync(params.sentinelFile, "");
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
			tmux: fakeTmux(async () => "done") as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not deferred");
	});

	test("turn 1: pins the account, launches with --session-id (resume=false), accepts a valid revised reply, marks presented, enriches links", async () => {
		const tmux = fakeTmux(writerProducesValidReply(1));
		const result = await runRelay(SID, CONFIG, {
			message: "",
			tmux: tmux as never,
		});
		expect(result.ok).toBe(true);
		expect(tmux.calls[0].resume).toBe(false);
		expect(result.envelope?.links.read).toContain(`/sessions/${SID}/spec/v1`);
		expect(result.envelope?.links.diff).toBeNull(); // v1 has no diff
		expect(result.envelope?.account).toBe("fake-claude");
		expect(alreadyPresented(SID, artifactScope("spec", 1, null), 1)).toBe(true);
		// WAL: relay events present and non-cursor (pendingStep still write_spec).
		const events = readLog(SID).map((e) => e.event);
		expect(events).toContain("relay:sent");
		expect(events).toContain("relay:reply");
		const { pendingStep } =
			require("../../driver") as typeof import("../../driver");
		expect(pendingStep(SID)).toBe("write_spec");
	});

	test("idempotent re-invoke: same/no message returns the accepted reply without spawning", async () => {
		const tmux1 = fakeTmux(writerProducesValidReply(1));
		await runRelay(SID, CONFIG, { message: "", tmux: tmux1 as never });
		const tmux2 = fakeTmux(async () => "done");
		const again = await runRelay(SID, CONFIG, { tmux: tmux2 as never });
		expect(again.ok).toBe(true);
		expect(again.turn).toBe(1);
		expect(tmux2.calls.length).toBe(0); // no respawn
	});

	test("idempotent re-invoke with the SAME user message never composes a duplicate turn", async () => {
		// Turn 1 (kickoff), then turn 2 with a real message.
		await runRelay(SID, CONFIG, {
			message: "",
			tmux: fakeTmux(writerProducesValidReply(1)) as never,
		});
		await runRelay(SID, CONFIG, {
			message: "my answer",
			tmux: fakeTmux(writerProducesValidReply(2, false, 2)) as never,
		});
		// Skill crashed before recording — re-sends the identical message.
		const tmux = fakeTmux(async () => "done");
		const again = await runRelay(SID, CONFIG, {
			message: "my answer",
			tmux: tmux as never,
		});
		expect(again.ok).toBe(true);
		expect(again.turn).toBe(2); // returned, not re-composed as turn 3
		expect(tmux.calls.length).toBe(0);
		// A DIFFERENT message does compose turn 3.
		const next = await runRelay(SID, CONFIG, {
			message: "a new different answer",
			tmux: fakeTmux(writerProducesValidReply(3, false, 2)) as never,
		});
		expect(next.ok).toBe(true);
		expect(next.turn).toBe(3);
	});

	test("re-attach preserves the crashed turn's approval-ness (no phantom mint)", async () => {
		// Presented v1.
		await runRelay(SID, CONFIG, {
			message: "",
			tmux: fakeTmux(writerProducesValidReply(1)) as never,
		});
		// Approval turn 2 crashes mid-wait (simulate: meta stays unaccepted).
		const dying = fakeTmux(async () => "died");
		const crashed = await runRelay(SID, CONFIG, {
			message: "the user approved",
			approval: true,
			tmux: dying as never,
		});
		expect(crashed.ok).toBe(false);
		// Recovery per relay.md: re-run with NO flags. Must still be an approval
		// turn (workingVersion pinned to presented v1, no v2 minted).
		const result = await runRelay(SID, CONFIG, {
			tmux: fakeTmux(writerProducesValidReply(2, false, 1)) as never,
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
			tmux: fakeTmux(writerProducesValidReply(1)) as never,
		});
		// Turn 2: pure Q&A (working version is the freshly-minted, unpresented v2).
		const result = await runRelay(SID, CONFIG, {
			message: "answering your question: A",
			tmux: fakeTmux(writerProducesValidReply(2, false, 2)) as never,
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
			harnessSessionId: "uuid",
			cwd: "/tmp",
			status: "running",
			turns: 0,
			started: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		const result = await runRelay(SID, CONFIG, {
			message: "a different new message",
			tmux: fakeTmux(async () => "done") as never,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("in flight");
	});

	test("adoption: finished-on-disk turn is accepted without respawning", async () => {
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
			harnessSessionId: "uuid",
			cwd: "/tmp",
			status: "running",
			turns: 0,
			started: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		// Writer's output is on disk.
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
		writeFileSync(paths.sentinel, "");

		const tmux = fakeTmux(async () => "done");
		const result = await runRelay(SID, CONFIG, { tmux: tmux as never });
		expect(result.ok).toBe(true);
		expect(result.turn).toBe(1);
		expect(tmux.calls.length).toBe(0); // adopted, not respawned
		expect(alreadyPresented(SID, artifactScope("spec", 1, null), 1)).toBe(true);
	});

	test("invalid reply → corrective retry with an addendum; failure after retries", async () => {
		let attempt = 0;
		const tmux = fakeTmux(async (params) => {
			attempt++;
			// Always writes an INVALID reply (missing artifact fields).
			writeTurnReply(SID, "spec@1", 1, { summary: "bad" });
			writeFileSync(params.sentinelFile, "");
			return "done";
		});
		const result = await runRelay(SID, CONFIG, {
			message: "",
			tmux: tmux as never,
		});
		expect(result.ok).toBe(false);
		expect(attempt).toBe(2); // 1 + maxTurnRetries(1)
		// Second attempt got the corrective addendum, not the original message.
		expect(tmux.calls[1].messageFile).toContain("addendum");
		expect(result.remediation?.length).toBeGreaterThan(0);
		const events = readLog(SID).map((e) => e.event);
		expect(events).toContain("relay:invalid");
		expect(events).toContain("relay:failed");
	});

	test("approval turn skips version prep (no phantom trailing version)", async () => {
		await runRelay(SID, CONFIG, {
			message: "",
			tmux: fakeTmux(writerProducesValidReply(1)) as never,
		});
		const result = await runRelay(SID, CONFIG, {
			message: "approve",
			approval: true,
			tmux: fakeTmux(writerProducesValidReply(2, false)) as never,
		});
		expect(result.ok).toBe(true);
		// No v2 was minted by the approval turn.
		const { latestRevisionOnDisk } =
			require("../../revisions") as typeof import("../../revisions");
		expect(latestRevisionOnDisk(SID, "spec", { epoch: 1 })).toBe(1);
	});

	test("session_exists on --session-id flips to --resume and retries", async () => {
		let call = 0;
		const specDir = join(sessionDir(SID), "epoch", "1", "spec");
		const tmux = fakeTmux(async (params) => {
			call++;
			if (call === 1) {
				// First attempt (resume=false): conversation already exists.
				expect(params.resume).toBe(false);
				return { outcome: "fatal", fatalKind: "session_exists" };
			}
			// Second attempt must resume the SAME uuid.
			expect(params.resume).toBe(true);
			mkdirSync(specDir, { recursive: true });
			writeFileSync(
				join(specDir, "v1.md"),
				"# Spec: enough real content to clear the blank-artifact check.",
			);
			writeFileSync(join(specDir, "v1.html"), "<html/>");
			writeTurnReply(SID, "spec@1", 1, {
				summary: "Recovered.",
				artifact: { kind: "spec", version: 1, revised: true },
			});
			writeFileSync(params.sentinelFile, "");
			return "done";
		});
		const result = await runRelay(SID, CONFIG, {
			message: "",
			tmux: tmux as never,
		});
		expect(result.ok).toBe(true);
		expect(tmux.calls.length).toBe(2);
		expect(tmux.calls[0].harnessSessionId).toBe(tmux.calls[1].harnessSessionId);
	});

	test("resume_lost rebootstraps: new uuid, full-contract message, pinned working version", async () => {
		// Turn 1 presented v1.
		await runRelay(SID, CONFIG, {
			message: "",
			tmux: fakeTmux(writerProducesValidReply(1)) as never,
		});
		const specDir = join(sessionDir(SID), "epoch", "1", "spec");
		let call = 0;
		const uuids: string[] = [];
		const tmux = fakeTmux(async (params) => {
			call++;
			uuids.push(params.harnessSessionId);
			if (call === 1) {
				// writer.started=true → first resume_lost is retried once…
				return { outcome: "fatal", fatalKind: "resume_lost", delivered: false };
			}
			if (call === 2) {
				// …second consecutive loss triggers the rebootstrap.
				return { outcome: "fatal", fatalKind: "resume_lost", delivered: false };
			}
			// Post-rebootstrap attempt: fresh uuid, working version still v2.
			const message = readFileSync(params.messageFile, "utf-8");
			expect(message).toContain("REBOOTSTRAP");
			expect(message).toContain("Reply contract");
			writeFileSync(
				join(specDir, "v2.md"),
				"# Spec v2: enough real content to clear the blank-artifact check.",
			);
			writeFileSync(join(specDir, "v2.html"), "<html/>");
			writeTurnReply(SID, "spec@1", 2, {
				summary: "Continued after rebootstrap.",
				artifact: { kind: "spec", version: 2, revised: true },
			});
			writeFileSync(params.sentinelFile, "");
			return "done";
		});
		const result = await runRelay(
			SID,
			{
				...CONFIG,
				writer: { ...CONFIG.writer, maxTurnRetries: 3 },
			},
			{
				message: "please revise per my feedback",
				tmux: tmux as never,
			},
		);
		expect(result.ok).toBe(true);
		expect(uuids[2]).not.toBe(uuids[0]); // rebootstrap minted a new uuid
		expect(readLog(SID).map((e) => e.event)).toContain("relay:rebootstrap");
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
			tmux: fakeTmux(writerProducesValidReply(1)) as never,
		});
		const d = readDiscussion(SID, "spec@1");
		expect(d.turns.length).toBe(1);
		expect(d.turns[0].state).toBe("replied");
		expect((d.turns[0].envelope as { summary: string }).summary).toBe(
			"Drafted the spec.",
		);
	});
});
