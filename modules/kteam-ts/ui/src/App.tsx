// Top-level shell. Reads the route, renders the matching page, and renders
// the persistent AppBar with breadcrumbs.
//
// PAGES ARE KEPT MOUNTED (round 5). Navigating dashboard → session → back used
// to unmount and remount both pages: the dashboard lost its scroll position and
// filters, and the session lost its draft, its loaded transcript pages and its
// follow state — every "let me just check the fleet" cost a full reload of the
// conversation you were reading. The dashboard now stays mounted for the app's
// life, and the sessions you have visited stay mounted up to a HARD BOUND
// (MAX_MOUNTED_SESSIONS, least-recently-visited evicted) so the cache can never
// grow without limit on a long session-hopping run.
//
// Hidden panes use `invisible` (visibility: hidden), NOT `hidden`
// (display: none): a display:none element loses its layout box, and with it the
// scroll offsets of every scroller inside — which is exactly the state we are
// keeping the pane mounted to preserve. visibility:hidden keeps layout, paints
// nothing, and takes its subtree out of the tab order.

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { navigate, useRoute } from './lib/router';
import { AppBar } from './components/AppBar';
import { AgentSidebar } from './components/AgentSidebar';
import { CommandPalette } from './components/CommandPalette';
import { SessionsListPage } from './pages/SessionsListPage';
import { NewSessionPage } from './pages/NewSessionPage';
import { SettingsPage, SettingsSheet } from './pages/SettingsPage';
import { WardenPage } from './pages/WardenPage';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { cn } from './lib/utils';
import { useAppViewport } from './hooks/useAppViewport';
import { useLayoutMode } from './hooks/useLayoutMode';
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate';
import { useChrome, useStore } from './lib/store';
import { isSettingId, settingsHref, type SettingId } from './lib/settings';
import { api } from './lib/api';

// THE CHAT PAGE IS A LAZY CHUNK. It pulls in the whole reading stack — the
// transcript, markdown, syntax highlighting, tool previews, the terminal view —
// and a reader looking at the fleet dashboard has asked for none of it.
// Measured (perf report): dashboard entry 837.0 KB raw / 253.8 KB gzip →
// 298.2 KB / 88.7 KB. The chat route downloads the rest on the first navigation
// into a session and keeps it for the life of the tab, so the second session
// opens with no network at all.
const SessionChatPage = lazy(() =>
  import('./pages/SessionChatPage').then(module => {
    // THE IMPORT CAN RESOLVE WITH `undefined` INSTEAD OF REJECTING.
    // `startPreloadErrorWatch` calls `preventDefault()` on `vite:preloadError`
    // — correct, it is what stops the unhandled rejection — and Vite's preload
    // helper reads that as "handled" and resolves the import with `undefined`.
    // Reading `.SessionChatPage` off that throws a TypeError that names the
    // property rather than the failure ("Cannot read properties of undefined
    // (reading 'SessionChatPage')" is what Stage E actually recorded). The
    // boundary catches it either way; this only makes the console line true.
    if (!module) throw new Error('kteam: the chat chunk failed to load');
    return { default: module.SessionChatPage };
  }),
);

const TasksPage = lazy(() =>
  import('./pages/TasksPage').then(module => {
    if (!module) throw new Error('kteam: the tasks chunk failed to load');
    return { default: module.TasksPage };
  }),
);

/** How many session pages stay mounted at once (the current one plus the one
 *  you most recently came from — enough for back-and-forth, bounded). */
const MAX_MOUNTED_SESSIONS = 2;

/** Shown for the one navigation that actually waits on the chat chunk.
 *
 *  It fills the pane exactly like the page it stands in for, so the shell does
 *  not shift when the real thing arrives, and it announces itself: `role=status`
 *  with `aria-live=polite` tells a screen reader the app is fetching rather than
 *  leaving it on a silent empty region. */
function ChatChunkFallback() {
  return (
    <div role="status" aria-live="polite" className="flex h-full min-h-0 w-full items-center justify-center">
      <span className="inline-flex items-center gap-2 text-[13px] text-muted">
        <span
          className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
          aria-hidden="true"
        />
        Loading conversation…
      </span>
    </div>
  );
}

function TasksChunkFallback() {
  return (
    <div role="status" aria-live="polite" className="flex h-full min-h-0 w-full items-center justify-center">
      <span className="inline-flex items-center gap-2 text-[13px] text-muted">
        <span
          className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
          aria-hidden="true"
        />
        Loading tasks…
      </span>
    </div>
  );
}

// THE ROUTE GUTTER IS BREAKPOINT-SCOPED. A flat `px-3` charged 12px per edge at
// every width. On a phone that is the single largest remaining inset in front of
// transcript prose — measured as the top item in a 21px-per-edge stack, ahead of
// the scroller's own padding — and 24px of a 390px screen is real text. Desktop
// keeps the established 12px, where the width is not scarce and the gutter is
// what stops content colliding with the window edge.
function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={active ? undefined : true}
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col px-1 sm:px-3',
        active ? 'z-10' : 'pointer-events-none invisible',
      )}
    >
      {children}
    </div>
  );
}

/** A pane that cannot take the shell down with it.
 *
 *  ONE BOUNDARY PER PANE, INSIDE THE PANE AND OUTSIDE ITS SUSPENSE, for
 *  pane-local isolation — the same reason the Suspense boundaries are per-pane.
 *  A single shared boundary at the top of `<main>` would keep the root and the
 *  sidebar alive, but it would replace every retained pane with one failed
 *  pane's fallback; the mounted-pane cache exists precisely so a healthy
 *  conversation you navigated away from is still there when you come back.
 *  Outside the Suspense rather than inside it so the boundary owns the whole
 *  pane surface: the recovery message replaces the loading fallback instead of
 *  rendering underneath a spinner that will never resolve.
 *
 *  Every pane gets one, not just the panes that lazy-load today: the boundary is
 *  exactly transparent while its child is healthy, and the failure it prevents —
 *  React unmounting the whole root, measured as an empty `#root` and no chip in
 *  Stage E — is not worth re-earning the next time someone adds a lazy import to
 *  a page that does not have one now. */
export function SafePane({
  active,
  onChunkError,
  onReload,
  children,
}: {
  active: boolean;
  onChunkError: (error: unknown) => void;
  onReload: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pane active={active}>
      <ChunkErrorBoundary onChunkError={onChunkError} onReload={onReload}>
        {children}
      </ChunkErrorBoundary>
    </Pane>
  );
}

export function App() {
  const [route] = useRoute();

  // Sizes the shell from the VISUAL viewport (--app-h / --app-top / --kb-h).
  // First thing in the component: every height below is measured against it.
  useAppViewport();

  // THE SESSION ROUTE HAS NO APP BAR ON A PHONE (round 8).
  //
  // Measured at 390x844: the breadcrumb row (`804 / Sessions / <id>` + theme),
  // the identity row (back + status + teammate) and the tab/controls row were
  // three separate bands saying two things, 141px of a 844px screen before a
  // keyboard existed. Its navigation is re-homed into the session header's
  // single row — the fleet trigger moves there, theme lives in Settings, and
  // the breadcrumb is redundant with a back link whose label already says
  // "Back to all sessions". The dashboard and full-width destinations keep the
  // bar, and so does every viewport at or above DRAWER_MAX.
  const layout = useLayoutMode();
  const compactSession = Boolean(route.sessionId) && layout === 'drawer';
  const settingsAsSheet = Boolean(route.isSettings) && layout === 'drawer';
  const fullWidthDestination = Boolean(route.isSettings || route.isWarden || route.isTasks);
  const store = useStore();
  const chrome = useChrome();

  // A phone opens Settings without changing the underlying route. If that same
  // window grows into rail/desktop mode, preserve the reader's destination as
  // the real deep-linkable page rather than leaving an invisible mobile overlay
  // flag behind.
  useEffect(() => {
    if (layout === 'drawer' || !chrome.settingsOpen) return;
    const target = chrome.settingsTarget;
    store.closeSettings();
    navigate(settingsHref(target));
  }, [chrome.settingsOpen, chrome.settingsTarget, layout, store]);

  // Registers the app-shell worker and owns the whole update lifecycle
  // (src/hooks/useServiceWorkerUpdate.ts). Mounted here, once, for the app's
  // life: the chip has to be reachable from every route, and a per-page hook
  // would re-register on navigation.
  const { updateReady, applyUpdate, raiseRecovery } = useServiceWorkerUpdate();

  // Mobile drawer visibility. It lives here rather than in the sidebar because
  // the AppBar's trigger and the drawer's own close button must drive ONE piece
  // of state, and because navigating to a session from the drawer has to shut
  // it — on a phone the drawer covers the page you just asked for.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false);
  }, [route.path]);

  // THE COMMAND PALETTE IS A SHELL SIBLING, mounted exactly once.
  //
  // It has to answer from EVERY route — including from inside the composer, a
  // filter box or a retained-but-hidden pane — so the shortcut lives here rather
  // than in any page, and the dialog itself is a sibling of `<main>` rather than
  // a child of whichever page happens to be visible. `focusSignal` is what makes
  // a second ⌘K put the caret back in the query box instead of no-opping.
  const [palette, setPalette] = useState({ open: false, focusSignal: 0 });
  const closePalette = useCallback(() => setPalette(p => ({ ...p, open: false })), []);
  const openPalette = useCallback(() => setPalette(p => ({ open: true, focusSignal: p.focusSignal + 1 })), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An IME is mid-composition: the keystroke belongs to the candidate
      // window, not to us. `keyCode === 229` is the legacy spelling of the same
      // fact that some IMEs still send instead of `isComposing`.
      if (event.isComposing || event.keyCode === 229) return;
      // BOTH CASES, BECAUSE CAPS LOCK IS NOT A MODIFIER. With Caps Lock on and
      // no Shift held, `key` is `'K'` and `shiftKey` is false — that is still the
      // shortcut, and testing the letter's casing to detect Shift would break it.
      if (event.key !== 'k' && event.key !== 'K') return;
      // Meta on Apple, Control everywhere else — but both are accepted on both,
      // because a reader on a cross-platform keyboard should not have to care.
      //
      // SHIFT IS A DIFFERENT SHORTCUT, NOT A SLOPPIER SPELLING OF THIS ONE.
      // `Cmd/Ctrl+Shift+K` is Firefox's Web Console and Chrome's own binding; the
      // hint declares `Meta+K Control+K` and nothing else, so accepting Shift
      // would both swallow a browser feature and make the advertised shortcut a
      // lie. Alt is excluded for the same reason (`Ctrl+Alt+K` is a compose
      // sequence on several layouts).
      if (event.shiftKey || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      // preventDefault ONLY once every guard has passed: this key is the browser's
      // address-bar/search shortcut, and swallowing it on a keystroke we are not
      // handling would be taking something and giving nothing back.
      event.preventDefault();
      openPalette();
    };
    // Capture, so a page-level or input-level handler cannot eat it first.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openPalette]);

  // Most-recently-visited first; the array IS the LRU. Adjusted DURING render
  // (the supported "derive state from props" pattern) rather than in an effect:
  // an effect would commit one frame in which the route names a session that has
  // no pane yet, which is a visible blank flash on every first navigation.
  const [mounted, setMounted] = useState<string[]>(() => (route.sessionId ? [route.sessionId] : []));
  if (route.sessionId && mounted[0] !== route.sessionId) {
    setMounted([route.sessionId, ...mounted.filter(other => other !== route.sessionId)].slice(0, MAX_MOUNTED_SESSIONS));
  }

  const crumbs = route.isNew
    ? [{ href: '/', label: 'Sessions' }, { label: 'New' }]
    : route.isSettings
      ? [{ href: '/', label: 'Sessions' }, { label: 'Settings' }]
      : route.isWarden
        ? [{ href: '/', label: 'Sessions' }, { label: 'Warden' }]
        : route.isTasks
          ? [{ href: '/', label: 'Sessions' }, { label: 'Tasks' }]
          : route.sessionId
            ? [{ href: '/', label: 'Sessions' }, { label: route.sessionId }]
            : [{ label: 'Sessions' }];

  // ONE SCROLL REGION (round 4). The shell is exactly the viewport — `100dvh`,
  // so it tracks mobile browser chrome collapsing instead of overflowing behind
  // it — and it never scrolls. Every page below owns exactly one scroller of its
  // own, which for the chat page is the transcript. Previously this was
  // `min-h-screen` + a `pb-8` main + a chat page sized `calc(100vh-44px)`: the
  // three added up to 100vh + 31px, so the PAGE scrolled 31px as well as the
  // transcript, and pushing the composer off-screen took one flick.
  //
  // FULL BLEED (round 5): the `max-w-[1180px]` centering is gone. On a wide
  // screen the fleet table was squeezed into the middle third with the rest of
  // the display empty, and the sidebar slice needs the whole width.
  //
  // ROUND 6 — THE VIEWPORT IS THE *VISUAL* VIEWPORT. `100dvh` is not the visible
  // area on a phone with the keyboard up: iOS keeps the layout viewport at full
  // height and pans over it, so the bottom of a 100dvh shell (the composer, the
  // send button) sits behind the keyboard with nothing to scroll — the shell is
  // deliberately `overflow:hidden`. `.kt-shell` is sized from
  // `window.visualViewport` via `--app-h`/`--app-top` (useAppViewport), falling
  // back to dvh and then vh, and is `position: fixed` at the pan offset so it
  // always covers exactly what the reader can see.
  return (
    <div className="kt-shell flex flex-col overflow-hidden">
      {!compactSession && (
        <AppBar
          crumbs={crumbs}
          onOpenSidebar={fullWidthDestination ? undefined : () => setDrawerOpen(true)}
          onOpenPalette={openPalette}
          updateReady={updateReady}
          onApplyUpdate={applyUpdate}
          settingsActive={route.isSettings}
          wardenActive={route.isWarden}
          tasksActive={route.isTasks}
          showTheme={!route.isSettings}
        />
      )}
      {/* THE RECOVERY AFFORDANCE MUST SURVIVE THE BAR BEING GONE.
          On a phone the session route suppresses the AppBar entirely (see the
          note above), and that is the single most likely place to hit a pruned
          lazy chunk — the chat page IS the lazy chunk. Without this the reader
          would be left on a permanent "Loading conversation…" with no way out.
          So when the bar is hidden AND something is actually wrong, the chip
          renders as its own one-row band instead. Only for 'recovery': a routine
          update offer is not worth spending a phone's vertical space on, and it
          will be there the next time the bar is. */}
      {compactSession && updateReady === 'recovery' && (
        <div className="shrink-0 border-b border-border bg-[var(--bar-bg)] px-panel py-1">
          <button
            type="button"
            onClick={applyUpdate}
            aria-live="polite"
            className="kt-badge w-full justify-center"
            data-tone="warn"
          >
            Reload to recover
          </button>
        </div>
      )}
      {/* THE SIDEBAR IS A SESSIONS-SURFACE SIBLING, not a page child. It stays
          mounted across dashboard/new/session navigation so its scroll and
          filters persist, but Settings is deliberately a full-width,
          non-session destination: no fleet rail, drawer, or bento there. */}
      <div className="flex min-h-0 w-full flex-1">
        {!fullWidthDestination && (
          <AgentSidebar activeId={route.sessionId} drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} />
        )}
        <main className="relative min-h-0 min-w-0 flex-1">
          {/* Keep the dashboard behind the same recovery boundary as every
              other pane. Warden owns its own route now, so no Warden polling or
              markdown work remains mounted here. */}
          <SafePane
            active={
              !route.sessionId &&
              !route.isNew &&
              !route.isWarden &&
              !route.isTasks &&
              (!route.isSettings || settingsAsSheet)
            }
            onChunkError={raiseRecovery}
            onReload={applyUpdate}
          >
            <SessionsListPage />
          </SafePane>
          {/* One Suspense boundary PER PANE, not one wrapping the list: a shared
              boundary would replace a retained, fully loaded chat with a
              fallback the moment another pane suspended. Only the first
              navigation suspends at all — the chunk is cached afterwards — and
              the LRU, drafts, scroll and client-side navigation are untouched. */}
          {mounted.map(id => (
            <SafePane key={id} active={route.sessionId === id} onChunkError={raiseRecovery} onReload={applyUpdate}>
              <Suspense fallback={<ChatChunkFallback />}>
                {/* The drawer trigger rides in the session header when the app
                    bar is suppressed, so the opener has to reach down here. */}
                <SessionChatPage
                  sessionId={id}
                  active={route.sessionId === id}
                  onOpenSidebar={() => setDrawerOpen(true)}
                />
              </Suspense>
            </SafePane>
          ))}
          {route.isNew && (
            <SafePane active onChunkError={raiseRecovery} onReload={applyUpdate}>
              <NewSessionPage />
            </SafePane>
          )}
          {route.isSettings && !settingsAsSheet && (
            <SafePane active onChunkError={raiseRecovery} onReload={applyUpdate}>
              <SettingsPage />
            </SafePane>
          )}
          {route.isWarden && (
            <SafePane active onChunkError={raiseRecovery} onReload={applyUpdate}>
              <WardenPage />
            </SafePane>
          )}
          {route.isTasks && (
            <SafePane active onChunkError={raiseRecovery} onReload={applyUpdate}>
              <Suspense fallback={<TasksChunkFallback />}>
                <TasksPage fetchTasks={api.listTasks} fetchTask={api.getTask} />
              </Suspense>
            </SafePane>
          )}
        </main>
      </div>
      <SettingsSheet
        open={layout === 'drawer' && (chrome.settingsOpen || Boolean(route.isSettings))}
        target={
          chrome.settingsOpen
            ? chrome.settingsTarget
            : typeof window !== 'undefined' && isSettingId(window.location.hash.replace(/^#/, ''))
              ? (window.location.hash.replace(/^#/, '') as SettingId)
              : null
        }
        onClose={() => {
          store.closeSettings();
          if (route.isSettings) navigate('/');
        }}
      />
      {/* Last child, above everything: it is `position: fixed` so tree order does
          not decide where it paints, but it does decide who wins a z-index tie
          with the details sheet and the mobile drawer. */}
      <CommandPalette open={palette.open} focusSignal={palette.focusSignal} onClose={closePalette} />
    </div>
  );
}
