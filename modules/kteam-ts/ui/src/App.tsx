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

import { Suspense, lazy, useEffect, useState } from 'react';
import { useRoute } from './lib/router';
import { AppBar } from './components/AppBar';
import { AgentSidebar } from './components/AgentSidebar';
import { SessionsListPage } from './pages/SessionsListPage';
import { NewSessionPage } from './pages/NewSessionPage';
import { cn } from './lib/utils';
import { useAppViewport } from './hooks/useAppViewport';

// THE CHAT PAGE IS A LAZY CHUNK. It pulls in the whole reading stack — the
// transcript, markdown, syntax highlighting, tool previews, the terminal view —
// and a reader looking at the fleet dashboard has asked for none of it.
// Measured (perf report): dashboard entry 837.0 KB raw / 253.8 KB gzip →
// 298.2 KB / 88.7 KB. The chat route downloads the rest on the first navigation
// into a session and keeps it for the life of the tab, so the second session
// opens with no network at all.
const SessionChatPage = lazy(() =>
  import('./pages/SessionChatPage').then(module => ({ default: module.SessionChatPage })),
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

function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={active ? undefined : true}
      className={cn('absolute inset-0 flex min-h-0 flex-col px-3', active ? 'z-10' : 'pointer-events-none invisible')}
    >
      {children}
    </div>
  );
}

export function App() {
  const [route] = useRoute();

  // Sizes the shell from the VISUAL viewport (--app-h / --app-top / --kb-h).
  // First thing in the component: every height below is measured against it.
  useAppViewport();

  // Mobile drawer visibility. It lives here rather than in the sidebar because
  // the AppBar's trigger and the drawer's own close button must drive ONE piece
  // of state, and because navigating to a session from the drawer has to shut
  // it — on a phone the drawer covers the page you just asked for.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false);
  }, [route.path]);

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
      <AppBar crumbs={crumbs} onOpenSidebar={() => setDrawerOpen(true)} />
      {/* THE SIDEBAR IS A SHELL SIBLING, not a page child: it is mounted once,
          for the app's life, so navigation never remounts it and its scroll
          position and filter state simply persist. It is also a sibling of the
          main pane's scroller rather than a parent of it, which is what keeps
          the one-scroll-region rule intact — two scrollers side by side, never
          one nested inside the other. */}
      <div className="flex min-h-0 w-full flex-1">
        <AgentSidebar activeId={route.sessionId} drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} />
        <main className="relative min-h-0 min-w-0 flex-1">
          <Pane active={!route.sessionId && !route.isNew}>
            <SessionsListPage />
          </Pane>
          {/* One Suspense boundary PER PANE, not one wrapping the list: a shared
              boundary would replace a retained, fully loaded chat with a
              fallback the moment another pane suspended. Only the first
              navigation suspends at all — the chunk is cached afterwards — and
              the LRU, drafts, scroll and client-side navigation are untouched. */}
          {mounted.map(id => (
            <Pane key={id} active={route.sessionId === id}>
              <Suspense fallback={<ChatChunkFallback />}>
                <SessionChatPage sessionId={id} />
              </Suspense>
            </Pane>
          ))}
          {route.isNew && (
            <Pane active>
              <NewSessionPage />
            </Pane>
          )}
        </main>
      </div>
    </div>
  );
}
