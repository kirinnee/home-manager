import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../core/artifacts";
import type { RepoEntry, SessionMeta } from "../core/session-meta";

// ============================================================================
// Prompt assembly helpers for the host-driven steps. Every yielded prompt is
// mechanics (binary-owned) + configurable body (DEFAULT_CONFIG.agents.*) +
// resolved vars (absolute paths). See PROMPT-SET.md.
// ============================================================================

/** Shared Approval Gate (describe-mode) — referenced by every interactive step. */
export const SHARED_APPROVAL_GATE = `### Interaction Protocol — STRICT

1. You suggest first. Propose a concrete result — do not open with "what do you want to do?" The user hired you to be proactive.
2. Debate with the user. They push back; iterate until you both agree.
3. Confirm the final decision explicitly so there is no ambiguity.
4. Wait for EXPLICIT approval. The user must say "approve" (or a clear equivalent like "yes approve this"). "ok", "sounds good", "sure" are NOT approval — ask again.
5. After approval, ensure the output file is written. Then STOP and hand control back — the controller finalizes the step (it calls \`kautopilot complete\`, which records the approval event). Do NOT run any kautopilot command yourself.`;

/** Session-store paths shared across plan/feedback steps. */
export function ticketPath(sessionId: string): string {
	return join(sessionDir(sessionId), "ticket.md");
}

/** Per-repo rules.md path (worktree), or null when no worktree/rules yet. */
export function rulesPath(repo: RepoEntry | null): string | null {
	if (!repo?.worktree) return null;
	const p = join(repo.worktree, "rules.md");
	return existsSync(p) ? p : null;
}

/** Substitute `{name}` placeholders with values (null → empty string). */
export function substitute(
	template: string,
	vars: Record<string, string | null>,
): string {
	let out = template;
	for (const [k, v] of Object.entries(vars)) {
		out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v ?? "");
	}
	return out;
}

/** Convenience: ticketId from meta, defaulting to a stable placeholder. */
export function ticketId(meta: SessionMeta): string {
	return meta.ticketId || "local";
}
