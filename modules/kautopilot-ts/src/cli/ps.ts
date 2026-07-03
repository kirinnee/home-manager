import { Command } from "commander";
import { listSessions } from "../core/db";
import { checkLock } from "../core/lock";
import {
	type Lpsm,
	readSessionMeta,
	type SessionMeta,
} from "../core/session-meta";
import {
	ensureStatus,
	getCurrentKloopRunId,
	isSessionActive,
	isSessionTerminal,
} from "../core/status";
import { formatPhase, parseRepoHost } from "../util/format";

/**
 * Derive the org / repo / branch display fields for a session row. A session is
 * associated with a FOLDER, not a repo — the real org/repo/branch live in
 * session.json (`meta`): org on the session, repo names + branch per entry in
 * `meta.repos`. The `folder` path is only a weak fallback for `org`/`repo` when a
 * session has no meta yet (parseRepoHost of a filesystem path is usually "?").
 *
 * @public Exported for unit tests; used internally by `runPs`.
 */
export function psDisplayFields(
	meta: SessionMeta | null,
	folder: string,
): { org: string; repo: string; branch: string } {
	const parsed = parseRepoHost(folder);
	const org = meta?.org ?? parsed.org;
	const repo =
		meta && meta.repos.length > 0
			? meta.repos.map((r) => r.repo).join(",")
			: parsed.repo === "?"
				? "—"
				: parsed.repo;
	const branch = meta?.repos.find((r) => r.branch)?.branch ?? "—";
	return { org, repo, branch };
}

/**
 * Does a session match all the given query tags? A query tag matches when its
 * value (case-insensitive) equals — or, failing exact, is a substring of — ANY
 * of the haystack values: the structured LPSM fields
 * (landscape/cluster/platform/service/module) OR any of the session's free-form
 * `tags[]`. With multiple query tags, ALL must match somewhere.
 *
 * @public Exported for unit tests; used internally by `runPs`.
 */
export function matchesTags(
	lpsm: Lpsm | undefined,
	freeTags: string[] | undefined,
	queryTags: string[],
): boolean {
	if (queryTags.length === 0) return true;
	const lpsmValues = lpsm
		? [lpsm.landscape, lpsm.cluster, lpsm.platform, lpsm.service, lpsm.module]
		: [];
	const values = [...lpsmValues, ...(freeTags ?? [])]
		.filter((v): v is string => Boolean(v))
		.map((v) => v.toLowerCase());
	if (values.length === 0) return false;
	return queryTags.every((tag) => {
		const t = tag.toLowerCase();
		if (values.some((v) => v === t)) return true;
		return values.some((v) => v.includes(t));
	});
}

const isTTY = process.stdout.isTTY;
const c = {
	reset: isTTY ? "\x1b[0m" : "",
	green: isTTY ? "\x1b[32m" : "",
	yellow: isTTY ? "\x1b[33m" : "",
};

export function createPsCommand(): Command {
	return new Command("ps")
		.option("--folder <path>", "Filter by associated folder (substring match)")
		.option("-a, --all", "Include stopped/completed sessions")
		.option(
			"--tag <value>",
			"Filter by AtomiCloud LPSM tag (repeatable; all must match)",
			(value: string, prev: string[]) => [...prev, value],
			[] as string[],
		)
		.option("--json", "Machine-readable output")
		.action(
			async (opts: {
				folder?: string;
				all?: boolean;
				tag?: string[];
				json?: boolean;
			}) => {
				try {
					await runPs(opts);
				} catch (err) {
					console.error(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}

async function runPs(opts: {
	folder?: string;
	all?: boolean;
	tag?: string[];
	json?: boolean;
}): Promise<void> {
	const sessions = listSessions();
	const tags = opts.tag ?? [];
	const tagging = tags.length > 0;

	// Filter by folder (substring match — catches a hub dir and anything under it)
	let filtered = sessions;
	if (opts.folder) {
		const folderFilter = opts.folder.toLowerCase();
		filtered = sessions.filter((s) =>
			s.folder.toLowerCase().includes(folderFilter),
		);
	}

	// Default view = ACTIVE (in-progress) sessions — `isSessionActive` reads the real
	// materialized status, not the dead DB `state` column, and not just the
	// held-this-instant lock (a thin-controller session rarely holds the lock). `-a`
	// or tag-filtering widens to all sessions.
	const visibleRows = filtered.filter(
		(session) => opts.all || tagging || isSessionActive(session.id),
	);

	// Apply tag filter: matches against structured LPSM fields OR free-form tags.
	const taggedRows = tagging
		? visibleRows.filter((session) => {
				const meta = readSessionMeta(session.id);
				return matchesTags(meta?.lpsm, meta?.tags, tags);
			})
		: visibleRows;

	if (taggedRows.length === 0) {
		console.log("No sessions found.");
		return;
	}

	const rows = taggedRows.map((session) => {
		const lockInfo = checkLock(session.id);
		const status = ensureStatus(session.id);
		const meta = readSessionMeta(session.id);
		const { org, repo, branch } = psDisplayFields(meta, session.folder);
		const lpsm = meta?.lpsm;
		const tags = meta?.tags ?? null;

		const elapsed =
			lockInfo.locked && status.startedAt
				? Date.now() - new Date(status.startedAt).getTime()
				: 0;

		const isRunning = lockInfo.locked;
		const isTerminal = isSessionTerminal(session.id);
		const kloopRunId = getCurrentKloopRunId(status);

		// Compute plan column
		let planCol = "—";
		if (status.phase === "execution" && status.activePlan) {
			planCol = `${status.activePlan.planIndex + 1}/${status.activePlan.maxPlans}`;
		} else if (status.phase === "execution" && status.context.maxPlans) {
			planCol = `${(status.context.planIndex ?? 0) + 1}/${status.context.maxPlans}`;
		} else if (status.phase === "feedback" && status.polishState) {
			if (status.polishState.prNumber) {
				planCol = `PR#${status.polishState.prNumber}`;
			} else {
				planCol = "pr";
			}
		}

		// Truncate kloop run ID for display
		const kloopCol = kloopRunId
			? kloopRunId.length > 8
				? kloopRunId.slice(0, 8)
				: kloopRunId
			: "—";

		return {
			id: session.id,
			ticketId: session.ticket_id || "—",
			org,
			repo,
			lpsm: lpsm ?? null,
			tags,
			branch,
			phase: status.phase,
			step: status.state,
			stepType: status.stepType,
			running: isRunning,
			completed: !isRunning && isTerminal,
			elapsed,
			planCol,
			kloopCol,
			// Full data for JSON
			activePlan: status.activePlan,
			polishState: status.polishState,
			kloopRunId,
			phases: status.phases,
		};
	});

	if (opts.json) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}

	// Table output
	const cols = {
		session: 10,
		ticket: 10,
		org: 12,
		repo: 16,
		branch: 25,
		phase: 16,
		step: 18,
		plan: 7,
		kloop: 9,
	};

	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
	const ANSI_RE = /\x1b\[[0-9;]*m/gu;
	/** Visible character width of a string (strips ANSI, handles multibyte) */
	const visWidth = (s: string) => {
		const noAnsi = s.replace(ANSI_RE, "");
		// Approximate: count non-surrogate code points
		return [...noAnsi].length;
	};

	/** Truncate to visible width `w` and pad, accounting for ANSI escape sequences */
	const p = (s: string, w: number) => {
		// For plain strings: truncate by visible width and pad
		if (!s.includes("\x1b")) {
			const chars = [...s];
			if (chars.length > w) {
				const truncated = `${chars.slice(0, w - 1).join("")}…`;
				return truncated + " ".repeat(Math.max(0, w - visWidth(truncated)));
			}
			return s + " ".repeat(Math.max(0, w - chars.length));
		}
		// ANSI string: pad based on visible width
		return s + " ".repeat(Math.max(0, w - visWidth(s)));
	};

	const header =
		p("SESSION", cols.session) +
		p("TICKET", cols.ticket) +
		p("ORG", cols.org) +
		p("REPO", cols.repo) +
		p("BRANCH", cols.branch) +
		p("PHASE", cols.phase) +
		p("STEP", cols.step) +
		p("PLAN", cols.plan) +
		"KLOOP";

	console.log(header);

	for (const row of rows) {
		const done = row.completed;

		const phaseText = done
			? `${c.green}done${c.reset}`
			: formatPhase(row.phase);
		const stepText = done
			? `✓ ${row.step}`
			: row.stepType
				? `${row.step} (${row.stepType})`
				: row.step || "—";

		const line =
			p(row.id, cols.session) +
			p(row.ticketId, cols.ticket) +
			p(row.org, cols.org) +
			p(row.repo, cols.repo) +
			p(row.branch, cols.branch) +
			p(phaseText, cols.phase) +
			p(stepText, cols.step) +
			p(row.planCol, cols.plan) +
			row.kloopCol;

		console.log(line);
	}
}
