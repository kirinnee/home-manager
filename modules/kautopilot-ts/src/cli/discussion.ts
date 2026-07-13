import { Command } from "commander";
import { artifactScope, pendingStep, STEP_ARTIFACT } from "../core/driver";
import { readSessionMeta } from "../core/session-meta";
import { discussionPhases, readDiscussion } from "../core/writer/relay";
import { phaseKeySafe } from "../core/writer/scratch";
import { authoringRepoName } from "../phases/shared";
import { logError } from "../util/format";
import { resolveSession } from "./resolve-session";

// ============================================================================
// `kautopilot discussion` — the deferred-writer capture surface: the turn list
// (message → envelope) for a phase, read fresh from the scratch mailbox. This
// is the inspection tool (and the skill's resume protocol source) until the
// dashboard's Discussion tab lands. (specs/deferred-writer-relay.md §7)
// ============================================================================

export function createDiscussionCommand(): Command {
	return new Command("discussion")
		.description(
			"Show the deferred-writer discussion (turns + envelopes) for a phase",
		)
		.option(
			"--phase <key>",
			"Phase key (e.g. spec@1) or artifact kind (e.g. spec); default: the pending step's phase",
		)
		.option("--session <id>", "Target session id")
		.option("--json", "Emit JSON")
		.action(
			async (opts: { phase?: string; session?: string; json?: boolean }) => {
				try {
					const { sessionId } = resolveSession(opts.session);
					const phaseKey = resolvePhaseKey(sessionId, opts.phase);
					if (!phaseKey) {
						logError(
							`No writer discussion found${opts.phase ? ` for phase ${opts.phase}` : ""}. Phases with discussions: ${discussionPhases(sessionId).join(", ") || "(none)"}`,
						);
						process.exit(1);
					}
					const discussion = readDiscussion(sessionId, phaseKey);
					if (opts.json) {
						process.stdout.write(`${JSON.stringify(discussion)}\n`);
					} else {
						printHuman(discussion);
					}
					process.exit(0);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}

/**
 * Resolve --phase: an exact phaseKey, an artifact kind (matched against the
 * session's current epoch), or default to the pending step's artifact.
 */
function resolvePhaseKey(sessionId: string, phaseArg?: string): string | null {
	const phases = discussionPhases(sessionId);
	const meta = readSessionMeta(sessionId);
	if (phaseArg) {
		const safe = phaseKeySafe(phaseArg);
		if (phases.includes(safe)) return safe;
		// Treat as artifact kind at the current epoch.
		if (meta) {
			const repo = phaseArg === "plans" ? authoringRepoName(meta) : null;
			const scoped = phaseKeySafe(
				artifactScope(
					phaseArg as Parameters<typeof artifactScope>[0],
					meta.epoch,
					repo,
				),
			);
			if (phases.includes(scoped)) return scoped;
		}
		return null;
	}
	// Default: the pending step's artifact.
	if (meta) {
		const step = pendingStep(sessionId);
		const kind = step ? STEP_ARTIFACT[step] : undefined;
		if (kind) {
			const repo = kind === "plans" ? authoringRepoName(meta) : null;
			const key = phaseKeySafe(artifactScope(kind, meta.epoch, repo));
			if (phases.includes(key)) return key;
		}
	}
	// Fall back to the most recent phase with a discussion.
	return phases.length ? phases[phases.length - 1] : null;
}

function printHuman(d: ReturnType<typeof readDiscussion>): void {
	console.log(`Phase: ${d.phaseKey}`);
	if (d.writer) {
		console.log(
			`Writer: ${d.writer.account} — ${d.writer.status} (${d.writer.turns} turns done)`,
		);
	}
	for (const t of d.turns) {
		const elapsed =
			t.elapsedMs != null ? ` ${Math.round(t.elapsedMs / 60000)}m` : "";
		const progress = t.lastProgress ? ` — ${t.lastProgress}` : "";
		console.log(
			`  turn ${t.turn}: ${t.state}${elapsed} (attempts: ${t.attempts})${progress}${t.state === "running" && t.tmuxSession ? ` [watch: tmux attach -r -t ${t.tmuxSession}]` : ""}`,
		);
		const env = t.envelope as { summary?: string } | null;
		if (env?.summary) console.log(`    ${env.summary.split("\n")[0]}`);
	}
}
