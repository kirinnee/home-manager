// Top bar — breadcrumb, quiet connection state, theme toggle, "read-only"
// banner when the daemon didn't substitute a token (i.e. we're on a non-loopback
// origin).

import { Search } from 'lucide-react';
import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';
import { useFleet } from '../lib/store';
import { SidebarDrawerTrigger } from './AgentSidebar';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './CommandPalette';

export function AppBar({
  crumbs,
  onOpenSidebar,
  onOpenPalette,
}: {
  crumbs: Array<{ href?: string; label: string }>;
  /** Opens the fleet sidebar's mobile drawer. The trigger renders itself only
   *  at drawer widths — the rail and the expanded column carry their own. */
  onOpenSidebar: () => void;
  /** Opens the Cmd/Ctrl+K palette. */
  onOpenPalette: () => void;
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
        {/* DISCOVERABILITY, NOT DECORATION. A keyboard-only feature that nothing
            on screen mentions is a feature only the person who built it has. This
            is a REAL button — clicking it opens the palette — so it is honest to
            a pointer user as well as legible to a keyboard one, and it declares
            the shortcut it stands for rather than drawing a picture of it.

            Hidden below `sm`: the palette is keyboard-summoned and there is no
            keyboard on a phone to summon it with, so a phone spends zero pixels
            on it (the chat route suppresses this whole bar there anyway). */}
        <button
          type="button"
          onClick={onOpenPalette}
          aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
          title="Jump to a session — the command palette"
          className="kt-chrome hidden shrink-0 items-center gap-xs rounded-control border border-border-soft px-badge-x py-0.5 text-meta text-muted hover:border-border hover:text-fg sm:inline-flex"
        >
          <Search size={11} aria-hidden="true" />
          <span className="mono">{paletteShortcutLabel()}</span>
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}
