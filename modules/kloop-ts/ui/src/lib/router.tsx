// Tiny pushState router (no react-router dep, matching kteam-ts/ui's approach).
// Routes: '/' → runs list, '/run/:id' → run detail, '/config' → config pane.
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';

export interface Route {
  path: string;
  runId?: string;
  isConfig?: boolean;
}

function parseRoute(pathname: string): Route {
  if (pathname === '/config') return { path: pathname, isConfig: true };
  if (pathname.startsWith('/run/')) {
    const id = decodeURIComponent(pathname.slice('/run/'.length).split('?')[0] ?? '');
    if (id) return { path: pathname, runId: id };
  }
  return { path: '/' };
}

export function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const push = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);
  return [route, push];
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
