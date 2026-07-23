import { ExternalLink } from "lucide-react";
import { useAsync } from "../hooks/useLiveReload";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import type { DiscussionTurn, ServerMeta } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { Badge, Empty, Skeleton } from "../components/Primitives";

const enc = encodeURIComponent;

function statusBadge(turns: DiscussionTurn[], writerStatus?: string) {
	const last = turns.length ? turns[turns.length - 1] : null;
	if (writerStatus === "running" || last?.state === "running")
		return { tone: "warn" as const, label: "writing…" };
	if (last?.state === "replied")
		return { tone: "ok" as const, label: "waiting for you" };
	if (writerStatus === "failed")
		return { tone: "err" as const, label: "failed" };
	return null;
}

export function DiscussionPage({
	id,
	phaseKey,
	meta,
	tick,
}: {
	id: string;
	phaseKey: string;
	meta: ServerMeta;
	tick: number;
}) {
	const { data, error, loading } = useAsync(
		() => api.discussion(id, phaseKey),
		[id, phaseKey, tick],
	);
	if (loading) return <Skeleton rows={3} />;
	if (error || !data)
		return (
			<Empty title="Not found">
				<Link href={`/sessions/${enc(id)}`}>← Back to session</Link>
			</Empty>
		);
	const w = data.writer;
	const badge = statusBadge(data.turns, w?.status);
	return (
		<div className="mx-auto max-w-prose">
			<div className="mb-4">
				<h1 className="text-[1.25rem] font-semibold tracking-[-0.01em]">
					Discussion{" "}
					<span className="text-[0.7em] font-medium text-muted">{phaseKey}</span>
				</h1>
				<div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
					{w ? (
						<>
							<span className="font-mono">{w.account}</span>
							<span className="opacity-50">·</span>
							<span>{w.turns} turns</span>
							{badge && (
								<>
									<span className="opacity-50">·</span>
									<Badge tone={badge.tone} pip>
										{badge.label}
									</Badge>
								</>
							)}
							{w.kteamSessionId && (
								<a
									href={`${meta.kteamBase}/session/${enc(w.kteamSessionId)}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-[6px] rounded-full border border-accent-border bg-accent-soft px-[10px] py-[3px] text-[0.76rem] font-semibold text-accent hover:bg-accent hover:text-accent-fg hover:no-underline"
								>
									Open in kteam <ExternalLink size={12} />
								</a>
							)}
						</>
					) : (
						<span>no writer yet</span>
					)}
				</div>
			</div>
			{data.turns.length === 0 ? (
				<Empty>No turns yet.</Empty>
			) : (
				<div className="grid gap-3">
					{data.turns.map((t) => (
						<Turn key={t.turn} t={t} />
					))}
				</div>
			)}
		</div>
	);
}

function Turn({ t }: { t: DiscussionTurn }) {
	const mins = t.elapsedMs != null ? `${Math.round(t.elapsedMs / 60000)}m` : "";
	const env = t.envelope;
	return (
		<div className="grid gap-2">
			{(t.userMessage || t.approval) && (
				<div className="max-w-[720px] justify-self-end rounded-md border border-accent-border bg-accent-soft px-4 py-[10px] text-[0.9rem] leading-[1.55]">
					<div className="mb-1 text-[0.72rem] text-muted">
						turn {t.turn} · you{t.approval ? " · approval" : ""}
					</div>
					<div>
						{t.userMessage || "(approved — final consistency check)"}
					</div>
				</div>
			)}
			{env ? (
				<div className="max-w-[720px] justify-self-start rounded-md border border-border bg-surface px-4 py-[10px] text-[0.9rem] leading-[1.55]">
					<div className="mb-1 flex items-center gap-2 text-[0.72rem] text-muted">
						turn {t.turn} · writer{mins ? ` · ${mins}` : ""}
						{t.attempts > 1 ? ` · ${t.attempts} attempts` : ""}
					</div>
					{env.summary && <Markdown>{env.summary}</Markdown>}
					{env.answers && env.answers.length > 0 && (
						<ul className="mt-1 list-disc pl-[18px]">
							{env.answers.map((ans, i) => (
								<li key={i} className="my-[2px]">
									<strong>{ans.question}</strong> — {ans.answer}
								</li>
							))}
						</ul>
					)}
					{env.questions && env.questions.length > 0 && (
						<>
							<div className="mt-2 text-[0.72rem] text-muted">
								questions for you
							</div>
							<ul className="list-disc pl-[18px]">
								{env.questions.map((q, i) => (
									<li key={i} className="my-[2px]">
										{q.text}
									</li>
								))}
							</ul>
						</>
					)}
					{env.links && (
						<div className="mt-2 flex flex-wrap gap-2">
							{env.links.read && (
								<a
									className="inline-flex items-center gap-[5px] rounded-full border border-accent-border bg-accent-soft px-[9px] py-[2px] text-[0.74rem] text-accent"
									href={env.links.read}
								>
									📄 {env.artifact ? `${env.artifact.kind} v${env.artifact.version}` : "read"}
								</a>
							)}
							{env.links.diff && (
								<a
									className="inline-flex items-center gap-[5px] rounded-full border border-accent-border bg-accent-soft px-[9px] py-[2px] text-[0.74rem] text-accent"
									href={env.links.diff}
								>
									± diff
								</a>
							)}
							{env.links.visual && (
								<a
									className="inline-flex items-center gap-[5px] rounded-full border border-accent-border bg-accent-soft px-[9px] py-[2px] text-[0.74rem] text-accent"
									href={env.links.visual}
								>
									📊 visual
								</a>
							)}
						</div>
					)}
				</div>
			) : (
				<div className="max-w-[720px] justify-self-start rounded-md border border-border bg-surface px-4 py-[10px] text-[0.9rem]">
					<div className="mb-1 text-[0.72rem] text-muted">
						turn {t.turn} · {t.state}
						{mins ? ` · ${mins}` : ""}
					</div>
					<div className="text-muted">{t.lastProgress || t.state}</div>
				</div>
			)}
		</div>
	);
}
