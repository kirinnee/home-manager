// Top bar — breadcrumb, quiet connection state, theme toggle, "read-only"
// banner when the daemon didn't substitute a token (i.e. we're on a non-loopback
// origin).

import { ChartNoAxesCombined, GraduationCap, LayoutGrid, RefreshCw, Search, Settings, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';
import { HAS_TOKEN } from '../lib/api';
import { useFleet } from '../lib/store';
import { SidebarDrawerTrigger } from './AgentSidebar';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './CommandPalette';
import type { UpdateReason } from '../hooks/useServiceWorkerUpdate';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { BottomSheet } from './SessionDetails';

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

export const LEARNING_ENTRY = {
  label: 'Learning',
  title: 'Open fleet learning proposals',
} as const;

export const ANALYTICS_ENTRY = {
  label: 'Analytics',
  title: 'Query all sessions and graph daily usage',
} as const;

/** The app-level destinations appear in both the wide tab group and the phone
 * selector. Keeping their route, label, and icon together stops the two
 * navigation affordances from quietly becoming different information
 * architectures. Theme is deliberately not here: it is a control, rather than
 * a destination, and remains with the other right-side controls. */
export const APP_BAR_DESTINATIONS = [
  { id: 'analytics', ...ANALYTICS_ENTRY, route: '/analytics', Icon: ChartNoAxesCombined },
  { id: 'warden', ...WARDEN_ENTRY, route: '/warden', Icon: ShieldCheck },
  { id: 'learning', ...LEARNING_ENTRY, route: '/learning', Icon: GraduationCap },
  { id: 'settings', ...SETTINGS_ENTRY, route: '/settings', Icon: Settings },
] as const;

type AppBarDestination = (typeof APP_BAR_DESTINATIONS)[number];
type AppBarDestinationId = AppBarDestination['id'];
type MobileDestinationMenuAction = 'open' | 'dismiss' | 'select';

/** Small, pure state transition so the modal's open/select/dismiss behaviour
 * can be asserted without a DOM test harness. */
export function mobileDestinationMenuOpen(_current: boolean, action: MobileDestinationMenuAction): boolean {
  if (action === 'open') return true;
  return false;
}

function DestinationLink({
  destination,
  active,
  onSelect,
}: {
  destination: AppBarDestination;
  active: boolean;
  onSelect?: () => void;
}) {
  const { Icon } = destination;
  return (
    <Link
      to={destination.route}
      aria-current={active ? 'page' : undefined}
      aria-label={destination.label}
      title={destination.title}
      onClick={onSelect}
      className="kt-btn kt-btn--sm shrink-0 items-center gap-xs"
    >
      <Icon size={14} aria-hidden="true" />
      <span className="text-meta font-medium">{destination.label}</span>
    </Link>
  );
}

export function AppBar({
  crumbs,
  onOpenSidebar,
  onOpenPalette,
  updateReady,
  onApplyUpdate,
  settingsActive = false,
  wardenActive = false,
  learningActive = false,
  analyticsActive = false,
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
  learningActive?: boolean;
  analyticsActive?: boolean;
  /** The flat Settings page owns theme controls while it is active. */
  showTheme?: boolean;
}) {
  const { status } = useFleet();
  const layout = useLayoutMode();
  const [mobileDestinationsOpen, setMobileDestinationsOpen] = useState(false);
  const destinationDialogId = useId();
  const activeDestination: AppBarDestinationId | null = analyticsActive
    ? 'analytics'
    : wardenActive
      ? 'warden'
      : learningActive
        ? 'learning'
        : settingsActive
          ? 'settings'
          : null;
  const dismissMobileDestinations = () =>
    setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'dismiss'));
  const selectMobileDestination = () =>
    setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'select'));

  return (
    // Not sticky any more: the shell no longer scrolls, so the bar is simply the
    // first row of a flex column that fills the viewport. Full bleed — the
    // 1180px centering that used to wrap this row is gone.
    <header data-density-region="app-bar" className="shrink-0 border-b border-border bg-[var(--bar-bg)]">
      <div className="grid min-h-control w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-sm px-panel font-ui text-ui">
        {/* The first column owns all desktop navigation. The equal flexible
            side columns make the palette genuinely centred without absolute
            positioning, even when status chips appear on the right. */}
        <div className="flex min-w-0 items-center gap-sm">
          {onOpenSidebar && <SidebarDrawerTrigger onOpen={onOpenSidebar} />}
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-sm text-muted min-[480px]:flex">
            {crumbs.map((c, i) => (
              <span key={`${i}-${c.label}`} className="flex min-w-0 items-center gap-sm">
                {c.href ? (
                  <Link to={c.href} className="truncate hover:text-fg">
                    {c.label}
                  </Link>
                ) : (
                  <span className="truncate text-fg font-semibold">{c.label}</span>
                )}
                {i < crumbs.length - 1 && <span className="text-muted">/</span>}
              </span>
            ))}
          </nav>
          <nav aria-label="Destinations" className="hidden min-w-0 items-center gap-xs md:flex">
            {APP_BAR_DESTINATIONS.map(destination => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                active={activeDestination === destination.id}
              />
            ))}
          </nav>
        </div>
        {/* Always reachable, including 390px: phones get an icon-only centre
            button while wider layouts show the familiar Cmd/Ctrl+K reminder. */}
        <button
          type="button"
          onClick={onOpenPalette}
          aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
          aria-label="Open command palette"
          title="Jump to a session — the command palette"
          className="kt-chrome inline-flex shrink-0 items-center gap-xs rounded-control border border-border-soft px-badge-x py-0.5 text-meta text-muted hover:border-border hover:text-fg"
          data-app-bar-search
        >
          <Search size={14} aria-hidden="true" />
          <span className="mono hidden sm:inline">{paletteShortcutLabel()}</span>
        </button>
        <div className="flex min-w-0 items-center justify-self-end gap-sm">
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
          {/* Keep the established standalone picker for desktop. On a phone the
            only theme control is Settings, so hidden chrome does not mount a
            second useTheme instance behind the sheet. */}
          {showTheme && layout !== 'drawer' && <ThemeToggle />}
          {/* Phone navigation is a real modal selector, not a horizontally
            scrollable tab strip. It stays at the right edge while search owns
            the centre column. */}
          {layout === 'drawer' && (
            <button
              type="button"
              onClick={() => setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'open'))}
              aria-label="Choose destination"
              aria-haspopup="dialog"
              aria-expanded={mobileDestinationsOpen}
              aria-controls={destinationDialogId}
              title="Choose destination"
              className="kt-btn kt-btn--sm shrink-0 items-center justify-center"
            >
              <LayoutGrid size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <BottomSheet
        id={destinationDialogId}
        open={mobileDestinationsOpen}
        onClose={dismissMobileDestinations}
        ariaLabel="Choose destination"
        closeLabel="Dismiss destination picker"
        panelClassName="px-panel pb-panel"
      >
        <div className="grid gap-sm pb-sm">
          <div className="grid gap-xs">
            <h2 className="m-0 text-ui font-semibold text-fg">Choose destination</h2>
            <p className="m-0 text-meta text-muted">Select a destination, or dismiss this menu.</p>
          </div>
          <nav aria-label="Destinations" className="grid gap-xs">
            {APP_BAR_DESTINATIONS.map(destination => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                active={activeDestination === destination.id}
                onSelect={selectMobileDestination}
              />
            ))}
          </nav>
          <button type="button" onClick={dismissMobileDestinations} className="kt-btn justify-center">
            Dismiss
          </button>
        </div>
      </BottomSheet>
    </header>
  );
}
