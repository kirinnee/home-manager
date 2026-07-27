// Top bar — breadcrumb, quiet connection state, theme toggle, "read-only"
// banner when the daemon didn't substitute a token (i.e. we're on a non-loopback
// origin).

import { ListTodo, RefreshCw, Search, Settings, ShieldCheck } from 'lucide-react';
import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';
import { useFleet } from '../lib/store';
import { SidebarDrawerTrigger } from './AgentSidebar';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './CommandPalette';
import type { UpdateReason } from '../hooks/useServiceWorkerUpdate';
import { useLayoutMode } from '../hooks/useLayoutMode';

/** The chip's two wordings, as data so they can be asserted directly.
 *
 *  THE RECOVERY TITLE NAMES NO CAUSE, and that is a correction rather than a
 *  style preference. It used to read "…because a newer version was deployed",
 *  but recovery has several possible causes and the chip cannot tell them
 *  apart. `startPreloadErrorWatch` is unconditional, so a plain network blip on
 *  a preload raises it with no deploy involved at all; and `ChunkErrorBoundary`
 *  catches every render error — deliberately, because the error a pruned chunk
 *  actually produces is an ordinary-looking one that no message filter would
 *  recognise — so an everyday render bug raises it too. Blaming a deploy would
 *  be a confident lie in most of those cases, and it would send the reader
 *  looking for a release note that does not exist.
 *
 *  What is true of EVERY path that raises recovery: this tab has already failed
 *  to load part of itself, and a reload is the only thing the reader can do
 *  about it. That is exactly what the title says and no more. The update
 *  wording is untouched — it IS about a version, and it can say so. */
export const UPDATE_CHIP = {
  update: {
    label: 'Update ready — reload',
    title: 'A newer version of Kteam is installed and ready. Reload to use it.',
  },
  recovery: {
    label: 'Reload to recover',
    title: 'This tab could not load part of the app. Reload to recover.',
  },
} as const satisfies Record<UpdateReason, { label: string; title: string }>;

export const SETTINGS_ENTRY = {
  label: 'Settings',
  title: 'Open appearance and density settings',
} as const;

export const WARDEN_ENTRY = {
  label: 'Warden',
  title: 'Open fleet supervision and verdicts',
} as const;

export const TASKS_ENTRY = {
  label: 'Tasks',
  title: 'Open the task board',
} as const;

export function AppBar({
  crumbs,
  onOpenSidebar,
  onOpenPalette,
  updateReady,
  onApplyUpdate,
  settingsActive = false,
  wardenActive = false,
  tasksActive = false,
  showTheme = true,
}: {
  crumbs: Array<{ href?: string; label: string }>;
  /** Opens the fleet sidebar's mobile drawer. The trigger renders itself only
   *  at drawer widths — the rail and the expanded column carry their own. */
  /** Sessions-surface drawer opener. Absent on non-session destinations such
   *  as Settings, where the fleet sidebar and its bento do not exist. */
  onOpenSidebar?: () => void;
  /** Opens the Cmd/Ctrl+K palette. */
  onOpenPalette: () => void;
  /** Non-null when a newer release is installed and waiting, or when this tab
   *  has already failed to lazy-load a chunk. Null hides the chip entirely. */
  updateReady?: UpdateReason | null;
  onApplyUpdate?: () => void;
  settingsActive?: boolean;
  wardenActive?: boolean;
  tasksActive?: boolean;
  /** The flat Settings page owns theme controls while it is active. */
  showTheme?: boolean;
}) {
  const { status } = useFleet();
  const layout = useLayoutMode();
  return (
    // Not sticky any more: the shell no longer scrolls, so the bar is simply the
    // first row of a flex column that fills the viewport. Full bleed — the
    // 1180px centering that used to wrap this row is gone.
    <header data-density-region="app-bar" className="shrink-0 border-b border-border bg-[var(--bar-bg)]">
      <div className="flex min-h-control w-full items-center gap-sm px-panel font-ui text-ui">
        {onOpenSidebar && <SidebarDrawerTrigger onOpen={onOpenSidebar} />}
        <nav className="flex min-w-0 flex-1 items-center gap-sm text-muted">
          {crumbs.map((c, i) => (
            <span key={`${i}-${c.label}`} className="flex items-center gap-sm">
              {c.href ? (
                <Link to={c.href} className="inline-flex min-h-[44px] items-center hover:text-fg">
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
            Both live in UPDATE_CHIP above, where the recovery title's silence
            about the cause is explained and asserted.
            `aria-live=polite` announces the chip's arrival without stealing
            focus mid-typing; `data-tone=warn` for recovery so it does not read
            as routine. */}
        {updateReady && (
          <button
            type="button"
            onClick={onApplyUpdate}
            aria-live="polite"
            title={UPDATE_CHIP[updateReady].title}
            className="kt-badge shrink-0 items-center gap-xs hover:text-fg"
            data-tone={updateReady === 'recovery' ? 'warn' : 'accent'}
          >
            <RefreshCw size={11} aria-hidden="true" />
            {UPDATE_CHIP[updateReady].label}
          </button>
        )}
        {/* DISCOVERABILITY, NOT DECORATION. A keyboard-only feature that nothing
            on screen mentions is a feature only the person who built it has. This
            is a REAL button — clicking it opens the palette — so it is honest to
            a pointer user as well as legible to a keyboard one, and it declares
            the shortcut it stands for rather than drawing a picture of it.

            Hidden below `md`: the palette is keyboard-summoned and there is no
            keyboard on a phone to summon it with, so a phone spends zero pixels
            on it (the chat route suppresses this whole bar there anyway). */}
        <button
          type="button"
          onClick={onOpenPalette}
          aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
          title="Jump to a session — the command palette"
          className="kt-chrome hidden shrink-0 items-center gap-xs rounded-control border border-border-soft px-badge-x py-0.5 text-meta text-muted hover:border-border hover:text-fg md:inline-flex"
        >
          <Search size={11} aria-hidden="true" />
          <span className="mono">{paletteShortcutLabel()}</span>
        </button>
        {/* Small desktop destination tabs. Drawer/rail widths get the same two
            destinations inside the fleet sidebar, so the top bar does not turn
            into a second navigation row on a phone. The complete nav IA remains
            a later batch. */}
        {/* Visibility belongs to the PARENT. `.kt-btn` sets display later in
            the stylesheet than Tailwind's `.hidden`, so putting both classes
            on one anchor makes the button win and leak into 390px chrome. */}
        <nav aria-label="Destinations" className="hidden shrink-0 items-center gap-xs min-[1100px]:flex">
          <Link
            to="/tasks"
            aria-current={tasksActive ? 'page' : undefined}
            aria-label={TASKS_ENTRY.label}
            title={TASKS_ENTRY.title}
            className="kt-btn kt-btn--sm shrink-0 items-center gap-xs"
          >
            <ListTodo size={14} aria-hidden="true" />
            <span className="text-meta font-medium">Tasks</span>
          </Link>
          <Link
            to="/warden"
            aria-current={wardenActive ? 'page' : undefined}
            aria-label={WARDEN_ENTRY.label}
            title={WARDEN_ENTRY.title}
            className="kt-btn kt-btn--sm shrink-0 items-center gap-xs"
          >
            <ShieldCheck size={14} aria-hidden="true" />
            <span className="text-meta font-medium">Warden</span>
          </Link>
          <Link
            to="/settings"
            aria-current={settingsActive ? 'page' : undefined}
            aria-label={SETTINGS_ENTRY.label}
            title={SETTINGS_ENTRY.title}
            className="kt-btn kt-btn--sm shrink-0 items-center gap-xs"
          >
            <Settings size={14} aria-hidden="true" />
            <span className="text-meta font-medium">Settings</span>
          </Link>
        </nav>
        {/* Keep the established standalone picker for desktop. On a phone the
            only theme control is Settings, so hidden chrome does not mount a
            second useTheme instance behind the sheet. */}
        {showTheme && layout !== 'drawer' && <ThemeToggle />}
      </div>
    </header>
  );
}
