// Tiny pushState-based router. Static pages stay explicit; session leaves carry
// their id. Used in place of react-router to keep the dep tree tight.
// Used in place of react-router to keep the dep tree tight. Listens to
// popstate so back/forward buttons Just Work.

import { forwardRef, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export interface Route {
  path: string;
  // path === '/' | '/new' | '/settings' | '/warden' | '/tasks' | '/learning' | '/session/:id' | unknown → list
  sessionId?: string;
  isNew?: boolean;
  isSettings?: boolean;
  isWarden?: boolean;
  isTasks?: boolean;
  isLearning?: boolean;
}

export function parseRoute(pathname: string): Route {
  if (pathname === '/new') return { path: '/new', isNew: true };
  if (pathname === '/settings') return { path: '/settings', isSettings: true };
  if (pathname === '/warden') return { path: '/warden', isWarden: true };
  if (pathname === '/tasks') return { path: '/tasks', isTasks: true };
  if (pathname === '/learning') return { path: '/learning', isLearning: true };
  if (pathname.startsWith('/session/')) {
    const rest = pathname.slice('/session/'.length);
    if (rest) {
      const id = decodeURIComponent(rest.split('?')[0] ?? '');
      if (id) return { path: pathname, sessionId: id };
    }
  }
  return { path: '/' };
}

export function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const handler = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  const push = (to: string) => {
    history.pushState({}, '', to);
    setRoute(parseRoute(to));
  };
  return [route, push];
}

/** Programmatic navigation (same mechanism as <Link>). */
export function navigate(to: string): void {
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, onClick, ...rest }, ref) {
  return (
    <a
      ref={ref}
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        history.pushState({}, '', to);
        window.dispatchEvent(new PopStateEvent('popstate'));
        onClick?.(e);
      }}
      {...rest}
    />
  );
});
