// Top-level shell. Reads the route, renders the matching page, and renders
// the persistent AppBar with breadcrumbs.

import { useRoute } from './lib/router';
import { AppBar } from './components/AppBar';
import { SessionsListPage } from './pages/SessionsListPage';
import { SessionChatPage } from './pages/SessionChatPage';

export function App() {
  const [route] = useRoute();

  const crumbs = route.sessionId
    ? [{ href: '/', label: 'Sessions' }, { label: route.sessionId }]
    : [{ label: 'Sessions' }];

  return (
    <div className="min-h-screen flex flex-col">
      <AppBar crumbs={crumbs} />
      <main className="mx-auto w-full max-w-[1180px] px-3 pb-8 flex-1 flex flex-col">
        {route.sessionId ? <SessionChatPage sessionId={route.sessionId} /> : <SessionsListPage />}
      </main>
    </div>
  );
}
