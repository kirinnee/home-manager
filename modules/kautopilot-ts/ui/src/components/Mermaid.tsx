import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";

let initialized = false;
function ensureInit() {
	if (initialized) return;
	initialized = true;
	mermaid.initialize({
		startOnLoad: false,
		theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
		securityLevel: "strict",
		fontFamily: "inherit",
	});
}

let seq = 0;

/** Render a mermaid graph source to inline SVG inside a themed card. */
export function Mermaid({ code }: { code: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [err, setErr] = useState(false);
	useEffect(() => {
		ensureInit();
		let alive = true;
		const id = `mmd-${seq++}`;
		mermaid
			.render(id, code)
			.then(({ svg }) => {
				if (alive && ref.current) ref.current.innerHTML = svg;
			})
			.catch(() => {
				if (alive) setErr(true);
			});
		return () => {
			alive = false;
		};
	}, [code]);
	if (err)
		return (
			<pre className="mermaid-card" style={{ textAlign: "left" }}>
				{code}
			</pre>
		);
	return <div className="mermaid-card" ref={ref} />;
}
