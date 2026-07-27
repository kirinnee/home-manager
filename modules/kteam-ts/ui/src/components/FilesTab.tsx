// Files tab — the read-only working-tree viewer for one session.
//
// CHANGES FIRST. The reason to open a session's files is almost never "browse a
// tree"; it is "what did the agent just change". So the tab opens on the git
// status list, one tap goes to the unified diff, and the directory browser is
// the second section rather than the front door.
//
// Everything here is phone-first and measured at 360px: one vertical scroller
// per pane, 44px rows, wide content (long paths, long diff lines, wide tables)
// scrolls INSIDE its own container so the page itself never scrolls sideways.
//
// WHAT THIS COMPONENT DOES NOT DECIDE: whether a file may be read. Containment,
// the secrets denylist, the gitignore gate and the size/binary caps are the
// daemon's (phase-1 `fs.ts`); a client-side gate is worth nothing against a
// leaked token. The viewer renders the verdicts — `denied`, `ignored`,
// `escapes`, `binary`, `tooLarge` — and never offers a way around one.
//
// Bundle: no new dependencies. The highlighter, react-markdown and the icons are
// already in the lazy session chunk this tab rides in.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CornerLeftUp, FileText, Folder, GitBranch, Link2Off, Loader2, Lock, RefreshCw } from 'lucide-react';
import { Markdown } from './Markdown';
import { ViewTabs } from './ViewTabs';
import { highlightToHtml } from '../lib/highlight';
import { langFromPath } from '../lib/tool-extract';
import { useInputModality } from '../hooks/useInputModality';
import {
  describeFsError,
  fsApi,
  isAbort,
  useFsProbe,
  type FsChange,
  type FsEntry,
  type FsFile,
  type FsListing,
} from './files-api';
import {
  UNOPENABLE_NAME_REASON,
  baseName,
  changeRowLabel,
  countLabel,
  crumbs,
  dirPrefix,
  formatBytes,
  isMarkdownPath,
  isOpenableName,
  isOpenablePath,
  joinRel,
  parentRel,
  parseUnifiedDiff,
  renderableDiffLines,
  statusChip,
  type ParsedDiff,
  type StatusChip,
} from './files-model';
import './files.css';

/** Mirrors `MAX_HIGHLIGHT_CHARS` in `lib/highlight.ts`, which is module-private
 *  there. It is duplicated rather than exported because that file is shared
 *  work in this change; the number exists here only to EXPLAIN the plain-text
 *  fallback (`highlightToHtml` still enforces it), so a drift makes the note
 *  wrong, never the rendering. */
const HIGHLIGHT_LIMIT = 60_000;

type OpenView =
  | { kind: 'diff'; path: string }
  | { kind: 'file'; path: string; rev: 'work' | 'head'; render: 'rendered' | 'source' };

interface Props {
  sessionId: string;
  /** The session's working directory — the viewer's root, shown as the `root`
   *  breadcrumb's title so it is obvious WHICH tree is being read. */
  cwd?: string;
}

/* ---- async resource ------------------------------------------------------
   One tiny hook behind every pane. Two properties matter more than brevity:
   (1) a superseded response can never paint — the effect aborts its request and
   drops any late result via `live`; (2) changing the key CLEARS the old data,
   so a new path can never briefly show the previous file's bytes. */
interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

interface ResourceState<T> {
  /** The key this data BELONGS to. A result is only ever rendered against the
   *  key that asked for it — the effect that resets state runs after paint, so
   *  comparing here is what actually prevents one frame of the previous file's
   *  bytes under the new file's title. */
  key: string | null;
  data: T | null;
  error: string | null;
}

function useFsResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ key: null, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    let live = true;
    loadRef
      .current(controller.signal)
      .then(data => {
        if (live) setState({ key, data, error: null });
      })
      .catch(error => {
        if (!live || controller.signal.aborted || isAbort(error)) return;
        setState({ key, data: null, error: describeFsError(error) });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [key, nonce]);

  // Anything belonging to another key is not "old data", it is someone else's.
  const fresh = state.key === key;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: key !== null && !fresh,
    reload: useCallback(() => {
      setState({ key: null, data: null, error: null });
      setNonce(n => n + 1);
    }, []),
  };
}

/* ---- shared bits --------------------------------------------------------- */

function Note({
  tone = 'plain',
  role,
  children,
}: {
  tone?: 'plain' | 'warn' | 'err';
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div className="kt-fs-note" data-tone={tone === 'plain' ? undefined : tone} role={role}>
      {children}
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <Note role="status">
      <span className="inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Loading {what}…
      </span>
    </Note>
  );
}

function Failed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <Note tone="err" role="alert">
      <span>
        Could not load {what}: {error}
      </span>
      <button type="button" className="kt-btn kt-btn--sm" onClick={onRetry} aria-label={`Retry loading ${what}`}>
        <RefreshCw size={13} aria-hidden="true" />
        Retry
      </button>
    </Note>
  );
}

function StatusBadge({ chip }: { chip: StatusChip }) {
  // The letter is decoration: every row's accessible name already says
  // "Modified: src/app.ts", so announcing "M" again is noise.
  return (
    <span
      className="kt-badge"
      data-tone={chip.tone === 'neutral' ? undefined : chip.tone}
      aria-hidden="true"
      title={chip.detail ? `${chip.label} (${chip.detail})` : chip.label}
    >
      {chip.code}
    </span>
  );
}

/* ---- Changes --------------------------------------------------------------
   Paths render in two parts — a dimmed directory and a strong basename — and
   WRAP rather than truncate. On a phone the tail of a path is the informative
   half, and `text-overflow: ellipsis` eats exactly that. */

export function ChangesList({
  changes,
  truncated,
  onOpen,
}: {
  changes: FsChange[];
  /** The daemon capped git's status output — say so, in the list itself. */
  truncated?: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {changes.map(change => {
        const chip = statusChip(change.status);
        // A path the daemon's grammar refuses is shown VERBATIM and inert: the
        // dimmed-directory/strong-basename split runs through `normalizeRel`,
        // which would print `a\b.ts` as `a/ b.ts` — a path that is not the one
        // git named. Dropping the row instead would be worse: the file really
        // did change.
        if (!isOpenablePath(change.path)) {
          return (
            <li key={`${change.status}:${change.path}`}>
              <div className="kt-fs-row" data-inert="true">
                <StatusBadge chip={chip} />
                <span className="kt-fs-name">
                  <span>
                    <span className="sr-only">{chip.label}: </span>
                    <span className="kt-fs-strong">{change.path}</span>
                  </span>
                  {change.from && <span className="kt-fs-dim">renamed from {change.from}</span>}
                  <span className="kt-fs-dim">{UNOPENABLE_NAME_REASON}</span>
                </span>
              </div>
            </li>
          );
        }
        return (
          <li key={`${change.status}:${change.path}`}>
            <button
              type="button"
              className="kt-fs-row"
              onClick={() => onOpen(change.path)}
              aria-label={changeRowLabel(change.path, chip, change.from)}
            >
              <StatusBadge chip={chip} />
              <span className="kt-fs-name">
                <span>
                  {dirPrefix(change.path) && <span className="kt-fs-dim">{dirPrefix(change.path)}</span>}
                  <span className="kt-fs-strong">{baseName(change.path)}</span>
                </span>
                {change.from && <span className="kt-fs-dim">renamed from {change.from}</span>}
              </span>
            </button>
          </li>
        );
      })}
      {truncated && (
        <li>
          <div className="kt-fs-note" data-tone="warn" role="status">
            Change list truncated by the daemon — git reported more changed files than it serves at once, so some are
            missing from this list.
          </div>
        </li>
      )}
    </ul>
  );
}

/* ---- Browse --------------------------------------------------------------- */

/** Why an entry cannot be opened, in the words the daemon's gates use. Null
 *  means "openable".
 *
 *  A REFUSAL REFUSES DIRECTORIES TOO. `.git/` and `node_modules/` are on the
 *  denylist as directories, and a gitignored directory's children are refused
 *  the moment they are read — offering to descend into one is offering a dead
 *  end. Symlinks are listing-only in every case: the daemon serves regular
 *  files (`lstat`, attachments standard), so an in-root symlink is refused for
 *  the same reason as an escaping one — it just gets the milder sentence. */
export function entryRefusal(entry: FsEntry): string | null {
  if (entry.denied) return 'not served — denylisted (secrets policy)';
  // Before any policy gate: a name the viewer cannot even ADDRESS. `opendir`
  // returns POSIX names the daemon's route grammar refuses (backslash, control
  // bytes), and joining one would request a different path than the row shows.
  // Ranked under the denylist only so a secret keeps its own, louder reason.
  if (!isOpenableName(entry.name)) return UNOPENABLE_NAME_REASON;
  if (entry.escapes) return 'symlink leaves this session’s folder — not served';
  if (entry.type === 'symlink') return 'symlink — listed only, not served';
  if (entry.ignored) return 'gitignored — content is not served';
  return null;
}

export function BrowseList({
  listing,
  dir,
  onEnter,
  onOpenFile,
}: {
  listing: FsListing;
  dir: string;
  onEnter: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  // The daemon sorts dirs-first; sorting again costs nothing and means a future
  // (or older) daemon cannot make the list look random.
  const entries = useMemo(() => {
    const rank = (entry: FsEntry) => (entry.type === 'dir' ? 0 : 1);
    return [...(listing.entries ?? [])].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }, [listing]);

  return (
    <ul className="m-0 list-none p-0">
      {dir && (
        <li>
          <button
            type="button"
            className="kt-fs-row"
            onClick={() => onEnter(parentRel(dir))}
            aria-label={`Up to ${parentRel(dir) || 'the session root'}`}
          >
            <CornerLeftUp size={15} className="kt-fs-icon" aria-hidden="true" />
            <span className="kt-fs-name">
              <span className="kt-fs-strong">..</span>
            </span>
          </button>
        </li>
      )}
      {entries.map(entry => {
        const refusal = entryRefusal(entry);
        const path = joinRel(dir, entry.name);
        const isDir = entry.type === 'dir';
        const openable = !refusal;
        const icon = entry.escapes ? (
          <Link2Off size={15} className="kt-fs-icon" aria-hidden="true" />
        ) : refusal ? (
          <Lock size={15} className="kt-fs-icon" aria-hidden="true" />
        ) : isDir ? (
          <Folder size={15} className="kt-fs-icon" aria-hidden="true" />
        ) : (
          <FileText size={15} className="kt-fs-icon" aria-hidden="true" />
        );
        const body = (
          <>
            {icon}
            <span className="kt-fs-name">
              <span className="kt-fs-strong">
                {entry.name}
                {isDir ? '/' : ''}
              </span>
              {refusal && <span className="kt-fs-dim">{refusal}</span>}
            </span>
            <span className="kt-fs-meta">{isDir ? '' : formatBytes(entry.size)}</span>
          </>
        );
        if (!openable) {
          return (
            <li key={entry.name}>
              {/* Not a disabled button: a control that exists only to refuse is
                  a worse answer than a row that states the reason. */}
              <div className="kt-fs-row" data-inert="true">
                {body}
              </div>
            </li>
          );
        }
        return (
          <li key={entry.name}>
            <button
              type="button"
              className="kt-fs-row"
              onClick={() => (isDir ? onEnter(path) : onOpenFile(path))}
              aria-label={
                isDir
                  ? `Open folder ${entry.name}`
                  : `Open file ${entry.name}${entry.size != null ? `, ${formatBytes(entry.size)}` : ''}`
              }
            >
              {body}
            </button>
          </li>
        );
      })}
      {listing.truncated && (
        <li>
          <div className="kt-fs-note" role="status">
            Listing truncated by the daemon — this directory has more entries than the viewer serves at once.
          </div>
        </li>
      )}
      {!entries.length && (
        <li>
          {/* Also at depth: a nested empty folder shows the `..` row, so without
              this the pane would look like a list that failed to load. */}
          <div className="kt-fs-note" role="status">
            This folder is empty.
          </div>
        </li>
      )}
    </ul>
  );
}

/* ---- diff ---------------------------------------------------------------- */

export function DiffBody({ parsed }: { parsed: ParsedDiff }) {
  return (
    <div className="kt-fs-code scroll-thin">
      <div className="kt-fs-diff">
        {renderableDiffLines(parsed).map((line, index) => {
          const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : '';
          const isRow = line.kind === 'add' || line.kind === 'del' || line.kind === 'ctx';
          return (
            <div key={index} className="kt-fs-diff-line" data-kind={line.kind}>
              {isRow && (
                <>
                  <span className="kt-fs-gutter" aria-hidden="true">
                    {line.oldNo ?? ''}
                  </span>
                  <span className="kt-fs-gutter" aria-hidden="true">
                    {line.newNo ?? ''}
                  </span>
                </>
              )}
              {isRow && <span className="kt-fs-sign">{sign}</span>}
              <span className="kt-fs-diff-text">{line.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- file ---------------------------------------------------------------- */

/** The refusal reasons the file endpoint can return, in reading order. */
export function fileRefusal(file: FsFile): string | null {
  if (file.denied) return 'This file is on the daemon’s denylist and is never served.';
  if (file.ignored && file.content == null) return 'This file is gitignored, so its content is not served.';
  if (file.tooLarge)
    return `This file is ${formatBytes(file.size) || 'too large'} — over the daemon’s 1 MB view limit.`;
  if (file.binary) return 'This file is binary, so there is nothing to show as text.';
  return null;
}

export function FileBody({ file, path, render }: { file: FsFile; path: string; render: 'rendered' | 'source' }) {
  const refusal = fileRefusal(file);
  const content = file.content ?? '';
  const lang = file.lang ?? langFromPath(path);
  const html = useMemo(
    () => (refusal || render === 'rendered' ? null : highlightToHtml(content, lang)),
    [refusal, render, content, lang],
  );

  if (refusal) {
    return (
      <Note tone="warn" role="status">
        {refusal}
      </Note>
    );
  }
  if (!content) {
    return <Note role="status">This file is empty.</Note>;
  }
  if (render === 'rendered') {
    return (
      <div className="kt-fs-md">
        <Markdown text={content} />
      </div>
    );
  }
  return (
    <>
      {html === null && lang && content.length > HIGHLIGHT_LIMIT && (
        <div className="kt-fs-note" role="status">
          Syntax highlighting is off above {HIGHLIGHT_LIMIT.toLocaleString()} characters.
        </div>
      )}
      <div className="kt-fs-code scroll-thin">
        {html === null ? (
          // Escaped by React — raw HTML is inserted ONLY for highlighter output,
          // which escapes its own input (same rule as Markdown.tsx).
          <pre className="kt-fs-pre">{content}</pre>
        ) : (
          <pre className="kt-fs-pre">
            <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        )}
      </div>
    </>
  );
}

/* ---- the tab -------------------------------------------------------------- */

export function FilesTab({ sessionId, cwd }: Props) {
  const probe = useFsProbe(sessionId);
  const [section, setSection] = useState<'changes' | 'browse'>('changes');
  const [dir, setDir] = useState('');
  const [stack, setStack] = useState<OpenView[]>([]);
  const open = stack.length ? stack[stack.length - 1]! : null;
  const { touchAffected } = useInputModality();
  const paneRef = useRef<HTMLDivElement>(null);

  const repo = probe.changes?.repo ?? false;
  const changes = probe.changes?.changes ?? [];
  const changesTruncated = probe.changes?.truncated ?? false;
  const changedPaths = useMemo(() => new Set(changes.map(change => change.path)), [changes]);

  const push = useCallback((next: OpenView) => setStack(current => [...current, next]), []);
  const back = useCallback(() => setStack(current => current.slice(0, -1)), []);
  const replaceTop = useCallback(
    (patch: Partial<Extract<OpenView, { kind: 'file' }>>) =>
      setStack(current => {
        const top = current[current.length - 1];
        if (!top || top.kind !== 'file') return current;
        return [...current.slice(0, -1), { ...top, ...patch }];
      }),
    [],
  );

  const openDiff = useCallback((path: string) => push({ kind: 'diff', path }), [push]);
  const openFile = useCallback(
    (path: string, rev: 'work' | 'head' = 'work', render?: 'rendered' | 'source') =>
      push({ kind: 'file', path, rev, render: render ?? (isMarkdownPath(path) ? 'rendered' : 'source') }),
    [push],
  );

  // Move focus to the pane when a view opens so a keyboard reader is not left
  // at the top of the page and can scroll the diff immediately. NEVER on touch:
  // an unrequested focus there summons the keyboard and jumps the viewport
  // (hooks/useInputModality.ts owns that policy — viewport width plays no part).
  const depth = stack.length;
  useEffect(() => {
    if (touchAffected || !depth) return;
    paneRef.current?.focus({ preventScroll: true });
  }, [touchAffected, depth]);

  const listing = useFsResource<FsListing>(
    !open && section === 'browse' ? `list:${sessionId}:${dir}` : null,
    useCallback(signal => fsApi.list(sessionId, dir, signal), [sessionId, dir]),
  );

  const diffPath = open?.kind === 'diff' ? open.path : null;
  const diff = useFsResource<string>(
    diffPath ? `diff:${sessionId}:${diffPath}` : null,
    useCallback(signal => fsApi.diff(sessionId, diffPath ?? '', signal), [sessionId, diffPath]),
  );

  const filePath = open?.kind === 'file' ? open.path : null;
  const fileRev = open?.kind === 'file' ? open.rev : 'work';
  const file = useFsResource<FsFile>(
    filePath ? `file:${sessionId}:${filePath}:${fileRev}` : null,
    useCallback(
      signal => fsApi.file(sessionId, filePath ?? '', fileRev === 'head' ? 'head' : undefined, signal),
      [sessionId, filePath, fileRev],
    ),
  );

  const parsedDiff = useMemo(() => (diff.data != null ? parseUnifiedDiff(diff.data) : null), [diff.data]);
  // A diff that is nothing but plumbing headers has nothing to show — the
  // emptiness test has to agree with what DiffBody actually renders.
  const diffHasBody = useMemo(() => (parsedDiff ? renderableDiffLines(parsedDiff).length > 0 : false), [parsedDiff]);

  // Browse states the CURRENT folder only — the breadcrumb row directly below
  // carries the rest of the path, and at 360px a deep directory printed in full
  // took five wrapped lines of the header before any content. A file/diff keeps
  // its whole path: there the path IS the identity of what you are reading.
  const title = open ? open.path : section === 'changes' ? 'Changes' : baseName(dir) || 'Browse';
  const subtitle = open
    ? open.kind === 'diff'
      ? 'Unified diff vs HEAD'
      : open.rev === 'head'
        ? 'Previous version (HEAD)'
        : 'Working tree'
    : cwd || undefined;

  return (
    // `.kt-fs` owns flex:1 + min-height:0 (files.css) — the pane fills what the
    // page gives it and its scroller, not the page, takes the overflow.
    <div className="kt-fs rounded-md border border-border bg-surface">
      <div className="kt-fs-bar">
        {open ? (
          <button type="button" className="kt-btn kt-btn--sm" onClick={back} aria-label="Back to the file list">
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
        ) : (
          <ViewTabs<'changes' | 'browse'>
            label="Files section"
            tabs={[
              { id: 'changes', label: 'Changes' },
              { id: 'browse', label: 'Browse' },
            ]}
            current={section}
            onChange={setSection}
          />
        )}
        <span className="kt-fs-title">
          <span className="kt-fs-title-path">{title}</span>
          {subtitle && (
            <span className="kt-fs-title-meta" title={subtitle}>
              {subtitle}
            </span>
          )}
        </span>
        <span className="kt-fs-actions">
          {repo && probe.changes?.branch && (
            // Truncates (files.css) — a long branch name must never carry the
            // Refresh control off the pane. The full name stays in the title and
            // in the accessible name.
            <span
              className="kt-badge kt-fs-branch"
              data-tone="accent"
              title={`On branch ${probe.changes.branch}`}
              aria-label={`On branch ${probe.changes.branch}`}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span>{probe.changes.branch}</span>
            </span>
          )}
          <button
            type="button"
            className="kt-btn kt-btn--sm"
            onClick={() => {
              probe.refresh();
              if (open?.kind === 'diff') diff.reload();
              else if (open?.kind === 'file') file.reload();
              else if (section === 'browse') listing.reload();
            }}
            aria-label={probe.refreshing ? 'Refreshing files' : 'Refresh files'}
            title="Re-read the working tree"
          >
            <RefreshCw size={13} className={probe.refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Refresh</span>
          </button>
        </span>
      </div>

      {/* Second row: whatever switches THIS pane. Kept off the title bar so a
          360px phone never has to fit a switcher, a path and a control on one
          line. */}
      {open?.kind === 'file' && <FileControls open={open} repo={repo} onChange={replaceTop} onDiff={openDiff} />}
      {open?.kind === 'diff' && (
        <div className="kt-fs-chip-row">
          {parsedDiff && (
            <span className="kt-fs-count">
              +{parsedDiff.added} −{parsedDiff.removed}
            </span>
          )}
          <button
            type="button"
            className="kt-btn kt-btn--sm"
            onClick={() => openFile(open.path, 'work', 'source')}
            aria-label={`Open ${baseName(open.path)} as a file`}
          >
            <FileText size={13} aria-hidden="true" />
            Open file
          </button>
          {isMarkdownPath(open.path) && (
            <>
              <button
                type="button"
                className="kt-btn kt-btn--sm"
                onClick={() => openFile(open.path, 'work', 'rendered')}
                aria-label={`Render ${baseName(open.path)} as it is now`}
              >
                Rendered now
              </button>
              {repo && (
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  onClick={() => openFile(open.path, 'head', 'rendered')}
                  aria-label={`Render the previous committed ${baseName(open.path)}`}
                >
                  Rendered before
                </button>
              )}
            </>
          )}
        </div>
      )}
      {!open && section === 'browse' && (
        <nav className="kt-fs-crumbs scroll-thin" aria-label="Folder path">
          {crumbs(dir).map((crumb, index) => (
            <span key={crumb.path || 'root'} className="contents">
              {index > 0 && (
                <span className="kt-fs-crumb-sep" aria-hidden="true">
                  /
                </span>
              )}
              <button
                type="button"
                className="kt-fs-crumb"
                aria-current={crumb.path === dir ? 'page' : undefined}
                onClick={() => setDir(crumb.path)}
                title={index === 0 ? cwd : crumb.path}
                aria-label={index === 0 ? `Go to the session root${cwd ? ` (${cwd})` : ''}` : `Go to ${crumb.path}`}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div ref={paneRef} tabIndex={-1} className="kt-fs-scroll scroll-thin outline-none">
        {open?.kind === 'diff' ? (
          diff.loading ? (
            <Loading what="the diff" />
          ) : diff.error ? (
            <Failed what="the diff" error={diff.error} onRetry={diff.reload} />
          ) : parsedDiff && parsedDiff.binary ? (
            <Note tone="warn" role="status">
              git reports this pair as binary — there is no textual diff to show.
            </Note>
          ) : parsedDiff && diffHasBody ? (
            <>
              <DiffBody parsed={parsedDiff} />
              {parsedDiff.truncated && (
                <div className="kt-fs-note" role="status">
                  Showing the first {parsedDiff.lines.length.toLocaleString()} of {parsedDiff.total.toLocaleString()}{' '}
                  diff lines.
                </div>
              )}
            </>
          ) : (
            <Note role="status">No textual changes in this file.</Note>
          )
        ) : open?.kind === 'file' ? (
          file.loading ? (
            <Loading what={baseName(open.path)} />
          ) : file.error ? (
            <Failed what={baseName(open.path)} error={file.error} onRetry={file.reload} />
          ) : file.data ? (
            <FileBody file={file.data} path={open.path} render={open.render} />
          ) : (
            <Note role="status">Nothing to show.</Note>
          )
        ) : section === 'changes' ? (
          probe.state === 'probing' ? (
            <Loading what="changes" />
          ) : probe.state === 'error' ? (
            <Failed what="changes" error={probe.error ?? 'unknown error'} onRetry={probe.refresh} />
          ) : !repo ? (
            <Note role="status">
              This session’s folder is not a git repository, so there is no change list. Use Browse to read its files.
            </Note>
          ) : changes.length ? (
            <>
              <div className="kt-fs-section-label">
                {/* A capped list must not print its length as if it were the
                    total — "12 changed files" would be a claim the daemon
                    never made. */}
                {changesTruncated ? 'First ' : ''}
                {countLabel(changes.length, 'changed file')} vs HEAD
              </div>
              <ChangesList changes={changes} truncated={changesTruncated} onOpen={openDiff} />
            </>
          ) : changesTruncated ? (
            // Capped before a single row survived: the empty list is an
            // artefact of the cap, so it must never read as "nothing changed".
            <Note tone="warn" role="status">
              git reported more changed files than the daemon serves at once, and none of them survived the cap — this
              list is incomplete, not empty.
            </Note>
          ) : (
            <Note role="status">No uncommitted changes — the working tree matches HEAD.</Note>
          )
        ) : listing.loading ? (
          <Loading what={dir || 'the session root'} />
        ) : listing.error ? (
          <Failed what={dir || 'the session root'} error={listing.error} onRetry={listing.reload} />
        ) : listing.data ? (
          <BrowseList
            listing={listing.data}
            dir={dir}
            onEnter={setDir}
            onOpenFile={path => (changedPaths.has(path) ? openDiff(path) : openFile(path))}
          />
        ) : (
          <Note role="status">Nothing to show.</Note>
        )}
      </div>
    </div>
  );
}

function FileControls({
  open,
  repo,
  onChange,
  onDiff,
}: {
  open: Extract<OpenView, { kind: 'file' }>;
  repo: boolean;
  onChange: (patch: Partial<Extract<OpenView, { kind: 'file' }>>) => void;
  onDiff: (path: string) => void;
}) {
  const markdown = isMarkdownPath(open.path);
  return (
    <div className="kt-fs-chip-row">
      {markdown && (
        <ViewTabs<'rendered' | 'source'>
          label="Markdown view"
          tabs={[
            { id: 'rendered', label: 'Rendered' },
            { id: 'source', label: 'Source' },
          ]}
          current={open.render}
          onChange={render => onChange({ render })}
        />
      )}
      {repo && (
        <ViewTabs<'work' | 'head'>
          label="File version"
          tabs={[
            { id: 'work', label: 'Current' },
            { id: 'head', label: 'Previous' },
          ]}
          current={open.rev}
          onChange={rev => onChange({ rev })}
        />
      )}
      {repo && (
        <button
          type="button"
          className="kt-btn kt-btn--sm"
          onClick={() => onDiff(open.path)}
          aria-label={`Show the diff for ${baseName(open.path)}`}
        >
          Diff
        </button>
      )}
    </div>
  );
}
