import type { RepoBrief } from "../lib/types";
import { cn, type Tone, tone } from "../lib/utils";

const TONE_CLASS: Record<Tone, string> = {
	ok: "text-ok bg-ok-bg border-ok-border",
	warn: "text-warn bg-warn-bg border-warn-border",
	pend: "text-pend bg-pend-bg border-pend-border",
	err: "text-err bg-err-bg border-err-border",
	block: "text-block bg-block-bg border-block-border",
	accent: "text-accent bg-accent-soft border-accent-border",
};

// Explicit literal classes so Tailwind's content scan keeps them (a
// `bg-${tone}` template would be purged).
const PIP_CLASS: Record<Tone, string> = {
	ok: "bg-ok",
	warn: "bg-warn",
	pend: "bg-pend",
	err: "bg-err",
	block: "bg-block",
	accent: "bg-accent",
};

export function Badge({
	children,
	tone: t = "pend",
	pip = false,
	className,
}: {
	children: React.ReactNode;
	tone?: Tone;
	pip?: boolean;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-[7px] py-[3px] text-[11px] font-semibold leading-none",
				TONE_CLASS[t],
				className,
			)}
		>
			{pip && (
				<span className="h-[5px] w-[5px] rounded-full bg-current opacity-90" />
			)}
			{children}
		</span>
	);
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<div className="mt-5 mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">
			{children}
		</div>
	);
}

export function RepoChip({ r }: { r: RepoBrief }) {
	const t = tone(r.status);
	return (
		<span className="inline-flex items-center overflow-hidden rounded-sm border border-border bg-surface-2 text-[11.5px] leading-[1.3]">
			<span className="inline-flex items-center gap-[5px] px-2 py-[3px] font-semibold text-fg-soft">
				<span className={cn("h-[6px] w-[6px] rounded-full", PIP_CLASS[t])} />
				{r.repo}
			</span>
			{r.prUrl && (
				<a
					className="border-l border-border bg-accent-soft px-2 py-[3px] font-semibold text-accent hover:bg-accent hover:text-accent-fg hover:no-underline"
					href={r.prUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					{r.prNumber == null ? "PR" : `PR #${r.prNumber}`}
				</a>
			)}
		</span>
	);
}

export function Empty({
	title,
	children,
}: {
	title?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="rounded-md border border-dashed border-border bg-surface-2 px-4 py-9 text-center text-muted">
			{title && <h1 className="mb-2 text-[1.05rem] text-fg">{title}</h1>}
			{children && <p className="my-1 text-[12.5px]">{children}</p>}
		</div>
	);
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
	return (
		<div className="grid gap-2">
			{Array.from({ length: rows }).map((_, i) => (
				<div
					key={i}
					className="h-11 animate-pulse rounded-md border border-border-soft bg-surface-2"
				/>
			))}
		</div>
	);
}
