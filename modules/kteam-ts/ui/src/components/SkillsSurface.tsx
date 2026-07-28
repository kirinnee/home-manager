// SKILLS — the session-scoped catalog surface hosted by SidePaneWorkspace.
//
// Discovery and invocation are deliberately NOT implemented here. The same
// loader that powers composer autocomplete supplies the exact session account's
// dynamic catalog, and its insertion helper owns Claude's `/name` versus
// Codex's `$name` convention. This component only gives those facts room to be
// read and searched.
//
// A row tap inserts text into the existing draft through a callback. It never
// submits, closes the pane, or focuses the composer/search field. The reader
// can keep browsing and review the draft before choosing to send it.

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';
import { ApiError } from '../lib/api';
import {
  loadSkillsCatalog,
  skillHarnessLabel,
  skillInsertText,
  type ComposerHarness,
  type ComposerSkillSummary,
  type ComposerSkillsCatalog,
} from './composer-autocomplete-providers';
import { SurfaceHeader, type SurfaceProps } from './SidePane';

type CatalogLoader = (sessionId: string, signal: AbortSignal) => Promise<ComposerSkillsCatalog>;
type LoadState = 'loading' | 'ready' | 'error';

export interface SkillsSurfaceProps extends SurfaceProps {
  /** Draft-only boundary. There is intentionally no submit callback. */
  onInsert: (invocation: string) => void;
  /** Test seam; production always uses the autocomplete catalog loader. */
  loadCatalog?: CatalogLoader;
}

export function filterSkills(skills: readonly ComposerSkillSummary[], query: string): ComposerSkillSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...skills];
  return skills.filter(skill => `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(needle));
}

/** Append one invocation as a new draft token while preserving real content. */
export function appendSkillInvocation(draft: string, invocation: string): string {
  if (draft.trim().length === 0) return `${invocation} `;
  return `${draft}${/\s$/.test(draft) ? '' : ' '}${invocation} `;
}

/** Shared row action, exported so the insert-only boundary has a direct test. */
export function insertSkillIntoDraft(
  onInsert: (invocation: string) => void,
  harness: ComposerHarness,
  name: string,
): string {
  const invocation = skillInsertText(harness, name);
  onInsert(invocation);
  return invocation;
}

/** Honest zero-state copy: missing account resolution is not an empty catalog. */
export function skillsEmptyCopy(harnessHomeResolved: boolean | undefined, query: string, catalogSize: number): string {
  if (query.trim() && catalogSize > 0) return `No skills match “${query.trim()}”.`;
  if (harnessHomeResolved === false)
    return "Skills are unavailable because this session's harness home could not be resolved.";
  if (harnessHomeResolved === undefined)
    return "No skills were returned, and this daemon cannot confirm whether the session's harness home was resolved.";
  return 'No skills are installed for this session.';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return String(error);
}

export function SkillsCatalogList({
  catalog,
  query,
  onInsert,
}: {
  catalog: ComposerSkillsCatalog;
  query: string;
  onInsert: (invocation: string) => void;
}) {
  const skills = filterSkills(catalog.skills, query);
  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Sparkles size={22} aria-hidden="true" className="text-faint" />
        <p className="m-0 max-w-[38ch] text-cell leading-base text-muted">
          {skillsEmptyCopy(catalog.harnessHomeResolved, query, catalog.skills.length)}
        </p>
      </div>
    );
  }

  return (
    <ul className="m-0 list-none divide-y divide-border-soft rounded-md border border-border-soft bg-surface p-0">
      {skills.map(skill => {
        const invocation = skillInsertText(catalog.harness, skill.name);
        return (
          <li key={skill.name}>
            <button
              type="button"
              className="flex min-h-[64px] w-full flex-col items-stretch gap-1 px-3 py-2 text-left hover:bg-surface-2"
              onClick={() => insertSkillIntoDraft(onInsert, catalog.harness, skill.name)}
              aria-label={`Insert ${invocation} into composer draft. ${skill.description}`}
            >
              <span className="flex min-w-0 items-center justify-between gap-2">
                <code className="min-w-0 truncate font-mono text-cell font-semibold text-accent">{invocation}</code>
                <span className="shrink-0 text-meta text-muted">Insert into draft</span>
              </span>
              <span className="text-cell leading-base text-muted">{skill.description}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SkillsSurface({
  sessionId,
  presentation,
  titleId,
  onClose,
  onInsert,
  loadCatalog: load = loadSkillsCatalog,
}: SkillsSurfaceProps) {
  const searchId = useId();
  const [state, setState] = useState<LoadState>('loading');
  const [catalog, setCatalog] = useState<ComposerSkillsCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [inserted, setInserted] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setState('loading');
    setCatalog(null);
    setError(null);
    void load(sessionId, controller.signal)
      .then(next => {
        if (!live) return;
        setCatalog(next);
        setState('ready');
      })
      .catch(reason => {
        if (!live || controller.signal.aborted) return;
        setError(errorMessage(reason));
        setState('error');
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [load, nonce, sessionId]);

  const visibleCount = useMemo(() => (catalog ? filterSkills(catalog.skills, query).length : 0), [catalog, query]);
  const insert = useCallback(
    (invocation: string) => {
      onInsert(invocation);
      setInserted(invocation);
    },
    [onInsert],
  );

  return (
    <>
      <SurfaceHeader
        icon={<Sparkles size={17} />}
        label="Skills"
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel="Close skills"
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-end gap-2 px-panel py-2">
          <label className="min-w-0 flex-1" htmlFor={searchId}>
            <span className="sr-only">Search skills</span>
            <span className="relative block">
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={event => setQuery(event.currentTarget.value)}
                placeholder="Search skills"
                autoComplete="off"
                spellCheck={false}
                disabled={state !== 'ready' || !catalog?.skills.length}
                className="kt-input min-h-[44px] w-full pl-9 pr-3"
              />
            </span>
          </label>
          <button
            type="button"
            className="kt-btn min-h-[44px] shrink-0"
            onClick={() => setNonce(value => value + 1)}
            disabled={state === 'loading'}
            aria-label="Refresh skills"
          >
            {state === 'loading' ? (
              <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            Refresh
          </button>
        </div>

        {catalog && (
          <div className="flex shrink-0 items-center justify-between gap-2 px-panel pb-2 text-meta text-muted">
            <span>{skillHarnessLabel(catalog.harness)}</span>
            <span>
              {query.trim() ? `${visibleCount} of ${catalog.skills.length}` : catalog.skills.length}{' '}
              {catalog.skills.length === 1 ? 'skill' : 'skills'}
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-3">
          {state === 'loading' && (
            <p role="status" className="py-6 text-center text-cell text-muted">
              Loading skills…
            </p>
          )}
          {state === 'error' && (
            <div className="flex flex-col items-center gap-2 py-8 text-center" role="alert">
              <Sparkles size={22} aria-hidden="true" className="text-faint" />
              <p className="m-0 max-w-[38ch] text-cell leading-base text-err">Couldn't load skills: {error}</p>
            </div>
          )}
          {state === 'ready' && catalog && <SkillsCatalogList catalog={catalog} query={query} onInsert={insert} />}
        </div>
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {inserted ? `Inserted ${inserted} into the composer draft. Review it before sending.` : ''}
      </div>
    </>
  );
}
