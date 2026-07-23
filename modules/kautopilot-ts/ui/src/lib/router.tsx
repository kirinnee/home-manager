import {
	createContext,
	forwardRef,
	useContext,
	useEffect,
	useState,
} from "react";

// A hand-rolled pushState router (no react-router) mirroring the stable URL
// scheme the legacy shell used, so old links keep working:
//   /                                   index (sessions list)
//   /config                             config pane
//   /sessions/:id                       session detail
//   /sessions/:id/:kind[/v:n]           doc (triage|spec|feedback|brainstorm|ticket)
//   /sessions/:id/:kind/diff            doc diff
//   /sessions/:id/plans/:repo[/v:n]     plan set
//   /sessions/:id/plans/:repo/diff      plan-set diff
//   /sessions/:id/discussion/:phaseKey  deferred-writer discussion

export type Route =
	| { name: "index" }
	| { name: "config" }
	| { name: "session"; id: string }
	| { name: "doc"; id: string; kind: string; version: number | null }
	| { name: "plans"; id: string; repo: string; version: number | null }
	| { name: "diff"; id: string; kind: string | null; repo: string | null }
	| { name: "discussion"; id: string; phaseKey: string }
	| { name: "notfound" };

function versionOf(part: string | undefined): number | null {
	return part && /^v\d+$/.test(part) ? Number(part.slice(1)) : null;
}

export function parseRoute(pathname: string): Route {
	const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length === 0) return { name: "index" };
	if (parts[0] === "config") return { name: "config" };
	if (parts[0] !== "sessions") return { name: "index" };
	const id = parts[1] ?? "";
	if (!id) return { name: "index" };
	if (parts.length === 2) return { name: "session", id };
	if (parts[2] === "discussion") {
		const phaseKey = parts[3] ?? "";
		return phaseKey
			? { name: "discussion", id, phaseKey }
			: { name: "session", id };
	}
	if (parts[2] === "plans") {
		const repo = parts[3] ?? "";
		if (!repo) return { name: "session", id };
		if (parts[4] === "diff") return { name: "diff", id, kind: null, repo };
		return { name: "plans", id, repo, version: versionOf(parts[4]) };
	}
	const kind = parts[2];
	if (parts[3] === "diff") return { name: "diff", id, kind, repo: null };
	return { name: "doc", id, kind, version: versionOf(parts[3]) };
}

type Push = (href: string) => void;
const RouterContext = createContext<Push>(() => {});

export function useRoute(): [Route, Push] {
	const [path, setPath] = useState(() => window.location.pathname);
	useEffect(() => {
		const onPop = () => setPath(window.location.pathname);
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
	const push: Push = (href) => {
		if (href !== window.location.pathname + window.location.search) {
			window.history.pushState(null, "", href);
		}
		setPath(new URL(href, window.location.origin).pathname);
		window.scrollTo(0, 0);
	};
	return [parseRoute(path), push];
}

export function RouterProvider({
	push,
	children,
}: {
	push: Push;
	children: React.ReactNode;
}) {
	return (
		<RouterContext.Provider value={push}>{children}</RouterContext.Provider>
	);
}

export const Link = forwardRef<
	HTMLAnchorElement,
	React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
>(function Link({ href, onClick, ...rest }, ref) {
	const push = useContext(RouterContext);
	return (
		<a
			ref={ref}
			href={href}
			onClick={(e) => {
				onClick?.(e);
				if (
					e.defaultPrevented ||
					e.button !== 0 ||
					e.metaKey ||
					e.ctrlKey ||
					e.shiftKey ||
					e.altKey ||
					rest.target === "_blank"
				)
					return;
				e.preventDefault();
				push(href);
			}}
			{...rest}
		/>
	);
});
