import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origHome = process.env.HOME;

describe("lock", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kautopilot-test-"));
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		process.env.HOME = origHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("checkLock returns unlocked when no lock file", () => {
		const { checkLock } = require("../lock") as typeof import("../lock");
		const info = checkLock("nonexistent");
		expect(info.locked).toBe(false);
		expect(info.pid).toBe(0);
		expect(info.alive).toBe(false);
	});

	it("acquireLock creates lock file with current PID", () => {
		const { acquireLock, checkLock, releaseLock } =
			require("../lock") as typeof import("../lock");
		acquireLock("testlock");

		const info = checkLock("testlock");
		expect(info.locked).toBe(true);
		expect(info.pid).toBe(process.pid);
		expect(info.alive).toBe(true);

		releaseLock("testlock");
	});

	it("releaseLock removes lock file", () => {
		const { acquireLock, releaseLock } =
			require("../lock") as typeof import("../lock");
		acquireLock("testlock");

		expect(existsSync(join(tempDir, ".kautopilot/testlock/lock.pid"))).toBe(
			true,
		);

		releaseLock("testlock");
		expect(existsSync(join(tempDir, ".kautopilot/testlock/lock.pid"))).toBe(
			false,
		);
	});

	it("stale lock is auto-cleaned", () => {
		const { writeFileSync } = require("node:fs");
		const lockDir = join(tempDir, ".kautopilot/testlock");
		const { mkdirSync } = require("node:fs");
		const { dirname } = require("node:path");
		mkdirSync(dirname(join(lockDir, "lock.pid")), { recursive: true });

		// Write a PID that definitely doesn't exist
		writeFileSync(join(lockDir, "lock.pid"), "99999999");

		const { checkLock } = require("../lock") as typeof import("../lock");
		const info = checkLock("testlock");

		expect(info.locked).toBe(false);
		expect(info.pid).toBe(99999999);
		expect(info.alive).toBe(false);
		// Stale lock file should be cleaned up
		expect(existsSync(join(lockDir, "lock.pid"))).toBe(false);
	});

	it("listLockKeys returns the session key plus every repo scope key", () => {
		const { acquireLock, listLockKeys, scopeLockKey, releaseLock } =
			require("../lock") as typeof import("../lock");

		// No lock files yet → empty.
		expect(listLockKeys("sess").sort()).toEqual([]);

		// Session timeline lock only.
		acquireLock("sess");
		expect(listLockKeys("sess")).toEqual(["sess"]);

		// Add two repo-scoped locks.
		acquireLock(scopeLockKey("sess", "api"));
		acquireLock(scopeLockKey("sess", "infra"));
		expect(listLockKeys("sess").sort()).toEqual([
			"sess",
			"sess:api",
			"sess:infra",
		]);

		// Releasing the session lock leaves the repo scopes discoverable.
		releaseLock("sess");
		expect(listLockKeys("sess").sort()).toEqual(["sess:api", "sess:infra"]);

		releaseLock(scopeLockKey("sess", "api"));
		releaseLock(scopeLockKey("sess", "infra"));
	});

	it("acquireLock throws when session already locked", () => {
		const { acquireLock, releaseLock } =
			require("../lock") as typeof import("../lock");
		acquireLock("testlock");

		// Should throw because we already hold the lock
		// (same PID, so it will succeed since it's the same process)
		// Actually, since it's the same process, the check will see PID as alive
		// and throw "already running"
		try {
			acquireLock("testlock");
			// If we got here, it succeeded (which shouldn't happen for same PID since PID is alive)
			releaseLock("testlock");
			expect(true).toBe(false); // Should not reach here
		} catch (err) {
			expect((err as Error).message).toContain("already running");
			releaseLock("testlock");
		}
	});
});
