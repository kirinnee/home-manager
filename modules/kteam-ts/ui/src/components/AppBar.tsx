// Top bar — breadcrumb, quiet connection state, theme toggle, "read-only"
// banner when the daemon didn't substitute a token (i.e. we're on a non-loopback
// origin).

import { RefreshCw, Search } from 'lucide-react';
import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';
import { useFleet } from '../lib/store';
import { SidebarDrawerTrigger } from './AgentSidebar';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './CommandPalette';
import type { UpdateReason } from '../hooks/useServiceWorkerUpdate';

export function AppBar({
  crumbs,
  onOpenSidebar,
  onOpenPalette,
  updateReady,
  onApplyUpdate,
}: {
  crumbs: Array<{ href?: string; label: string }>;
  /** Opens the fleet sidebar's mobile drawer. The trigger renders itself only
   *  at drawer widths — the rail and the expanded column carry their own. */
  onOpenSidebar: () => void;
  /** Opens the Cmd/Ctrl+K palette. */
  onOpenPalette: () => void;
  /** Non-null when a newer release is installed and waiting, or when this tab
   *  has already failed to lazy-load a chunk. Null hides the chip entirely. */
  updateReady?: UpdateReason | null;
  onApplyUpdate?: () => void;
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
        {/* UPDATE / RECOVERY CHIP — an offer, never an interruption.
            A reload throws away unsent composer text and the transcript scroll
            position, so nothing here reloads on its own: the new worker sits
            waiting until this is clicked. Two wordings because they are two
            different facts — "Update ready" is news, "Reload to recover" means
            this tab has ALREADY failed to load part of itself and is stuck.
            `aria-live=polite` announces the chip's arrival without stealing
            focus mid-typing; `data-tone=warn` for recovery so it does not read
            as routine. */}
        {updateReady && (
          <button
            type="button"
            onClick={onApplyUpdate}
            aria-live="polite"
            title={
              updateReady === 'recovery'
                ? 'This tab could not load part of the app because a newer version was deployed. Reload to recover.'
                : 'A newer version of Kteam is installed and ready. Reload to use it.'
            }
            className="kt-badge shrink-0 items-center gap-xs hover:text-fg"
            data-tone={updateReady === 'recovery' ? 'warn' : 'accent'}
          >
            <RefreshCw size={11} aria-hidden="true" />
            {updateReady === 'recovery' ? 'Reload to recover' : 'Update ready — reload'}
          </button>
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
