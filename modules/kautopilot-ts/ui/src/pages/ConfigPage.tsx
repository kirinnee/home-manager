import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ConfigView } from "../lib/types";
import { Badge, Empty, SectionTitle, Skeleton } from "../components/Primitives";

const RUN_MODES = ["current-session", "sub-agent"];
const EXEC_MODES = ["kloop", "sub-agent"];
const WRITER_MODES = ["inline", "deferred"];

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="flex items-center justify-between gap-3 border-t border-border-soft px-4 py-[9px] first:border-t-0">
			<span className="min-w-0">
				<span className="block text-[13px] font-semibold text-fg">{label}</span>
				{hint && <span className="block text-[11.5px] text-muted">{hint}</span>}
			</span>
			<span className="flex-shrink-0">{children}</span>
		</label>
	);
}

const inputCls =
	"rounded-sm border border-border bg-surface px-2 py-1 text-[13px] text-fg";
const numCls = `${inputCls} w-20 text-right`;

export function ConfigPage() {
	const [resp, setResp] = useState<{
		config: ConfigView;
		wrappers: string[];
		revision: number | null;
	} | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [cfg, setCfg] = useState<ConfigView | null>(null);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{
		ok: boolean;
		errors?: string[];
		conflict?: boolean;
	} | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.config()
			.then((r) => {
				if (!alive) return;
				setResp(r);
				setCfg(structuredClone(r.config));
			})
			.catch((e: unknown) =>
				setErr(e instanceof Error ? e.message : String(e)),
			);
		return () => {
			alive = false;
		};
	}, []);

	if (err) return <Empty title="Error">{err}</Empty>;
	if (!resp || !cfg) return <Skeleton rows={6} />;

	const wrappers = resp.wrappers;
	const s = cfg.settings;
	const w = cfg.writer;
	const setS = (patch: Partial<ConfigView["settings"]>) =>
		setCfg({ ...cfg, settings: { ...cfg.settings, ...patch } });
	const setW = (patch: Partial<ConfigView["writer"]>) =>
		setCfg({ ...cfg, writer: { ...cfg.writer, ...patch } });

	const poolRows = Object.entries(w.pool);

	async function save() {
		setSaving(true);
		setResult(null);
		const r = await api.saveConfig({
			settings: s,
			writer: w,
			expectedRevision: resp?.revision,
		});
		setResult(r);
		setSaving(false);
		// On success: re-read to reflect the persisted (re-serialized) config +
		// new revision. On conflict: re-read so the user edits against the latest
		// on-disk revision instead of clobbering the concurrent change.
		if (r.ok || r.conflict) {
			const fresh = await api.config();
			setResp(fresh);
			setCfg(structuredClone(fresh.config));
		}
	}

	return (
		<div className="mx-auto max-w-prose">
			<div className="mb-4 flex items-center justify-between">
				<div>
					<h1 className="text-[1.25rem] font-semibold tracking-[-0.01em]">
						Configuration
					</h1>
					<div className="text-[12.5px] text-muted">
						~/.kautopilot/config.yaml — prompts &amp; templates preserved
					</div>
				</div>
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="inline-flex items-center gap-[6px] rounded-md border border-accent bg-accent px-[14px] py-[7px] text-[13px] font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50"
				>
					<Save size={14} /> {saving ? "Saving…" : "Save"}
				</button>
			</div>

			{result && (
				<div className="mb-4">
					{result.ok ? (
						<Badge tone="ok" pip>
							Saved
						</Badge>
					) : (
						<div className="rounded-md border border-err-border bg-err-bg px-3 py-2 text-[12.5px] text-err">
							{(result.errors ?? ["Save failed"]).map((e, i) => (
								<div key={i}>{e}</div>
							))}
						</div>
					)}
				</div>
			)}

			<SectionTitle>Mode defaults &amp; timeouts</SectionTitle>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				<Field label="Run mode" hint="where the controller loop runs">
					<select
						className={inputCls}
						value={s.runMode}
						onChange={(e) => setS({ runMode: e.target.value })}
					>
						{RUN_MODES.map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
				</Field>
				<Field label="Exec mode" hint="how ready plans are implemented">
					<select
						className={inputCls}
						value={s.execMode}
						onChange={(e) => setS({ execMode: e.target.value })}
					>
						{EXEC_MODES.map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
				</Field>
				<Field label="CodeRabbit" hint="wait for CodeRabbit review">
					<input
						type="checkbox"
						checked={s.coderabbit}
						onChange={(e) => setS({ coderabbit: e.target.checked })}
						className="h-4 w-4 accent-accent"
					/>
				</Field>
				<Field label="Max parallel repos" hint="1–10">
					<input
						type="number"
						min={1}
						max={10}
						className={numCls}
						value={s.maxParallelRepos}
						onChange={(e) => setS({ maxParallelRepos: Number(e.target.value) })}
					/>
				</Field>
				<Field label="Max push cycles" hint="polish push retries (1–20)">
					<input
						type="number"
						min={1}
						max={20}
						className={numCls}
						value={s.maxPushCycles}
						onChange={(e) => setS({ maxPushCycles: Number(e.target.value) })}
					/>
				</Field>
				<Field label="Poll interval" hint="seconds (1–300)">
					<input
						type="number"
						min={1}
						max={300}
						className={numCls}
						value={s.pollInterval}
						onChange={(e) => setS({ pollInterval: Number(e.target.value) })}
					/>
				</Field>
			</div>

			<SectionTitle>Writer</SectionTitle>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				<Field label="Writer mode" hint="inline or deferred (kteam relay)">
					<select
						className={inputCls}
						value={w.mode}
						onChange={(e) => setW({ mode: e.target.value })}
					>
						{WRITER_MODES.map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
				</Field>
				<Field label="Turn timeout" hint="minutes (1–300)">
					<input
						type="number"
						min={1}
						max={300}
						className={numCls}
						value={w.turnTimeoutMins}
						onChange={(e) => setW({ turnTimeoutMins: Number(e.target.value) })}
					/>
				</Field>
				<Field label="Max turn retries" hint="0–10">
					<input
						type="number"
						min={0}
						max={10}
						className={numCls}
						value={w.maxTurnRetries}
						onChange={(e) => setW({ maxTurnRetries: Number(e.target.value) })}
					/>
				</Field>
				<Field
					label="Reviewer model"
					hint="model hint for reviewer subagents (blank = default)"
				>
					<input
						type="text"
						className={`${inputCls} w-48`}
						value={w.reviewerModel ?? ""}
						placeholder="(default)"
						onChange={(e) =>
							setW({ reviewerModel: e.target.value.trim() || null })
						}
					/>
				</Field>
			</div>

			<SectionTitle>Deferred steps</SectionTitle>
			<div className="flex flex-wrap gap-2 rounded-md border border-border bg-surface p-3">
				{cfg.writerSteps.map((step) => {
					const on = w.steps.includes(step);
					return (
						<button
							key={step}
							type="button"
							onClick={() =>
								setW({
									steps: on
										? w.steps.filter((x) => x !== step)
										: [...w.steps, step],
								})
							}
							className={`rounded-sm border px-[9px] py-[3px] text-[12px] font-semibold ${
								on
									? "border-accent bg-accent text-accent-fg"
									: "border-border bg-surface-2 text-fg-soft"
							}`}
						>
							{step}
						</button>
					);
				})}
			</div>

			<SectionTitle>Writer pool (wrapper assignments)</SectionTitle>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				{poolRows.length === 0 && (
					<div className="px-4 py-3 text-[12.5px] text-muted">
						No accounts — add one below.
					</div>
				)}
				{poolRows.map(([account, weight], i) => {
					const unknown = !wrappers.includes(account);
					return (
						<div
							key={i}
							className="flex items-center gap-2 border-t border-border-soft px-4 py-[9px] first:border-t-0"
						>
							<select
								className={`${inputCls} flex-1`}
								value={wrappers.includes(account) ? account : ""}
								onChange={(e) => {
									const pool = { ...w.pool };
									delete pool[account];
									pool[e.target.value] = weight;
									setW({ pool });
								}}
							>
								<option value="" disabled>
									{unknown ? `${account} (unknown)` : "select wrapper…"}
								</option>
								{wrappers.map((wr) => (
									<option key={wr}>{wr}</option>
								))}
							</select>
							{unknown && <Badge tone="err">unknown</Badge>}
							<input
								type="number"
								min={1}
								className={numCls}
								value={weight}
								onChange={(e) => {
									const pool = { ...w.pool };
									pool[account] = Number(e.target.value);
									setW({ pool });
								}}
							/>
							<button
								type="button"
								aria-label="Remove"
								onClick={() => {
									const pool = { ...w.pool };
									delete pool[account];
									setW({ pool });
								}}
								className="rounded-sm p-1 text-muted hover:text-err"
							>
								<Trash2 size={14} />
							</button>
						</div>
					);
				})}
				<button
					type="button"
					onClick={() => {
						const avail = wrappers.find((wr) => !(wr in w.pool));
						if (avail) setW({ pool: { ...w.pool, [avail]: 1 } });
					}}
					className="flex w-full items-center gap-[6px] border-t border-border-soft px-4 py-[9px] text-[12.5px] font-semibold text-accent hover:bg-surface-2"
				>
					<Plus size={14} /> Add account
				</button>
			</div>

			<SectionTitle>Reviewers (read-only)</SectionTitle>
			<div className="grid gap-4 sm:grid-cols-2">
				{(["spec", "plan"] as const).map((g) => (
					<div key={g}>
						<div className="mb-1 text-[11.5px] font-semibold text-muted">
							{g} reviewers
						</div>
						<div className="overflow-hidden rounded-md border border-border bg-surface">
							{cfg.reviewers[g].map((r) => (
								<div
									key={r.name}
									className="border-t border-border-soft px-3 py-2 text-[12px] first:border-t-0"
								>
									<span className="font-semibold text-fg">{r.name}</span>
									<span className="block text-muted">{r.desc}</span>
								</div>
							))}
						</div>
					</div>
				))}
			</div>

			<SectionTitle>Orgs (read-only)</SectionTitle>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				{Object.entries(cfg.orgs).map(([org, p]) => (
					<div
						key={org}
						className="flex items-center gap-3 border-t border-border-soft px-4 py-2 text-[12.5px] first:border-t-0"
					>
						<span className="flex-1 font-semibold text-fg">{org}</span>
						<span className="text-muted">{p.ticketSystem}</span>
						<span className="text-muted">base {p.baseBranch}</span>
						{p.commitSpec && <Badge tone="pend">commit-spec</Badge>}
					</div>
				))}
			</div>
		</div>
	);
}
