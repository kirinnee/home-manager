import { dirname } from "node:path";

function gitSync(
	args: string[],
	cwd?: string,
): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: cwd || process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString().trim(),
		stderr: proc.stderr.toString().trim(),
	};
}

export function getGitRoot(cwd?: string): string {
	const result = gitSync(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		cwd,
	);
	if (result.exitCode !== 0) throw new Error("Not a git repository.");
	return dirname(result.stdout);
}

export function hasUnmergedPaths(cwd?: string): boolean {
	const result = gitSync(["diff", "--name-only", "--diff-filter=U"], cwd);
	if (result.exitCode !== 0) return false;
	return result.stdout.length > 0;
}

export function getCurrentBranch(cwd?: string): string {
	const result = gitSync(["branch", "--show-current"], cwd);
	if (result.exitCode !== 0)
		throw new Error("Could not determine current branch.");
	return result.stdout;
}

export function createBranch(name: string, cwd?: string): void {
	const result = gitSync(["checkout", "-b", name], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to create branch "${name}".`);
	}
}

/** Slugify a string into a safe git branch component (lowercase, dash-joined). */
export function slugifyBranch(s: string): string {
	return String(s)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

/**
 * Sanitize a ticket id for use as a git branch segment, **preserving case** so
 * refs like `PE-1234` stay recognizable (e.g. branch `kirinnee/PE-1234-i18n`).
 * Returns "" when there's no usable ticket id (callers then fall back).
 */
export function branchTicketRef(ticketId: string | undefined | null): string {
	return String(ticketId ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".") // git forbids ".." anywhere in a ref
		.replace(/^[-._]+|[-._]+$/g, "")
		.slice(0, 40)
		.replace(/[-._]+$/g, "");
}

/**
 * The git user handle (`git config user.name`) slugified, for branch-name
 * prefixes — e.g. "Kirin Nee" → "kirin-nee". Falls back to $USER, then "user".
 * Reads global config when no repo cwd is given, so it works outside a repo.
 */
export function gitUserSlug(cwd?: string): string {
	const r = gitSync(["config", "user.name"], cwd);
	const name =
		r.exitCode === 0 && r.stdout ? r.stdout : process.env.USER || "user";
	return slugifyBranch(name) || "user";
}

export function detectDefaultBranch(cwd?: string): string {
	// Try git symbolic-ref for the remote HEAD
	const result = gitSync(
		["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
		cwd,
	);
	if (result.exitCode === 0) {
		// Returns e.g. "origin/master" → strip "origin/"
		return result.stdout.replace(/^origin\//, "");
	}
	// Fallback: check if master exists
	const masterCheck = gitSync(
		["rev-parse", "--verify", "refs/remotes/origin/master"],
		cwd,
	);
	if (masterCheck.exitCode === 0) return "master";
	return "main";
}

export function isOnMain(baseBranch?: string, cwd?: string): boolean {
	const branch = getCurrentBranch(cwd);
	const mainBranch = baseBranch || "main";
	return branch === mainBranch;
}
