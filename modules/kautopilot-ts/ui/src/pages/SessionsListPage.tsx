import { useAsync } from "../hooks/useLiveReload";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import type { SessionModes } from "../lib/types";
import { phaseTone } from "../lib/utils";
import { Badge, Empty, RepoChip, Skeleton } from "../components/Primitives";

/** Non-null mode values as short badges. Pipeline mode (when the pipeline adds
 *  one) shows first and accented; everything else is a plain string. */
export function ModeBadges({ modes }: { modes: SessionModes }) {
	const items: { label: string; accent?: boolean }[] = [];
	if (modes.pipeline) items.push({ label: modes.pipeline, accent: true });
	if (modes.writer) items.push({ label: `writer: ${modes.writer}` });
	if (modes.exec) items.push({ label: `exec: ${modes.exec}` });
	if (modes.merge) items.push({ label: `merge: ${modes.merge}` });
	if (items.length === 0) return null;
	return (
		<>
			{items.map((it, i) => (
				<Badge key={i} tone={it.accent ? "accent" : "pend"}>
					{it.label}
				</Badge>
			))}
		</>
	);
}

export function SessionsListPage({ tick }: { tick: number }) {
	const { data, error, loading } = useAsync(() => api.listSessions(), [tick]);
	return (
		<>
			<div className="mb-4">
				<h1 className="mb-2 text-[1.25rem] font-semibold tracking-[-0.01em]">
					Sessions
				</h1>
				<div className="text-[12.5px] text-muted">kautopilot autopilot runs</div>
			</div>
			{loading && <Skeleton rows={4} />}
			{error && <Empty title="Error">{error}</Empty>}
			{!loading && !error && (!data || data.length === 0) && (
				<Empty title="No sessions yet">
					Start an autopilot run and it will show up here.
				</Empty>
			)}
			{data && data.length > 0 && (
				<div className="overflow-hidden rounded-md border border-border bg-surface">
					{data.map((s) => (
						<Link
							key={s.id}
							href={`/sessions/${encodeURIComponent(s.id)}`}
							className="flex items-center gap-3 border-t border-border-soft px-4 py-[9px] text-fg first:border-t-0 hover:bg-surface-2 hover:no-underline"
						>
							<span className="flex min-w-0 flex-1 flex-col gap-[3px]">
								<span className="text-[13.5px] font-semibold tracking-[-0.01em] text-fg">
									{s.ticketId}
								</span>
								<span className="text-[11.5px] leading-[1.3] text-muted">
									{s.ticketSystem
										? `${s.org} · ${s.ticketSystem}`
										: s.org}{" "}
									· epoch {s.epoch} · {s.id}
								</span>
							</span>
							<span className="flex flex-wrap items-center justify-end gap-2">
								{s.repos.length > 0 && (
									<span className="flex flex-wrap justify-end gap-[5px]">
										{s.repos.map((r) => (
											<RepoChip key={r.repo} r={r} />
										))}
									</span>
								)}
								<ModeBadges modes={s.modes} />
								<Badge tone={phaseTone(s.phase)} pip>
									{s.phase}
								</Badge>
							</span>
						</Link>
					))}
				</div>
			)}
		</>
	);
}
