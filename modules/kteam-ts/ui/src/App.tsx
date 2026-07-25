// Top-level shell. Reads the route, renders the matching page, and renders
// the persistent AppBar with breadcrumbs.

import { useRoute } from './lib/router';
import { AppBar } from './components/AppBar';
import { SessionsListPage } from './pages/SessionsListPage';
import { SessionChatPage } from './pages/SessionChatPage';
import { NewSessionPage } from './pages/NewSessionPage';

export function App() {
  const [route] = useRoute();

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
  return (
    <div className="flex h-screen h-[100dvh] flex-col overflow-hidden">
      <AppBar crumbs={crumbs} />
      <main className="mx-auto flex w-full min-h-0 max-w-[1180px] flex-1 flex-col px-3">
        {route.isNew ? (
          <NewSessionPage />
        ) : route.sessionId ? (
          <SessionChatPage sessionId={route.sessionId} />
        ) : (
          <SessionsListPage />
        )}
      </main>
    </div>
  );
}
