import { isCancel, select } from "@clack/prompts";
import { Command } from "commander";
import {
	gatePhasePlan,
	type Phase,
	type PhaseProposal,
	parsePhasesArg,
} from "../core/phase-plan";
import { createSession, proposeStartPhasePlan } from "../core/session-create";
import {
	detectOrgFromTicket,
	type ExecMode,
	isOrg,
	type Lpsm,
	type MergeMode,
	ORGS,
	type Org,
} from "../core/session-meta";
import { logError, logField, logInfo } from "../util/format";

// ============================================================================
// `kautopilot start [TICKET_ID | "request"]` — thin convenience. It resolves the
// org (--org → ticket → ask), creates the host-driven session, and hands off to
// the controller (the /kautopilot skill drives `next`/`complete`). There is NO
// self-driving loop and NO `claude -p` / TTY spawn from the binary. (SPEC §13 #2)
// ============================================================================

export function createStartCommand(): Command {
	return new Command("start")
		.description(
			"Initialize a host-driven session (ticket or free-form request)",
		)
		.argument(
			"[task]",
			"Ticket id (e.g. PE-1234) or a free-form request in quotes",
		)
		.option("--org <org>", "Org: liftoff | atomicloud")
		.option("--exec <mode>", "Execution mode: kloop | sub-agent")
		.option(
			"--phases <list>",
			"Phase set (comma-separated subset of brainstorm,triage,spec,plan; plan is always included), e.g. 'plan' or 'spec,plan'. Overrides the keyword heuristics; pinned into the session.",
		)
		.option(
			"--writer <mode>",
			"Writer-step execution: inline | deferred (defaults from config.writer.mode; pinned into the session)",
		)
		.option(
			"--merge <mode>",
			"Merge policy: manual (ask before merging) | auto (merge ready PRs)",
		)
		.option("--max-repos <n>", "Max parallel repos", (v) =>
			Number.parseInt(v, 10),
		)
		.option(
			"--landscape <l>",
			"AtomiCloud LPSM landscape/environment (atomicloud-only)",
		)
		.option("--cluster <c>", "AtomiCloud LPSM cluster (atomicloud-only)")
		.option(
			"--platform <p>",
			"AtomiCloud LPSM platform/namespace (atomicloud-only)",
		)
		.option("--service <s>", "AtomiCloud LPSM service/repo (atomicloud-only)")
		.option("--module <m>", "AtomiCloud LPSM module (atomicloud-only)")
		.option(
			"--tag <t>",
			"Free-form session tag (repeatable)",
			(v: string, acc: string[]) => [...acc, v],
			[] as string[],
		)
		.action(
			async (
				task: string | undefined,
				opts: {
					org?: string;
					exec?: string;
					phases?: string;
					writer?: string;
					merge?: string;
					maxRepos?: number;
					landscape?: string;
					cluster?: string;
					platform?: string;
					service?: string;
					module?: string;
					tag?: string[];
				},
			) => {
				try {
					await runStart(task, opts);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}

function looksLikeTicketId(task: string): boolean {
	// A short token with no spaces is treated as a ticket id; quoted prose is a request.
	return !/\s/.test(task) && task.length <= 40;
}

async function resolveOrg(
	ticketId: string | null,
	orgArg?: string,
): Promise<Org> {
	if (orgArg) {
		if (!isOrg(orgArg))
			throw new Error(`Unknown org: ${orgArg}. Use liftoff | atomicloud.`);
		return orgArg;
	}
	if (ticketId) {
		const detected = detectOrgFromTicket(ticketId);
		if (detected) {
			logInfo(`Detected org '${detected}' from ticket ${ticketId}.`);
			return detected;
		}
	}
	if (!process.stdout.isTTY) {
		throw new Error(
			"Org could not be resolved. Pass --org liftoff|atomicloud.",
		);
	}
	const picked = await select({
		message:
			"Which org is this task for? (Determines the ticket system and commit-spec policy.)",
		options: ORGS.map((o) => ({ value: o, label: o })),
	});
	if (isCancel(picked)) throw new Error("Cancelled.");
	return picked as Org;
}

/**
 * Low-confidence clarifying question, asked BEFORE the session commits to a phase
 * set. On a TTY it asks the user how much upfront planning to do; headless (no TTY)
 * it can't clarify, so it proceeds with the proposal and says so. Only invoked by
 * the gate on an `ask` outcome. (core/phase-plan.ts gatePhasePlan)
 */
async function askPhasesInteractively(
	proposal: PhaseProposal,
): Promise<readonly string[]> {
	if (!process.stdout.isTTY) {
		logInfo(
			`Ambiguous request (confidence ${proposal.confidence.toFixed(2)}) and no TTY to clarify — proceeding with the proposed set [${proposal.phases.join(", ")}]. Override with --phases.`,
		);
		return proposal.phases;
	}
	logInfo(
		`The request was ambiguous (confidence ${proposal.confidence.toFixed(2)}). ${proposal.reasons.join("; ")}.`,
	);
	const picked = await select({
		message: "How much upfront planning should this run do?",
		options: [
			{
				value: "plan",
				label: "Plan only — one artifact, one PR (small/quick)",
			},
			{ value: "spec,plan", label: "Spec + plan" },
			{ value: "triage,spec,plan", label: "Triage + spec + plan" },
			{
				value: "brainstorm,triage,spec,plan",
				label: "Full — brainstorm → triage → spec → plan (big/risky)",
			},
		],
		initialValue: proposal.phases.join(","),
	});
	if (isCancel(picked)) throw new Error("Cancelled.");
	return parsePhasesArg(picked as string);
}

/** Build an LPSM object from whichever flags are set, or undefined if none. */
function buildLpsm(opts: {
	landscape?: string;
	cluster?: string;
	platform?: string;
	service?: string;
	module?: string;
}): Lpsm | undefined {
	const lpsm: Lpsm = {};
	if (opts.landscape) lpsm.landscape = opts.landscape;
	if (opts.cluster) lpsm.cluster = opts.cluster;
	if (opts.platform) lpsm.platform = opts.platform;
	if (opts.service) lpsm.service = opts.service;
	if (opts.module) lpsm.module = opts.module;
	return Object.keys(lpsm).length > 0 ? lpsm : undefined;
}

async function runStart(
	task: string | undefined,
	opts: {
		org?: string;
		exec?: string;
		phases?: string;
		writer?: string;
		merge?: string;
		maxRepos?: number;
		landscape?: string;
		cluster?: string;
		platform?: string;
		service?: string;
		module?: string;
		tag?: string[];
	},
): Promise<void> {
	const ticketId = task && looksLikeTicketId(task) ? task : null;
	const org = await resolveOrg(ticketId, opts.org);

	// Phase set: an explicit `--phases` list (validated + normalized) or the
	// keyword-heuristic proposal from the request. The proposal also carries the
	// confidence gate — a low-confidence guess is a cue for the harness to confirm
	// or clarify before proceeding. Either way the chosen set is echoed + overridable.
	let explicitPhases: Phase[] | undefined;
	if (opts.phases !== undefined) {
		explicitPhases = parsePhasesArg(opts.phases);
	}
	const requestText = ticketId ? undefined : (task ?? undefined);
	const phasePlan = proposeStartPhasePlan(org, {
		explicit: explicitPhases,
		requestText,
	});
	// CONFIDENCE GATE — runs BEFORE the session is created. A confident proposal
	// proceeds as-is; a low-confidence one asks a clarifying question FIRST, and the
	// session is pinned with the answer (never the unconfirmed guess).
	const gate = await gatePhasePlan(phasePlan, () =>
		askPhasesInteractively(phasePlan),
	);

	let execMode: ExecMode | undefined;
	if (opts.exec !== undefined) {
		if (opts.exec !== "kloop" && opts.exec !== "sub-agent") {
			throw new Error(
				`Unknown exec mode: ${opts.exec}. Use kloop | sub-agent.`,
			);
		}
		execMode = opts.exec;
	}

	// Writer mode: flag → config default. Pinned into session.json so later
	// config flips never affect this session. (specs/deferred-writer-relay.md §2)
	let writerMode: "inline" | "deferred" | undefined;
	if (opts.writer !== undefined) {
		if (opts.writer !== "inline" && opts.writer !== "deferred") {
			throw new Error(
				`Unknown writer mode: ${opts.writer}. Use inline | deferred.`,
			);
		}
		writerMode = opts.writer;
	}

	let mergeMode: MergeMode | undefined;
	if (opts.merge !== undefined) {
		if (opts.merge !== "manual" && opts.merge !== "auto") {
			throw new Error(`Unknown merge mode: ${opts.merge}. Use manual | auto.`);
		}
		mergeMode = opts.merge;
	}

	if (opts.maxRepos !== undefined && !Number.isInteger(opts.maxRepos)) {
		throw new Error("--max-repos must be a positive integer.");
	}
	if (opts.maxRepos !== undefined && opts.maxRepos < 1) {
		throw new Error("--max-repos must be at least 1.");
	}

	// kautopilot can launch from ANYWHERE. The session is associated with the FOLDER
	// you ran `start` in — the exact cwd, NOT the enclosing git root. It's purely a
	// bookkeeping location to find the session again; each repo's real path comes from
	// triage and its worktree is created on demand by `seed` via worktrunk.
	const folder = process.cwd();
	const lpsm = buildLpsm(opts);

	const meta = createSession({
		ticketId,
		// Persist the free-form one-liner when this is an ad-hoc (no-ticket) request,
		// so brainstorm/create_ticket prompts can reference it (vars.request).
		request: ticketId ? undefined : (task ?? undefined),
		org,
		folder,
		execMode,
		writerMode,
		phases: gate.phases,
		mergeMode,
		maxParallelRepos: opts.maxRepos,
		lpsm,
		tags: opts.tag,
	});

	logField("Session", meta.sessionId);
	logField(
		"Org",
		`${meta.org} (${meta.ticketSystem}, commitSpec=${meta.commitSpec})`,
	);
	logField("Task", ticketId ?? `(ad-hoc) ${task ?? ""}`);
	logField(
		"Phases",
		`${(meta.phases ?? []).join(" → ")} (${
			gate.asked
				? `clarified — proposal was low confidence ${phasePlan.confidence.toFixed(2)}`
				: `confidence ${phasePlan.confidence.toFixed(2)}`
		})`,
	);
	if (phasePlan.reasons.length > 0) {
		logInfo(`Phase rationale: ${phasePlan.reasons.join("; ")}.`);
	}
	logField("Merge", meta.mergeMode);
	logField("Writer", meta.writerMode ?? "inline");
	if (meta.lpsm) {
		const parts = (
			[
				["L", meta.lpsm.landscape],
				["C", meta.lpsm.cluster],
				["P", meta.lpsm.platform],
				["S", meta.lpsm.service],
				["M", meta.lpsm.module],
			] as const
		)
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${v}`);
		logField("LPSM", parts.join(" "));
	}
	if (meta.tags && meta.tags.length > 0) {
		logField("Tags", meta.tags.join(" "));
	}
	logInfo(
		"Drive it with the /kautopilot skill, or manually: `kautopilot next --json` then `kautopilot complete <step>`.",
	);
}
