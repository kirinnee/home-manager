import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../core/artifacts";
import type { StepContext } from "../core/descriptor";
import type { RepoEntry, SessionMeta } from "../core/session-meta";
import { stepExecution } from "../core/writer/mode";

// ============================================================================
// Prompt assembly helpers for the host-driven steps. Every yielded prompt is
// mechanics (binary-owned) + configurable body (DEFAULT_CONFIG.agents.*) +
// resolved vars (absolute paths). See PROMPT-SET.md.
// ============================================================================

/** Shared Approval Gate (describe-mode) — referenced by every interactive step
 *  via `approvalGate(ctx, step)` below. */
const SHARED_APPROVAL_GATE = `### Interaction Protocol — STRICT

1. You suggest first. Propose a concrete result — do not open with "what do you want to do?" The user hired you to be proactive.
2. Debate with the user. They push back; iterate until you both agree.
3. Confirm the final decision explicitly so there is no ambiguity.
4. Wait for EXPLICIT approval. The user must say "approve" (or a clear equivalent like "yes approve this"). "ok", "sounds good", "sure" are NOT approval — ask again.
5. After approval, ensure the output file is written. Then STOP and hand control back — the controller finalizes the step (it calls \`kautopilot complete\`, which records the approval event). Do NOT run any kautopilot command yourself.`;

/**
 * Writer-session gate — used IN PLACE of SHARED_APPROVAL_GATE when a writer step
 * runs deferred: the step prompt is delivered to a separate writer session (via
 * \`kautopilot relay\`) that never talks to the user and never runs kautopilot
 * commands. The two protocols are mutually exclusive; \`approvalGate(ctx)\` picks
 * exactly one. Turn-specific details (working-version path, reply.json path,
 * progress.log path, visual brief) are appended per-turn by the relay engine.
 * (specs/deferred-writer-relay.md §5)
 */
const WRITER_SESSION_GATE = `### Writer-Session Protocol — STRICT

You are the WRITER SESSION for this step. A relay forwards messages between you
and the user — you never talk to the user directly, and you NEVER run any
\`kautopilot\` command (the binary owns versions, approval, and completion).

1. Each turn you receive the user's latest answers/feedback, the WORKING VERSION
   path to edit, and the reply contract (envelope schema + file paths). Do the
   step's work: draft/update the artifact AT THAT PATH (only when actually
   revising), and spike unknowns with your own subagents instead of asking.
2. When a reviewer payload is provided in the message, run every reviewer as a
   parallel subagent on your draft, synthesize, and fix until all approve BEFORE
   finishing a revising turn. Steps without a payload skip this.
3. Generate the visual infographic (vN.html beside the working version; for plans
   one <plan>/vN.html per plan folder) per the provided brief on EVERY revising
   turn — the relay rejects a revised turn without it.
4. NEVER clone or create repos. If a repo isn't found locally, add a questions[]
   entry ("repo X not found — clone it?") and stop that line of work until answered.
5. Everything agreed must live in the ARTIFACT — the discussion transcript does
   not survive epochs; decisions recorded only in conversation are lost.
6. Append one short line to the turn's progress.log at each phase change
   (drafting / reviewers 3/8 / fixing findings / visual / finalizing).
7. End EVERY turn by writing the turn's reply.json exactly per the envelope
   schema as your VERY LAST action — write it atomically (write a temp file, then
   rename it into place) so the relay never reads a half-written file. The relay
   watches for reply.json to appear and reads it the instant it does. A pure Q&A
   turn sets artifact.revised=false and leaves the artifact untouched.
8. Once the phase looks approvable, fill proposedCompletionMetadata from the
   artifact (shape provided) — the main session confirms it with the user; you
   never decide approval.
9. On an approval turn ("the user approved — final consistency check"): verify
   artifact-vs-discussion consistency and metadata WITHOUT revising
   (revised=false) unless something is genuinely broken — a revision forces a
   re-presentation round.`;

/**
 * The interaction-protocol block for a writer step's prompt: the inline approval
 * gate, or the writer-session gate when this step runs deferred. Exactly one is
 * ever present in an assembled prompt.
 */
export function approvalGate(ctx: StepContext, step: string): string {
	return stepExecution(step, ctx.meta, ctx.config) === "deferred"
		? WRITER_SESSION_GATE
		: SHARED_APPROVAL_GATE;
}

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
