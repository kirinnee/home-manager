import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactKind } from "../revisions";
import { htmlRevisionExists, plansRepoDir, revisionPath } from "../revisions";
import { type Envelope, envelopeSchema } from "../types";

// ============================================================================
// Envelope validation: schema (zod, mobile-first caps) + side-effect checks
// against the session store — the reply is only trusted once the disk agrees
// with what it claims. (specs/deferred-writer-relay.md §6)
// ============================================================================

export interface EnvelopeCheck {
	ok: boolean;
	envelope?: Envelope;
	errors: string[];
}

/**
 * Validate a raw reply.json against the schema and the phase's disk state.
 * `workingVersion` is the version the relay handed out this turn; a `revised`
 * turn must have produced that version's artifact + visual(s).
 */
export function validateEnvelope(params: {
	raw: unknown;
	sessionId: string;
	kind: ArtifactKind;
	epoch: number;
	repo: string | null;
	workingVersion: number;
}): EnvelopeCheck {
	const { raw, sessionId, kind, epoch, repo, workingVersion } = params;
	const parsed = envelopeSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map(
				(i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
			),
		};
	}
	const env = parsed.data;
	const errors: string[] = [];

	if (env.artifact.kind !== kind) {
		errors.push(
			`artifact.kind must be "${kind}" (the current phase), got "${env.artifact.kind}"`,
		);
	}
	if (env.artifact.version !== workingVersion) {
		errors.push(
			`artifact.version must be ${workingVersion} (the working version you were handed), got ${env.artifact.version}`,
		);
	}

	if (env.artifact.revised) {
		errors.push(
			...checkRevisedSideEffects(sessionId, kind, epoch, repo, workingVersion),
		);
	}

	return errors.length
		? { ok: false, envelope: env, errors }
		: { ok: true, envelope: env, errors: [] };
}

/** A revised turn must have a non-trivial artifact + the visual(s) on disk. */
function checkRevisedSideEffects(
	sessionId: string,
	kind: ArtifactKind,
	epoch: number,
	repo: string | null,
	n: number,
): string[] {
	const errors: string[] = [];
	if (kind === "plans") {
		const dir = plansRepoDir(sessionId, epoch, repo ?? "default");
		if (!existsSync(dir)) {
			return [`plans dir not found: ${dir}`];
		}
		const plans = readdirSync(dir).filter((p) => {
			try {
				return statSync(join(dir, p)).isDirectory();
			} catch {
				return false;
			}
		});
		const withVersion = plans.filter((p) =>
			existsSync(join(dir, p, `v${n}.md`)),
		);
		if (withVersion.length === 0) {
			errors.push(`no plan folder contains v${n}.md under ${dir}`);
		}
		for (const p of withVersion) {
			if (!existsSync(join(dir, p, `v${n}.html`))) {
				errors.push(
					`plan "${p}" is missing its visual (${p}/v${n}.html) — every plan needs one`,
				);
			}
		}
		return errors;
	}
	const ref = kind === "brainstorm" ? {} : { epoch };
	const path = revisionPath(sessionId, kind, n, ref);
	if (!existsSync(path)) {
		errors.push(`revision file not found: ${path}`);
	} else if (readFileSync(path, "utf-8").trim().length < 40) {
		errors.push(
			`revision ${path} looks empty/blank — a revised turn must contain the real artifact`,
		);
	}
	if (!htmlRevisionExists(sessionId, kind, n, ref)) {
		errors.push(
			`visual not found: v${n}.html beside the revision — generate it per the brief before finishing a revised turn`,
		);
	}
	return errors;
}
