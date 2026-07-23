import { useState } from "react";
import { useAsync } from "../hooks/useLiveReload";
import { diffRows } from "../lib/diff";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import { Badge, Empty, Skeleton } from "../components/Primitives";
import { Markdown } from "../components/Markdown";

const enc = encodeURIComponent;

function DiffCell({ md, type }: { md: string; type: string }) {
	const bg =
		type === "del" ? "bg-del-bg" : type === "add" ? "bg-add-bg" : "";
	return (
		<div className={`min-w-0 border-t border-border-soft ${bg}`}>
			{md.trim() ? (
				<Markdown allowHtml className="px-[10px] py-px !text-[13.5px]">
					{md}
				</Markdown>
			) : (
				<div className="px-[10px]">&nbsp;</div>
			)}
		</div>
	);
}

export function DiffPage({
	id,
	kind,
	repo,
	tick,
}: {
	id: string;
	kind: string | null;
	repo: string | null;
	tick: number;
}) {
	const [search, setSearch] = useState(() => window.location.search);
	const [layout, setLayout] = useState<"side" | "inline">(() =>
		window.matchMedia("(max-width: 720px)").matches ? "inline" : "side",
	);
	const { data, error, loading } = useAsync(
		() => api.diff(id, kind, repo, search),
		[id, kind, repo, search, tick],
	);
	const label = repo ? `Plans · ${repo}` : kind || "";
	const backHref = repo
		? `/sessions/${enc(id)}/plans/${enc(repo)}`
		: `/sessions/${enc(id)}/${kind}`;

	function setVersions(from: number, to: number) {
		const s = `?from=${from}&to=${to}`;
		window.history.replaceState(null, "", window.location.pathname + s);
		setSearch(s);
	}

	if (loading) return <Skeleton rows={1} />;
	if (error || !data)
		return (
			<Empty title="Not found">
				<Link href={backHref}>← Back</Link>
			</Empty>
		);

	const rows = diffRows(data.fromMarkdown || "", data.toMarkdown || "");
	const vers = data.versions || [];
	return (
		<div className="mx-auto max-w-prose">
			<div className="mb-3 flex items-center gap-2 text-[0.9rem]">
				<Badge tone="accent" pip>
					Diff
				</Badge>
				<strong>{label}</strong>
				{data.fromVersion && data.toVersion && (
					<span className="font-mono font-semibold">
						v{data.fromVersion} → v{data.toVersion}
					</span>
				)}
			</div>

			<div className="mb-4 flex flex-wrap gap-3">
				{vers.length > 1 && (
					<div className="inline-flex items-center gap-2">
						<span className="text-[0.66rem] font-semibold uppercase tracking-[0.04em] text-muted">
							old
						</span>
						<select
							className="rounded-sm border border-border bg-surface px-[6px] py-[3px] text-[0.78rem] text-fg"
							value={data.fromVersion}
							onChange={(e) =>
								setVersions(Number(e.target.value), data.toVersion)
							}
						>
							{vers.map((v) => (
								<option key={v} value={v}>
									v{v}
								</option>
							))}
						</select>
						<span className="text-muted">→</span>
						<span className="text-[0.66rem] font-semibold uppercase tracking-[0.04em] text-muted">
							new
						</span>
						<select
							className="rounded-sm border border-border bg-surface px-[6px] py-[3px] text-[0.78rem] text-fg"
							value={data.toVersion}
							onChange={(e) =>
								setVersions(data.fromVersion, Number(e.target.value))
							}
						>
							{vers.map((v) => (
								<option key={v} value={v}>
									v{v}
								</option>
							))}
						</select>
					</div>
				)}
				<div className="hidden overflow-hidden rounded-sm border border-border sm:inline-flex">
					{(["side", "inline"] as const).map((l) => (
						<button
							key={l}
							type="button"
							onClick={() => setLayout(l)}
							className={`border-r border-border px-[11px] py-1 text-[0.78rem] last:border-r-0 ${
								layout === l
									? "bg-accent-soft font-semibold text-accent"
									: "bg-surface text-muted"
							}`}
						>
							{l === "side" ? "Side-by-side" : "Inline"}
						</button>
					))}
				</div>
			</div>

			{layout === "side" ? (
				<div className="grid grid-cols-2 overflow-hidden rounded-md border border-border text-[0.84rem] leading-[1.5]">
					<div className="border-r border-b border-border bg-surface-2 px-[10px] py-1 font-mono text-[0.76rem] font-semibold text-muted">
						v{data.fromVersion} · old
					</div>
					<div className="border-b border-border bg-surface-2 px-[10px] py-1 font-mono text-[0.76rem] font-semibold text-muted">
						v{data.toVersion} · new
					</div>
					{rows.map((row, i) => (
						<DiffPair key={i} row={row} sideBySide />
					))}
				</div>
			) : (
				<div className="overflow-hidden rounded-md border border-border text-[0.84rem] leading-[1.5]">
					{rows.map((row, i) => (
						<DiffPair key={i} row={row} sideBySide={false} />
					))}
				</div>
			)}
		</div>
	);
}

function DiffPair({
	row,
	sideBySide,
}: {
	row: { type: string; l: string; r: string };
	sideBySide: boolean;
}) {
	if (sideBySide)
		return (
			<>
				<DiffCell md={row.l} type={row.type === "mod" ? "del" : row.type} />
				<div className="border-l border-border">
					<DiffCell md={row.r} type={row.type === "mod" ? "add" : row.type} />
				</div>
			</>
		);
	// inline (unified)
	if (row.type === "eq") return <DiffCell md={row.l} type="eq" />;
	if (row.type === "del") return <DiffCell md={row.l} type="del" />;
	if (row.type === "add") return <DiffCell md={row.r} type="add" />;
	return (
		<>
			<DiffCell md={row.l} type="del" />
			<DiffCell md={row.r} type="add" />
		</>
	);
}
