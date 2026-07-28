import { useEffect, useId } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ThemeSettings } from '../components/ThemeToggle';
import { DictationSettings } from '../components/DictationSettings';
import { ChatWidthControl } from '../components/ChatWidthControl';
import { NotificationSettings } from '../components/NotificationSettings';
import { BottomSheet } from '../components/SessionDetails';
import { DENSITY_OPTIONS, useDensity } from '../hooks/useDensity';
import { useInputModality } from '../hooks/useInputModality';
import { TEXT_SCALE_FACTORS, useTheme, type TextScale, type ThemeState } from '../hooks/useTheme';
import {
  SETTINGS_DEFINITIONS,
  SETTINGS_LINKS,
  isSettingId,
  type SettingDefinition,
  type SettingId,
} from '../lib/settings';
import { Link } from '../lib/router';
import { useUiControls } from '../lib/store';
import { cn } from '../lib/utils';

const SETTINGS_SHEET_HEIGHT = 'min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))';

/** Settings has one scroll owner on every layout. Explicit vertical panning is
 * important on the sheet: a gesture commonly starts on a radio button, and the
 * fixed app shell is intentionally unable to accept a chained page scroll. */
const SETTINGS_SCROLLER_CLASS = 'min-h-0 w-full overflow-y-auto overscroll-contain scroll-thin [touch-action:pan-y]';

export const TEXT_SCALE_OPTIONS: ReadonlyArray<{
  id: TextScale;
  label: string;
  description: string;
}> = [
  { id: 'default', label: 'Default', description: 'Use the interface’s designed size.' },
  { id: 'large', label: 'Large', description: `${Math.round(TEXT_SCALE_FACTORS.large * 100)}% of default.` },
  { id: 'larger', label: 'Larger', description: `${Math.round(TEXT_SCALE_FACTORS.larger * 100)}% of default.` },
];

function SettingsSection({ definition, children }: { definition: SettingDefinition; children: React.ReactNode }) {
  const headingId = `settings-${definition.id}-heading`;
  return (
    <section
      id={`settings-${definition.id}`}
      data-setting-id={definition.id}
      tabIndex={-1}
      className="kt-panel p-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="m-0 text-title font-semibold text-fg">
        {definition.label}
      </h2>
      <p className="mt-1 text-ui leading-base text-muted">{definition.description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function TextScaleControl({ theme }: { theme: ThemeState }) {
  return (
    <div
      role="radiogroup"
      aria-label="Text size"
      aria-describedby={!theme.textScaleSupported ? 'text-scale-unsupported' : undefined}
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {TEXT_SCALE_OPTIONS.map(option => {
        const checked = (theme.textScaleSupported ? theme.textScale : 'default') === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!theme.textScaleSupported}
            onClick={() => theme.setTextScale(option.id)}
            className={cn(
              'flex min-h-[44px] min-w-0 flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
              checked
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-fg hover:border-accent',
              !theme.textScaleSupported && 'cursor-not-allowed opacity-60',
            )}
          >
            <span className="text-ui font-semibold">{option.label}</span>
            <span className="text-meta leading-tight text-muted">{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function scrollToSetting(target: SettingId | null, touchAffected: boolean): () => void {
  if (!target || typeof document === 'undefined') return () => undefined;
  const frame = requestAnimationFrame(() => {
    const section = document.getElementById(`settings-${target}`);
    if (!section) return;
    // `scrollIntoView()` walks EVERY scroll container, including the app's
    // overflow-hidden shell (which is still programmatically scrollable). That
    // pushed the persistent AppBar 45px above the viewport. Scroll only the
    // Settings-owned region and keep shell chrome pinned at zero.
    const shell = section.closest<HTMLElement>('.kt-shell');
    shell?.scrollTo({ top: 0, left: 0 });
    const scroller = section.closest<HTMLElement>('[data-settings-scroller]');
    if (scroller) {
      const scrollerBox = scroller.getBoundingClientRect();
      const sectionBox = section.getBoundingClientRect();
      scroller.scrollTo({ top: scroller.scrollTop + sectionBox.top - scrollerBox.top - 8 });
    }
    const focusTarget = touchAffected
      ? section
      : (section.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not([disabled])') ?? section);
    focusTarget.focus({ preventScroll: true });
  });
  return () => cancelAnimationFrame(frame);
}

export function SettingsContent({ target = null }: { target?: SettingId | null }) {
  const theme = useTheme();
  const { density, explicit, setDensity } = useDensity();
  const [controls, setControls] = useUiControls();
  const { touchAffected } = useInputModality();

  useEffect(() => scrollToSetting(target, touchAffected), [target, touchAffected]);

  const control = (id: SettingId) => {
    switch (id) {
      case 'text-size':
        return (
          <>
            <TextScaleControl theme={theme} />
            {theme.textScaleSupported ? (
              <p className="mt-2 text-meta leading-base text-faint">
                Sizes never go below Default, so existing 44px touch targets are not reduced.
              </p>
            ) : (
              <p id="text-scale-unsupported" role="status" className="mt-2 text-ui leading-base text-warn">
                Text sizing is unavailable in this browser because it does not support percentage text adjustment. The
                choices remain visible but disabled; browser and operating-system zoom still work.
              </p>
            )}
          </>
        );
      case 'density':
        return (
          <>
            <div role="radiogroup" aria-label="Dashboard density" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {DENSITY_OPTIONS.map(option => {
                const checked = density === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => setDensity(option.id)}
                    className={cn(
                      'flex min-h-[44px] min-w-0 flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                      checked
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-border bg-surface-2 text-fg hover:border-accent',
                    )}
                  >
                    <span className="text-ui font-semibold">{option.label}</span>
                    <span className="text-meta leading-tight text-muted">{option.description}</span>
                  </button>
                );
              })}
            </div>
            {explicit === null && (
              <p className="mt-2 text-meta leading-base text-faint">
                Using the device default. Picking a level saves an explicit choice.
              </p>
            )}
          </>
        );
      case 'chat-width':
        return <ChatWidthControl value={controls.chatWidth} onChange={chatWidth => setControls({ chatWidth })} />;
      case 'theme':
        return <ThemeSettings theme={theme} />;
      case 'dictation':
        return <DictationSettings />;
      case 'notifications':
        return <NotificationSettings />;
    }
  };

  return (
    <div data-density={density} className="mx-auto flex w-full max-w-[760px] flex-col gap-3 py-2">
      {SETTINGS_DEFINITIONS.map(definition => (
        <SettingsSection key={definition.id} definition={definition}>
          {control(definition.id)}
        </SettingsSection>
      ))}
      {SETTINGS_LINKS.map(link => (
        <section key={link.id} id={`settings-${link.id}`} className="kt-panel p-panel" aria-label={link.label}>
          <Link to={link.href} className="group flex min-h-[44px] w-full items-center justify-between gap-2 text-left">
            <span className="min-w-0">
              <span className="block text-title font-semibold text-fg group-hover:text-accent">{link.label}</span>
              <span className="mt-1 block text-ui leading-base text-muted">{link.description}</span>
            </span>
            <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted group-hover:text-accent" />
          </Link>
        </section>
      ))}
    </div>
  );
}

function hashSetting(): SettingId | null {
  if (typeof window === 'undefined') return null;
  const value = window.location.hash.replace(/^#/, '');
  return isSettingId(value) ? value : null;
}

/** Desktop route and deep-link surface. Mobile renders this same content inside
 * SettingsSheet; there is deliberately no second settings implementation. */
export function SettingsPage() {
  return (
    <div data-settings-scroller className={cn('h-full pb-4', SETTINGS_SCROLLER_CLASS)}>
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            to="/"
            aria-label="Back to sessions"
            className="kt-btn inline-flex min-h-[44px] shrink-0 items-center gap-1"
          >
            <ChevronLeft size={16} aria-hidden="true" />
            Sessions
          </Link>
          <div className="min-w-0">
            <h1 className="m-0 font-display text-display font-bold tracking-display">Settings</h1>
            <p className="mt-0.5 text-ui text-muted">Appearance and dashboard detail for this browser.</p>
          </div>
        </div>
        <SettingsContent target={hashSetting()} />
      </div>
    </div>
  );
}

export function SettingsSheet({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: SettingId | null;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <BottomSheet
      id="kt-settings-sheet"
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel="Close settings"
      panelClassName="kt-details bg-surface"
      // A definite flex height makes the child below a real scrollport in
      // WebKit as well as Chromium. It is the same keyboard-safe expression as
      // maxHeight, so the sheet still shrinks with the visual viewport.
      maxHeight={SETTINGS_SHEET_HEIGHT}
      height={SETTINGS_SHEET_HEIGHT}
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <h1 id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
          Settings
        </h1>
        <p className="mt-0.5 text-ui text-muted">Appearance and dashboard detail for this browser.</p>
      </div>
      <div
        data-settings-scroller
        data-settings-sheet-scroller
        className={cn('flex-1 px-panel pb-4', SETTINGS_SCROLLER_CLASS)}
      >
        <SettingsContent target={target} />
      </div>
    </BottomSheet>
  );
}
