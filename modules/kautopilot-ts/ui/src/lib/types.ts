// Client mirrors of the `kautopilot serve` /api JSON shapes. Kept deliberately
// loose where the server already validates (config), strict where the UI needs
// the fields.

export interface RepoBrief {
	repo: string;
	status: string;
	prNumber: number | null;
	prUrl: string | null;
}

/** Pipeline/run modes surfaced as opaque strings so a new mode (e.g. "fast")
 *  renders with zero UI changes when the pipeline adds it. */
export interface SessionModes {
	run: string | null;
	exec: string | null;
	merge: string | null;
	writer: string | null;
	/** Forward-compat: the pipeline mode field, read defensively (null today). */
	pipeline: string | null;
}

export interface SessionSummary {
	id: string;
	ticketId: string;
	org: string;
	ticketSystem: string;
	epoch: number;
	phase: string;
	repos: RepoBrief[];
	modes: SessionModes;
}

export interface RevisionInfo {
	version: number;
	epoch: number | null;
}

export interface DagProgress {
	plan: string;
	repo: string;
	status: string;
	kloopRunId?: string | null;
	prUrl?: string | null;
}

export interface DagView {
	mermaid: string;
	mergeMode: string;
	progress: DagProgress[];
}

export interface SessionDetail {
	meta: Record<string, unknown> & {
		sessionId: string;
		ticketId: string;
		org: string;
		ticketSystem: string;
		baseBranch: string;
		epoch: number;
		repos: RepoBrief[];
	};
	phase: string;
	state: string;
	modes: SessionModes;
	artifacts: {
		ticket: boolean;
		ticketDraft: boolean;
		brainstorm: RevisionInfo[];
		triage: RevisionInfo[];
		spec: RevisionInfo[];
		masterPlan: RevisionInfo[];
		feedback: RevisionInfo[];
		plans: Record<string, RevisionInfo[]>;
		kloopRuns: string[];
	};
	dag: DagView | null;
}

export interface DocView {
	markdown: string;
	version: number | null;
	versions: RevisionInfo[];
	plans?: { name: string; markdown: string; htmlAvailable: boolean }[];
	htmlAvailable?: boolean;
}

export interface DiffView {
	kind: string;
	fromVersion: number;
	toVersion: number;
	fromMarkdown: string;
	toMarkdown: string;
	versions: number[];
}

export interface DiscussionTurn {
	turn: number;
	state: string;
	sentAt?: string;
	repliedAt?: string;
	attempts: number;
	elapsedMs: number | null;
	lastProgress: string | null;
	kteamSessionId?: string;
	userMessage: string | null;
	approval: boolean;
	envelope: {
		summary?: string;
		artifact?: { kind: string; version: number };
		answers?: { question: string; answer: string }[];
		questions?: { text: string }[];
		links?: { read?: string; diff?: string; visual?: string };
	} | null;
}

export interface WriterState {
	phaseKey: string;
	account: string;
	kteamSessionId?: string;
	status: string;
	turns: number;
	createdAt: string;
	updatedAt: string;
}

export interface Discussion {
	phaseKey: string;
	writer: WriterState | null;
	turns: DiscussionTurn[];
}

export interface ServerMeta {
	version: string;
	kloopBase: string;
	kteamBase: string;
}

/** The config surface the pane edits. Prompts/templates are preserved server
 *  side (round-tripped) and not exposed here. */
export interface ConfigView {
	settings: {
		maxPushCycles: number;
		pollInterval: number;
		coderabbit: boolean;
		maxParallelRepos: number;
		runMode: string;
		execMode: string;
		viewerBaseUrl: string;
		kloopBaseUrl: string;
		viewerPort: number;
	};
	writer: {
		mode: string;
		steps: string[];
		pool: Record<string, number>;
		reviewerModel: string | null;
		turnTimeoutMins: number;
		maxTurnRetries: number;
		visualBriefPath: string;
	};
	orgs: Record<
		string,
		{ ticketSystem: string; commitSpec: boolean; baseBranch: string }
	>;
	/** Reviewer definitions (read-only display; name + one-line desc). */
	reviewers: {
		spec: { name: string; desc: string }[];
		plan: { name: string; desc: string }[];
	};
	/** Available writer-step names (for the steps multi-select). */
	writerSteps: string[];
}

export interface ConfigResponse {
	config: ConfigView;
	/** Fleet wrapper binaries under ~/.kfleet/bin (claude-* and codex-* only). */
	wrappers: string[];
	/** Opaque revision token (config file mtime) for optimistic concurrency. */
	revision: number | null;
}

export interface ConfigSaveResult {
	ok: boolean;
	errors?: string[];
	/** True when the write was refused because the file changed since load. */
	conflict?: boolean;
	revision?: number | null;
}
