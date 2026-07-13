import { existsSync } from "node:fs";

// ============================================================================
// Writer-session tmux runner — a trimmed port of kloop's interactive mechanics
// (kloop-ts src/tmux/service.ts): launch the claude TUI detached, wait for the
// input prompt, inject a one-line bootstrap pointing at the message file, poll
// for the sentinel, then /exit + kill (try/finally backstop). Differences from
// kloop: a NEW `--resume` launch path (turn ≥2 — the pane replays the prior
// transcript, so readiness keys on the input-prompt glyph, and inject probing
// tolerates replayed text), a fatal-signature pane scan that fails fast instead
// of burning the whole timeout, and no transcript copying (the record is the
// envelope; the pane snapshot is the failure diagnostic).
// (specs/deferred-writer-relay.md §4-5)
// ============================================================================

export type SpawnFn = typeof Bun.spawn;

export type FatalKind =
	| "rate_limit"
	| "auth"
	| "resume_lost"
	| "session_exists";

export interface TurnRunResult {
	/** done = sentinel appeared; died = TUI exited without it; timeout = wait cap;
	 *  fatal = a fatal pane signature matched (fail fast). */
	outcome: "done" | "died" | "timeout" | "fatal";
	fatalKind?: FatalKind;
	/** Full pane scrollback at the end (diagnostic; persisted by the caller). */
	pane: string;
	/** Whether the bootstrap line was actually delivered — once true, the harness
	 *  conversation exists and later attempts must `--resume`, never re-pin. */
	delivered: boolean;
	durationMs: number;
}

const POLL_MS = 2000;
const READY_CAP_MS = 45_000;

/** Fatal pane signatures → fail the attempt immediately (don't burn the
 *  timeout). resume_lost triggers the rebootstrap path; session_exists means
 *  the conversation ALREADY exists for our uuid (a `--session-id` launch after
 *  a mid-turn-1 controller kill) — the caller flips to `--resume` and retries. */
const FATAL_SIGNATURES: Array<{ kind: FatalKind; pattern: RegExp }> = [
	{
		kind: "rate_limit",
		pattern:
			/rate.?limit (reached|exceeded)|usage limit reached|out of extra usage/i,
	},
	{
		kind: "auth",
		pattern: /invalid api key|please run \/login|authentication[_ ]error/i,
	},
	{
		kind: "resume_lost",
		pattern: /no conversation found (with|to resume)|could not resume session/i,
	},
	{
		// Real CLI shape: `Error: Session ID <uuid> is already in use.` — the uuid
		// sits BETWEEN "ID" and "is", so allow up to ~60 chars there.
		kind: "session_exists",
		pattern: /session id.{0,60}already in use|already exists.*session/i,
	},
];

/**
 * Classify a pane as fatal, or null. To avoid matching the WRITER'S OWN PROSE
 * (a spec about rate limiting would otherwise abort a healthy turn), only the
 * pane's LAST 15 lines are considered — CLI error banners land at the bottom;
 * artifact text scrolls. Callers additionally gate on pane stability (a working
 * writer's pane keeps changing; an error banner sits still).
 * @public Exported for unit tests.
 */
export function classifyFatal(pane: string): FatalKind | null {
	const tail = pane.trimEnd().split("\n").slice(-15).join("\n");
	for (const { kind, pattern } of FATAL_SIGNATURES) {
		if (pattern.test(tail)) return kind;
	}
	return null;
}

export class WriterTmux {
	constructor(private spawn: SpawnFn = Bun.spawn.bind(Bun)) {}

	// --- tmux primitives (kloop parity) ---------------------------------------

	private async run(cmd: string[]): Promise<number> {
		const proc = this.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
		return await proc.exited;
	}

	async isSessionAlive(name: string): Promise<boolean> {
		return (await this.run(["tmux", "has-session", "-t", name])) === 0;
	}

	/**
	 * Whether the pane's process has exited. Writer sessions run with
	 * `remain-on-exit on` so a launch error's output SURVIVES process exit (the
	 * session stays alive with a dead pane — otherwise the tmux session vanishes
	 * before we can capture/classify the error). A missing session counts as dead.
	 */
	private async isPaneDead(name: string): Promise<boolean> {
		const proc = this.spawn(
			["tmux", "list-panes", "-t", name, "-F", "#{pane_dead}"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if ((await proc.exited) !== 0) return true; // session gone
		const out = (await new Response(proc.stdout).text()).trim();
		return out.split("\n").some((line) => line.trim() === "1");
	}

	async killSession(name: string): Promise<void> {
		await this.run(["tmux", "kill-session", "-t", name]);
	}

	/** Graceful `/exit` (lets the harness persist the conversation) then kill —
	 *  for orphaned-but-alive writer TUIs found by the recovery matrix. (With
	 *  remain-on-exit the session never dies on its own — always kill.) */
	async gracefulClose(name: string): Promise<void> {
		if (!(await this.isPaneDead(name))) {
			try {
				await this.sendKeys(name, ["Escape"]);
				await Bun.sleep(300);
				await this.sendKeys(name, ["/exit"], true);
				await this.sendKeys(name, ["Enter"]);
			} catch {}
			const grace = Date.now();
			while (Date.now() - grace < 5000) {
				if (await this.isPaneDead(name)) break;
				await Bun.sleep(500);
			}
		}
		await this.killSession(name);
	}

	/** Kill every tmux session whose name starts with `prefix` (stop/delete). */
	async killSessionsWithPrefix(prefix: string): Promise<number> {
		const proc = this.spawn(["tmux", "ls", "-F", "#{session_name}"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if ((await proc.exited) !== 0) return 0; // no tmux server
		const out = await new Response(proc.stdout).text();
		let killed = 0;
		for (const name of out.split("\n").map((s) => s.trim())) {
			if (name.startsWith(prefix)) {
				await this.killSession(name);
				killed++;
			}
		}
		return killed;
	}

	private async capturePane(name: string, full = false): Promise<string> {
		const cmd = full
			? ["tmux", "capture-pane", "-p", "-S", "-", "-t", name]
			: ["tmux", "capture-pane", "-p", "-t", name];
		const proc = this.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		await proc.exited;
		return await new Response(proc.stdout).text();
	}

	private async sendKeys(
		name: string,
		keys: string[],
		literal = false,
	): Promise<void> {
		await this.run(
			literal
				? ["tmux", "send-keys", "-t", name, "-l", ...keys]
				: ["tmux", "send-keys", "-t", name, ...keys],
		);
	}

	// --- launch ----------------------------------------------------------------

	/**
	 * Launch the writer TUI detached. Turn 1 pins the harness session id
	 * (`--session-id`); later turns resume it (`--resume`). CLAUDECODE is scrubbed
	 * three ways (tmux -e / env -u / unset) exactly like kloop, so a nested
	 * Claude session never inherits it.
	 */
	private async launch(params: {
		sessionName: string;
		binary: string;
		harnessSessionId: string;
		resume: boolean;
		cwd: string;
	}): Promise<void> {
		const { sessionName, binary, harnessSessionId, resume, cwd } = params;
		const idFlag = resume ? "--resume" : "--session-id";
		const { CLAUDECODE: _, ...env } = process.env;
		const proc = this.spawn(
			[
				"tmux",
				"new-session",
				"-d",
				"-s",
				sessionName,
				"-c",
				cwd,
				"-e",
				"CLAUDECODE=",
				"env",
				"-u",
				"CLAUDECODE",
				binary,
				"--dangerously-skip-permissions",
				idFlag,
				harnessSessionId,
			],
			{ stdout: "pipe", stderr: "pipe", env },
		);
		if ((await proc.exited) !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(
				`Failed to create writer tmux session: ${stderr.trim() || "unknown"}`,
			);
		}
		// remain-on-exit: a launch error (session-in-use, resume-lost, auth) exits
		// the process almost immediately — without this the tmux session vanishes
		// before the poll loop can capture and CLASSIFY the error pane, degrading
		// every fatal into a generic "died". The finally backstop kills the session
		// either way.
		await this.run([
			"tmux",
			"set-option",
			"-t",
			sessionName,
			"remain-on-exit",
			"on",
		]);
	}

	// --- readiness / inject (kloop parity + resume tolerance) -------------------

	/** The one-time "Bypass Permissions mode" warning on a fresh config dir. */
	private paneShowsBypassGate(pane: string): boolean {
		const lower = pane.toLowerCase();
		return (
			lower.includes("bypass permissions") &&
			(lower.includes("yes, i accept") || lower.includes("no, exit"))
		);
	}

	/**
	 * Is the pane at Claude's interactive input prompt (vs a blocking onboarding
	 * screen)? Same heuristic as kloop; under `--resume` the replayed transcript
	 * scrolls above the input box, so the positive signal (the prompt glyph) is
	 * what matters — replay text can't fake it.
	 */
	private paneShowsInputPrompt(pane: string): boolean {
		const lower = pane.toLowerCase();
		const blockers = [
			"do you trust the files",
			"choose the text style",
			"select theme",
			"press enter to continue",
		];
		if (blockers.some((m) => lower.includes(m))) return false;
		if (this.paneShowsBypassGate(pane)) return false;
		return /(^|\n)\s*[│|]?\s*>\s/.test(pane) || pane.includes("│ >");
	}

	private scanFatal(pane: string): FatalKind | null {
		return classifyFatal(pane);
	}

	/**
	 * Wait until the TUI accepts input: pane stable across two captures AND
	 * showing the input prompt. Dismisses the bypass-permissions gate once.
	 * Returns "fatal" early when a fatal signature appears (auth/resume-lost show
	 * up here, before any input lands).
	 */
	private async waitForPaneReady(
		name: string,
	): Promise<{ ready: boolean; fatal: FatalKind | null }> {
		const start = Date.now();
		await Bun.sleep(2000);
		let prev = "";
		let stable = 0;
		let dismissedBypass = false;
		while (Date.now() - start < READY_CAP_MS) {
			if (!(await this.isSessionAlive(name)))
				return { ready: false, fatal: null };
			// remain-on-exit: a launch error exits the PROCESS but keeps the session
			// (dead pane) so we can still capture + classify the error output.
			if (await this.isPaneDead(name)) {
				const pane = (await this.capturePane(name, true)).trim();
				return { ready: false, fatal: this.scanFatal(pane) };
			}
			const pane = (await this.capturePane(name, true)).trim();
			// Live pane: only classify fatal when the input prompt is NOT visible —
			// an error exit never reaches the prompt, while a `--resume` replay can
			// legitimately show signature-like words in the transcript tail.
			if (!this.paneShowsInputPrompt(pane)) {
				const fatal = this.scanFatal(pane);
				if (fatal) return { ready: false, fatal };
			}
			if (!dismissedBypass && this.paneShowsBypassGate(pane)) {
				await this.sendKeys(name, ["Down"]);
				await Bun.sleep(200);
				await this.sendKeys(name, ["Enter"]);
				dismissedBypass = true;
				stable = 0;
				prev = "";
				await Bun.sleep(1500);
				continue;
			}
			if (pane.length > 0 && pane === prev && this.paneShowsInputPrompt(pane)) {
				if (++stable >= 2) return { ready: true, fatal: null };
			} else {
				stable = 0;
			}
			prev = pane;
			await Bun.sleep(1500);
		}
		return { ready: false, fatal: null };
	}

	/**
	 * Type the bootstrap line and submit it, confirming it landed in the input
	 * first (kloop's injectLine: whitespace-normalized probe, C-u clear between
	 * attempts, Enter only after a confirmed landing). Under `--resume` the probe
	 * only matches freshly-typed input — replayed transcript is above the input
	 * box and won't contain the exact bootstrap text of THIS turn (the message
	 * path embeds the turn number).
	 */
	private async injectLine(name: string, line: string): Promise<boolean> {
		const norm = (s: string) => s.replace(/\s+/g, "");
		const probe = norm(line).slice(0, 50);
		let landed = false;
		for (let i = 0; i < 4; i++) {
			if (i > 0) {
				await this.sendKeys(name, ["C-u"]);
				await Bun.sleep(300);
			}
			await this.sendKeys(name, [line], true);
			await Bun.sleep(600);
			if (norm(await this.capturePane(name)).includes(probe)) {
				landed = true;
				break;
			}
		}
		if (landed) await this.sendKeys(name, ["Enter"]);
		return landed;
	}

	// --- the turn --------------------------------------------------------------

	/**
	 * Run one writer turn: launch → ready → inject bootstrap → wait for the
	 * sentinel → graceful /exit → kill (backstop in finally — a detached TUI
	 * left running would hold a real Claude session and burn quota forever).
	 * The caller has already unlinked the sentinel.
	 */
	async runTurn(params: {
		sessionName: string;
		binary: string;
		harnessSessionId: string;
		resume: boolean;
		cwd: string;
		messageFile: string;
		sentinelFile: string;
		timeoutMins: number;
		/** Called every poll tick — the relay heartbeats its session lock here so
		 *  a long sentinel wait never goes TTL-stale (spec §4.2). */
		onTick?: () => void;
	}): Promise<TurnRunResult> {
		const start = Date.now();
		const { sessionName, messageFile, sentinelFile, timeoutMins, onTick } =
			params;
		await this.launch(params);
		try {
			const { ready, fatal: readyFatal } =
				await this.waitForPaneReady(sessionName);
			if (readyFatal) {
				return {
					outcome: "fatal",
					fatalKind: readyFatal,
					pane: await this.capturePane(sessionName, true).catch(() => ""),
					delivered: false,
					durationMs: Date.now() - start,
				};
			}
			if (
				!ready &&
				(!(await this.isSessionAlive(sessionName)) ||
					(await this.isPaneDead(sessionName)))
			) {
				return {
					outcome: "died",
					pane: await this.capturePane(sessionName, true).catch(() => ""),
					delivered: false,
					durationMs: Date.now() - start,
				};
			}
			const bootstrap = `Read the file ${messageFile} now, then carefully follow every instruction inside it exactly. That file is your complete task for this turn.`;
			const landed = await this.injectLine(sessionName, bootstrap);
			if (!landed) {
				// Stuck on a blocking screen readiness gave up on — bail fast so the
				// caller retries/classifies instead of burning the whole timeout.
				const pane = await this.capturePane(sessionName, true).catch(() => "");
				const fatal = this.scanFatal(pane);
				return {
					outcome: fatal ? "fatal" : "died",
					fatalKind: fatal ?? undefined,
					pane,
					delivered: false,
					durationMs: Date.now() - start,
				};
			}

			// Clock starts once input is actually delivered (kloop parity).
			const workStart = Date.now();
			const timeoutMs = timeoutMins * 60 * 1000;
			// Mid-work fatal detection is STABILITY-GATED: a working writer's pane
			// keeps changing, an error banner sits still. Only classify fatal when
			// the same signature-matching pane is seen on 2 consecutive ticks —
			// otherwise artifact prose that merely mentions "rate limit" would abort
			// a healthy turn. (waitForPaneReady scans un-gated: nothing legitimate
			// is being written before input lands.)
			let prevFatalPane = "";
			while (true) {
				onTick?.();
				if (existsSync(sentinelFile)) {
					return {
						outcome: "done",
						pane: "",
						delivered: true,
						durationMs: Date.now() - start,
					};
				}
				if (
					!(await this.isSessionAlive(sessionName)) ||
					(await this.isPaneDead(sessionName))
				) {
					// Exited before signalling — re-check the marker to avoid the race.
					// With remain-on-exit the dead pane's output survives: capture it and
					// classify (a mid-turn rate-limit/crash error is a fatal, not "died").
					if (existsSync(sentinelFile)) {
						return {
							outcome: "done",
							pane: "",
							delivered: true,
							durationMs: Date.now() - start,
						};
					}
					const pane = await this.capturePane(sessionName, true).catch(
						() => "",
					);
					const fatal = this.scanFatal(pane);
					return {
						outcome: fatal ? "fatal" : "died",
						fatalKind: fatal ?? undefined,
						pane,
						delivered: true,
						durationMs: Date.now() - start,
					};
				}
				const pane = await this.capturePane(sessionName).catch(() => "");
				const fatal = this.scanFatal(pane);
				if (fatal && pane === prevFatalPane) {
					return {
						outcome: "fatal",
						fatalKind: fatal,
						pane: await this.capturePane(sessionName, true).catch(() => pane),
						delivered: true,
						durationMs: Date.now() - start,
					};
				}
				prevFatalPane = fatal ? pane : "";
				if (Date.now() - workStart > timeoutMs) {
					return {
						outcome: "timeout",
						pane: await this.capturePane(sessionName, true).catch(() => ""),
						delivered: true,
						durationMs: Date.now() - start,
					};
				}
				await Bun.sleep(POLL_MS);
			}
		} finally {
			// Graceful /exit so the harness persists the conversation, then the
			// backstop kill. With remain-on-exit the session NEVER dies on its own —
			// always kill it here (a dead pane just skips the /exit).
			if (await this.isSessionAlive(sessionName)) {
				if (!(await this.isPaneDead(sessionName))) {
					try {
						await this.sendKeys(sessionName, ["Escape"]);
						await Bun.sleep(300);
						await this.sendKeys(sessionName, ["/exit"], true);
						await this.sendKeys(sessionName, ["Enter"]);
					} catch {}
					const grace = Date.now();
					while (Date.now() - grace < 5000) {
						if (await this.isPaneDead(sessionName)) break;
						await Bun.sleep(500);
					}
				}
				await this.killSession(sessionName);
			}
		}
	}
}

/** Session-name prefix for a kautopilot session's writer tmux sessions —
 *  distinct from kloop's `kloop-`/`devloop-` cleanup filters. */
export function writerTmuxPrefix(sessionId: string): string {
	return `kap-${sessionId}-`;
}

export function writerTmuxName(
	sessionId: string,
	phaseKeySafe: string,
	turn: number,
	attempt: number,
): string {
	return `${writerTmuxPrefix(sessionId)}${phaseKeySafe}-t${turn}-a${attempt}`;
}
