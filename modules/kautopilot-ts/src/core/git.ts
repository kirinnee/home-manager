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

export function getWorktree(cwd?: string): string {
	const result = gitSync(
		["rev-parse", "--path-format=absolute", "--show-toplevel"],
		cwd,
	);
	if (result.exitCode !== 0) throw new Error("Not a git repository.");
	return result.stdout;
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
