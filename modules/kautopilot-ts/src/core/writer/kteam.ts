import { existsSync } from "node:fs";

// ============================================================================
// Writer-session harness — kteamd edition. Replaces the old tmux driver
// (WriterTmux): kautopilot no longer owns the TUI, send-keys, pane readiness,
// sentinel files, or fatal-signature scanning. kteamd owns the session
// lifecycle (auth/quota preflight, startup dialogs, prompt landing, stall +
// login-wall fail-fast, auto-revive, account failover). One PERSISTENT kteam
// session per writer phase: turn 1 is `kteam start`, later turns are
// `kteam send` (context persists; a finished session auto-revives on send —
// the spec's rebootstrap machinery collapses into this). Turn completion is the
// envelope file itself, gated by `kteam wait --until-marker <reply.json>`.
// (specs/deferred-writer-relay.md §4-5; mirrors kloop-ts src/agents/runner.ts +
//  src/kteam.ts.)
// ============================================================================

/** Result of shelling out to the `kteam` CLI. */
export interface KteamExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable `kteam` runner (default spawns the real binary). Tests pass a fake. */
export type KteamExec = (
	args: string[],
	timeoutMs: number,
) => Promise<KteamExecResult>;

/**
 * Thrown when kteamd itself is unreachable (daemon down / token missing). The
 * relay maps this to a LOUD, non-corrupting failure (`kteam daemon start` hint)
 * — the turn stays re-attachable, never marked failed. (Same contract as
 * kloop's DaemonUnavailableError.)
 */
export class DaemonUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonUnavailableError";
	}
}

/** kteam terminal session statuses (mirror of kteam-ts `terminal` + kill_failed). */
const KTEAM_TERMINAL = new Set([
	"completed",
	"failed",
	"stalled",
	"stopped",
	"kill_failed",
]);

/** True when a failed `kteam` invocation was caused by the daemon being unreachable. */
function isDaemonUnavailable(r: KteamExecResult): boolean {
	const text = `${r.stderr}\n${r.stdout}`;
	return /daemon is unavailable|daemon token is missing|ECONNREFUSED|fetch failed|connect(ion)? refused/i.test(
		text,
	);
}

/** Default `kteam` executor: spawn the CLI with a hard timeout, capture output.
 *  CLAUDECODE leaks the parent Claude session into the child harness; strip it. */
const defaultKteamExec: KteamExec = async (args, timeoutMs) => {
	const { CLAUDECODE: _drop, ...env } = process.env;
	const proc = Bun.spawn(["kteam", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const killer = setTimeout(() => proc.kill(), timeoutMs);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(killer);
	return { exitCode, stdout, stderr };
};

/** Ownership label for a kautopilot session's writer kteam sessions — the
 *  filter both cleanup (`kteam ps --label`) and the watch hint use. Distinct
 *  from kloop's `kloop-<runId>` labels. */
export function writerLabel(sessionId: string): string {
	return `kauto-${sessionId}`;
}

/** `--name` for a writer session (shown in `kteam ps`). */
export function writerSessionName(kind: string): string {
	return `writer-${kind}`;
}

/** One writer turn's outcome (marker/status → a small, testable enum). */
export interface KteamTurnResult {
	/** done = reply.json (the envelope marker) appeared; needs_attention = the
	 *  session handed control back (awaiting/waiting) without the marker; failed =
	 *  a terminal kteam status with no marker; timeout = our per-turn deadline
	 *  elapsed while still working. */
	outcome: "done" | "needs_attention" | "failed" | "timeout";
	/** The kteam session id — created by `start` on turn 1, echoed back so the
	 *  relay can `send` to it on every later turn/attempt. */
	kteamSessionId: string;
	/** Last kteam `state.status` seen (diagnostic). */
	status?: string;
	/** kteam snapshot captured on a non-done outcome (the diagnostic that
	 *  replaces the old tmux pane snapshot). */
	snapshot?: string;
	durationMs: number;
}

export class WriterKteam {
	private exec: KteamExec;
	constructor(exec: KteamExec = defaultKteamExec) {
		this.exec = exec;
	}

	/** Run a `kteam` command; throw DaemonUnavailableError if the daemon is down. */
	private async kteam(
		args: string[],
		timeoutMs: number,
	): Promise<KteamExecResult> {
		const result = await this.exec(args, timeoutMs);
		if (result.exitCode !== 0 && isDaemonUnavailable(result)) {
			throw new DaemonUnavailableError(
				`kteam daemon is unreachable (${(result.stderr || result.stdout).trim().slice(0, 200)}); start it with: kteam daemon start`,
			);
		}
		return result;
	}

	/** True when the kteamd HTTP API is reachable (probe via `kteam ps --json`,
	 *  not `kteam daemon status` — the latter reports the systemd unit, which can
	 *  read "stopped" while the daemon is up and serving). */
	async daemonReachable(): Promise<boolean> {
		try {
			const r = await this.exec(["ps", "--json"], 30_000);
			return r.exitCode === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Run one writer turn end-to-end. No `kteamSessionId` ⇒ `kteam start` (turn
	 * 1); otherwise `kteam send` (later turns, corrective retries, re-attach — a
	 * finished session auto-revives). Then poll `kteam wait --until-marker` in
	 * ≤60s slices, heartbeating the caller's lock between slices, until the
	 * envelope marker appears / a terminal status / our per-turn deadline.
	 *
	 * The caller MUST rotate (delete) the marker before calling — a stale
	 * reply.json from a prior attempt would otherwise read as this attempt's
	 * completion (the marker-hygiene hazard the old sentinel had).
	 *
	 * `onSessionCreated` fires the instant a NEW session id is minted by
	 * `kteam start` (turn 1), BEFORE the first `wait`. The relay persists the id
	 * synchronously there so a daemon hiccup during the wait can never orphan the
	 * live session — the next relay re-attaches to it instead of starting a rival.
	 */
	async runTurn(params: {
		kteamSessionId?: string;
		account: string;
		name: string;
		label: string;
		cwd: string;
		messageFile: string;
		markerFile: string;
		timeoutMins: number;
		onSessionCreated?: (kteamSessionId: string) => void;
		onTick?: () => void;
	}): Promise<KteamTurnResult> {
		const start = Date.now();
		const {
			kteamSessionId,
			account,
			name,
			label,
			cwd,
			messageFile,
			markerFile,
			timeoutMins,
			onSessionCreated,
			onTick,
		} = params;

		// --- start (turn 1) or send (everything else) ---------------------------
		let id: string;
		if (!kteamSessionId) {
			const started = await this.kteam(
				[
					"start",
					"--json",
					"-a",
					account,
					"--mode",
					"auto",
					"--name",
					name.slice(0, 48),
					"--label",
					label,
					"--cwd",
					cwd,
					"--prompt-file",
					messageFile,
				],
				180_000,
			);
			if (started.exitCode !== 0) {
				throw new Error(
					`kteam start failed for ${account}: ${(started.stderr || started.stdout).trim().slice(0, 300)}`,
				);
			}
			try {
				const view = JSON.parse(started.stdout) as {
					config?: { id?: string };
				};
				if (!view.config?.id) throw new Error("missing config.id");
				id = view.config.id;
			} catch (error) {
				throw new Error(
					`kteam start returned unexpected JSON for ${account} (${String(error)}): ${started.stdout.trim().slice(0, 300)}`,
				);
			}
			// Persist the id BEFORE the first wait — a daemon hiccup during the wait
			// must never orphan this just-created session (re-attach depends on it).
			onSessionCreated?.(id);
		} else {
			id = kteamSessionId;
			const sent = await this.kteam(
				["send", id, "--message-file", messageFile],
				120_000,
			);
			if (sent.exitCode !== 0) {
				throw new Error(
					`kteam send failed for ${id}: ${(sent.stderr || sent.stdout).trim().slice(0, 300)}`,
				);
			}
		}

		// --- poll the deliverable gate ------------------------------------------
		const deadlineMs = start + timeoutMins * 60 * 1000;
		let status: string | undefined;
		while (true) {
			onTick?.();
			// `wait --until-marker` returns the moment the marker exists; otherwise it
			// blocks up to its own 60s slice. Exit 1 = a terminal status with no
			// marker; exit 0 without a marker = the session handed control back
			// (awaiting/waiting); exit 124 = the slice elapsed while still working.
			const waited = await this.kteam(
				["wait", id, "--json", "--timeout", "60", "--until-marker", markerFile],
				90_000,
			);
			status = this.parseStatus(waited.stdout) ?? status;

			// The deliverable is ground truth — check disk first, regardless of the
			// exit code (a marker that landed just as `wait` returned still counts).
			if (existsSync(markerFile)) {
				return {
					outcome: "done",
					kteamSessionId: id,
					status,
					durationMs: Date.now() - start,
				};
			}
			if (waited.exitCode === 1) {
				return {
					outcome: "failed",
					kteamSessionId: id,
					status,
					snapshot: await this.snapshot(id),
					durationMs: Date.now() - start,
				};
			}
			if (waited.exitCode === 0) {
				// Returned without the marker ⇒ waiting/awaiting_user/awaiting_question:
				// the session can't produce the envelope on its own (needs the lead).
				return {
					outcome: "needs_attention",
					kteamSessionId: id,
					status,
					snapshot: await this.snapshot(id),
					durationMs: Date.now() - start,
				};
			}
			// exit 124 (wait's own slice elapsed while still running) — keep polling
			// until OUR per-turn deadline.
			if (Date.now() >= deadlineMs) {
				return {
					outcome: "timeout",
					kteamSessionId: id,
					status,
					snapshot: await this.snapshot(id),
					durationMs: Date.now() - start,
				};
			}
		}
	}

	/** `kteam wait --json` prints the SessionState as one line; pull `.status`. */
	private parseStatus(stdout: string): string | undefined {
		try {
			return (JSON.parse(stdout.trim() || "{}") as { status?: string }).status;
		} catch {
			return undefined;
		}
	}

	/** Best-effort `kteam snapshot` (the failure diagnostic; "" on any error). */
	async snapshot(id: string): Promise<string> {
		try {
			const r = await this.exec(["snapshot", id], 30_000);
			return r.exitCode === 0 ? r.stdout : "";
		} catch {
			return "";
		}
	}

	/** Stop `id` (used on kautopilot stop/delete). */
	async stop(id: string, reason: string): Promise<void> {
		try {
			await this.exec(["stop", id, "--reason", reason], 30_000);
		} catch {
			// Daemon down / already gone — nothing to stop.
		}
	}

	/** Stop every live (non-terminal) writer session for a kautopilot session,
	 *  found by its ownership label. Returns the count stopped. */
	async stopByLabel(label: string): Promise<number> {
		try {
			const r = await this.exec(
				["ps", "--all", "--label", label, "--json"],
				30_000,
			);
			if (r.exitCode !== 0) return 0;
			const views = JSON.parse(r.stdout.trim() || "[]") as Array<{
				config?: { id?: string };
				state?: { status?: string };
			}>;
			let stopped = 0;
			for (const view of views) {
				const id = view.config?.id;
				const st = view.state?.status;
				if (id && !(st && KTEAM_TERMINAL.has(st))) {
					await this.stop(id, "kautopilot session stopped");
					stopped++;
				}
			}
			return stopped;
		} catch {
			return 0;
		}
	}
}
