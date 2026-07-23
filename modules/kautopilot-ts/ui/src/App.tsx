import { useEffect, useState } from "react";
import { AppBar, type Crumb } from "./components/AppBar";
import { Skeleton } from "./components/Primitives";
import { useLiveReload } from "./hooks/useLiveReload";
import { api } from "./lib/api";
import { type Route, RouterProvider, useRoute } from "./lib/router";
import type { ServerMeta } from "./lib/types";
import { titleCase } from "./lib/utils";
import { ConfigPage } from "./pages/ConfigPage";
import { DiffPage } from "./pages/DiffPage";
import { DiscussionPage } from "./pages/DiscussionPage";
import { DocPage } from "./pages/DocPage";
import { SessionPage } from "./pages/SessionPage";
import { SessionsListPage } from "./pages/SessionsListPage";

function crumbsFor(route: Route): Crumb[] {
	const base: Crumb = { text: "Sessions", href: "/" };
	switch (route.name) {
		case "index":
			return [{ text: "Sessions" }];
		case "config":
			return [base, { text: "Config" }];
		case "session":
			return [base, { text: route.id }];
		case "doc":
			return [
				base,
				{ text: route.id, href: `/sessions/${encodeURIComponent(route.id)}` },
				{ text: titleCase(route.kind) },
			];
		case "plans":
			return [
				base,
				{ text: route.id, href: `/sessions/${encodeURIComponent(route.id)}` },
				{ text: `Plans · ${route.repo}` },
			];
		case "diff":
			return [
				base,
				{ text: route.id, href: `/sessions/${encodeURIComponent(route.id)}` },
				{ text: route.repo ? `Plans · ${route.repo}` : route.kind || "" },
				{ text: "diff" },
			];
		case "discussion":
			return [
				base,
				{ text: route.id, href: `/sessions/${encodeURIComponent(route.id)}` },
				{ text: `Discussion · ${route.phaseKey}` },
			];
		default:
			return [base];
	}
}

export default function App() {
	const [route, push] = useRoute();
	const { state: live, tick } = useLiveReload();
	const [meta, setMeta] = useState<ServerMeta | null>(null);

	useEffect(() => {
		api
			.meta()
			.then(setMeta)
			.catch(() =>
				setMeta({ version: "", kloopBase: "", kteamBase: "" }),
			);
	}, []);

	return (
		<RouterProvider push={push}>
			<AppBar crumbs={crumbsFor(route)} live={live} />
			<main className="mx-auto max-w-shell px-4 pb-9 pt-4">
				{!meta ? (
					<Skeleton rows={4} />
				) : route.name === "index" ? (
					<SessionsListPage tick={tick} />
				) : route.name === "config" ? (
					<ConfigPage />
				) : route.name === "session" ? (
					<SessionPage id={route.id} meta={meta} tick={tick} />
				) : route.name === "doc" ? (
					<DocPage
						id={route.id}
						kind={route.kind}
						repo={null}
						version={route.version}
						tick={tick}
					/>
				) : route.name === "plans" ? (
					<DocPage
						id={route.id}
						kind={null}
						repo={route.repo}
						version={route.version}
						tick={tick}
					/>
				) : route.name === "diff" ? (
					<DiffPage
						id={route.id}
						kind={route.kind}
						repo={route.repo}
						tick={tick}
					/>
				) : route.name === "discussion" ? (
					<DiscussionPage
						id={route.id}
						phaseKey={route.phaseKey}
						meta={meta}
						tick={tick}
					/>
				) : (
					<SessionsListPage tick={tick} />
				)}
			</main>
		</RouterProvider>
	);
}
