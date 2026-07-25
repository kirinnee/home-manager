// Top sticky bar — breadcrumb, theme toggle, "read-only" banner when the
// daemon didn't substitute a token (i.e. we're on a non-loopback origin).

import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';

export function AppBar({ crumbs }: { crumbs: Array<{ href?: string; label: string }> }) {
  return (
    // Not sticky any more: the shell no longer scrolls, so the bar is simply the
    // first row of a flex column that fills the viewport.
    <header className="shrink-0 border-b border-border bg-[var(--bar-bg)]">
      <div className="mx-auto flex max-w-[1180px] min-h-[32px] items-center gap-2 px-3">
        <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-muted">
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
