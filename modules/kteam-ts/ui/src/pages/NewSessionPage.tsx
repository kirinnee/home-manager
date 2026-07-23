// New-session flow: pick a project (cwd), an auto-mode wrapper (account),
// optional model override + kteam mode, and an opening prompt → POST
// /v1/sessions → land in the new chat.
//
// Degrades defensively: if the daemon lacks /v1/wrappers or /v1/projects
// (older build), the pickers fall back to free-text agent + cwd inputs so the
// flow still works.

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Bot, Sparkles, FolderGit2, Rocket } from 'lucide-react';
import { api, ApiError, HAS_TOKEN } from '../lib/api';
import type { InteractionMode, ProjectInfo, WrapperInfo } from '../types';
import { Button, Textarea } from '../components/Primitives';
import { Link, navigate } from '../lib/router';
import { fmtRelative } from '../lib/utils';

export function NewSessionPage() {
  const [wrappers, setWrappers] = useState<WrapperInfo[] | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [wrappersUnavailable, setWrappersUnavailable] = useState(false);
  const [projectsUnavailable, setProjectsUnavailable] = useState(false);

  const [agent, setAgent] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<InteractionMode>('auto');
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const w = (await api.wrappers()).filter(x => x.launchable);
        setWrappers(w);
        if (!agent && w.length) setAgent(w.find(x => /loge/.test(x.name))?.name ?? w[0]!.name);
      } catch {
        setWrappersUnavailable(true);
      }
      try {
        const p = await api.projects();
        setProjects(p);
        if (!cwd && p.length) setCwd(p[0]!.path);
      } catch {
        setProjectsUnavailable(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => {
    const byHarness: Record<string, WrapperInfo[]> = {};
    for (const w of wrappers ?? []) (byHarness[w.harness] ??= []).push(w);
    return byHarness;
  }, [wrappers]);

  const canSubmit = HAS_TOKEN && agent.trim().length > 0 && prompt.trim().length > 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const view = await api.createSession({
        prompt: prompt.trim(),
        agent: agent.trim(),
        cwd: cwd.trim() || undefined,
        mode,
        model: model.trim() || undefined,
        label: label.trim() || undefined,
      });
      navigate(`/session/${encodeURIComponent(view.config.id)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <div className="mt-5 mb-4 flex items-center gap-2.5">
        <Link to="/" className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg text-[13px]">
          <ChevronLeft size={15} /> Sessions
        </Link>
        <h1 className="m-0 text-[1.5rem] font-semibold tracking-tight">New session</h1>
      </div>

      {!HAS_TOKEN && (
        <div className="mb-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
          Read-only origin: no local token, so sessions can't be created here.
        </div>
      )}

      <div className="space-y-5 rounded-lg border border-border bg-surface p-5 shadow-sm">
        {/* Project / cwd */}
        <Field label="Project" hint="working directory for the session">
          {projectsUnavailable ? (
            <input
              type="text"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              placeholder="/absolute/path/to/project"
              className="w-full"
            />
          ) : projects == null ? (
            <div className="h-9 animate-pulse rounded-md bg-surface-2" />
          ) : (
            <div className="grid gap-1.5">
              <div className="max-h-52 overflow-auto rounded-md border border-border-soft scroll-thin">
                {projects.map(p => (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => setCwd(p.path)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2 ${
                      cwd === p.path ? 'bg-accent-soft' : ''
                    }`}
                  >
                    <FolderGit2 size={14} className={cwd === p.path ? 'text-accent' : 'text-faint'} />
                    <span className="font-medium">{p.name}</span>
                    <span className="mono truncate text-[11.5px] text-faint">{p.path}</span>
                    {p.lastActivity && (
                      <span className="mono ml-auto shrink-0 text-[11px] text-faint">
                        {fmtRelative(p.lastActivity)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={cwd}
                onChange={e => setCwd(e.target.value)}
                placeholder="…or type a path"
                className="w-full mono text-[12.5px]"
              />
            </div>
          )}
        </Field>

        {/* Wrapper / account */}
        <Field label="Account" hint="auto-mode fleet wrapper the agent runs under">
          {wrappersUnavailable ? (
            <input
              type="text"
              value={agent}
              onChange={e => setAgent(e.target.value)}
              placeholder="claude-auto-loge"
              className="w-full mono"
            />
          ) : wrappers == null ? (
            <div className="h-9 animate-pulse rounded-md bg-surface-2" />
          ) : (
            <div className="space-y-2.5">
              {Object.entries(grouped).map(([harness, list]) => (
                <div key={harness}>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-faint">
                    {harness === 'claude' ? <Bot size={12} /> : <Sparkles size={12} />}
                    {harness}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map(w => (
                      <button
                        key={w.name}
                        type="button"
                        onClick={() => setAgent(w.name)}
                        title={w.modelHint}
                        className={`rounded-md border px-2.5 py-1 text-[12.5px] mono transition-colors ${
                          agent === w.name
                            ? 'border-accent-border bg-accent-soft text-accent'
                            : 'border-border bg-surface hover:border-accent-border'
                        }`}
                      >
                        {w.name.replace(/^(claude|codex)-auto-/, '')}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Model override" hint="blank = account default">
            <input
              type="text"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder="e.g. claude-opus-4-8[1m]"
              className="w-full mono text-[12.5px]"
            />
          </Field>
          <Field label="Mode" hint="kteam turn handling">
            <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
              {(['auto', 'interactive'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`h-7 rounded px-3 text-[12.5px] font-medium transition-colors ${
                    mode === m ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <Field label="Label" hint="optional — groups related sessions">
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. kteam-ui"
            className="w-full"
          />
        </Field>

        <Field label="Opening prompt" hint="the task for this teammate">
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={6}
            placeholder="Describe the task…"
          />
        </Field>

        {error && (
          <div className="rounded-md border border-err-border bg-err-bg px-3 py-2 text-[12.5px] text-err">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Link to="/" className="text-[13px] text-muted hover:text-fg">
            Cancel
          </Link>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            <Rocket size={13} /> {submitting ? 'Creating…' : 'Create session'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12.5px] font-semibold text-fg">{label}</span>
        {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
