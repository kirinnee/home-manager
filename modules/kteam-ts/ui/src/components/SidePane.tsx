// THE UNIFIED SESSION SIDE PANE — one host for every session-scoped companion
// surface: browser, files, tasks, pins, terminals, skills, lineage and
// analytics.
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
  ChartNoAxesCombined,
  FolderGit2,
  GitFork,
  Globe2,
  ListTodo,
  Pin,
  Sparkles,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
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
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';
import { InAppBrowserContext, type BrowserDestination, type InAppBrowserHost } from './InAppBrowser';
import { FilesTab } from './FilesTab';
import { PinSurface } from './PinSheet';
import { SessionTasksSurface } from './SessionTasks';
import { AnalyticsSurface } from './AnalyticsSurface';
import { LineageSurface } from './LineageSurface';
import { SkillsSurface } from './SkillsSurface';
import { SidePaneResizeHandle } from './SidePaneResizeHandle';
import { SidePaneTabs, sidePanePanelId, sidePaneTabId, type SidePaneTabSpec } from './SidePaneTabs';
import { UnifiedBrowserSurface } from './UnifiedBrowserSurface';
import { WebTerminals } from './WebTerminals';

export type SidePaneSurface = 'browser' | 'files' | 'tasks' | 'pins' | 'terminals' | 'skills' | 'lineage' | 'analytics';
export type SidePanePresentation = 'pane' | 'sheet';

export interface SidePaneSurfaceMeta {
  label: string;
  /** Compact visible name; the full label remains the tab's accessible name. */
  tabLabel: string;
  closeLabel: string;
  icon: LucideIcon;
}

/** What the reader is told opened, and how the sheet dismiss is labelled. */
export const SIDE_PANE_SURFACES: Record<SidePaneSurface, SidePaneSurfaceMeta> = {
  browser: { label: 'Browser', tabLabel: 'Web', closeLabel: 'Close browser', icon: Globe2 },
  files: { label: 'Files', tabLabel: 'Files', closeLabel: 'Close files', icon: FolderGit2 },
  tasks: { label: 'Tasks', tabLabel: 'Tasks', closeLabel: 'Close tasks', icon: ListTodo },
  pins: { label: 'Pins', tabLabel: 'Pins', closeLabel: 'Close pins', icon: Pin },
  terminals: { label: 'Terminals', tabLabel: 'Term', closeLabel: 'Close terminals', icon: SquareTerminal },
  skills: { label: 'Skills', tabLabel: 'Skill', closeLabel: 'Close skills', icon: Sparkles },
  lineage: { label: 'Lineage', tabLabel: 'Tree', closeLabel: 'Close lineage', icon: GitFork },
  analytics: {
    label: 'Analytics',
    tabLabel: 'Cost',
    closeLabel: 'Close analytics',
    icon: ChartNoAxesCombined,
  },
};

/** Surfaces that, once opened, stay MOUNTED (hidden) on desktop when the
 *  reader switches surface or closes the pane — for surfaces whose unmount
 *  tears down something expensive or stateful. Members: `terminals` (each open
 *  terminal holds a live WebSocket and an xterm scrollback buffer; unmounting
 *  per open would drop scrollback and churn reconnects) and `browser` (a live
 *  Chrome/profile the human may be logged into).
 *  Everything else stays mount-per-open on purpose — that is what resets
 *  transient state (pins relies on it). Skills likewise remounts so its dynamic
 *  account catalog refreshes. Retention is desktop-only — the mobile sheet is
 *  a focus-trapped dialog and must fully unmount on close. */
export const RETAINED_SURFACES: ReadonlySet<SidePaneSurface> = new Set<SidePaneSurface>(['browser', 'terminals']);

/** The spoken confirmation for a surface opening. Desktop names WHERE it
 *  opened, because the reader's context did not change — the conversation is
 *  still in front of them. The browser adds the one fact that distinguishes
 *  this open from the last: the URL. */
export function sidePaneAnnouncement(
  surface: SidePaneSurface,
  presentation: SidePanePresentation,
  browser: BrowserDestination | null,
): string {
  const label = SIDE_PANE_SURFACES[surface].label;
  const base = presentation === 'pane' ? `Opened ${label} beside the conversation` : `Opened ${label}`;
  return surface === 'browser' && browser ? `${base}: ${browser.href}` : base;
}

// ---- per-session memory ------------------------------------------------------
//
// Module state, NOT React state: the workspace component is created and
// destroyed with its retained session pane (bounded LRU in App.tsx), and an
// evicted-then-revisited session should come back to the surface it had open.
// Keyed strictly on session id — this is what makes the pane session-scoped
// rather than app-scoped.

export interface SidePaneSnapshot {
  surface: SidePaneSurface | null;
  browser: BrowserDestination | null;
}

const CLOSED: SidePaneSnapshot = { surface: null, browser: null };
const sessionPanes = new Map<string, SidePaneSnapshot>();

export function readSidePaneState(sessionId: string): SidePaneSnapshot {
  return sessionPanes.get(sessionId) ?? CLOSED;
}

/** Test seam + the workspace's own write path. */
export function writeSidePaneState(sessionId: string, next: SidePaneSnapshot): void {
  sessionPanes.set(sessionId, next);
}

/** Test seam — the memory is module state, so tests must be able to start
 *  from nothing. */
export function resetSidePaneStates(): void {
  sessionPanes.clear();
}

// ---- the host contract ---------------------------------------------------------

export interface SidePaneHost {
  /** The pane element's id, for `aria-controls` on triggers. */
  paneId: string;
  presentation: SidePanePresentation;
  /** Which surface is open right now (null when closed). */
  surface: SidePaneSurface | null;
  /** Open a surface. The opener element, when given, receives focus back on
   *  close — focus is NEVER moved on open. */
  open: (surface: SidePaneSurface, opener?: HTMLElement | null) => void;
  close: () => void;
  /** The trigger gesture: open when closed or on another surface, close when
   *  this surface is already the open one. */
  toggle: (surface: SidePaneSurface, opener?: HTMLElement | null) => void;
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

function FilesSurface({ sessionId, cwd, presentation, titleId, onClose }: SurfaceProps & { cwd?: string }) {
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
          stack, probe and error copy exactly as it did as a page tab. */}
      <div className="flex min-h-0 flex-1 flex-col px-panel pb-2 pt-2">
        <FilesTab sessionId={sessionId} cwd={cwd} />
      </div>
    </>
  );
}

function TasksSurface({ sessionId, presentation, titleId, onClose }: SurfaceProps) {
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
      <SessionTasksSurface sessionId={sessionId} />
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
  sessionId,
  cwd,
  browser,
  presentation,
  titleId,
  onClose,
  onInsertSkill,
  isActive,
}: {
  surface: SidePaneSurface;
  sessionId: string;
  cwd?: string;
  browser: BrowserDestination | null;
  presentation: SidePanePresentation;
  titleId: string;
  onClose: () => void;
  onInsertSkill: (invocation: string) => void;
  isActive: boolean;
}) {
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
        <FilesSurface sessionId={sessionId} cwd={cwd} presentation={presentation} titleId={titleId} onClose={onClose} />
      );
    case 'tasks':
      return <TasksSurface sessionId={sessionId} presentation={presentation} titleId={titleId} onClose={onClose} />;
    case 'pins':
      return (
        <PinSurface sessionId={sessionId} presentation={presentation} titleId={titleId} onRequestClose={onClose} />
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

// ---- triggers -------------------------------------------------------------------

/** A 44px header trigger for one surface, styled to sit beside PinsTrigger.
 *  Renders nothing outside a workspace so callers never need to guard. */
export function SidePaneTrigger({
  surface,
  label,
  icon,
}: {
  surface: SidePaneSurface;
  label: string;
  icon: ReactNode;
}) {
  const host = useSidePane();
  if (!host) return null;
  const expanded = host.surface === surface;
  return (
    <button
      type="button"
      onClick={event => host.toggle(surface, event.currentTarget)}
      aria-expanded={expanded}
      aria-controls={expanded ? host.paneId : undefined}
      aria-label={label}
      title={label}
      className="relative inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control border border-border p-0 text-muted hover:border-accent-border hover:text-fg"
    >
      {icon}
    </button>
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
  const [state, setState] = useState<SidePaneSnapshot>(() => readSidePaneState(sessionId));
  const storedPreferences = useSyncExternalStore(
    subscribeSidePanePreferences,
    getSidePanePreferences,
    getSidePanePreferences,
  );
  // Preview is local to this workspace: retained sessions do not re-render on
  // every drag tick. The global preference publishes only at drag end.
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const paneWidth = previewWidth ?? storedPreferences.width;
  const commitPaneWidth = useCallback((width: number) => {
    setSidePaneWidth(width);
    setPreviewWidth(null);
  }, []);
  // RETAINED_SURFACES members that have been opened in this workspace's life.
  // They stay mounted (hidden) on desktop after the reader moves away, so
  // switching surface never tears down a live remote session. Bounded by the
  // retained set's size and reset with the workspace (session pane eviction).
  const [everRetained, setEverRetained] = useState<ReadonlySet<SidePaneSurface>>(() => new Set());
  const presentation: SidePanePresentation = compact ? 'sheet' : 'pane';
  const tabSpecs = useMemo<readonly SidePaneTabSpec<SidePaneSurface>[]>(
    () =>
      (Object.entries(SIDE_PANE_SURFACES) as Array<[SidePaneSurface, SidePaneSurfaceMeta]>).map(([key, meta]) => {
        const Icon = meta.icon;
        return {
          key,
          label: meta.label,
          shortLabel: meta.tabLabel,
          icon: <Icon size={15} aria-hidden="true" />,
        };
      }),
    [],
  );
  useEffect(() => {
    const surface = state.surface;
    if (!surface || compact || !RETAINED_SURFACES.has(surface)) return;
    setEverRetained(current => (current.has(surface) ? current : new Set(current).add(surface)));
  }, [compact, state.surface]);

  const commit = useCallback(
    (next: SidePaneSnapshot) => {
      writeSidePaneState(sessionId, next);
      setState(next);
    },
    [sessionId],
  );

  const open = useCallback(
    (surface: SidePaneSurface, opener?: HTMLElement | null) => {
      if (opener) openerRef.current = opener;
      commit({ ...readSidePaneState(sessionId), surface });
    },
    [commit, sessionId],
  );

  // Close NEVER touches focus unless the opener is still in the document —
  // the same restraint InAppBrowser shipped with. Restoring focus on close is
  // the counterpart of never stealing it on open.
  const close = useCallback(() => {
    commit({ ...readSidePaneState(sessionId), surface: null });
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && typeof window !== 'undefined' && document.contains(opener)) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }, [commit, sessionId]);

  const toggle = useCallback(
    (surface: SidePaneSurface, opener?: HTMLElement | null) => {
      if (readSidePaneState(sessionId).surface === surface) close();
      else open(surface, opener);
    },
    [close, open, sessionId],
  );

  // The browser surface's payload rides in the same per-session snapshot, so a
  // revisited session restores the page it was reading.
  const openDestination = useCallback(
    (destination: BrowserDestination, opener: HTMLElement) => {
      openerRef.current = opener;
      commit({ surface: 'browser', browser: destination });
    },
    [commit],
  );

  // A hidden retained pane keeping an OPEN focus-trapped sheet alive would own
  // the Escape stack from behind visibility:hidden. Close the sheet when this
  // pane stops being the one on screen; the non-modal desktop pane is safe to
  // retain (it traps nothing) and is exactly what "remember per session" is
  // for. Deliberately not reopened on return — an unprompted modal is worse
  // than a lost sheet.
  useEffect(() => {
    if (compact && !active && readSidePaneState(sessionId).surface)
      commit({ ...readSidePaneState(sessionId), surface: null });
  }, [active, commit, compact, sessionId]);

  // Stable while the pane opens/closes, so hundreds of transcript links do not
  // re-render because a sibling surface changed.
  const browserHost = useMemo<InAppBrowserHost>(
    () => ({ paneId, presentation, openDestination }),
    [paneId, presentation, openDestination],
  );
  const host = useMemo<SidePaneHost>(
    () => ({ paneId, presentation, surface: state.surface, open, close, toggle }),
    [paneId, presentation, state.surface, open, close, toggle],
  );

  const surfaceOpen = state.surface !== null;
  // The sheet's slide-out needs its content for one more transition frame
  // after close, so the LAST surface lingers for the sheet path only (the same
  // reason InAppBrowser never cleared its destination on close). The desktop
  // pane unmounts immediately — it has no exit animation.
  const lastSurfaceRef = useRef<SidePaneSurface | null>(null);
  if (state.surface) lastSurfaceRef.current = state.surface;
  const sheetSurface = state.surface ?? lastSurfaceRef.current;
  const displaySurface = compact ? sheetSurface : state.surface;
  const body = displaySurface && !(RETAINED_SURFACES.has(displaySurface) && !compact) && (
    <div
      id={sidePanePanelId(paneId, displaySurface)}
      role="tabpanel"
      aria-labelledby={sidePaneTabId(paneId, displaySurface)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SurfaceBody
        surface={displaySurface}
        sessionId={sessionId}
        cwd={cwd}
        browser={state.browser}
        presentation={presentation}
        titleId={titleId}
        onClose={close}
        onInsertSkill={onInsertSkill}
        isActive={active && state.surface === displaySurface}
      />
    </div>
  );
  // Retained surfaces render OUTSIDE the mount-per-open body: each one stays
  // in the DOM once opened (visibility:hidden while not the open surface, the
  // same technique App.tsx uses for retained session panes) so switching away
  // never tears it down. Desktop only; the sheet path never retains. The OPEN
  // surface joins the list synchronously — the everRetained effect lands a
  // render later, and a first open must not paint blank for that frame.
  const retainedList =
    !compact && state.surface && RETAINED_SURFACES.has(state.surface) && !everRetained.has(state.surface)
      ? [...everRetained, state.surface]
      : [...everRetained];
  const retainedBodies = !compact
    ? retainedList.map(surface => (
        <div
          key={surface}
          id={sidePanePanelId(paneId, surface)}
          role="tabpanel"
          aria-labelledby={sidePaneTabId(paneId, surface)}
          aria-hidden={state.surface === surface ? undefined : true}
          className={
            state.surface === surface
              ? 'flex min-h-0 flex-1 flex-col'
              : 'pointer-events-none invisible absolute h-0 overflow-hidden'
          }
        >
          <SurfaceBody
            surface={surface}
            sessionId={sessionId}
            cwd={cwd}
            browser={state.browser}
            presentation={presentation}
            titleId={state.surface === surface ? titleId : `${titleId}-retained-${surface}`}
            onClose={close}
            onInsertSkill={onInsertSkill}
            isActive={active && state.surface === surface}
          />
        </div>
      ))
    : [];
  const paneVisible = !compact && (surfaceOpen || everRetained.size > 0);

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
              {state.surface && (
                <SidePaneTabs paneId={paneId} tabs={tabSpecs} current={state.surface} onSelect={open} />
              )}
              {body}
              {retainedBodies}
            </SidePaneShell>
          )}
        </div>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.surface ? sidePaneAnnouncement(state.surface, presentation, state.browser) : ''}
        </div>
        {compact && sheetSurface && (
          <BottomSheet
            id={paneId}
            open={surfaceOpen}
            onClose={close}
            labelledBy={titleId}
            closeLabel={SIDE_PANE_SURFACES[sheetSurface].closeLabel}
            panelClassName="h-full overflow-hidden bg-surface"
            maxHeight="calc(var(--app-h, 100dvh) - var(--gap-xs))"
            zIndexClass="z-[70]"
          >
            <SidePaneTabs paneId={paneId} tabs={tabSpecs} current={sheetSurface} onSelect={open} />
            {body}
          </BottomSheet>
        )}
      </InAppBrowserContext.Provider>
    </SidePaneContext.Provider>
  );
}
