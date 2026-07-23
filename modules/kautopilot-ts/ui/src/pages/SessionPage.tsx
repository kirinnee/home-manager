import { ExternalLink } from "lucide-react";
import { useAsync } from "../hooks/useLiveReload";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import type {
	Discussion,
	RevisionInfo,
	ServerMeta,
	SessionDetail,
} from "../lib/types";
import { phaseTone, tone } from "../lib/utils";
import { Mermaid } from "../components/Mermaid";
import {
	Badge,
	Empty,
	RepoChip,
	SectionTitle,
	Skeleton,
} from "../components/Primitives";
import { ModeBadges } from "./SessionsListPage";

const enc = encodeURIComponent;

function latest(revs: RevisionInfo[]): number | null {
	return revs.length ? revs[revs.length - 1].version : null;
}
function maxEpoch(revs: RevisionInfo[]): number | null {
	const es = revs.map((r) => r.epoch).filter((e): e is number => e != null);
	return es.length ? Math.max(...es) : null;
}

function ArtifactRow({
	href,
	label,
	revs,
	diffHref,
}: {
	href: string;
	label: string;
	revs?: RevisionInfo[];
	diffHref?: string;
}) {
	const v = revs ? latest(revs) : null;
	const ep = revs ? maxEpoch(revs) : null;
	return (
		<div className="flex items-center gap-3 border-t border-border-soft px-4 py-2 first:border-t-0 hover:bg-surface-2">
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold">
				<Link href={href} className="text-fg hover:text-accent hover:no-underline">
					{label}
				</Link>
			</span>
			{revs && (
				<span className="flex flex-shrink-0 items-center gap-2 text-[11.5px] text-muted">
					<Badge tone="accent">v{v ?? "—"}</Badge>
					{ep != null && <span>epoch {ep}</span>}
					{diffHref && revs.length > 1 && (
						<>
							<span className="opacity-50">·</span>
							<Link href={diffHref} className="font-semibold">
								diff
							</Link>
						</>
					)}
				</span>
			)}
		</div>
	);
}

/** A deep-link to the kteam chat page for a writer/reviewer kteam session,
 *  with teammate (account) name + live status. */
function KteamLink({
	kteamBase,
	sessionId,
	account,
	status,
}: {
	kteamBase: string;
	sessionId: string;
	account: string;
	status: string;
}) {
	return (
		<a
			href={`${kteamBase}/session/${enc(sessionId)}`}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-[6px] rounded-full border border-accent-border bg-accent-soft px-[9px] py-[2px] text-[0.76rem] text-accent hover:bg-accent hover:text-accent-fg hover:no-underline"
			title={`kteam session ${sessionId}`}
		>
			<span className="font-mono">{account}</span>
			<Badge tone={tone(status)} pip>
				{status}
			</Badge>
			<ExternalLink size={12} />
		</a>
	);
}

function Writers({
	id,
	meta,
	tick,
}: {
	id: string;
	meta: ServerMeta;
	tick: number;
}) {
	const { data: phases } = useAsync(() => api.discussionPhases(id), [id, tick]);
	const { data: discussions } = useAsync(async () => {
		if (!phases || phases.length === 0) return [] as Discussion[];
		return Promise.all(phases.map((p) => api.discussion(id, p)));
	}, [id, tick, phases?.join(",")]);
	if (!phases || phases.length === 0) return null;
	return (
		<>
			<SectionTitle>Writers &amp; discussions</SectionTitle>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				{phases.map((p, i) => {
					const d = discussions?.[i];
					const w = d?.writer;
					return (
						<div
							key={p}
							className="flex items-center gap-3 border-t border-border-soft px-4 py-2 first:border-t-0 hover:bg-surface-2"
						>
							<span className="min-w-0 flex-1 text-[13px] font-semibold">
								<Link
									href={`/sessions/${enc(id)}/discussion/${enc(p)}`}
									className="text-fg hover:text-accent hover:no-underline"
								>
									{p.replace(/_/g, " ")}
								</Link>
							</span>
							<span className="flex flex-shrink-0 items-center gap-2">
								{w?.kteamSessionId ? (
									<KteamLink
										kteamBase={meta.kteamBase}
										sessionId={w.kteamSessionId}
										account={w.account}
										status={w.status}
									/>
								) : (
									w && <Badge tone={tone(w.status)}>{w.status}</Badge>
								)}
							</span>
						</div>
					);
				})}
			</div>
		</>
	);
}

export function SessionPage({
	id,
	meta,
	tick,
}: {
	id: string;
	meta: ServerMeta;
	tick: number;
}) {
	const { data, error, loading } = useAsync(() => api.session(id), [id, tick]);
	if (loading) return <Skeleton rows={4} />;
	if (error || !data)
		return (
			<Empty title="Not found">
				No session <code>{id}</code>.{" "}
				<Link href="/">← Back to sessions</Link>
			</Empty>
		);
	const d: SessionDetail = data;
	const m = d.meta;
	const a = d.artifacts;
	const docKinds: { key: keyof typeof a; kind: string; label: string }[] = [
		{ key: "brainstorm", kind: "brainstorm", label: "Brainstorm" },
		{ key: "triage", kind: "triage", label: "Triage" },
		{ key: "spec", kind: "spec", label: "Spec" },
		{ key: "masterPlan", kind: "master_plan", label: "Master plan" },
		{ key: "feedback", kind: "feedback", label: "Feedback" },
	];
	const artRows: React.ReactNode[] = [];
	if (a.ticket)
		artRows.push(
			<ArtifactRow key="ticket" href={`/sessions/${enc(id)}/ticket`} label="Ticket" />,
		);
	if (a.ticketDraft && a.brainstorm.length)
		artRows.push(
			<ArtifactRow
				key="ticket-draft"
				href={`/sessions/${enc(id)}/ticket-draft`}
				label="Ticket draft"
			/>,
		);
	for (const dk of docKinds) {
		const revs = a[dk.key] as RevisionInfo[];
		if (revs && revs.length) {
			const base = `/sessions/${enc(id)}/${dk.kind}`;
			artRows.push(
				<ArtifactRow
					key={dk.kind}
					href={`${base}/v${latest(revs)}`}
					label={dk.label}
					revs={revs}
					diffHref={`${base}/diff`}
				/>,
			);
		}
	}
	for (const repo of Object.keys(a.plans)) {
		const revs = a.plans[repo];
		const base = `/sessions/${enc(id)}/plans/${enc(repo)}`;
		const v = latest(revs);
		artRows.push(
			<ArtifactRow
				key={`plans-${repo}`}
				href={v ? `${base}/v${v}` : base}
				label={`Plans · ${repo}`}
				revs={revs}
				diffHref={`${base}/diff`}
			/>,
		);
	}

	return (
		<>
			<div className="mb-4">
				<h1 className="mb-2 text-[1.25rem] font-semibold tracking-[-0.01em]">
					<Link
						href={`/sessions/${enc(id)}/ticket`}
						className="text-inherit hover:text-accent hover:no-underline"
					>
						{m.ticketId || id}
					</Link>
				</h1>
				<div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
					<span>
						{m.ticketSystem ? `${m.org} · ${m.ticketSystem}` : m.org}
					</span>
					<span className="opacity-50">·</span>
					<Badge tone={phaseTone(d.phase)} pip>
						{d.phase} ({d.state})
					</Badge>
					<span className="opacity-50">·</span>
					<span>epoch {m.epoch}</span>
					<span className="opacity-50">·</span>
					<span>base {m.baseBranch}</span>
					<ModeBadges modes={d.modes} />
				</div>
				{m.repos.length > 0 && (
					<div className="mt-[10px] flex flex-wrap gap-2">
						{m.repos.map((r) => (
							<RepoChip key={r.repo} r={r} />
						))}
					</div>
				)}
			</div>

			{a.kloopRuns.length > 0 && (
				<div className="mb-3 flex flex-wrap gap-2">
					{a.kloopRuns.map((rid) => (
						<a
							key={rid}
							href={`${meta.kloopBase}/kloop/${enc(rid)}`}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-[5px] rounded-full border border-accent-border bg-accent-soft px-[9px] py-[2px] font-mono text-[0.76rem] text-accent hover:bg-accent hover:text-accent-fg hover:no-underline"
						>
							🔁 {rid}
						</a>
					))}
				</div>
			)}

			<SectionTitle>Artifacts</SectionTitle>
			{artRows.length === 0 ? (
				<Empty>No artifacts yet.</Empty>
			) : (
				<div className="overflow-hidden rounded-md border border-border bg-surface">
					{artRows}
				</div>
			)}

			{d.dag && (
				<>
					<SectionTitle>
						Orchestration DAG
						<Badge tone="pend" className="ml-2 normal-case">
							merge: {d.dag.mergeMode}
						</Badge>
					</SectionTitle>
					<Mermaid code={d.dag.mermaid} />
					{d.dag.progress.length > 0 && (
						<div className="mt-3 overflow-hidden rounded-md border border-border bg-surface">
							{d.dag.progress.map((p, i) => (
								<div
									key={`${p.repo}-${p.plan}-${i}`}
									className="flex items-center gap-3 border-t border-border-soft px-4 py-2 text-[12.5px] first:border-t-0"
								>
									<span className="flex-1 font-mono text-fg-soft">
										{p.repo} · {p.plan}
									</span>
									{p.kloopRunId && (
										<a
											href={`${meta.kloopBase}/kloop/${enc(p.kloopRunId)}`}
											target="_blank"
											rel="noopener noreferrer"
											className="font-mono text-[0.72rem] text-accent"
										>
											🔁 {p.kloopRunId}
										</a>
									)}
									<Badge tone={tone(p.status)} pip>
										{p.status}
									</Badge>
								</div>
							))}
						</div>
					)}
				</>
			)}

			<Writers id={id} meta={meta} tick={tick} />
		</>
	);
}
