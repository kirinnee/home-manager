// THE UNIFIED SESSION SIDE PANE — one host for every session-scoped companion
// surface: browser, files, tasks, pins, terminals, skills, lineage, analytics,
// attention and the explicitly unavailable MCP capability.
//
// The pattern is extracted from InAppBrowser.tsx (the first surface to get it
// right) and is now the CANONICAL shape for session-scoped side content —
// agreed with the dictation work, which stays a separate composer-owned mini
// recorder and deliberately does not live here:
//
//   DESKTOP (≥768px)  a NON-MODAL right-hand pane. No focus trap, no scrim,
//                     no `inert` on the conversation: the reader keeps reading
//                     and keeps typing while it is open. Escape closes it only
//                     when focus is inside the pane. Nothing is focused on
//                     open — a composer focus-steal is the bug this whole
//                     contract exists to prevent.
//   PHONE (<768px)    the shared BottomSheet. A portrait phone cannot fit two
//                     useful columns, so the sheet is the honest fallback; the
//                     transcript, its scroll position and a half-typed draft
//                     stay MOUNTED behind it. The sheet may trap focus — there
//                     is no visible chat beside it to preserve — and it is the
//                     established overlay primitive here (details, settings,
//                     pins, task detail all use it) rather than a new drawer.
//
// SESSION-SCOPED. Which surface is open (and the browser's destination) is
// remembered PER SESSION in a module map keyed on session id, so switching
// sessions can never carry another session's open pane, and returning to a
// session restores what you had open there. Pane width is intentionally a
// GLOBAL reader/layout preference, avoiding layout jumps between sessions. The
// workspace itself mounts inside each retained session pane (App.tsx keeps
// visited sessions mounted), so a retained surface's own internal state — a
// browser profile or terminal scrollback — survives navigation exactly as long
// as the session's draft and transcript do.
//
// SURFACES ARE CONTENT, NOT CONTAINERS. Each surface renders its own chrome
// (heading, close affordance, body) against one small contract; the host owns
// only the shell: which surface is open, the desktop/mobile split, dismissal,
// Escape, and focus restore to the opener on close.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Cable,
  ChartNoAxesCombined,
  CircleAlert,
  FileCode2,
  FolderGit2,
  GitFork,
  LayoutGrid,
  ListTodo,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  activateSidePaneTab,
  deactivateSidePane,
  getSidePaneInstanceBody,
  getSidePaneTabDefinition,
  getSidePaneTabDefinitions,
  openSidePaneBrowserTab,
  openSidePaneFileTab,
  openSidePaneTab,
  readSidePaneTabsState,
  removeSidePaneTab,
  resetSidePaneTabsStates,
  resolveSidePaneTab,
  SIDE_PANE_BUILT_IN_TABS,
  sortSidePaneTabs,
  subscribeSidePaneTabRegistry,
  subscribeSidePaneTabsState,
  writeSidePaneTabsState,
  type SidePaneInstanceKind,
  type SidePaneTabDefinition,
  type SidePaneTabId,
  type SidePaneTabInstance,
} from '../lib/side-pane-tab-model';
import {
  clampSidePaneWidth,
  getSidePanePreferences,
  setSidePaneWidth,
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MAX_WIDTH,
  SIDE_PANE_MIN_CHAT_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_WORKSPACE_GAP,
  subscribeSidePanePreferences,
} from '../lib/side-pane-preferences';
import type { CodeReference } from '../lib/code-references';
import type { AttentionId } from '../lib/attention';
import type { PinReferenceLookup } from '../lib/remark-session-references';
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';
import { InAppBrowserContext, type BrowserDestination, type InAppBrowserHost } from './InAppBrowser';
import { describeFsError, fsApi, isAbort, type FsFile } from './files-api';
import { FileBody, FilesTab } from './FilesTab';
import { PinSurface, type PinOpenRequest } from './PinSheet';
import { SessionTasksSurface, type TaskOpenRequest } from './SessionTasks';
import { AnalyticsSurface } from './AnalyticsSurface';
import { AttentionSurface } from './AttentionPanel';
import { LineageSurface } from './LineageSurface';
import { SkillsSurface } from './SkillsSurface';
import { SidePaneResizeHandle } from './SidePaneResizeHandle';
import { SidePaneTabs, sidePanePanelId, sidePaneTabId } from './SidePaneTabs';
import { UnifiedBrowserSurface } from './UnifiedBrowserSurface';
import { WebTerminals } from './WebTerminals';

export type SidePaneSurface =
  | 'browser'
  | 'files'
  | 'tasks'
  | 'pins'
  | 'terminals'
  | 'skills'
  | 'lineage'
  | 'analytics'
  | 'attention'
  | 'mcp';
export type SidePanePresentation = 'pane' | 'sheet';

export interface SidePaneSurfaceMeta {
  label: string;
  /** Compact visible name; the full label remains the tab's accessible name. */
  tabLabel: string;
  closeLabel: string;
  icon: LucideIcon;
  /** Static capability gate. Omit for a live surface. An unavailable entry is
   *  still shown in the registry-driven launcher, but cannot pretend to open
   *  a data source that does not exist yet. */
  unavailableReason?: string;
}

/** What the reader is told opened, and how the sheet dismiss is labelled.
 *  Derived from the tab model's built-in definitions — ONE source of tab
 *  identity — in the historical key order existing consumers iterate. */
export const SIDE_PANE_SURFACES: Record<SidePaneSurface, SidePaneSurfaceMeta> = Object.fromEntries(
  SIDE_PANE_BUILT_IN_TABS.map(def => [
    def.id,
    {
      label: def.label,
      tabLabel: def.shortLabel,
      closeLabel: def.closeLabel,
      icon: def.icon,
      ...(def.unavailableReason ? { unavailableReason: def.unavailableReason } : {}),
    },
  ]),
) as Record<SidePaneSurface, SidePaneSurfaceMeta>;

/** Surfaces that, once opened, stay MOUNTED (hidden) on desktop when the
 *  reader switches surface or closes the pane — for surfaces whose unmount
 *  tears down something expensive or stateful. Members (the definitions'
 *  `retain` flag): `terminals` (each open terminal holds a live WebSocket and
 *  an xterm scrollback buffer; unmounting per open would drop scrollback and
 *  churn reconnects) and `browser` (a live Chrome/profile the human may be
 *  logged into).
 *  Everything else stays mount-per-open on purpose — that is what resets
 *  transient state (pins relies on it). Skills likewise remounts so its dynamic
 *  account catalog refreshes. Retention is desktop-only — the mobile sheet is
 *  a focus-trapped dialog and must fully unmount on close. */
export const RETAINED_SURFACES: ReadonlySet<SidePaneSurface> = new Set(
  SIDE_PANE_BUILT_IN_TABS.filter(def => def.retain).map(def => def.id as SidePaneSurface),
);

/** The spoken confirmation for a surface opening. Desktop names WHERE it
 *  opened, because the reader's context did not change — the conversation is
 *  still in front of them. The browser adds the one fact that distinguishes
 *  this open from the last: the URL. */
export function sidePaneAnnouncement(
  surface: SidePaneTabId,
  presentation: SidePanePresentation,
  browser: BrowserDestination | null,
  /** Resolved label for instance tabs (a file's path, a page's URL host);
   *  singleton ids keep resolving through the registry. */
  label?: string,
): string {
  const resolved = label ?? getSidePaneTabDefinition(surface)?.label ?? surface;
  const base = presentation === 'pane' ? `Opened ${resolved} beside the conversation` : `Opened ${resolved}`;
  const isBrowser = surface === 'browser' || surface.startsWith('browser:');
  return isBrowser && browser ? `${base}: ${browser.href}` : base;
}

// ---- per-session memory ------------------------------------------------------
//
// Tab state lives in the unified tab model (../lib/side-pane-tab-model.ts) —
// module state, NOT React state, keyed strictly on session id, so an
// evicted-then-revisited session comes back to the tabs it had. The exports
// below are the HISTORICAL single-surface view of that model, kept for the
// callers and tests that predate the strip: `surface` is the active tab.

export interface SidePaneSnapshot {
  surface: SidePaneSurface | null;
  browser: BrowserDestination | null;
}

export function readSidePaneState(sessionId: string): SidePaneSnapshot {
  const state = readSidePaneTabsState(sessionId);
  return { surface: state.active as SidePaneSurface | null, browser: state.browser };
}

/** Test seam + the workspace's own write path. Writing a surface also adds
 *  its tab to the session's strip, exactly like opening it via the model. */
export function writeSidePaneState(sessionId: string, next: SidePaneSnapshot): void {
  const current = readSidePaneTabsState(sessionId);
  writeSidePaneTabsState(sessionId, {
    open: next.surface && !current.open.includes(next.surface) ? [...current.open, next.surface] : current.open,
    active: next.surface,
    browser: next.browser,
    instances: current.instances,
  });
}

/** Test seam — the memory is module state, so tests must be able to start
 *  from nothing. */
export function resetSidePaneStates(): void {
  resetSidePaneTabsStates();
}

// ---- the host contract ---------------------------------------------------------

export interface SidePaneHost {
  /** The pane element's id, for `aria-controls` on triggers. */
  paneId: string;
  presentation: SidePanePresentation;
  /** The ACTIVE tab right now (null when the pane is closed). Widened from
   *  the built-in surface union: registered wave-2 tabs are ids too. */
  surface: SidePaneTabId | null;
  /** Authoritative root of this session's Files surface. */
  cwd?: string;
  /** Open a tab: add it to the session's strip if absent and activate it.
   *  The opener element, when given, receives focus back on close — focus is
   *  NEVER moved on open. */
  open: (surface: SidePaneTabId, opener?: HTMLElement | null) => void;
  close: () => void;
  /** The trigger gesture: open when closed or on another surface, close when
   *  this surface is already the open one. */
  toggle: (surface: SidePaneTabId, opener?: HTMLElement | null) => void;
  /** Open one fleet-global task directly in the task surface. */
  openTask: (taskId: string, opener?: HTMLElement | null) => void;
  /** Open a proven session file, optionally selecting one source line/range. */
  openCodeReference: (reference: CodeReference, opener?: HTMLElement | null) => void;
  /** Open one proven durable attention notice. Optional so standalone hosts and
   * older fixtures do not have to invent a delivery capability. */
  openAttention?: (attentionId: AttentionId, opener?: HTMLElement | null) => void;
  /** Open one proven daemon pin in this session's pin surface. */
  openPin?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
}

const SidePaneContext = createContext<SidePaneHost | null>(null);

/** Null outside a workspace, so SessionHeader (and tests) render standalone. */
export function useSidePane(): SidePaneHost | null {
  return useContext(SidePaneContext);
}

// ---- surface bodies ------------------------------------------------------------

/** The contract every hosted surface renders against. Chrome is the surface's
 *  own (heading carrying `titleId`, close affordance where the presentation
 *  needs one); the host provides only shell, dismissal and geometry. */
export interface SurfaceProps {
  sessionId: string;
  presentation: SidePanePresentation;
  titleId: string;
  onClose: () => void;
}

/** Shared slim header for surfaces that do not bring their own (files, tasks).
 *  Pane presentation carries the close button; the sheet already has the
 *  backdrop, handle and swipe for dismissal. */
export function SurfaceHeader({
  icon,
  label,
  titleId,
  presentation,
  onClose,
  closeLabel,
}: {
  icon: ReactNode;
  label: string;
  titleId: string;
  presentation: SidePanePresentation;
  onClose: () => void;
  closeLabel: string;
}) {
  const Heading = presentation === 'pane' ? 'h2' : 'h1';
  return (
    <header className="flex shrink-0 items-center gap-sm border-b border-border-soft px-panel pb-3">
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent"
        aria-hidden="true"
      >
        {icon}
      </span>
      <Heading
        id={titleId}
        className="m-0 min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg"
      >
        {label}
      </Heading>
      {presentation === 'pane' && (
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="ml-auto min-h-[44px] min-w-[44px] justify-center p-0"
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X size={17} aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}

function FilesSurface({
  sessionId,
  cwd,
  presentation,
  titleId,
  onClose,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: SurfaceProps & {
  cwd?: string;
  onTaskOpen?: SidePaneHost['openTask'];
  onCodeReferenceOpen?: SidePaneHost['openCodeReference'];
  onAttentionOpen?: NonNullable<SidePaneHost['openAttention']>;
  onPinOpen?: NonNullable<SidePaneHost['openPin']>;
}) {
  return (
    <>
      <SurfaceHeader
        icon={<FolderGit2 size={17} />}
        label="Files"
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel={SIDE_PANE_SURFACES.files.closeLabel}
      />
      {/* FilesTab is re-hosted, not redesigned: it owns its sections, viewer
          stack, probe and error copy exactly as it did as a page tab. Line
          deliveries no longer arrive here — a code reference opens its own
          per-file instance tab carrying the selection. */}
      <div className="flex min-h-0 flex-1 flex-col px-panel pb-2 pt-2">
        <FilesTab
          sessionId={sessionId}
          cwd={cwd}
          onTaskOpen={onTaskOpen}
          onCodeReferenceOpen={onCodeReferenceOpen}
          onAttentionOpen={onAttentionOpen}
          onPinOpen={onPinOpen}
        />
      </div>
    </>
  );
}

function TasksSurface({
  sessionId,
  cwd,
  presentation,
  titleId,
  onClose,
  requestedTask,
  onRequestedTaskHandled,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: SurfaceProps & {
  cwd?: string;
  requestedTask?: TaskOpenRequest | null;
  onRequestedTaskHandled?: (sequence: number) => void;
  onCodeReferenceOpen?: SidePaneHost['openCodeReference'];
  onAttentionOpen?: NonNullable<SidePaneHost['openAttention']>;
  onPinOpen?: NonNullable<SidePaneHost['openPin']>;
}) {
  return (
    <>
      <SurfaceHeader
        icon={<ListTodo size={17} />}
        label="Tasks"
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel={SIDE_PANE_SURFACES.tasks.closeLabel}
      />
      <SessionTasksSurface
        sessionId={sessionId}
        cwd={cwd}
        requestedTask={requestedTask}
        onRequestedTaskHandled={onRequestedTaskHandled}
        onCodeReferenceOpen={onCodeReferenceOpen}
        onAttentionOpen={onAttentionOpen}
        onPinOpen={onPinOpen}
      />
    </>
  );
}

function LineagePaneSurface({ sessionId, presentation, titleId, onClose }: SurfaceProps) {
  return (
    <>
      <SurfaceHeader
        icon={<GitFork size={17} />}
        label="Lineage"
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel={SIDE_PANE_SURFACES.lineage.closeLabel}
      />
      <LineageSurface sessionId={sessionId} />
    </>
  );
}

function AnalyticsPaneSurface({ sessionId, presentation, titleId, onClose }: SurfaceProps) {
  return (
    <>
      <SurfaceHeader
        icon={<ChartNoAxesCombined size={17} />}
        label="Analytics"
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel={SIDE_PANE_SURFACES.analytics.closeLabel}
      />
      <AnalyticsSurface sessionId={sessionId} />
    </>
  );
}

/** ONE FILE, ONE TAB. The body of a `file:<path>` instance: fetch the file
 *  from the same daemon endpoint the Files tree reads, render it through the
 *  files surface's own `FileBody` (Markdown as prose, code highlighted, the
 *  daemon's refusal verdicts respected), and honour a delivered line range.
 *  Loading and failure render as themselves — never as an empty file. */
function FileInstanceSurface({
  instance,
  sessionId,
  cwd,
  presentation,
  titleId,
  onClose,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: SurfaceProps & {
  instance: SidePaneTabInstance;
  cwd?: string;
  onTaskOpen?: SidePaneHost['openTask'];
  onCodeReferenceOpen?: SidePaneHost['openCodeReference'];
  onAttentionOpen?: NonNullable<SidePaneHost['openAttention']>;
  onPinOpen?: NonNullable<SidePaneHost['openPin']>;
}) {
  const path = instance.key;
  const [nonce, setNonce] = useState(0);
  // The result is only rendered against the path that asked for it, so a
  // reused surface can never paint one frame of the previous file's bytes.
  const [resource, setResource] = useState<{ path: string; file: FsFile | null; error: string | null } | null>(null);
  const targetLineRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    fsApi
      .file(sessionId, path, undefined, controller.signal)
      .then(file => {
        if (live) setResource({ path, file, error: null });
      })
      .catch(error => {
        if (!live || controller.signal.aborted || isAbort(error)) return;
        setResource({ path, file: null, error: describeFsError(error) });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [sessionId, path, nonce]);

  // A delivered line range scrolls into view once per delivery (revision
  // bumps on every re-delivery to an already-open tab), never on plain
  // re-render — the reader's own scroll position is theirs.
  const loaded = resource?.path === path && resource.file !== null;
  useEffect(() => {
    if (!instance.selection || !loaded) return;
    const frame = requestAnimationFrame(() => {
      targetLineRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [instance.selection, instance.revision, loaded]);

  const fresh = resource !== null && resource.path === path;
  return (
    <>
      <SurfaceHeader
        icon={<FileCode2 size={17} />}
        label={instance.label}
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel={`Close ${instance.label}`}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-panel pb-2 pt-2">
        <p className="m-0 mb-2 shrink-0 truncate text-2xs text-muted" title={path}>
          {path}
        </p>
        {!fresh && (
          <p className="m-0 text-ui text-muted" role="status">
            Loading {instance.label}…
          </p>
        )}
        {fresh && resource.error !== null && (
          <div role="alert" className="text-ui text-muted">
            <p className="m-0">
              Could not load {path}: {resource.error}
            </p>
            <Button type="button" variant="ghost" className="mt-2" onClick={() => setNonce(n => n + 1)}>
              Retry
            </Button>
          </div>
        )}
        {fresh && resource.file !== null && (
          <FileBody
            file={resource.file}
            path={path}
            selection={instance.selection}
            targetLineRef={targetLineRef}
            sessionId={sessionId}
            cwd={cwd}
            onTaskOpen={onTaskOpen}
            onCodeReferenceOpen={onCodeReferenceOpen}
            onAttentionOpen={onAttentionOpen}
            onPinOpen={onPinOpen}
          />
        )}
      </div>
    </>
  );
}

function TerminalsSurface({ sessionId, cwd, presentation, titleId, onClose }: SurfaceProps & { cwd?: string }) {
  return (
    <>
      <SurfaceHeader
        icon={<SquareTerminal size={17} />}
        label="Terminals"
        titleId={titleId}
        presentation={presentation}
        onClose={onClose}
        closeLabel={SIDE_PANE_SURFACES.terminals.closeLabel}
      />
      <WebTerminals sessionId={sessionId} cwd={cwd} />
    </>
  );
}

function SurfaceBody({
  surface,
  instance,
  sessionId,
  cwd,
  browser,
  presentation,
  titleId,
  onClose,
  onInsertSkill,
  isActive,
  requestedTask,
  onRequestedTaskHandled,
  requestedAttention,
  onRequestedAttentionHandled,
  requestedPin,
  onRequestedPinHandled,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: {
  surface: SidePaneTabId;
  /** Present when `surface` is an instance tab (file / browser page / terminal). */
  instance?: SidePaneTabInstance;
  sessionId: string;
  cwd?: string;
  browser: BrowserDestination | null;
  presentation: SidePanePresentation;
  titleId: string;
  onClose: () => void;
  onInsertSkill: (invocation: string) => void;
  isActive: boolean;
  requestedTask?: TaskOpenRequest | null;
  onRequestedTaskHandled?: (sequence: number) => void;
  requestedAttention?: { id: AttentionId; sequence: number } | null;
  onRequestedAttentionHandled?: (sequence: number) => void;
  requestedPin?: PinOpenRequest | null;
  onRequestedPinHandled?: (sequence: number) => void;
  onTaskOpen?: SidePaneHost['openTask'];
  onCodeReferenceOpen?: SidePaneHost['openCodeReference'];
  onAttentionOpen?: NonNullable<SidePaneHost['openAttention']>;
  onPinOpen?: NonNullable<SidePaneHost['openPin']>;
}) {
  // Instance tabs first: each renders ITS OWN instance — its own file, its own
  // page — never a shared singleton body.
  if (instance) {
    switch (instance.kind) {
      case 'file':
        return (
          <FileInstanceSurface
            instance={instance}
            sessionId={sessionId}
            cwd={cwd}
            presentation={presentation}
            titleId={titleId}
            onClose={onClose}
            onTaskOpen={onTaskOpen}
            onCodeReferenceOpen={onCodeReferenceOpen}
            onAttentionOpen={onAttentionOpen}
            onPinOpen={onPinOpen}
          />
        );
      case 'browser':
        // One UnifiedBrowserSurface per page tab; retention keeps each page's
        // engine, history and profile alive while another tab is showing.
        return (
          <UnifiedBrowserSurface
            sessionId={sessionId}
            destination={instance.destination ?? null}
            presentation={presentation}
            titleId={titleId}
            onClose={onClose}
            isActive={isActive}
          />
        );
      case 'terminal': {
        // The terminals deck owns terminal rendering. It (or any wave-2
        // module) claims the kind via registerSidePaneInstanceBody; until that
        // registration exists a terminal tab says so instead of pretending.
        const render = getSidePaneInstanceBody('terminal');
        if (render) {
          return <>{render({ sessionId, presentation, titleId, onClose, cwd, isActive, instance })}</>;
        }
        return (
          <>
            <SurfaceHeader
              icon={<SquareTerminal size={17} />}
              label={instance.label}
              titleId={titleId}
              presentation={presentation}
              onClose={onClose}
              closeLabel={`Close ${instance.label}`}
            />
            <div className="flex min-h-[240px] flex-1 items-center justify-center px-panel py-8 text-center">
              <p className="m-0 max-w-xs text-ui leading-base text-muted">
                No terminal body is registered in this build; open the Terminals tab for the deck.
              </p>
            </div>
          </>
        );
      }
    }
  }
  switch (surface) {
    case 'browser':
      return (
        <UnifiedBrowserSurface
          sessionId={sessionId}
          destination={browser}
          presentation={presentation}
          titleId={titleId}
          onClose={onClose}
          isActive={isActive}
        />
      );
    case 'files':
      return (
        <FilesSurface
          sessionId={sessionId}
          cwd={cwd}
          presentation={presentation}
          titleId={titleId}
          onClose={onClose}
          onTaskOpen={onTaskOpen}
          onCodeReferenceOpen={onCodeReferenceOpen}
          onAttentionOpen={onAttentionOpen}
          onPinOpen={onPinOpen}
        />
      );
    case 'tasks':
      return (
        <TasksSurface
          sessionId={sessionId}
          cwd={cwd}
          presentation={presentation}
          titleId={titleId}
          onClose={onClose}
          requestedTask={requestedTask}
          onRequestedTaskHandled={onRequestedTaskHandled}
          onCodeReferenceOpen={onCodeReferenceOpen}
          onAttentionOpen={onAttentionOpen}
          onPinOpen={onPinOpen}
        />
      );
    case 'pins':
      return (
        <PinSurface
          sessionId={sessionId}
          cwd={cwd}
          presentation={presentation}
          titleId={titleId}
          onRequestClose={onClose}
          requestedPin={requestedPin}
          onRequestedPinHandled={onRequestedPinHandled}
          onTaskOpen={onTaskOpen}
          onCodeReferenceOpen={onCodeReferenceOpen}
          onAttentionOpen={onAttentionOpen}
          onPinOpen={onPinOpen}
        />
      );
    case 'skills':
      return (
        <SkillsSurface
          sessionId={sessionId}
          presentation={presentation}
          titleId={titleId}
          onClose={onClose}
          onInsert={onInsertSkill}
        />
      );
    case 'terminals':
      return (
        <TerminalsSurface
          sessionId={sessionId}
          cwd={cwd}
          presentation={presentation}
          titleId={titleId}
          onClose={onClose}
        />
      );
    case 'lineage':
      return (
        <LineagePaneSurface sessionId={sessionId} presentation={presentation} titleId={titleId} onClose={onClose} />
      );
    case 'analytics':
      return (
        <AnalyticsPaneSurface sessionId={sessionId} presentation={presentation} titleId={titleId} onClose={onClose} />
      );
    case 'attention':
      return (
        <AttentionSurface
          sessionId={sessionId}
          presentation={presentation}
          titleId={titleId}
          onRequestClose={onClose}
          cwd={cwd}
          requestedAttention={requestedAttention}
          onRequestedAttentionHandled={onRequestedAttentionHandled}
          onTaskOpen={onTaskOpen}
          onCodeReferenceOpen={onCodeReferenceOpen}
          onAttentionOpen={onAttentionOpen}
          onPinOpen={onPinOpen}
        />
      );
    case 'mcp':
      return (
        <>
          <SurfaceHeader
            icon={<Cable size={17} />}
            label="MCP"
            titleId={titleId}
            presentation={presentation}
            onClose={onClose}
            closeLabel={SIDE_PANE_SURFACES.mcp.closeLabel}
          />
          <div className="flex min-h-[240px] flex-1 items-center justify-center px-panel py-8 text-center">
            <div className="max-w-xs">
              <Cable size={28} aria-hidden="true" className="mx-auto text-muted" />
              <p className="mb-0 mt-3 text-ui leading-base text-muted">{SIDE_PANE_SURFACES.mcp.unavailableReason}</p>
            </div>
          </div>
        </>
      );
    default: {
      // Not a built-in surface: a wave-2 tab registered into the model. Its
      // definition brings its own body; a definition without one — or an id
      // whose registration vanished — renders an explicit unknown, never a
      // confident default.
      const def = getSidePaneTabDefinition(surface);
      if (def?.render) {
        return <>{def.render({ sessionId, presentation, titleId, onClose, cwd, isActive })}</>;
      }
      const DefIcon = def?.icon;
      return (
        <>
          <SurfaceHeader
            icon={DefIcon ? <DefIcon size={17} /> : <CircleAlert size={17} />}
            label={def?.label ?? 'Unknown tab'}
            titleId={titleId}
            presentation={presentation}
            onClose={onClose}
            closeLabel={def?.closeLabel ?? 'Close tab'}
          />
          <div className="flex min-h-[240px] flex-1 items-center justify-center px-panel py-8 text-center">
            <p className="m-0 max-w-xs text-ui leading-base text-muted">
              {def
                ? (def.unavailableReason ?? 'This tab registered no content to show.')
                : 'This tab is not registered in this build.'}
            </p>
          </div>
        </>
      );
    }
  }
}

// ---- the desktop pane shell ------------------------------------------------------

const IGNORE_RESIZE = (_width: number) => undefined;

/** Desktop's non-modal half of the workspace: the conversation stays visible
 *  and usable. The resize gutter is a sibling of the semantic aside so its
 *  16px hit target can straddle the border without being clipped. */
export function SidePaneShell({
  id,
  titleId,
  onClose,
  width = SIDE_PANE_DEFAULT_WIDTH,
  onWidthPreview = IGNORE_RESIZE,
  onWidthCommit = IGNORE_RESIZE,
  hidden = false,
  children,
}: {
  id: string;
  titleId: string;
  onClose: () => void;
  width?: number;
  onWidthPreview?: (width: number) => void;
  onWidthCommit?: (width: number) => void;
  /** True when the pane is CLOSED but still hosts retained (hidden) surfaces:
   *  it keeps their DOM alive while costing no layout, paint, or tab stop —
   *  the visibility technique App.tsx uses for retained session panes. */
  hidden?: boolean;
  children: ReactNode;
}) {
  const preferredWidth = clampSidePaneWidth(width);
  return (
    <div
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
      className={
        hidden ? 'pointer-events-none invisible absolute w-0 overflow-hidden' : 'relative mb-2 min-h-0 shrink-0'
      }
      style={
        hidden
          ? undefined
          : {
              width: `${preferredWidth}px`,
              minWidth: `${SIDE_PANE_MIN_WIDTH}px`,
              maxWidth: `min(${SIDE_PANE_MAX_WIDTH}px, calc(100% - ${SIDE_PANE_MIN_CHAT_WIDTH + SIDE_PANE_WORKSPACE_GAP}px))`,
            }
      }
    >
      {!hidden && <SidePaneResizeHandle width={preferredWidth} onPreview={onWidthPreview} onCommit={onWidthCommit} />}
      <aside
        id={id}
        role="complementary"
        aria-labelledby={hidden ? undefined : titleId}
        aria-hidden={hidden ? true : undefined}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
      >
        {children}
      </aside>
    </div>
  );
}

// ---- registry-driven bento launcher ---------------------------------------------

export type SidePaneLauncherBadges = Partial<Record<SidePaneSurface, number>>;
export type SidePaneLauncherDisabled = Partial<Record<SidePaneSurface, string>>;

export function SidePaneBento({
  host,
  onSelect,
  badges,
  disabled,
}: {
  host: SidePaneHost;
  onSelect: (surface: SidePaneSurface) => void;
  badges: SidePaneLauncherBadges;
  disabled: SidePaneLauncherDisabled;
}) {
  return (
    <div className="grid grid-cols-2 gap-sm sm:grid-cols-3" aria-label="Session tools">
      {(Object.entries(SIDE_PANE_SURFACES) as Array<[SidePaneSurface, SidePaneSurfaceMeta]>).map(([surface, meta]) => {
        const Icon = meta.icon;
        const unavailable = meta.unavailableReason ?? disabled[surface];
        const selected = host.surface === surface;
        const badge = badges[surface] ?? 0;
        return (
          <button
            key={surface}
            type="button"
            disabled={Boolean(unavailable)}
            aria-disabled={unavailable ? true : undefined}
            aria-pressed={selected}
            aria-label={unavailable ? `${meta.label}, unavailable: ${unavailable}` : `Open ${meta.label}`}
            title={unavailable ?? `Open ${meta.label}`}
            onClick={() => onSelect(surface)}
            className="relative flex min-h-[68px] min-w-0 flex-col items-start justify-between gap-xs rounded-control border border-border bg-surface-2 p-2 text-left text-fg hover:border-accent-border hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="flex w-full items-start justify-between gap-xs">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent-border bg-surface text-accent"
                aria-hidden="true"
              >
                <Icon size={17} />
              </span>
              {badge > 0 && (
                <span className="inline-flex min-h-[22px] min-w-[22px] items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-fg">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span className="w-full min-w-0">
              <span className="block truncate text-ui font-semibold">{meta.label}</span>
              {unavailable && <span className="block truncate text-2xs text-muted">Unavailable</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The one top-bar entry for every registered session tool. The launcher maps
 *  SIDE_PANE_SURFACES directly: adding a registry entry cannot silently omit
 *  it from the bento. Desktop uses a non-modal anchored panel; a 390px layout
 *  uses the established focus-trapped sheet. Neither path focuses pane content
 *  when a tool is selected. */
export function SidePaneLauncher({
  compact,
  active = true,
  badges = {},
  disabled = {},
}: {
  compact: boolean;
  active?: boolean;
  badges?: SidePaneLauncherBadges;
  disabled?: SidePaneLauncherDisabled;
}) {
  const host = useSidePane();
  const generatedId = useId();
  const launcherId = `session-tools-${generatedId}`;
  const panelId = `${launcherId}-panel`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useEffect(() => {
    if (!open || compact) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, compact, open]);

  if (!host) return null;

  const select = (surface: SidePaneSurface) => {
    const meta = SIDE_PANE_SURFACES[surface];
    if (meta.unavailableReason || disabled[surface]) return;
    setOpen(false);
    // Let a closing mobile launcher restore its own focus first; opening a
    // surface never focuses its content, and records the launcher as opener so
    // the pane's eventual close has a stable return target.
    window.requestAnimationFrame(() => host.open(surface, triggerRef.current));
  };
  const bento = <SidePaneBento host={host} onSelect={select} badges={badges} disabled={disabled} />;

  return (
    <>
      <div className="relative shrink-0">
        <button
          ref={triggerRef}
          id={launcherId}
          type="button"
          onClick={() => setOpen(current => !current)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label="Open session tools"
          title="Session tools"
          className="relative inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control border border-border p-0 text-muted hover:border-accent-border hover:text-fg"
        >
          <LayoutGrid size={17} aria-hidden="true" />
        </button>
        {open && !compact && (
          <div
            ref={popoverRef}
            id={panelId}
            role="dialog"
            aria-label="Session tools"
            className="absolute right-0 top-full z-50 mt-1 w-[min(336px,calc(100vw-16px))] rounded-panel border border-border bg-surface p-panel shadow-popover"
          >
            {bento}
          </div>
        )}
      </div>
      {compact && (
        <BottomSheet
          id={panelId}
          open={open}
          onClose={() => close()}
          labelledBy={launcherId}
          closeLabel="Close session tools"
          panelClassName="overflow-hidden bg-surface"
          maxHeight="min(76dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
          zIndexClass="z-[80]"
        >
          <div className="overflow-y-auto p-panel">{bento}</div>
        </BottomSheet>
      )}
    </>
  );
}

// ---- the workspace ---------------------------------------------------------------

/**
 * Session-local side-pane host. Wraps the chat page (one workspace per
 * retained session pane) and provides:
 *   - the SidePane context for triggers (header buttons),
 *   - the InAppBrowser link context, so a transcript link tap opens the
 *     browser surface through the same host.
 */
const IGNORE_SKILL_INSERT = (_invocation: string) => undefined;

export function SidePaneWorkspace({
  sessionId,
  compact,
  active = true,
  cwd,
  onInsertSkill = IGNORE_SKILL_INSERT,
  children,
}: {
  sessionId: string;
  compact: boolean;
  /** Is this the pane the reader is looking at? A retained BACKGROUND pane
   *  must not keep a focus-trapped sheet (an escape layer) alive — the pane
   *  presentation is non-modal and safely retained, the sheet is not. */
  active?: boolean;
  cwd?: string;
  /** Draft-only boundary: Skills can insert an invocation but cannot submit. */
  onInsertSkill?: (invocation: string) => void;
  children: ReactNode;
}) {
  const generatedId = useId();
  const paneId = `session-side-pane-${generatedId}`;
  const titleId = `${paneId}-title`;
  const openerRef = useRef<HTMLElement | null>(null);
  // Tab state and the tab registry are external stores (the model). The
  // registry snapshot doubles as the picker catalogue, and subscribing to it
  // makes a late wave-2 registration appear in a live strip.
  const allTabs = useSyncExternalStore(
    subscribeSidePaneTabRegistry,
    getSidePaneTabDefinitions,
    getSidePaneTabDefinitions,
  );
  const state = useSyncExternalStore(
    subscribeSidePaneTabsState,
    () => readSidePaneTabsState(sessionId),
    () => readSidePaneTabsState(sessionId),
  );
  const storedPreferences = useSyncExternalStore(
    subscribeSidePanePreferences,
    getSidePanePreferences,
    getSidePanePreferences,
  );
  // Preview is local to this workspace: retained sessions do not re-render on
  // every drag tick. The global preference publishes only at drag end.
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [requestedTask, setRequestedTask] = useState<TaskOpenRequest | null>(null);
  // Delivery requests are transient, unlike the durable surface/browser
  // snapshot. Keep an independent monotonic sequence so clearing a handled
  // request can never make the next click repeat an id a surface has seen.
  // (Code references need no request channel any more: they ride on the
  // per-file instance tab itself, revisioned by the model.)
  const attentionSequence = useRef(0);
  const [requestedAttention, setRequestedAttention] = useState<{ id: AttentionId; sequence: number } | null>(null);
  const pinSequence = useRef(0);
  const [requestedPin, setRequestedPin] = useState<PinOpenRequest | null>(null);
  const paneWidth = previewWidth ?? storedPreferences.width;
  const commitPaneWidth = useCallback((width: number) => {
    setSidePaneWidth(width);
    setPreviewWidth(null);
  }, []);
  // Retained tabs (definition `retain` flag) that have been opened in this
  // workspace's life. They stay mounted (hidden) on desktop after the reader
  // moves away, so switching tab never tears down a live remote session.
  // Bounded by the retained definitions and reset with the workspace.
  const [everRetained, setEverRetained] = useState<ReadonlySet<SidePaneTabId>>(() => new Set());
  const presentation: SidePanePresentation = compact ? 'sheet' : 'pane';
  // The strip: this session's open tabs, definitions resolved, strip order.
  // An id whose registration vanished renders nowhere (unknown must not
  // invent a tab); its body, if active, says so explicitly.
  const openTabDefs = useMemo(
    () =>
      sortSidePaneTabs(state.open, state.instances)
        .map(id => resolveSidePaneTab(sessionId, id))
        .filter((def): def is SidePaneTabDefinition => def !== undefined),
    // allTabs keys the registry version: a (un)registration re-resolves.
    [state, sessionId, allTabs],
  );
  useEffect(() => {
    const active = state.active;
    if (!active || compact || resolveSidePaneTab(sessionId, active)?.retain !== true) return;
    setEverRetained(current => (current.has(active) ? current : new Set(current).add(active)));
  }, [compact, sessionId, state.active]);

  const open = useCallback(
    (surface: SidePaneTabId, opener?: HTMLElement | null) => {
      if (opener) openerRef.current = opener;
      openSidePaneTab(sessionId, surface);
    },
    [sessionId],
  );

  // Close NEVER touches focus unless the opener is still in the document —
  // the same restraint InAppBrowser shipped with. Restoring focus on close is
  // the counterpart of never stealing it on open.
  const close = useCallback(() => {
    deactivateSidePane(sessionId);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && typeof window !== 'undefined' && document.contains(opener)) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }, [sessionId]);

  const toggle = useCallback(
    (surface: SidePaneTabId, opener?: HTMLElement | null) => {
      if (readSidePaneTabsState(sessionId).active === surface) close();
      else open(surface, opener);
    },
    [close, open, sessionId],
  );

  const openTask = useCallback(
    (taskId: string, opener?: HTMLElement | null) => {
      const id = taskId.trim().replace(/^#/u, '').toUpperCase();
      if (!/^[BFIC][0-9]{1,9}$/u.test(id)) return;
      setRequestedTask(current => ({ id, sequence: (current?.sequence ?? 0) + 1 }));
      open('tasks', opener);
    },
    [open],
  );

  // ONE TAB PER FILE: transcript links, code references and (via the lead's
  // integration line) the files tree all land here — the same open-instance
  // call. Re-opening a path focuses its existing tab with the new line range.
  const openCodeReference = useCallback(
    (reference: CodeReference, opener?: HTMLElement | null) => {
      if (opener) openerRef.current = opener;
      const line = reference.line;
      const selection =
        line !== undefined && Number.isSafeInteger(line) && line >= 1
          ? {
              line,
              ...(reference.endLine !== undefined &&
              Number.isSafeInteger(reference.endLine) &&
              reference.endLine >= line
                ? { endLine: reference.endLine }
                : {}),
              ...(reference.endLine === undefined &&
              reference.column !== undefined &&
              Number.isSafeInteger(reference.column) &&
              reference.column >= 1
                ? { column: reference.column }
                : {}),
            }
          : undefined;
      openSidePaneFileTab(sessionId, reference.path, selection);
    },
    [sessionId],
  );

  const openAttention = useCallback(
    (attentionId: AttentionId, opener?: HTMLElement | null) => {
      if (!/^A[1-9][0-9]*$/u.test(attentionId)) return;
      setRequestedAttention({ id: attentionId, sequence: ++attentionSequence.current });
      open('attention', opener);
    },
    [open],
  );

  const openPin = useCallback(
    (reference: PinReferenceLookup, opener?: HTMLElement | null) => {
      // Pin identity is session-scoped. Never reinterpret a valid pin from a
      // different workspace as a missing pin in this one.
      if (reference.sessionId !== sessionId) return;
      setRequestedPin({ reference, sequence: ++pinSequence.current });
      open('pins', opener);
    },
    [open, sessionId],
  );

  // ONE TAB PER PAGE: a transcript link opens its destination as a page
  // instance — a page already showing that URL is focused, anything else gets
  // a fresh tab with its own state. The legacy singleton payload keeps riding
  // in session state for the historical snapshot readers.
  const openDestination = useCallback(
    (destination: BrowserDestination, opener: HTMLElement) => {
      openerRef.current = opener;
      const current = readSidePaneTabsState(sessionId);
      writeSidePaneTabsState(sessionId, { ...current, browser: destination });
      openSidePaneBrowserTab(sessionId, destination);
    },
    [sessionId],
  );

  // The + picker's instance entries always create a NEW instance: a fresh
  // empty browser page (files and terminals spawn instances from their own
  // surfaces — the tree picks files, the deck opens terminals).
  const openNewInstance = useCallback(
    (kind: SidePaneInstanceKind) => {
      if (kind === 'browser') openSidePaneBrowserTab(sessionId, null, { forceNew: true });
      else if (kind === 'file') openSidePaneTab(sessionId, 'files');
      else openSidePaneTab(sessionId, 'terminals');
    },
    [sessionId],
  );

  // A hidden retained pane keeping an OPEN focus-trapped sheet alive would own
  // the Escape stack from behind visibility:hidden. Close the sheet when this
  // pane stops being the one on screen; the non-modal desktop pane is safe to
  // retain (it traps nothing) and is exactly what "remember per session" is
  // for. Deliberately not reopened on return — an unprompted modal is worse
  // than a lost sheet.
  useEffect(() => {
    if (compact && !active && readSidePaneTabsState(sessionId).active) deactivateSidePane(sessionId);
  }, [active, compact, sessionId]);

  // Stable while the pane opens/closes, so hundreds of transcript links do not
  // re-render because a sibling surface changed.
  const browserHost = useMemo<InAppBrowserHost>(
    () => ({ paneId, presentation, openDestination }),
    [paneId, presentation, openDestination],
  );
  const host = useMemo<SidePaneHost>(
    () => ({
      paneId,
      presentation,
      surface: state.active,
      cwd,
      open,
      close,
      toggle,
      openTask,
      openCodeReference,
      openAttention,
      openPin,
    }),
    [paneId, presentation, state.active, cwd, open, close, toggle, openTask, openCodeReference, openAttention, openPin],
  );

  const surfaceOpen = state.active !== null;
  // The sheet's slide-out needs its content for one more transition frame
  // after close, so the LAST surface lingers for the sheet path only (the same
  // reason InAppBrowser never cleared its destination on close). The desktop
  // pane unmounts immediately — it has no exit animation.
  const lastSurfaceRef = useRef<SidePaneTabId | null>(null);
  // Instance payloads linger with the surface: a just-closed file/page tab
  // must not flash "not registered" behind the sheet's slide-out.
  const lastInstanceRef = useRef<SidePaneTabInstance | undefined>(undefined);
  if (state.active) {
    lastSurfaceRef.current = state.active;
    lastInstanceRef.current = state.instances[state.active];
  }
  const sheetSurface = state.active ?? lastSurfaceRef.current;
  const displaySurface = compact ? sheetSurface : state.active;
  // `role=tabpanel` wiring is desktop-only: the mobile presentation has no
  // tablist (the switcher modal replaced the strip), so there is no tab
  // element for the panel to be labelled by — the sheet dialog labels itself.
  const body = displaySurface && !(resolveSidePaneTab(sessionId, displaySurface)?.retain === true && !compact) && (
    <div
      id={sidePanePanelId(paneId, displaySurface)}
      role={compact ? undefined : 'tabpanel'}
      aria-labelledby={compact ? undefined : sidePaneTabId(paneId, displaySurface)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SurfaceBody
        surface={displaySurface}
        instance={
          state.instances[displaySurface] ??
          (displaySurface === lastSurfaceRef.current ? lastInstanceRef.current : undefined)
        }
        sessionId={sessionId}
        cwd={cwd}
        browser={state.browser}
        presentation={presentation}
        titleId={titleId}
        onClose={close}
        onInsertSkill={onInsertSkill}
        isActive={active && state.active === displaySurface}
        requestedTask={requestedTask}
        onRequestedTaskHandled={() => setRequestedTask(null)}
        requestedAttention={requestedAttention}
        onRequestedAttentionHandled={sequence =>
          setRequestedAttention(current => (current?.sequence === sequence ? null : current))
        }
        requestedPin={requestedPin}
        onRequestedPinHandled={sequence =>
          setRequestedPin(current => (current?.sequence === sequence ? null : current))
        }
        onTaskOpen={openTask}
        onCodeReferenceOpen={openCodeReference}
        onAttentionOpen={openAttention}
        onPinOpen={openPin}
      />
    </div>
  );
  // Retained surfaces render OUTSIDE the mount-per-open body: each one stays
  // in the DOM once opened (visibility:hidden while not the open surface, the
  // same technique App.tsx uses for retained session panes) so switching away
  // never tears it down. Desktop only; the sheet path never retains. The OPEN
  // surface joins the list synchronously — the everRetained effect lands a
  // render later, and a first open must not paint blank for that frame.
  // A retained id must still RESOLVE to stay mounted: a singleton (terminals
  // deck) survives being hidden or toggled out of the strip, but a CLOSED
  // instance tab (its ✕) no longer resolves — closing a browser page disposes
  // that page, it does not park it invisibly forever.
  const liveRetained = [...everRetained].filter(id => resolveSidePaneTab(sessionId, id)?.retain === true);
  const retainedList =
    !compact &&
    state.active &&
    resolveSidePaneTab(sessionId, state.active)?.retain === true &&
    !liveRetained.includes(state.active)
      ? [...liveRetained, state.active]
      : liveRetained;
  const retainedBodies = !compact
    ? retainedList.map(surface => (
        <div
          key={surface}
          id={sidePanePanelId(paneId, surface)}
          role="tabpanel"
          aria-labelledby={sidePaneTabId(paneId, surface)}
          aria-hidden={state.active === surface ? undefined : true}
          className={
            state.active === surface
              ? 'flex min-h-0 flex-1 flex-col'
              : 'pointer-events-none invisible absolute h-0 overflow-hidden'
          }
        >
          <SurfaceBody
            surface={surface}
            instance={state.instances[surface]}
            sessionId={sessionId}
            cwd={cwd}
            browser={state.browser}
            presentation={presentation}
            titleId={state.active === surface ? titleId : `${titleId}-retained-${surface}`}
            onClose={close}
            onInsertSkill={onInsertSkill}
            isActive={active && state.active === surface}
            requestedTask={requestedTask}
            onRequestedTaskHandled={() => setRequestedTask(null)}
            requestedAttention={requestedAttention}
            onRequestedAttentionHandled={sequence =>
              setRequestedAttention(current => (current?.sequence === sequence ? null : current))
            }
            requestedPin={requestedPin}
            onRequestedPinHandled={sequence =>
              setRequestedPin(current => (current?.sequence === sequence ? null : current))
            }
            onTaskOpen={openTask}
            onCodeReferenceOpen={openCodeReference}
            onAttentionOpen={openAttention}
            onPinOpen={openPin}
          />
        </div>
      ))
    : [];
  const paneVisible = !compact && (surfaceOpen || retainedList.length > 0);
  const activeDef = state.active ? resolveSidePaneTab(sessionId, state.active) : undefined;
  const activeBrowser = state.active ? (state.instances[state.active]?.destination ?? state.browser) : state.browser;

  return (
    <SidePaneContext.Provider value={host}>
      <InAppBrowserContext.Provider value={browserHost}>
        <div className="flex h-full min-h-0 min-w-0 w-full gap-2">
          <div className="min-h-0 min-w-0 flex-1">{children}</div>
          {paneVisible && (
            <SidePaneShell
              id={paneId}
              titleId={titleId}
              onClose={close}
              width={paneWidth}
              onWidthPreview={setPreviewWidth}
              onWidthCommit={commitPaneWidth}
              hidden={!surfaceOpen}
            >
              {state.active && (
                <SidePaneTabs
                  paneId={paneId}
                  presentation="pane"
                  tabs={openTabDefs}
                  all={allTabs}
                  current={state.active}
                  onSelect={id => activateSidePaneTab(sessionId, id)}
                  onAdd={open}
                  onRemove={id => removeSidePaneTab(sessionId, id)}
                  onNewInstance={openNewInstance}
                />
              )}
              {body}
              {retainedBodies}
            </SidePaneShell>
          )}
        </div>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {/* Instance tabs announce their short name (basename, page host);
              the browser announcement already appends the full URL. */}
          {state.active
            ? sidePaneAnnouncement(
                state.active,
                presentation,
                activeBrowser,
                activeDef?.instance?.label ?? activeDef?.label,
              )
            : ''}
        </div>
        {compact && sheetSurface && (
          <BottomSheet
            id={paneId}
            open={surfaceOpen}
            onClose={close}
            labelledBy={titleId}
            closeLabel={resolveSidePaneTab(sessionId, sheetSurface)?.closeLabel ?? 'Close'}
            panelClassName="h-full overflow-hidden bg-surface"
            maxHeight="calc(var(--app-h, 100dvh) - var(--gap-xs))"
            zIndexClass="z-[70]"
          >
            <SidePaneTabs
              paneId={paneId}
              presentation="sheet"
              tabs={openTabDefs}
              all={allTabs}
              current={sheetSurface}
              onSelect={id => activateSidePaneTab(sessionId, id)}
              onAdd={open}
              onRemove={id => removeSidePaneTab(sessionId, id)}
              onNewInstance={openNewInstance}
            />
            {body}
          </BottomSheet>
        )}
      </InAppBrowserContext.Provider>
    </SidePaneContext.Provider>
  );
}
