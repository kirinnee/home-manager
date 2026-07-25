// Top bar — breadcrumb, quiet connection state, theme toggle, "read-only"
// banner when the daemon didn't substitute a token (i.e. we're on a non-loopback
// origin).

import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';
import { useFleet } from '../lib/store';
import { SidebarDrawerTrigger } from './AgentSidebar';

export function AppBar({
  crumbs,
  onOpenSidebar,
}: {
  crumbs: Array<{ href?: string; label: string }>;
  /** Opens the fleet sidebar's mobile drawer. The trigger renders itself only
   *  at drawer widths — the rail and the expanded column carry their own. */
  onOpenSidebar: () => void;
}) {
  const { status } = useFleet();
  return (
    // Not sticky any more: the shell no longer scrolls, so the bar is simply the
    // first row of a flex column that fills the viewport. Full bleed — the
    // 1180px centering that used to wrap this row is gone.
    <header data-density-region="app-bar" className="shrink-0 border-b border-border bg-[var(--bar-bg)]">
      <div className="flex min-h-control w-full items-center gap-sm px-panel font-ui text-ui">
        <SidebarDrawerTrigger onOpen={onOpenSidebar} />
        <nav className="flex min-w-0 flex-1 items-center gap-sm text-muted">
          {crumbs.map((c, i) => (
            <span key={`${i}-${c.label}`} className="flex items-center gap-sm">
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
        {/* QUIET connection state: nothing at all while the socket is open (the
            normal case), and a small dot — never a modal, never an instruction
            to refresh — while it is reconnecting. The store keeps working from
            cache and catches up on its own. */}
        {status !== 'open' && (
          <span
            className="inline-flex shrink-0 items-center gap-xs text-meta text-muted"
            title={status === 'connecting' ? 'connecting to the daemon…' : 'reconnecting to the daemon…'}
          >
            <span className={`kt-dot ${status === 'connecting' ? 'bg-warn' : 'bg-err'}`} />
            <span className="hidden sm:inline">{status === 'connecting' ? 'connecting' : 'reconnecting'}</span>
          </span>
        )}
        {!HAS_TOKEN && (
          <span className="kt-badge" data-tone="warn">
            read-only: no local token
          </span>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
