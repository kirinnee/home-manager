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
        <span className="hidden text-[11px] font-medium sm:inline">{activeFamily?.label ?? 'Theme'}</span>
      </Button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Theme"
          className="absolute right-0 top-full z-50 mt-1 w-[292px] rounded-lg border border-border bg-surface p-2 shadow-md"
        >
          <div
            role="radiogroup"
            aria-label="Colour mode"
            className="mb-2 flex gap-1 rounded-md border border-border bg-surface-2 p-1"
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
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                    checked
                      ? 'border border-accent-border bg-accent-soft text-accent'
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
                    'flex w-full flex-col gap-1 rounded-md border p-2 text-left transition-colors',
                    checked
                      ? 'border-accent-border bg-accent-soft'
                      : 'border-border bg-surface hover:border-accent-border',
                  )}
                >
                  <span className="flex items-center gap-1">
                    <span className="text-[12.5px] font-semibold text-fg">{f.label}</span>
                    {checked && <Check size={12} className="text-accent" aria-hidden="true" />}
                  </span>
                  <span className="text-[11px] leading-snug text-muted">{f.blurb}</span>
                  <span className="mt-1 flex items-stretch gap-1.5">
                    {(['light', 'dark'] as ResolvedMode[]).map(variant => (
                      <Swatch key={variant} theme={`${f.id}-${variant}`} current={checked && resolved === variant} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-2 border-t border-border-soft pt-1.5 text-[10.5px] leading-snug text-faint">
            Previews render in their own theme. Auto follows the OS live.
          </p>
        </div>
      )}
    </div>
  );
}
