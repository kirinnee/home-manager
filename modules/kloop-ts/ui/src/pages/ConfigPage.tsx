import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { Button, Card, Textarea } from '../components/Primitives';
import type { ConfigResponse, KloopConfig } from '../types';

// ---------- helpers ----------
function entryToWrapper(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return Object.keys(entry as object)[0] ?? '';
  return '';
}
function phasesToWrappers(phases: unknown[][] | undefined): string[] {
  return (phases ?? []).flat().map(entryToWrapper).filter(Boolean);
}

interface FormState {
  implementers: Array<{ wrapper: string; weight: number }>;
  reviewers: string[];
  verifiers: string[];
  synthesizer: string;
  checkpointer: string;
  maxIterations: number;
  implementerTimeout: number;
  reviewerTimeout: number;
  synthesisTimeout: number;
  verifyTimeout: number;
  conflictCheckThreshold: number;
  previousReviewPropagation: number;
  firstIterationWeightMultiplier: number;
  synthesis: boolean;
  verify: boolean;
  rerankAfterCheckpoint: boolean;
  firstLoopFullReview: boolean;
  compressSpec: boolean;
  snapshot: boolean;
}

function toForm(c: KloopConfig): FormState {
  return {
    implementers: Object.entries(c.implementers ?? {}).map(([wrapper, weight]) => ({ wrapper, weight })),
    reviewers: phasesToWrappers(c.reviewPhases),
    verifiers: phasesToWrappers(c.verifyPhases),
    synthesizer: entryToWrapper(c.synthesizer),
    checkpointer: entryToWrapper(c.conflictChecker),
    maxIterations: c.maxIterations,
    implementerTimeout: c.implementerTimeout,
    reviewerTimeout: c.reviewerTimeout,
    synthesisTimeout: c.synthesisTimeout,
    verifyTimeout: c.verifyTimeout,
    conflictCheckThreshold: c.conflictCheckThreshold,
    previousReviewPropagation: c.previousReviewPropagation,
    firstIterationWeightMultiplier: c.firstIterationWeightMultiplier,
    synthesis: c.synthesis,
    verify: c.verify,
    rerankAfterCheckpoint: c.rerankAfterCheckpoint,
    firstLoopFullReview: c.firstLoopFullReview,
    compressSpec: c.compressSpec,
    snapshot: c.snapshot,
  };
}

function toPatch(f: FormState): Record<string, unknown> {
  const implementers: Record<string, number> = {};
  for (const { wrapper, weight } of f.implementers) if (wrapper) implementers[wrapper] = Math.max(1, weight || 1);
  return {
    implementers,
    reviewPhases: [f.reviewers.filter(Boolean)],
    verifyPhases: [f.verifiers.filter(Boolean)],
    synthesizer: f.synthesizer || undefined,
    conflictChecker: f.checkpointer || undefined,
    maxIterations: f.maxIterations,
    implementerTimeout: f.implementerTimeout,
    reviewerTimeout: f.reviewerTimeout,
    synthesisTimeout: f.synthesisTimeout,
    verifyTimeout: f.verifyTimeout,
    conflictCheckThreshold: f.conflictCheckThreshold,
    previousReviewPropagation: f.previousReviewPropagation,
    firstIterationWeightMultiplier: f.firstIterationWeightMultiplier,
    synthesis: f.synthesis,
    verify: f.verify,
    rerankAfterCheckpoint: f.rerankAfterCheckpoint,
    firstLoopFullReview: f.firstLoopFullReview,
    compressSpec: f.compressSpec,
    snapshot: f.snapshot,
  };
}

export function ConfigPage() {
  const [resp, setResp] = useState<ConfigResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [rawYaml, setRawYaml] = useState('');
  const [rawMode, setRawMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const load = () =>
    api.getConfig().then(r => {
      setResp(r);
      setRawYaml(r.yaml);
      if (r.config) setForm(toForm(r.config));
    });

  useEffect(() => {
    load().catch(e => setError(String(e)));
  }, []);

  const wrappers = resp?.wrappers ?? [];

  const save = async (body: { yaml?: string; patch?: Record<string, unknown>; note?: string }) => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await api.putConfig(body);
      if (!res.ok) {
        setError(res.error ?? 'save failed');
      } else {
        setOkMsg(res.change ? `Saved — ${res.change.summary}` : 'Saved');
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !resp) return <p className="text-sm text-err">{error}</p>;
  if (!resp) return <div className="h-40 animate-pulse rounded-md bg-surface-2" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Configuration</h1>
          <p className="font-mono text-[11px] text-muted">{resp.path}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant={rawMode ? 'outline' : 'primary'} size="sm" onClick={() => setRawMode(false)}>
            Form
          </Button>
          <Button variant={rawMode ? 'primary' : 'outline'} size="sm" onClick={() => setRawMode(true)}>
            Raw YAML
          </Button>
        </div>
      </div>

      {resp.lastChange && (
        <div className="rounded-md border border-border-soft bg-surface-2 px-3 py-2 text-xs text-fg-soft">
          <span className="text-muted">Last change {fmtAgo(resp.lastChange.at)}: </span>
          {resp.lastChange.summary}
        </div>
      )}
      {error && <div className="rounded-md border border-err-border bg-err-bg px-3 py-2 text-xs text-err">{error}</div>}
      {okMsg && <div className="rounded-md border border-ok-border bg-ok-bg px-3 py-2 text-xs text-ok">{okMsg}</div>}

      {rawMode ? (
        <Card className="flex flex-col gap-2 p-4">
          <p className="text-xs text-muted">
            Full config YAML. Validated on save (schema + every agent must be an installed kfleet wrapper).
          </p>
          <Textarea
            value={rawYaml}
            onChange={e => setRawYaml(e.target.value)}
            rows={26}
            className="font-mono text-[12px] leading-relaxed"
            spellCheck={false}
          />
          <div className="flex justify-end">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => save({ yaml: rawYaml })}>
              {busy ? 'Saving…' : 'Save YAML'}
            </Button>
          </div>
        </Card>
      ) : form ? (
        <FormEditor
          form={form}
          setForm={setForm}
          wrappers={wrappers}
          busy={busy}
          onSave={() => save({ patch: toPatch(form) })}
        />
      ) : (
        <p className="text-sm text-warn">Config could not be parsed into the form — edit it as raw YAML.</p>
      )}
    </div>
  );
}

// ---------- form editor ----------
function FormEditor({
  form,
  setForm,
  wrappers,
  busy,
  onSave,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  wrappers: string[];
  busy: boolean;
  onSave: () => void;
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const options = useMemo(() => wrappers, [wrappers]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <SectionTitle>Agent role assignments</SectionTitle>
        {wrappers.length === 0 && (
          <p className="text-xs text-warn">
            No kfleet wrappers found in ~/.kfleet/bin — names won't be validated. Install wrappers with kfleet.
          </p>
        )}

        {/* implementer weighted rows */}
        <div className="flex flex-col gap-2">
          <Label>Implementer (weighted rotation)</Label>
          {form.implementers.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <WrapperSelect
                value={row.wrapper}
                options={options}
                onChange={w => {
                  const next = [...form.implementers];
                  next[i] = { ...next[i], wrapper: w };
                  set('implementers', next);
                }}
              />
              <input
                type="number"
                min={1}
                value={row.weight}
                onChange={e => {
                  const next = [...form.implementers];
                  next[i] = { ...next[i], weight: Number(e.target.value) };
                  set('implementers', next);
                }}
                className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-[13px]"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  set(
                    'implementers',
                    form.implementers.filter((_, j) => j !== i),
                  )
                }
              >
                remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => set('implementers', [...form.implementers, { wrapper: options[0] ?? '', weight: 1 }])}
            >
              + add implementer
            </Button>
          </div>
        </div>

        <ChipRole
          label="Reviewers (phase 1)"
          value={form.reviewers}
          options={options}
          onChange={v => set('reviewers', v)}
        />
        <ChipRole
          label="Verifiers (phase 1)"
          value={form.verifiers}
          options={options}
          onChange={v => set('verifiers', v)}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label>Synthesizer</Label>
            <WrapperSelect
              value={form.synthesizer}
              options={options}
              allowEmpty
              onChange={v => set('synthesizer', v)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Checkpointer / conflict checker</Label>
            <WrapperSelect
              value={form.checkpointer}
              options={options}
              allowEmpty
              onChange={v => set('checkpointer', v)}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted">
          Multi-phase review matrices and inline pools are collapsed to a single phase here — use Raw YAML for those.
        </p>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <SectionTitle>Tunables</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Num label="Max iterations" value={form.maxIterations} onChange={v => set('maxIterations', v)} />
          <Num
            label="Review threshold"
            value={form.conflictCheckThreshold}
            onChange={v => set('conflictCheckThreshold', v)}
          />
          <Num
            label="First-iter ×weight"
            value={form.firstIterationWeightMultiplier}
            onChange={v => set('firstIterationWeightMultiplier', v)}
          />
          <Num
            label="Implementer timeout (m)"
            value={form.implementerTimeout}
            onChange={v => set('implementerTimeout', v)}
          />
          <Num label="Reviewer timeout (m)" value={form.reviewerTimeout} onChange={v => set('reviewerTimeout', v)} />
          <Num label="Synthesis timeout (m)" value={form.synthesisTimeout} onChange={v => set('synthesisTimeout', v)} />
          <Num label="Verify timeout (m)" value={form.verifyTimeout} onChange={v => set('verifyTimeout', v)} />
          <Num
            label="Prev-review propagation"
            value={form.previousReviewPropagation}
            step={0.1}
            onChange={v => set('previousReviewPropagation', v)}
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Toggle label="synthesis" checked={form.synthesis} onChange={v => set('synthesis', v)} />
          <Toggle label="verify" checked={form.verify} onChange={v => set('verify', v)} />
          <Toggle
            label="rerank after checkpoint"
            checked={form.rerankAfterCheckpoint}
            onChange={v => set('rerankAfterCheckpoint', v)}
          />
          <Toggle
            label="first loop full review"
            checked={form.firstLoopFullReview}
            onChange={v => set('firstLoopFullReview', v)}
          />
          <Toggle label="compress spec" checked={form.compressSpec} onChange={v => set('compressSpec', v)} />
          <Toggle label="snapshot" checked={form.snapshot} onChange={v => set('snapshot', v)} />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" disabled={busy} onClick={onSave}>
          {busy ? 'Saving…' : 'Save config'}
        </Button>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-fg">{children}</h2>;
}
function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] uppercase tracking-wide text-muted">{children}</span>;
}

function WrapperSelect({
  value,
  options,
  onChange,
  allowEmpty,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allowEmpty?: boolean;
}) {
  // Ensure the current value is selectable even if not in the installed list.
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="h-8 min-w-[200px] rounded-md border border-border bg-surface px-2 text-[13px] text-fg"
    >
      {allowEmpty && <option value="">(none)</option>}
      {opts.map(o => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function ChipRole({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((w, i) => (
          <span
            key={i}
            className="flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px]"
          >
            <span className="font-mono">{w}</span>
            <button className="text-muted hover:text-err" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        <WrapperSelect
          value=""
          options={options.filter(o => !value.includes(o))}
          allowEmpty
          onChange={w => {
            if (w) onChange([...value, w]);
          }}
        />
      </div>
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        type="number"
        step={step ?? 1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-soft">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}
