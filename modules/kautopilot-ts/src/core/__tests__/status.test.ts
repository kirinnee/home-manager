import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME!;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-status-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

import { appendEvent } from "../log";
import { ensureStatus, isSessionActive, isSessionTerminal } from "../status";

const TEST_SESSION = `test-status-${Date.now()}`;
function sessionDir() {
	return join(process.env.HOME!, ".kautopilot", TEST_SESSION);
}

beforeEach(() => {
	mkdirSync(sessionDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(sessionDir())) {
		rmSync(sessionDir(), { recursive: true });
	}
});

describe("ensureStatus", () => {
	it("returns initial status for empty log", () => {
		const status = ensureStatus(TEST_SESSION);
		expect(status.phase).toBe("none");
		expect(status.state).toBe("none");
		expect(status.running).toBe(false);
		expect(status.walCursor).toBe(0);
		expect(status.completedSteps).toEqual([]);
		expect(status.lastCheckpoint).toBeNull();
	});

	it("tracks phase and state from events", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "start:started",
			metadata: { phase: "plan" },
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:01Z",
			event: "phase1:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:02Z",
			event: "pull_ticket:started",
			version: 1,
		});

		const status = ensureStatus(TEST_SESSION);
		expect(status.phase).toBe("plan");
		expect(status.version).toBe(1);
		expect(status.state).toBe("pull_ticket");
		expect(status.stateStatus).toBe("running");
		expect(status.running).toBe(true);
	});

	it("marks completed steps and checkpoints", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "start:started",
			metadata: { phase: "plan" },
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:01Z",
			event: "phase1:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:02Z",
			event: "pull_ticket:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:03Z",
			event: "pull_ticket:completed",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:04Z",
			event: "write_spec:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:05Z",
			event: "write_spec:completed",
			version: 1,
		});

		const status = ensureStatus(TEST_SESSION);
		expect(status.completedSteps).toEqual(["pull_ticket", "write_spec"]);
		expect(status.lastCheckpoint).toBe("write_spec");
		expect(status.stateStatus).toBe("completed");
	});

	it("handles context:updated events", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "phase1:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:01Z",
			event: "context:updated",
			metadata: { maxPlans: 3 },
		});

		const status = ensureStatus(TEST_SESSION);
		expect(status.context.maxPlans).toBe(3);
	});

	it("treats feedback_check done as the terminal session cursor", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "feedback_check:completed",
			version: 1,
			metadata: { step: "feedback_check", to: "done" },
		});

		expect(isSessionTerminal(TEST_SESSION)).toBe(true);
		expect(isSessionActive(TEST_SESSION)).toBe(false);
	});

	it("keeps feedback_check feedback choice active", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "feedback_check:completed",
			version: 1,
			metadata: { step: "feedback_check", to: "feedback" },
		});

		expect(isSessionTerminal(TEST_SESSION)).toBe(false);
		expect(isSessionActive(TEST_SESSION)).toBe(true);
	});

	it("incremental replay — only processes new events", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "phase1:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:01Z",
			event: "pull_ticket:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:02Z",
			event: "pull_ticket:completed",
			version: 1,
		});

		const status1 = ensureStatus(TEST_SESSION);
		expect(status1.walCursor).toBe(3);
		expect(status1.completedSteps).toEqual(["pull_ticket"]);

		// Add more events
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:03Z",
			event: "write_spec:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:04Z",
			event: "write_spec:completed",
			version: 1,
		});

		const status2 = ensureStatus(TEST_SESSION);
		expect(status2.walCursor).toBe(5);
		expect(status2.completedSteps).toEqual(["pull_ticket", "write_spec"]);
	});

	it("persists status to YAML file", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "phase1:started",
			version: 1,
		});
		ensureStatus(TEST_SESSION);

		const yamlPath = join(sessionDir(), "status.yaml");
		expect(existsSync(yamlPath)).toBe(true);

		const content = readFileSync(yamlPath, "utf-8");
		expect(content).toContain("phase: plan");
		expect(content).toContain("walCursor: 1");
	});

	it("tracks per-plan cycle", () => {
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:00Z",
			event: "phase2:started",
			version: 1,
		});
		// Plan 0
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:01Z",
			event: "clear_loop:started",
			metadata: { planIndex: 0 },
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:02Z",
			event: "clear_loop:completed",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:03Z",
			event: "setup_run:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:04Z",
			event: "setup_run:completed",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:05Z",
			event: "running:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:06Z",
			event: "running:completed",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:07Z",
			event: "commit:started",
			version: 1,
		});
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:08Z",
			event: "commit:completed",
			version: 1,
		});
		// Plan 1
		appendEvent(TEST_SESSION, {
			ts: "2026-03-24T10:00:09Z",
			event: "clear_loop:started",
			metadata: { planIndex: 1 },
		});

		const status = ensureStatus(TEST_SESSION);
		expect(status.context.planIndex).toBe(1);
		expect(status.completedSteps).toEqual([]); // reset for plan 1
	});
});
