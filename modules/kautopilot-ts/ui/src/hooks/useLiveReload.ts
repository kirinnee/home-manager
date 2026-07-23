import { useEffect, useState } from "react";

export type LiveState = "off" | "on" | "beat";

/**
 * Subscribe to the server SSE live-reload stream (/api/events). Returns a
 * connection indicator state and a monotonically increasing `tick` that bumps
 * whenever the store changes on disk — pages depend on `tick` to re-fetch in
 * place (preserving scroll) instead of a full reload. EventSource auto-
 * reconnects, so onerror just dims the indicator.
 */
export function useLiveReload(): { state: LiveState; tick: number } {
	const [state, setState] = useState<LiveState>("off");
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		let beatT: ReturnType<typeof setTimeout> | undefined;
		let es: EventSource | undefined;
		try {
			es = new EventSource("/api/events");
			es.onopen = () => setState("on");
			es.onmessage = (e) => {
				if (e.data === "reload") {
					setTick((t) => t + 1);
					setState("beat");
					clearTimeout(beatT);
					beatT = setTimeout(() => setState("on"), 700);
				}
			};
			es.onerror = () => setState("off");
		} catch {
			// live reload unavailable; static view still works
		}
		return () => {
			clearTimeout(beatT);
			es?.close();
		};
	}, []);
	return { state, tick };
}

/** Small async data hook that re-fetches when any dep (incl. the live tick)
 *  changes. Returns loading only on the first load so live refreshes don't
 *  flash the skeleton. */
import { useCallback } from "react";

export function useAsync<T>(
	fn: () => Promise<T>,
	deps: unknown[],
): { data: T | null; error: string | null; loading: boolean } {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are the contract
	const run = useCallback(fn, deps);
	useEffect(() => {
		let alive = true;
		run()
			.then((d) => {
				if (alive) {
					setData(d);
					setError(null);
				}
			})
			.catch((e: unknown) => {
				if (alive) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [run]);
	return { data, error, loading };
}
