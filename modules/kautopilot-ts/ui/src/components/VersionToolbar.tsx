import { Link } from "../lib/router";
import type { RevisionInfo } from "../lib/types";
import { cn } from "../lib/utils";

/** Version switcher. Epoch-grouped chips when every revision carries an epoch;
 *  a flat chip list otherwise (epoch-agnostic artifacts like brainstorm). */
export function VersionToolbar({
	baseHref,
	current,
	versions,
	diffHref,
}: {
	baseHref: string;
	current: number | null;
	versions: RevisionInfo[];
	diffHref?: string | null;
}) {
	if (versions.length === 0) return null;
	const grouped = versions.every((r) => r.epoch != null);
	let lastEpoch: number | null = null;
	const nodes: React.ReactNode[] = [];
	for (const r of versions) {
		if (grouped && r.epoch !== lastEpoch) {
			if (lastEpoch !== null)
				nodes.push(
					<span key={`sep-${r.epoch}`} className="mx-[3px] h-4 w-px bg-border" />,
				);
			nodes.push(
				<span
					key={`ep-${r.epoch}`}
					className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted"
				>
					Epoch {r.epoch}
				</span>,
			);
			lastEpoch = r.epoch;
		}
		nodes.push(
			<Link
				key={`v-${r.epoch}-${r.version}`}
				href={`${baseHref}/v${r.version}`}
				className={cn(
					"rounded-sm border px-[9px] py-[3px] font-semibold hover:border-accent-border hover:text-accent hover:no-underline",
					r.version === current
						? "border-accent bg-accent text-accent-fg"
						: "border-border bg-surface text-fg-soft",
				)}
			>
				v{r.version}
			</Link>,
		);
	}
	return (
		<div className="mb-4 flex flex-wrap items-center gap-[5px] rounded-md border border-border-soft bg-surface-2 p-[6px] text-[12px]">
			{nodes}
			{diffHref && versions.length > 1 && (
				<Link
					href={diffHref}
					className="ml-auto rounded-sm border border-accent-border bg-accent-soft px-[9px] py-[3px] font-semibold text-accent hover:bg-accent hover:text-accent-fg hover:no-underline"
				>
					Diff vs previous
				</Link>
			)}
		</div>
	);
}
