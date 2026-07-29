// Files tab — a deliberately ordinary read-only file browser for one session.
//
// The directory is the front door. Opening a file immediately shows its useful
// form: Markdown as prose, recognised code with the app's existing highlighter,
// everything else as text. Raw bytes and the git diff are icon actions on that
// file, never modes the reader must pick before seeing it. Git status stays in
// the listing as a compact dot plus line counts instead of a second ceremony.
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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowLeft,
  Code2,
  CornerLeftUp,
  FileText,
  Folder,
  GitCompareArrows,
  Link2Off,
  Loader2,
  Lock,
  RefreshCw,
  X,
} from 'lucide-react';
import { Markdown } from './Markdown';
import { highlightToHtml } from '../lib/highlight';
import { formatCodeReference, type CodeReference, type CodeReferenceOpenRequest } from '../lib/references';
import type { AttentionId } from '../lib/attention';
import type { PinReferenceLookup } from '../lib/pin-links';
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
  crumbs,
  formatBytes,
  isMarkdownPath,
  isOpenablePath,
  isOpenableName,
  joinRel,
  parentRel,
  parseUnifiedDiff,
  renderableDiffLines,
  splitHighlightedLines,
  statusChip,
  type ParsedDiff,
} from './files-model';
import './files.css';

/** Mirrors the shared highlighter's private cap only to explain its fallback.
 *  Highlighting itself still owns and enforces the real limit. */
const HIGHLIGHT_LIMIT = 60_000;

export type FileView = 'normal' | 'raw' | 'diff';

export interface FileLineSelection {
  line: number;
  endLine?: number;
  column?: number;
}

export interface OpenFileTab {
  path: string;
  view: FileView;
  /** A reference temporarily shows exact source lines even when this tab's
   * remembered view is rendered Markdown or diff. Clearing it restores `view`. */
  selection?: FileLineSelection;
}

interface Props {
  sessionId: string;
  /** The session's working directory — the viewer's root, shown as the `root`
   *  breadcrumb's title so it is obvious WHICH tree is being read. */
  cwd?: string;
  /** Programmatic open request from the session SidePane host. */
  requestedReference?: CodeReferenceOpenRequest | null;
  onRequestedReferenceHandled?: (sequence: number) => void;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
}

export interface FilesTabSnapshot {
  dir: string;
  tabs: OpenFileTab[];
  activePath: string | null;
}

const EMPTY_FILES_TAB_SNAPSHOT: FilesTabSnapshot = { dir: '', tabs: [], activePath: null };
const sessionFileTabs = new Map<string, FilesTabSnapshot>();

/** The Files surface is mount-per-open (and a mobile sheet must unmount), so its
 * tabs live in bounded page memory keyed by session. Clicking a reference from
 * another surface cannot erase the files the reader already had open. */
export function readFilesTabState(sessionId: string): FilesTabSnapshot {
  const state = sessionFileTabs.get(sessionId);
  return state ? { ...state, tabs: [...state.tabs] } : EMPTY_FILES_TAB_SNAPSHOT;
}

function writeFilesTabState(sessionId: string, state: FilesTabSnapshot): void {
  sessionFileTabs.set(sessionId, { ...state, tabs: [...state.tabs] });
}

export function resetFilesTabStates(): void {
  sessionFileTabs.clear();
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
      <button
        type="button"
        className="kt-btn kt-btn--sm kt-fs-retry"
        onClick={onRetry}
        aria-label={`Retry loading ${what}`}
      >
        <RefreshCw size={13} aria-hidden="true" />
        Retry
      </button>
    </Note>
  );
}

/** Spoken + tooltip copy for the condensed visual marker. Colour and the dot
 *  are deliberately redundant: the row's accessible name carries the status
 *  word and exact counts too. */
export function changeDescription(change: FsChange): string {
  const chip = statusChip(change.status);
  const counts = [
    change.additions === undefined || (change.additions === 0 && !['A', '?'].includes(chip.code))
      ? null
      : `+${change.additions}`,
    change.deletions === undefined || (change.deletions === 0 && chip.code !== 'D') ? null : `−${change.deletions}`,
  ].filter(Boolean);
  return [chip.detail ? `${chip.label} (${chip.detail})` : chip.label, ...counts].join(' · ');
}

export function ChangeIndicator({ change }: { change: FsChange }) {
  const chip = statusChip(change.status);
  const knownAdd = change.additions !== undefined;
  const knownDel = change.deletions !== undefined;
  const showAdd = (change.additions ?? 0) > 0 || (knownAdd && ['A', '?'].includes(chip.code));
  const showDel = (change.deletions ?? 0) > 0 || (knownDel && chip.code === 'D');
  const unknownAdd = !knownAdd && ['A', '?', 'C'].includes(chip.code);
  const unknownDel = !knownDel && chip.code === 'D';
  const label = changeDescription(change);

  return (
    <span className="kt-fs-change" aria-label={label} title={label}>
      <span className="kt-fs-change-dot" data-tone={chip.tone} aria-hidden="true" />
      {(showAdd || unknownAdd) && (
        <span className="kt-fs-change-count" data-kind="add" aria-hidden="true">
          +{showAdd ? change.additions : ''}
        </span>
      )}
      {(showDel || unknownDel) && (
        <span className="kt-fs-change-count" data-kind="del" aria-hidden="true">
          −{showDel ? change.deletions : ''}
        </span>
      )}
    </span>
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
  changes,
  onEnter,
  onOpenFile,
}: {
  listing: FsListing;
  dir: string;
  changes?: ReadonlyMap<string, FsChange>;
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
        const change = openable && !isDir ? changes?.get(path) : undefined;
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
              <span className="kt-fs-name-line">
                <span className="kt-fs-strong">
                  {entry.name}
                  {isDir ? '/' : ''}
                </span>
                {change && <ChangeIndicator change={change} />}
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
                  : `Open file ${entry.name}${entry.size != null ? `, ${formatBytes(entry.size)}` : ''}${
                      change ? `, ${changeDescription(change)}` : ''
                    }`
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

export function SourceLines({
  content,
  html,
  lang,
  selection,
  targetLineRef,
}: {
  content: string;
  html: string | null;
  lang?: string;
  selection: FileLineSelection;
  targetLineRef?: RefObject<HTMLSpanElement | null>;
}) {
  const sourceLines = useMemo(() => content.split(/\r?\n/u), [content]);
  const highlightedLines = useMemo(() => (html === null ? null : splitHighlightedLines(html)), [html]);
  const lineCount = sourceLines.length;
  const requestedEnd = selection.endLine ?? selection.line;
  const valid = selection.line <= lineCount;
  const visibleEnd = valid ? Math.min(requestedEnd, lineCount) : selection.line;
  const location =
    selection.endLine === undefined
      ? `Line ${selection.line}${selection.column === undefined ? '' : `, column ${selection.column}`}`
      : `Lines ${selection.line}–${selection.endLine}`;

  return (
    <>
      <div className="kt-fs-location" data-tone={valid ? undefined : 'warn'} role="status">
        {valid
          ? requestedEnd > lineCount
            ? `${location} requested; this file ends at line ${lineCount}. Highlighting through the final line.`
            : `${location} highlighted.`
          : `${location} does not exist; this file has ${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'}.`}
      </div>
      <div className="kt-fs-code scroll-thin">
        <pre className="kt-fs-pre kt-fs-pre--lines">
          {sourceLines.map((line, index) => {
            const lineNumber = index + 1;
            const selected = valid && lineNumber >= selection.line && lineNumber <= visibleEnd;
            const first = selected && lineNumber === selection.line;
            const lineHtml = highlightedLines?.[index];
            return (
              <span
                key={lineNumber}
                ref={first ? targetLineRef : undefined}
                className="kt-fs-source-line"
                data-line={lineNumber}
                data-highlighted={selected || undefined}
                data-column={first && selection.column !== undefined ? selection.column : undefined}
                aria-current={first ? 'location' : undefined}
              >
                <span className="kt-fs-source-gutter" aria-hidden="true">
                  {lineNumber}
                </span>
                {lineHtml === undefined ? (
                  <code className="kt-fs-source-text">{line || ' '}</code>
                ) : (
                  <code
                    className={`kt-fs-source-text hljs${lang ? ` language-${lang}` : ''}`}
                    // Safe: Highlight.js escaped the source. splitHighlightedLines
                    // only balances the span tags that highlighter emitted.
                    dangerouslySetInnerHTML={{ __html: lineHtml || ' ' }}
                  />
                )}
              </span>
            );
          })}
        </pre>
      </div>
    </>
  );
}

export function FileBody({
  file,
  path,
  raw = false,
  selection,
  targetLineRef,
  sessionId,
  cwd,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: {
  file: FsFile;
  path: string;
  raw?: boolean;
  selection?: FileLineSelection;
  targetLineRef?: RefObject<HTMLSpanElement | null>;
  sessionId?: string;
  cwd?: string;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
}) {
  const refusal = fileRefusal(file);
  const content = file.content ?? '';
  const lang = file.lang ?? langFromPath(path);
  const markdown = isMarkdownPath(path);
  const renderedMarkdown = markdown && selection === undefined;
  const html = useMemo(
    () => (refusal || raw || renderedMarkdown ? null : highlightToHtml(content, lang)),
    [refusal, raw, renderedMarkdown, content, lang],
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
  if (!raw && renderedMarkdown) {
    return (
      <div className="kt-fs-md">
        <Markdown
          text={content}
          sessionId={sessionId}
          cwd={cwd}
          onTaskOpen={onTaskOpen}
          onCodeReferenceOpen={onCodeReferenceOpen}
          onAttentionOpen={onAttentionOpen}
          onPinOpen={onPinOpen}
        />
      </div>
    );
  }
  if (selection) {
    return (
      <>
        {!raw && html === null && lang && content.length > HIGHLIGHT_LIMIT && (
          <div className="kt-fs-note" role="status">
            Syntax highlighting is off above {HIGHLIGHT_LIMIT.toLocaleString()} characters.
          </div>
        )}
        <SourceLines content={content} html={html} lang={lang} selection={selection} targetLineRef={targetLineRef} />
      </>
    );
  }
  return (
    <>
      {!raw && html === null && lang && content.length > HIGHLIGHT_LIMIT && (
        <div className="kt-fs-note" role="status">
          Syntax highlighting is off above {HIGHLIGHT_LIMIT.toLocaleString()} characters.
        </div>
      )}
      <div className="kt-fs-code scroll-thin">
        {raw || html === null ? (
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

export function OpenFileTabs({
  tabs,
  activePath,
  onActivate,
  onClose,
}: {
  tabs: readonly OpenFileTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div className="kt-fs-tabs scroll-thin" role="group" aria-label="Open files">
      {tabs.map(tab => {
        const active = tab.path === activePath;
        return (
          <span key={tab.path} className="kt-fs-tab" data-active={active || undefined}>
            <button
              type="button"
              className="kt-fs-tab-open"
              aria-pressed={active}
              aria-label={`Show ${tab.path}`}
              onClick={() => onActivate(tab.path)}
              title={tab.path}
            >
              <FileText size={14} aria-hidden="true" />
              <span>{baseName(tab.path)}</span>
            </button>
            <button
              type="button"
              className="kt-fs-tab-close"
              onClick={() => onClose(tab.path)}
              aria-label={`Close ${tab.path}`}
              title={`Close ${tab.path}`}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

function selectionFromReference(reference: CodeReference): FileLineSelection | undefined {
  const line = reference.line;
  if (line === undefined || !Number.isSafeInteger(line) || line < 1) return undefined;
  const endLine =
    reference.endLine !== undefined && Number.isSafeInteger(reference.endLine) && reference.endLine >= line
      ? reference.endLine
      : undefined;
  const column =
    endLine === undefined &&
    reference.column !== undefined &&
    Number.isSafeInteger(reference.column) &&
    reference.column >= 1
      ? reference.column
      : undefined;
  return { line, ...(endLine === undefined ? {} : { endLine }), ...(column === undefined ? {} : { column }) };
}

export function scrollFileLineIntoView(
  pane: Pick<HTMLDivElement, 'clientHeight' | 'scrollTop' | 'getBoundingClientRect'>,
  target: Pick<HTMLSpanElement, 'getBoundingClientRect'>,
): void {
  const paneTop = pane.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  const targetOffset = pane.scrollTop + targetTop - paneTop;
  pane.scrollTop = Math.max(0, targetOffset - Math.floor(pane.clientHeight / 3));
}

export function FilesTab({
  sessionId,
  cwd,
  requestedReference,
  onRequestedReferenceHandled,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: Props) {
  const probe = useFsProbe(sessionId);
  const restored = readFilesTabState(sessionId);
  const [stateSessionId, setStateSessionId] = useState(sessionId);
  const [dir, setDir] = useState(restored.dir);
  const [tabs, setTabs] = useState<OpenFileTab[]>(restored.tabs);
  const [activePath, setActivePath] = useState<string | null>(restored.activePath);
  const [focusRequest, setFocusRequest] = useState(0);
  const { touchAffected } = useInputModality();
  const paneRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLSpanElement>(null);
  const handledReference = useRef<number | null>(null);
  const touchAffectedRef = useRef(touchAffected);
  touchAffectedRef.current = touchAffected;
  const stateMatchesSession = stateSessionId === sessionId;

  useEffect(() => {
    if (stateMatchesSession) return;
    const next = readFilesTabState(sessionId);
    setDir(next.dir);
    setTabs(next.tabs);
    setActivePath(next.activePath);
    setFocusRequest(0);
    handledReference.current = null;
    setStateSessionId(sessionId);
  }, [sessionId, stateMatchesSession]);

  const repo = probe.changes?.repo ?? false;
  const changes = probe.changes?.changes ?? [];
  const changesTruncated = probe.changes?.truncated ?? false;
  const changeMap = useMemo(() => new Map(changes.map(change => [change.path, change])), [changes]);
  const active = stateMatchesSession && activePath ? (tabs.find(tab => tab.path === activePath) ?? null) : null;

  const openFile = useCallback((path: string) => {
    setTabs(current =>
      current.some(tab => tab.path === path)
        ? current.map(tab => (tab.path === path ? { ...tab, view: 'normal', selection: undefined } : tab))
        : [...current, { path, view: 'normal' }],
    );
    setActivePath(path);
    // Opening from the directory replaces the control that held focus. Ask for
    // the content once; clicking an EXISTING file tab never increments this,
    // so tab switching leaves focus exactly where the reader put it.
    setFocusRequest(request => request + 1);
  }, []);

  const openReference = useCallback((reference: CodeReference) => {
    if (!isOpenablePath(reference.path)) return;
    const selection = selectionFromReference(reference);
    setTabs(current =>
      current.some(tab => tab.path === reference.path)
        ? current.map(tab => (tab.path === reference.path ? { ...tab, selection } : tab))
        : [...current, { path: reference.path, view: 'normal', selection }],
    );
    setActivePath(reference.path);
    setFocusRequest(request => request + 1);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      const index = tabs.findIndex(tab => tab.path === path);
      if (index < 0) return;
      const remaining = tabs.filter(tab => tab.path !== path);
      setTabs(remaining);
      setActivePath(current =>
        current === path ? (remaining[Math.min(index, remaining.length - 1)]?.path ?? null) : current,
      );
    },
    [tabs],
  );

  const setActiveView = useCallback(
    (view: FileView) => {
      if (!activePath) return;
      setTabs(current => current.map(tab => (tab.path === activePath ? { ...tab, view, selection: undefined } : tab)));
    },
    [activePath],
  );

  const clearActiveSelection = useCallback(() => {
    if (!activePath) return;
    setTabs(current => current.map(tab => (tab.path === activePath ? { ...tab, selection: undefined } : tab)));
  }, [activePath]);

  useEffect(() => {
    if (!stateMatchesSession) return;
    writeFilesTabState(sessionId, { dir, tabs, activePath });
  }, [activePath, dir, sessionId, stateMatchesSession, tabs]);

  useEffect(() => {
    if (!stateMatchesSession || !requestedReference || handledReference.current === requestedReference.sequence) return;
    handledReference.current = requestedReference.sequence;
    openReference(requestedReference.reference);
    onRequestedReferenceHandled?.(requestedReference.sequence);
  }, [onRequestedReferenceHandled, openReference, requestedReference, stateMatchesSession]);

  // Never on touch: an unrequested focus there summons the keyboard and jumps
  // the viewport (input capability, not viewport width, owns that policy).
  // `focusRequest` is the ONLY dependency on purpose: raw/diff changes and file
  // tab activation update `active` but must keep focus on the control used.
  useEffect(() => {
    if (touchAffectedRef.current || focusRequest === 0) return;
    paneRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  const listing = useFsResource<FsListing>(
    stateMatchesSession && !active ? `list:${sessionId}:${dir}` : null,
    useCallback(signal => fsApi.list(sessionId, dir, signal), [sessionId, dir]),
  );

  const diffPath = active?.view === 'diff' && active.selection === undefined ? active.path : null;
  const diff = useFsResource<string>(
    diffPath ? `diff:${sessionId}:${diffPath}` : null,
    useCallback(signal => fsApi.diff(sessionId, diffPath ?? '', signal), [sessionId, diffPath]),
  );

  const filePath = active && (active.view !== 'diff' || active.selection !== undefined) ? active.path : null;
  const file = useFsResource<FsFile>(
    filePath ? `file:${sessionId}:${filePath}` : null,
    useCallback(signal => fsApi.file(sessionId, filePath ?? '', undefined, signal), [sessionId, filePath]),
  );

  useEffect(() => {
    if (!active?.selection || !file.data) return;
    const pane = paneRef.current;
    const target = targetLineRef.current;
    if (!pane || !target) return;
    // Scope the jump to the Files pane. `scrollIntoView` can walk every
    // scrollable ancestor and drag the transcript/page behind the side pane.
    scrollFileLineIntoView(pane, target);
  }, [active?.path, active?.selection, file.data]);

  const parsedDiff = useMemo(() => (diff.data != null ? parseUnifiedDiff(diff.data) : null), [diff.data]);
  // A diff that is nothing but plumbing headers has nothing to show — the
  // emptiness test has to agree with what DiffBody actually renders.
  const diffHasBody = useMemo(() => (parsedDiff ? renderableDiffLines(parsedDiff).length > 0 : false), [parsedDiff]);

  if (!stateMatchesSession) {
    return (
      <div className="kt-fs rounded-md border border-border bg-surface">
        <Loading what="session files" />
      </div>
    );
  }

  const title = active
    ? formatCodeReference({ path: active.path, ...active.selection })
    : dir || cwd || 'Session files';
  const rawActive = active?.view === 'raw';
  const diffActive = active?.view === 'diff' && active.selection === undefined;

  return (
    // `.kt-fs` owns flex:1 + min-height:0 (files.css) — the pane fills what the
    // page gives it and its scroller, not the page, takes the overflow.
    <div className="kt-fs rounded-md border border-border bg-surface">
      <div className="kt-fs-bar">
        {active && (
          <button
            type="button"
            className="kt-fs-icon-button"
            onClick={() => setActivePath(null)}
            aria-label="Back to the file list"
            title="Back to files"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        )}
        <span className="kt-fs-title" title={title}>
          <span className="kt-fs-title-path">{title}</span>
        </span>
        <span className="kt-fs-actions">
          {active?.selection && (
            <button
              type="button"
              className="kt-fs-icon-button"
              onClick={clearActiveSelection}
              aria-label={`Clear line selection for ${active.path}`}
              title={active.view === 'diff' ? 'Clear highlight and return to diff' : 'Clear line highlight'}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
          {active && (
            <button
              type="button"
              className="kt-fs-icon-button"
              data-active={rawActive || undefined}
              aria-pressed={rawActive}
              onClick={() => setActiveView(rawActive ? 'normal' : 'raw')}
              aria-label={rawActive ? `Show ${active.path} normally` : `Show raw bytes for ${active.path}`}
              title={rawActive ? 'Show normally' : 'Show raw'}
            >
              <Code2 size={17} aria-hidden="true" />
            </button>
          )}
          {active && repo && (
            <button
              type="button"
              className="kt-fs-icon-button"
              data-active={diffActive || undefined}
              aria-pressed={diffActive}
              onClick={() => setActiveView(diffActive ? 'normal' : 'diff')}
              aria-label={diffActive ? `Show ${active.path} normally` : `Show git diff for ${active.path}`}
              title={diffActive ? 'Show file' : 'Show git diff'}
            >
              <GitCompareArrows size={17} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="kt-fs-icon-button"
            onClick={() => {
              probe.refresh();
              if (diffActive) diff.reload();
              else if (active) file.reload();
              else listing.reload();
            }}
            aria-label={probe.refreshing ? 'Refreshing files' : 'Refresh files'}
            title="Re-read the working tree"
          >
            <RefreshCw size={16} className={probe.refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
          </button>
        </span>
      </div>

      {tabs.length > 0 && (
        <OpenFileTabs tabs={tabs} activePath={activePath} onActivate={setActivePath} onClose={closeFile} />
      )}
      {!active && (
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
        {diffActive && active ? (
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
        ) : active ? (
          file.loading ? (
            <Loading what={baseName(active.path)} />
          ) : file.error ? (
            <Failed what={baseName(active.path)} error={file.error} onRetry={file.reload} />
          ) : file.data ? (
            <FileBody
              file={file.data}
              path={active.path}
              raw={rawActive}
              selection={active.selection}
              targetLineRef={targetLineRef}
              sessionId={sessionId}
              cwd={cwd}
              onTaskOpen={onTaskOpen}
              onCodeReferenceOpen={onCodeReferenceOpen}
              onAttentionOpen={onAttentionOpen}
              onPinOpen={onPinOpen}
            />
          ) : (
            <Note role="status">Nothing to show.</Note>
          )
        ) : (
          <>
            {probe.state === 'error' && (
              <Note tone="warn" role="status">
                Files still browse normally, but git change markers are unavailable: {probe.error ?? 'unknown error'}.
              </Note>
            )}
            {changesTruncated && (
              <Note tone="warn" role="status">
                Some change dots may be missing because the daemon capped this repository’s status response.
              </Note>
            )}
            {listing.loading ? (
              <Loading what={dir || 'the session root'} />
            ) : listing.error ? (
              <Failed what={dir || 'the session root'} error={listing.error} onRetry={listing.reload} />
            ) : listing.data ? (
              <BrowseList listing={listing.data} dir={dir} changes={changeMap} onEnter={setDir} onOpenFile={openFile} />
            ) : (
              <Note role="status">Nothing to show.</Note>
            )}
          </>
        )}
      </div>
    </div>
  );
}
