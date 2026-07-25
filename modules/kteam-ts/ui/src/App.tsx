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

import { useState } from 'react';
import { useRoute } from './lib/router';
import { AppBar } from './components/AppBar';
import { SessionsListPage } from './pages/SessionsListPage';
import { SessionChatPage } from './pages/SessionChatPage';
import { NewSessionPage } from './pages/NewSessionPage';
import { cn } from './lib/utils';

/** How many session pages stay mounted at once (the current one plus the one
 *  you most recently came from — enough for back-and-forth, bounded). */
const MAX_MOUNTED_SESSIONS = 2;

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
  return (
    <div className="flex h-screen h-[100dvh] flex-col overflow-hidden">
      <AppBar crumbs={crumbs} />
      <main className="relative w-full min-h-0 flex-1">
        <Pane active={!route.sessionId && !route.isNew}>
          <SessionsListPage />
        </Pane>
        {mounted.map(id => (
          <Pane key={id} active={route.sessionId === id}>
            <SessionChatPage sessionId={id} />
          </Pane>
        ))}
        {route.isNew && (
          <Pane active>
            <NewSessionPage />
          </Pane>
        )}
      </main>
    </div>
  );
}
