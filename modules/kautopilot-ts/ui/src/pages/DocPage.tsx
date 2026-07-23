import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useAsync } from "../hooks/useLiveReload";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import { titleCase } from "../lib/utils";
import { Markdown } from "../components/Markdown";
import { Empty, Skeleton } from "../components/Primitives";
import { VersionToolbar } from "../components/VersionToolbar";

const enc = encodeURIComponent;

function VisualLink({ href }: { href: string }) {
	return (
		<div className="mb-4">
			<a
				href={href}
				className="inline-flex items-center gap-[6px] rounded-md border border-border bg-raised px-[14px] py-[7px] font-semibold text-accent hover:border-accent hover:bg-accent-soft hover:no-underline"
			>
				📊 View visual infographic <ExternalLink size={13} />
			</a>
		</div>
	);
}

function PlanTabs({
	id,
	repo,
	version,
	plans,
}: {
	id: string;
	repo: string;
	version: number | null;
	plans: { name: string; markdown: string; htmlAvailable: boolean }[];
}) {
	const [active, setActive] = useState(0);
	const p = plans[active];
	return (
		<>
			<div className="mb-4 flex flex-wrap gap-[2px] overflow-x-auto border-b border-border">
				{plans.map((pl, i) => (
					<button
						key={pl.name}
						type="button"
						onClick={() => setActive(i)}
						className={`whitespace-nowrap border-b-2 px-3 py-[7px] text-[0.86rem] font-semibold ${
							i === active
								? "border-accent text-accent"
								: "border-transparent text-muted hover:text-fg"
						}`}
					>
						{pl.name}
					</button>
				))}
			</div>
			{p.htmlAvailable && (
				<VisualLink
					href={`/sessions/${enc(id)}/html/plans/${enc(repo)}/${enc(p.name)}${
						version ? `/v/${version}` : ""
					}`}
				/>
			)}
			<Markdown>{p.markdown}</Markdown>
		</>
	);
}

export function DocPage({
	id,
	kind,
	repo,
	version,
	tick,
}: {
	id: string;
	kind: string | null;
	repo: string | null;
	version: number | null;
	tick: number;
}) {
	const isPlan = repo != null;
	const { data, error, loading } = useAsync(
		() =>
			isPlan
				? api.plans(id, repo, version)
				: api.doc(id, kind as string, version),
		[id, kind, repo, version, tick],
	);
	const label = isPlan ? `Plans · ${repo}` : titleCase(kind || "");
	const base = isPlan
		? `/sessions/${enc(id)}/plans/${enc(repo)}`
		: `/sessions/${enc(id)}/${kind}`;

	if (loading) return <Skeleton rows={3} />;
	if (error || !data)
		return (
			<Empty title="Not found">
				<Link href={`/sessions/${enc(id)}`}>← Back to session</Link>
			</Empty>
		);

	const isTicket = kind === "ticket" || kind === "ticket-draft";
	return (
		<div className="mx-auto max-w-prose">
			<div className="mb-4">
				<h1 className="text-[1.25rem] font-semibold tracking-[-0.01em]">
					{label}
					{data.version && (
						<span className="ml-2 text-[0.7em] font-medium text-muted">
							v{data.version}
						</span>
					)}
				</h1>
			</div>
			<VersionToolbar
				baseHref={base}
				current={data.version}
				versions={data.versions}
				diffHref={isTicket ? null : `${base}/diff`}
			/>
			{!isPlan && data.htmlAvailable && (
				<VisualLink
					href={`/sessions/${enc(id)}/html/${kind}${
						data.version ? `/v/${data.version}` : ""
					}`}
				/>
			)}
			{isPlan && data.plans && data.plans.length > 0 ? (
				<PlanTabs id={id} repo={repo} version={data.version} plans={data.plans} />
			) : data.markdown.trim() ? (
				<Markdown>{data.markdown}</Markdown>
			) : (
				<Empty>No content yet.</Empty>
			)}
		</div>
	);
}
