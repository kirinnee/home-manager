// Top sticky bar — breadcrumb, theme toggle, "read-only" banner when the
// daemon didn't substitute a token (i.e. we're on a non-loopback origin).

import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';

export function AppBar({ crumbs }: { crumbs: Array<{ href?: string; label: string }> }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-[var(--bar-bg)] backdrop-blur-md">
      <div className="mx-auto flex max-w-[1180px] min-h-[42px] items-center gap-2 px-3">
        <nav className="flex-1 min-w-0 flex items-center gap-1.5 text-sm text-muted">
          {crumbs.map((c, i) => (
            <span key={`${i}-${c.label}`} className="flex items-center gap-1.5">
              {c.href ? (
                <Link to={c.href} className="hover:text-fg">
                  {c.label}
                </Link>
              ) : (
                <span className="text-fg font-semibold">{c.label}</span>
              )}
              {i < crumbs.length - 1 && <span className="text-muted">/</span>}
            </span>
          ))}
        </nav>
        {!HAS_TOKEN && (
          <span className="rounded border border-warn-border bg-warn-bg px-2 py-0.5 text-[11px] text-warn">
            read-only: no local token
          </span>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
