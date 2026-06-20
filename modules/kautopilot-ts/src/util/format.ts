// ============================================================================
// Duration formatting
// ============================================================================

export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";

	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	const s = seconds % 60;
	const m = minutes % 60;

	if (hours > 0) {
		return `${hours}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
	}
	if (minutes > 0) {
		return `${m}m ${String(s).padStart(2, "0")}s`;
	}
	return `${s}s`;
}

// ============================================================================
// ANSI colors
// ============================================================================

const isTTY = process.stdout.isTTY;

const c = {
	reset: isTTY ? "\x1b[0m" : "",
	bold: isTTY ? "\x1b[1m" : "",
	dim: isTTY ? "\x1b[2m" : "",
	green: isTTY ? "\x1b[32m" : "",
	yellow: isTTY ? "\x1b[33m" : "",
	red: isTTY ? "\x1b[31m" : "",
	cyan: isTTY ? "\x1b[36m" : "",
	magenta: isTTY ? "\x1b[35m" : "",
	blue: isTTY ? "\x1b[34m" : "",
};

// ============================================================================
// Colored log helpers
// ============================================================================

/** Key-value label like "Ticket:    PE-1234" — cyan label, white value */
export function logField(label: string, value: string): void {
	console.log(`${c.cyan}${label.padEnd(11)}${c.reset}${value}`);
}

/** Success / positive message */
export function logOk(msg: string): void {
	console.log(`${c.green}✓${c.reset} ${msg}`);
}

/** Informational message */
export function logInfo(msg: string): void {
	console.log(`${c.blue}ℹ${c.reset} ${msg}`);
}

/** Error message */
export function logError(msg: string): void {
	console.error(`${c.red}✗${c.reset} ${msg}`);
}

/** Section heading */
export function logHeading(title: string): void {
	console.log(`\n${c.bold}${c.cyan}${title}${c.reset}`);
}

/** Dim/debug text */
export function logDim(msg: string): void {
	console.log(`${c.dim}${msg}${c.reset}`);
}

export function formatPhase(phase: string): string {
	if (!phase || phase === "none") return `${c.dim}—${c.reset}`;
	return `${c.magenta}${phase}${c.reset}`;
}

// ============================================================================
// Step line formatting for phase progress display
// ============================================================================

export function formatStepLine(
	step: string,
	status: "done" | "active" | "pending",
	detail?: string,
): string {
	const icon =
		status === "done"
			? `${c.green}✓${c.reset}`
			: status === "active"
				? `${c.cyan}→${c.reset}`
				: `${c.dim}○${c.reset}`;
	const label =
		status === "done"
			? `${c.dim}${step}${c.reset}`
			: status === "active"
				? `${c.bold}${step}${c.reset}`
				: `${c.dim}${step}${c.reset}`;
	const detailStr = detail ? `  ${c.dim}${detail}${c.reset}` : "";
	return ` ${icon} ${label}${detailStr}`;
}

// ============================================================================
// Repo parsing
// ============================================================================

export function parseRepoHost(gitRootHost: string): {
	platform: string;
	org: string;
	repo: string;
} {
	// Format: github-{platform}/{org}/{repo}
	const match = gitRootHost.match(/^(github-[^/]+)\/(.+)\/(.+)$/);
	if (!match) return { platform: gitRootHost, org: "?", repo: "?" };
	return { platform: match[1], org: match[2], repo: match[3] };
}
