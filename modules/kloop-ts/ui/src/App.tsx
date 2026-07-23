import { useEffect } from 'react';
import { AppBar, type Crumb } from './components/AppBar';
import { useRoute } from './lib/router';
import { useTheme } from './hooks/useTheme';
import { RunsListPage } from './pages/RunsListPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ConfigPage } from './pages/ConfigPage';

export function App() {
  useTheme(); // applies data-theme on <html>
  const [route] = useRoute();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.path]);

  let crumbs: Crumb[] = [];
  let page = <RunsListPage />;
  if (route.isConfig) {
    crumbs = [{ label: 'config' }];
    page = <ConfigPage />;
  } else if (route.runId) {
    crumbs = [{ label: route.runId }];
    page = <RunDetailPage runId={route.runId} />;
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <AppBar crumbs={crumbs} />
      <main className="mx-auto max-w-[1180px] px-4 py-5">{page}</main>
    </div>
  );
}
