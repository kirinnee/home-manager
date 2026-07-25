// Theme picker. A compact trigger in the app bar opens a popover with the five
// theme families and an explicit Auto / Light / Dark control.
//
// The family previews are the real thing, not an approximation: each swatch
// carries `data-swatch="<family>-<mode>"`, and index.css declares that theme's
// tokens on `[data-swatch=...]` alongside `:root[data-theme=...]`. So a swatch
// renders in the theme it is advertising — its wash, surface, ink, display
// font, accent, status trio, border weight and corner radius — while the rest
// of the app stays in the current one. Nothing here hardcodes a colour.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import { useTheme, type ResolvedMode, type ThemeFamilyId, type ThemeMode } from '../hooks/useTheme';
import { cn } from '../lib/utils';
import { Button } from './Primitives';

/** Everything the browser can put focus on inside the panel. The `tabIndex >= 0`
 *  filter applied to this list is what separates a TAB STOP from something that
 *  is merely focusable — see the cycle below. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

const MODE_OPTIONS: ReadonlyArray<{ id: ThemeMode; label: string; Icon: typeof Sun; hint: string }> = [
  { id: 'system', label: 'Auto', Icon: Monitor, hint: 'Follow the operating system' },
  { id: 'light', label: 'Light', Icon: Sun, hint: 'Always light' },
  { id: 'dark', label: 'Dark', Icon: Moon, hint: 'Always dark' },
];

/** A live, CSS-only preview of one family/mode pair. */
function Swatch({ theme, current }: { theme: string; current: boolean }) {
  return (
    <span
      className={cn(
        'block min-w-0 flex-1 rounded-sm',
        current && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
      )}
    >
      <span className="kt-swatch" data-swatch={theme} aria-hidden="true">
        <span className="kt-swatch-face">Aa</span>
        <i className="kt-swatch-accent" />
        <i className="kt-swatch-signal" />
      </span>
    </span>
  );
}

export function ThemeToggle() {
  const { family, mode, resolved, families, setFamily, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Escape closes and hands focus back; a click anywhere outside just closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);

  // Opening puts focus on the family that is currently in force, so the popover
  // is usable without a pointer.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  // TAB CYCLE. The panel has said `role="dialog"` since it was written, and Tab
  // walked straight out of it: one press from the family in force left the
  // reader somewhere in the page behind, with the popover still open and still
  // announcing itself as a dialog. A dialog you can tab out of but not see past
  // is the worst of both shapes.
  //
  // Deliberately NOT the shared useDialogFocus contract. That hook restores
  // focus to the opener on EVERY close, which is right for a modal and wrong
  // here: this popover also dismisses on an outside click, and snatching focus
  // back to the trigger when the reader has just clicked into something else
  // would be a regression. Escape, initial focus and return-focus are already
  // correct above; the cycle is the only piece missing, so the cycle is the only
  // piece added. No `aria-modal` either — the page behind stays live and
  // reachable by pointer, and claiming otherwise would be a lie that assistive
  // tech repeats to the reader.
  //
  // The cycle turns on TAB STOPS (`tabIndex >= 0`), not on everything focusable,
  // because the family list is a roving radiogroup: four of its five buttons sit
  // at `tabIndex={-1}` and Tab never visits them. A first/last comparison over
  // "everything focusable" would believe the cycle ends at the LAST family
  // button and happily let focus escape from the CHECKED one — which is where a
  // keyboard reader actually stands. Position is compared by document order, so
  // a programmatic focus onto a parked button still wraps instead of leaking.
  const onPanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      el => el.tabIndex >= 0 && (el.offsetParent !== null || el === document.activeElement),
    );
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    if (e.shiftKey) {
      // Backwards past the top: nothing inside left to land on.
      if (!active || active === first || !follows(first, active)) {
        e.preventDefault();
        last.focus();
      }
      return;
    }
    // Forwards past the last stop — including from a parked button that sits
    // after it in the DOM.
    if (!active || active === last || !follows(active, last)) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // Roving arrow-key navigation inside the family radiogroup.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const index = families.findIndex(f => f.id === family);
    const last = families.length - 1;
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : e.key === 'ArrowDown' || e.key === 'ArrowRight'
            ? Math.min(last, index + 1)
            : Math.max(0, index - 1);
    const target = families[next];
    if (!target) return;
    setFamily(target.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-family="${target.id}"]`)?.focus();
  };

  const activeFamily = families.find(f => f.id === family);
  const modeLabel = MODE_OPTIONS.find(m => m.id === mode)?.label ?? 'Auto';
  const summary = `Theme: ${activeFamily?.label ?? family}, ${modeLabel}${mode === 'system' ? ` (${resolved})` : ''}`;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        onClick={() => (open ? close(true) : setOpen(true))}
        title={summary}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Palette size={14} aria-hidden="true" />
        <span className="hidden text-meta font-medium sm:inline">{activeFamily?.label ?? 'Theme'}</span>
      </Button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Theme"
          onKeyDown={onPanelKeyDown}
          // Role silhouette, not a generic one: `shadow-popover` is what makes
          // Neo-Brutalism's hard offset block appear here instead of a soft
          // Studio blur, and `rounded-panel`/`p-panel` follow the family's own
          // geometry rather than a fixed 8px/8px.
          className="absolute right-0 top-full z-50 mt-1 w-[292px] rounded-panel border border-border bg-surface p-panel shadow-popover"
        >
          <div
            role="radiogroup"
            aria-label="Colour mode"
            className="mb-2 flex gap-1 rounded-control border border-border bg-surface-2 p-1"
          >
            {MODE_OPTIONS.map(({ id, label, Icon, hint }) => {
              const checked = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  title={hint}
                  onClick={() => setMode(id)}
                  // `h-control-sm` instead of `py-1`: themes.css composes the
                  // coarse-pointer floor into that token, so this segmented
                  // control is 24px on a desktop and a full 44px thumb target on
                  // a phone without this component knowing what a pointer is.
                  className={cn(
                    'flex h-control-sm flex-1 items-center justify-center gap-1 rounded-tab px-control-x text-meta font-medium transition-colors',
                    checked
                      ? // `border-accent`, NOT `border-accent-border`: a
                        // state-bearing edge has to be identifiable, and
                        // `--accent-border` measures 1.2-2.9:1 against its
                        // surface in 6 of the 10 themes. It is decorative tint
                        // only now (contract §8.2).
                        'border border-accent bg-accent-soft text-accent'
                      : 'border border-transparent text-muted hover:text-fg',
                  )}
                >
                  <Icon size={12} aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>

          <div
            ref={listRef}
            role="radiogroup"
            aria-label="Theme family"
            onKeyDown={onListKeyDown}
            className="flex max-h-[min(60vh,420px)] flex-col gap-1.5 overflow-y-auto scroll-thin"
          >
            {families.map(f => {
              const checked = f.id === family;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  data-family={f.id}
                  aria-checked={checked}
                  aria-label={`${f.label} — ${f.blurb}`}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setFamily(f.id as ThemeFamilyId)}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-panel border p-panel text-left transition-colors',
                    checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent',
                  )}
                >
                  <span className="flex items-center gap-1">
                    <span className="text-ui font-semibold text-fg">{f.label}</span>
                    {checked && <Check size={12} className="text-accent" aria-hidden="true" />}
                  </span>
                  <span className="text-meta leading-base text-muted">{f.blurb}</span>
                  <span className="mt-1 flex items-stretch gap-1.5">
                    {(['light', 'dark'] as ResolvedMode[]).map(variant => (
                      <Swatch key={variant} theme={`${f.id}-${variant}`} current={checked && resolved === variant} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-2 border-t border-border-soft pt-1.5 text-2xs leading-base text-faint">
            Previews render in their own theme. Auto follows the OS live.
          </p>
        </div>
      )}
    </div>
  );
}
