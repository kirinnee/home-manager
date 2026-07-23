import { useCallback, useState } from "react";

type Theme = "light" | "dark";

function current(): Theme {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Read/toggle the theme. The boot script in index.html already applied the
 *  saved/OS theme to <html data-theme>; this just flips + persists it. */
export function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(current);
	const toggle = useCallback(() => {
		const next: Theme = current() === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		try {
			localStorage.setItem("theme", next);
		} catch {
			// storage unavailable — theme still applies for this session
		}
		setTheme(next);
	}, []);
	return [theme, toggle];
}
