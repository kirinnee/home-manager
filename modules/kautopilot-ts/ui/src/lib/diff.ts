// Markdown redline: word/line-level LCS diff of two markdown docs → aligned rows
// carrying markdown source with inline <ins>/<del> woven in. Ported from the
// legacy shell so the diff view renders identically (rendered prose track-
// changes, not a code-style line diff).

interface Seg {
	t: "eq" | "ins" | "del";
	s: string;
}

function tokenizeMd(s: string): string[] {
	return (
		String(s).match(
			/!?\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]+`|<[^>\n]+>|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\n|[^\S\n]+|[^\s]+/g,
		) || []
	);
}

function lcsDiff(a: string[], b: string[]): Seg[] {
	const n = a.length;
	const m = b.length;
	if (n * m > 4_000_000)
		return [
			{ t: "del", s: a.join("") },
			{ t: "ins", s: b.join("") },
		];
	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			dp[i][j] =
				a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out: Seg[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ t: "eq", s: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ t: "del", s: a[i] });
			i++;
		} else {
			out.push({ t: "ins", s: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ t: "del", s: a[i++] });
	while (j < m) out.push({ t: "ins", s: b[j++] });
	return out;
}

/** Word-level highlight of one OLD→NEW line as markdown source with inline
 *  <ins>/<del> tags (react-markdown passes them through; rehype keeps them). */
function wordCells(oldLine: string, newLine: string): { l: string; r: string } {
	const runs = lcsDiff(tokenizeMd(oldLine), tokenizeMd(newLine));
	let l = "";
	let r = "";
	for (const x of runs) {
		if (x.t === "eq") {
			l += x.s;
			r += x.s;
		} else if (x.t === "del") l += `<del class="d-del">${x.s}</del>`;
		else r += `<ins class="d-ins">${x.s}</ins>`;
	}
	return { l, r };
}

export interface DiffRow {
	type: "eq" | "del" | "add" | "mod";
	l: string;
	r: string;
}

/** Line-aligned diff (OLD→NEW). Modified lines carry word-level inline highlight. */
export function diffRows(oldMd: string, newMd: string): DiffRow[] {
	const segs = lcsDiff(String(oldMd).split("\n"), String(newMd).split("\n"));
	const rows: DiffRow[] = [];
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i];
		if (s.t === "eq") rows.push({ type: "eq", l: s.s, r: s.s });
		else if (s.t === "del") {
			if (i + 1 < segs.length && segs[i + 1].t === "ins") {
				const c = wordCells(s.s, segs[i + 1].s);
				rows.push({ type: "mod", l: c.l, r: c.r });
				i++;
			} else rows.push({ type: "del", l: s.s, r: "" });
		} else rows.push({ type: "add", l: "", r: s.s });
	}
	return rows;
}
