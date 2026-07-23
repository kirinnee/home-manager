import { Moon, Settings, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import type { LiveState } from "../hooks/useLiveReload";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";

export interface Crumb {
	text: string;
	href?: string;
}

export function AppBar({
	crumbs,
	live,
}: {
	crumbs: Crumb[];
	live: LiveState;
}) {
	const [theme, toggle] = useTheme();
	return (
		<header className="sticky top-0 z-30 border-b border-border bg-[var(--bar-bg)] backdrop-blur-md backdrop-saturate-150">
			<div className="mx-auto flex min-h-[40px] max-w-shell items-center gap-3 px-4">
				<nav className="flex min-w-0 flex-1 flex-wrap items-center gap-px text-[13px] text-muted">
					{crumbs.map((c, i) => (
						<span key={i} className="flex items-center gap-px">
							{i > 0 && <span className="mx-px opacity-40">/</span>}
							{c.href ? (
								<Link
									href={c.href}
									className="max-w-[42vw] overflow-hidden text-ellipsis whitespace-nowrap rounded-[5px] px-1 py-px font-medium text-muted hover:bg-accent-soft hover:text-accent hover:no-underline"
								>
									{c.text}
								</Link>
							) : (
								<span className="px-1 py-px font-semibold text-fg">
									{c.text}
								</span>
							)}
						</span>
					))}
				</nav>
				<Link
					href="/config"
					aria-label="Config"
					title="Config"
					className="flex-shrink-0 rounded-sm p-[5px] text-muted hover:bg-accent-soft hover:text-accent hover:no-underline"
				>
					<Settings size={15} />
				</Link>
				<button
					type="button"
					onClick={toggle}
					aria-label="Toggle light/dark"
					title="Toggle light/dark"
					className="flex-shrink-0 rounded-sm p-[5px] text-muted hover:bg-accent-soft hover:text-accent"
				>
					{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
				</button>
				<span
					className="flex flex-shrink-0 select-none items-center gap-[5px] text-[11.5px] leading-none text-muted"
					title={`live: ${live}`}
				>
					<span
						className={cn(
							"h-[6px] w-[6px] rounded-full transition-colors",
							live === "off" && "bg-pend",
							live === "on" && "bg-ok",
							live === "beat" && "bg-accent",
						)}
					/>
					<span className="hidden sm:inline">live</span>
				</span>
			</div>
		</header>
	);
}
