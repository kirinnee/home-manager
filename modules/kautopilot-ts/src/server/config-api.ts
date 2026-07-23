import {
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { resolveConfig, serializeConfigWithComments } from "../core/config";
import { type Config, configSchema, DEFAULT_CONFIG } from "../core/types";

// ============================================================================
// Config read/write for the web UI's config pane. Stays entirely in the serve
// layer: it reads via the exported resolveConfig, validates with the exported
// configSchema, and persists with the exported serializeConfigWithComments —
// touching no core pipeline code. Only `settings` and `writer` are editable
// from the UI; prompts/templates/orgs round-trip untouched.
// ============================================================================

function globalConfigPath(): string {
	return `${process.env.HOME}/.kautopilot/config.yaml`;
}

function fleetBinDir(): string {
	return `${process.env.HOME}/.kfleet/bin`;
}

/** Fleet wrapper binaries kteam accepts as harnesses (claude-* / codex-*),
 *  sorted. Empty when ~/.kfleet/bin is absent (sandbox). */
export function listWrappers(): string[] {
	try {
		return readdirSync(fleetBinDir())
			.filter((n) => /^(claude|codex)-/.test(n))
			.filter((n) => {
				try {
					return statSync(`${fleetBinDir()}/${n}`).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

/** Current global config, or the built-in defaults when no config file exists
 *  yet (the pane can then create one on save). */
function currentConfig(): Config {
	try {
		return resolveConfig();
	} catch {
		return DEFAULT_CONFIG;
	}
}

export interface ConfigView {
	settings: Config["settings"];
	writer: Config["writer"];
	orgs: Config["orgs"];
	reviewers: {
		spec: { name: string; desc: string }[];
		plan: { name: string; desc: string }[];
	};
	writerSteps: string[];
}

function toView(config: Config): ConfigView {
	const rev = (m: Record<string, { desc: string }>) =>
		Object.entries(m).map(([name, r]) => ({ name, desc: r.desc }));
	return {
		settings: config.settings,
		writer: config.writer,
		orgs: config.orgs,
		reviewers: {
			spec: rev(config.agents.phase1.spec_reviewers),
			plan: rev(config.agents.phase1.plan_reviewers),
		},
		// Derived from defaults so a new step (e.g. fast_plan) appears with no
		// change here when the pipeline adds it.
		writerSteps: [...DEFAULT_CONFIG.writer.steps],
	};
}

/** Config file mtime (ms) as an opaque revision token for optimistic
 *  concurrency, or null when the file does not exist yet. */
function configRevision(): number | null {
	try {
		return statSync(globalConfigPath()).mtimeMs;
	} catch {
		return null;
	}
}

export function readConfigResponse(): {
	config: ConfigView;
	wrappers: string[];
	revision: number | null;
} {
	return {
		config: toView(currentConfig()),
		wrappers: listWrappers(),
		revision: configRevision(),
	};
}

export interface ConfigPatch {
	settings?: Partial<Config["settings"]>;
	writer?: Partial<Config["writer"]>;
	/**
	 * Optimistic-concurrency guard: the `revision` the client last read from GET.
	 * When present and it no longer matches the file's current mtime, the PUT is
	 * rejected as a conflict rather than silently clobbering a concurrent edit.
	 */
	expectedRevision?: number | null;
}

export interface ConfigSaveResult {
	ok: boolean;
	errors?: string[];
	/** True when the write was refused because the file changed since GET. */
	conflict?: boolean;
	/** The config revision after a successful write (or the current one on conflict). */
	revision?: number | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	v != null && typeof v === "object" && !Array.isArray(v);

/** Validate the wire shape of the editable sections BEFORE merging, so a
 *  malformed body (e.g. `writer.pool: null`) is a clean 400 rather than a 500
 *  from a downstream spread / Object.keys on a non-object. */
function validatePatchShape(patch: ConfigPatch): string[] {
	const errs: string[] = [];
	if (patch.settings !== undefined && !isPlainObject(patch.settings))
		errs.push("settings must be an object");
	if (patch.writer !== undefined && !isPlainObject(patch.writer))
		errs.push("writer must be an object");
	if (isPlainObject(patch.writer)) {
		const w = patch.writer as Record<string, unknown>;
		if (w.pool !== undefined && !isPlainObject(w.pool))
			errs.push("writer.pool must be an object");
		if (w.steps !== undefined && !Array.isArray(w.steps))
			errs.push("writer.steps must be an array");
	}
	return errs;
}

/**
 * Apply a settings/writer patch to the global config and persist it. Order is
 * defensive: wire-shape guard → optimistic-concurrency check → merge → schema
 * validation → wrapper-pool validation → atomic write. Nothing dereferences an
 * unvalidated shape, so a malformed body is always a 400, never a 500.
 */
export function saveConfigPatch(patch: ConfigPatch): ConfigSaveResult {
	if (!isPlainObject(patch))
		return { ok: false, errors: ["invalid patch body"] };

	const shapeErrors = validatePatchShape(patch);
	if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };

	// Optimistic concurrency: refuse if the file changed since the client's GET.
	if (patch.expectedRevision !== undefined) {
		const current = configRevision();
		if ((patch.expectedRevision ?? null) !== current)
			return {
				ok: false,
				conflict: true,
				revision: current,
				errors: [
					"config changed on disk since you loaded it — reload and retry",
				],
			};
	}

	const base = currentConfig();
	const merged: Config = {
		...base,
		settings: { ...base.settings, ...(patch.settings ?? {}) },
		writer: { ...base.writer, ...(patch.writer ?? {}) },
	};

	// Schema-validate FIRST so no code below dereferences an invalid shape.
	const parsed = configSchema.safeParse(merged);
	if (!parsed.success)
		return {
			ok: false,
			errors: parsed.error.issues.map(
				(i) => `${i.path.join(".")}: ${i.message}`,
			),
		};

	// Wrapper-pool validation on the validated data (best-effort: skip when
	// ~/.kfleet/bin is unreadable so a sandbox without it still saves).
	const errors: string[] = [];
	const pool = parsed.data.writer.pool;
	const wrappers = new Set(listWrappers());
	if (wrappers.size > 0)
		for (const account of Object.keys(pool))
			if (!wrappers.has(account))
				errors.push(`writer.pool: unknown wrapper "${account}"`);
	if (Object.keys(pool).length === 0)
		errors.push("writer.pool must have at least one account");
	if (errors.length > 0) return { ok: false, errors };

	const path = globalConfigPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		// Atomic write (temp + rename) so a concurrent reader never sees a partial
		// file and the swap is a single inode replacement.
		const tmp = `${path}.tmp.${process.pid}`;
		writeFileSync(tmp, serializeConfigWithComments(parsed.data));
		renameSync(tmp, path);
	} catch (err) {
		return {
			ok: false,
			errors: [err instanceof Error ? err.message : String(err)],
		};
	}
	return { ok: true, revision: configRevision() };
}
