import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
	return clsx(inputs);
}

export type Tone = "ok" | "warn" | "pend" | "err" | "block" | "accent";

/** Map a repo/phase status word to a semantic tone (badge/pip color). */
export function tone(status: string | null | undefined): Tone {
	const s = String(status || "").toLowerCase();
	if (/(done|ready|approved|merged|success|complete|pass|open)/.test(s))
		return "ok";
	if (/(run|active|progress|exec|working|build)/.test(s)) return "warn";
	if (/(fail|error|reject)/.test(s)) return "err";
	if (/(block|conflict|stuck)/.test(s)) return "block";
	return "pend";
}

/** Phase → tone for the phase badge. */
export function phaseTone(phase: string | null | undefined): Tone {
	const p = String(phase || "").toLowerCase();
	if (p.includes("plan")) return "accent";
	if (p.includes("exec")) return "warn";
	if (p.includes("polish")) return "ok";
	if (p.includes("feedback")) return "block";
	return "pend";
}

export function titleCase(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
