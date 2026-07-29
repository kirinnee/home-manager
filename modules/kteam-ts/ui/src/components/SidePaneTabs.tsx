// THE UNIFIED TAB CONTROLS for the session side pane. One model
// (side-pane-tab-model.ts) feeds two presentations:
//
//   DESKTOP (pane)   a real WAI-ARIA tablist of the OPEN tabs — the settled
//                    `.kt-sheet-tabs .kt-tab` vocabulary, roving tabindex,
//                    wrap-around arrows — followed by a sibling + button that
//                    opens an anchored, non-modal picker: every registered tab
//                    with a pressed state for "in the strip". The strip is
//                    exactly ONE ROW tall: overflow is horizontal only, and
//                    the + button stays pinned at the end.
//   PHONE (sheet)    NEVER a horizontal strip. A sideways-scrolling tab row is
//                    the thing this replaces. One 44px tab control shows the
//                    active tab; tapping it opens a focus-trapped modal (the
//                    shared BottomSheet) that lists the open tabs to switch
//                    between, offers per-tab removal, and carries the
//                    "Add a tab" half of the + picker.
//
// INSTANCE TABS (one per open file / browser page / terminal) render exactly
// like singleton tabs plus a close affordance: a pointer ✕ on the desktop tab,
// the Delete key on the focused tab, and the per-row ✕ the mobile switcher
// already gives every tab. Their hover title is the full path/URL.
//
// The controls are deliberately presentational: SidePane owns the session id
// and calls the model; wave-2 surfaces register tabs in the model and appear
// here without this file changing.

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import type {
  SidePaneInstanceKind,
  SidePaneTabDefinition,
  SidePaneTabId,
  SidePaneTabPresentation,
} from '../lib/side-pane-tab-model';
import { BottomSheet } from './SessionDetails';

export function sidePaneTabId(paneId: string, surface: string): string {
  return `${paneId}-tab-${surface}`;
}

export function sidePanePanelId(paneId: string, surface: string): string {
  return `${paneId}-tabpanel-${surface}`;
}

/** WAI-ARIA tab keyboard policy. Focus movement is invoked only from the
 * strip's own key handler, never when a surface opens through another trigger. */
export function nextSidePaneTab<T extends string>(key: string, current: T, order: readonly T[]): T | null {
  const index = order.indexOf(current);
  if (index === -1 || order.length === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return order[(index + 1) % order.length]!;
    case 'ArrowLeft':
    case 'ArrowUp':
      return order[(index - 1 + order.length) % order.length]!;
    case 'Home':
      return order[0]!;
    case 'End':
      return order[order.length - 1]!;
    default:
      return null;
  }
}

export interface SidePaneTabsProps {
  paneId: string;
  presentation: SidePaneTabPresentation;
  /** The session's OPEN tabs (definitions resolved, strip order) — singleton
   *  registrations and synthesized instance definitions alike. */
  tabs: readonly SidePaneTabDefinition[];
  /** Every registered tab, strip order — the picker's catalogue. Instance
   *  tabs are never in it; their catalogue entries are the `instanceKind`
   *  definitions (Browser) that spawn them. */
  all: readonly SidePaneTabDefinition[];
  /** The active tab id. May name a tab outside `tabs` when its definition
   *  vanished; the strip then simply has no selected tab. */
  current: SidePaneTabId;
  /** Switch among open tabs. */
  onSelect: (id: SidePaneTabId) => void;
  /** Add a not-yet-open tab to the strip and activate it (the + picker). */
  onAdd: (id: SidePaneTabId) => void;
  /** Take a tab out of the strip; closes (disposes) an instance tab. */
  onRemove: (id: SidePaneTabId) => void;
  /** The + picker chose a catalogue entry that spawns instances: create a NEW
   *  instance of this kind (a fresh empty browser page). Optional so bare
   *  fixtures keep working; without it the entry falls back to `onAdd`. */
  onNewInstance?: (kind: SidePaneInstanceKind) => void;
}

/** Rows shared by the desktop + picker and the mobile modal's "Add" section:
 *  one toggle per registered tab, pressed = in the strip. An unavailable tab
 *  (mcp) stays togglable — it is a real default tab whose BODY is the honest
 *  placeholder; hiding the choice would misrender absence as nonexistence.
 *  An `instanceKind` entry is not a toggle at all: choosing it always creates
 *  a NEW instance tab, so it reads "New …", never "Remove …". */
export function SidePaneTabPickerList({
  all,
  openIds,
  onAdd,
  onRemove,
  onNewInstance,
}: {
  all: readonly SidePaneTabDefinition[];
  openIds: readonly SidePaneTabId[];
  onAdd: (id: SidePaneTabId) => void;
  onRemove: (id: SidePaneTabId) => void;
  onNewInstance?: (kind: SidePaneInstanceKind) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-xs p-0">
      {all.map(def => {
        const Icon = def.icon;
        const spawns = def.instanceKind;
        const isOpen = !spawns && openIds.includes(def.id);
        const label = spawns ? `New ${def.label} tab` : isOpen ? `Remove ${def.label} tab` : `Add ${def.label} tab`;
        return (
          <li key={def.id}>
            <button
              type="button"
              aria-pressed={spawns ? undefined : isOpen}
              aria-label={label}
              onClick={() => {
                if (spawns) {
                  if (onNewInstance) onNewInstance(spawns);
                  else onAdd(def.id);
                } else if (isOpen) onRemove(def.id);
                else onAdd(def.id);
              }}
              className="flex min-h-[44px] w-full items-center gap-sm rounded-control border border-border bg-surface-2 px-2 text-left text-fg hover:border-accent-border hover:bg-accent-soft"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent-border bg-surface text-accent"
                aria-hidden="true"
              >
                <Icon size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-semibold">{def.label}</span>
                {def.instanceKind && <span className="block truncate text-2xs text-muted">Opens a new tab</span>}
                {def.unavailableReason && <span className="block truncate text-2xs text-muted">Unavailable</span>}
              </span>
              {isOpen && <Check size={15} aria-hidden="true" className="shrink-0 text-accent" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The mobile modal's content: the open tabs to switch between (with per-tab
 *  removal), then the not-yet-open catalogue under "Add a tab". Exported so
 *  the markup contract is testable without a DOM to open the sheet in.
 *  Instance tabs list with their short label (full path/URL as the hover
 *  title) and the same per-row ✕ every tab gets — NEVER a horizontal strip. */
export function SidePaneTabSwitcherList({
  tabs,
  all,
  current,
  onSelect,
  onAdd,
  onRemove,
  onNewInstance,
}: Pick<SidePaneTabsProps, 'tabs' | 'all' | 'current' | 'onSelect' | 'onAdd' | 'onRemove' | 'onNewInstance'>) {
  const closed = all.filter(def => def.instanceKind || !tabs.some(tab => tab.id === def.id));
  return (
    <div className="flex flex-col gap-sm">
      <ul aria-label="Open tabs" className="m-0 flex list-none flex-col gap-xs p-0">
        {tabs.map(def => {
          const Icon = def.icon;
          const selected = def.id === current;
          const shortLabel = def.instance ? def.instance.label : def.label;
          return (
            <li key={def.id} className="flex items-stretch gap-xs">
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                aria-label={def.label}
                title={def.label}
                onClick={() => onSelect(def.id)}
                className={`flex min-h-[44px] min-w-0 flex-1 items-center gap-sm rounded-control border px-2 text-left ${
                  selected
                    ? 'border-accent bg-accent-soft text-fg'
                    : 'border-border bg-surface-2 text-fg hover:border-accent-border hover:bg-accent-soft'
                }`}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent-border bg-surface text-accent"
                  aria-hidden="true"
                >
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate text-ui font-semibold">{shortLabel}</span>
                {selected && <Check size={15} aria-hidden="true" className="shrink-0 text-accent" />}
              </button>
              <button
                type="button"
                onClick={() => onRemove(def.id)}
                aria-label={def.instance ? `Close ${shortLabel} tab` : `Remove ${def.label} tab`}
                title={def.instance ? `Close ${shortLabel} tab` : `Remove ${def.label} tab`}
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border border-border text-muted hover:border-accent-border hover:text-fg"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {closed.length > 0 && (
        <div>
          <h2 className="m-0 mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">Add a tab</h2>
          <SidePaneTabPickerList
            all={closed}
            openIds={[]}
            onAdd={onAdd}
            onRemove={onRemove}
            onNewInstance={onNewInstance}
          />
        </div>
      )}
    </div>
  );
}

/** Desktop: the tablist of open tabs plus the sibling + button and its
 *  anchored non-modal picker (pointer-down-outside and Escape dismiss it,
 *  matching the launcher popover's manners). */
function SidePaneTabStrip({
  paneId,
  tabs,
  all,
  current,
  onSelect,
  onAdd,
  onRemove,
  onNewInstance,
}: Omit<SidePaneTabsProps, 'presentation'>) {
  const refs = useRef(new Map<SidePaneTabId, HTMLButtonElement>());
  const order = tabs.map(tab => tab.id);
  // Roving tabindex needs exactly one stop even when the active tab has no
  // strip entry (its definition vanished): fall back to the first tab.
  const focusStop = order.includes(current) ? current : order[0];
  const generatedId = useId();
  const pickerId = `${paneId}-tab-picker-${generatedId}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPickerOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  return (
    <div className="flex shrink-0 items-stretch border-b border-border-soft">
      {/* One row, horizontal overflow only — a tab strip must never grow a
          vertical scrollbar. `overflow-x-auto` alone computes overflow-y as
          `auto` too (CSS overflow interaction), which is exactly the phantom
          vertical scrollbar the human flagged; pin it hidden. */}
      <div
        role="tablist"
        aria-label="Side pane tabs"
        className="kt-sheet-tabs flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
      >
        {tabs.map(tab => {
          const Icon = tab.icon;
          const selected = tab.id === current;
          const instance = tab.instance;
          return (
            <button
              key={tab.id}
              ref={element => {
                if (element) refs.current.set(tab.id, element);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={sidePaneTabId(paneId, tab.id)}
              aria-label={tab.label}
              aria-selected={selected}
              aria-controls={sidePanePanelId(paneId, tab.id)}
              aria-keyshortcuts={instance ? 'Delete' : undefined}
              tabIndex={tab.id === focusStop ? 0 : -1}
              title={tab.label}
              onClick={() => {
                if (!selected) onSelect(tab.id);
              }}
              onKeyDown={event => {
                if (instance && event.key === 'Delete') {
                  event.preventDefault();
                  onRemove(tab.id);
                  return;
                }
                const next = nextSidePaneTab(event.key, tab.id, order);
                if (next === null) return;
                event.preventDefault();
                onSelect(next);
                // This is direct keyboard navigation inside the strip. External
                // opens and tab changes never run this focus movement.
                requestAnimationFrame(() => refs.current.get(next)?.focus());
              }}
              className={`kt-tab min-h-[44px] min-w-[56px] max-w-[148px] flex-none justify-center !gap-0 px-0 ${
                instance ? '!flex-row gap-xs px-2' : '!flex-col'
              }`}
            >
              {instance ? (
                <>
                  <Icon size={13} aria-hidden="true" className="shrink-0" />
                  <span aria-hidden="true" className="min-w-0 truncate px-1 text-2xs leading-tight">
                    {tab.shortLabel}
                  </span>
                  {/* Pointer close. Not a nested button (invalid inside a tab);
                      keyboard closes with Delete, mobile has a real ✕ row. */}
                  <span
                    role="presentation"
                    title={tab.closeLabel}
                    onClick={event => {
                      event.stopPropagation();
                      onRemove(tab.id);
                    }}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-muted hover:bg-accent-soft hover:text-fg"
                  >
                    <X size={12} aria-hidden="true" />
                  </span>
                </>
              ) : (
                <>
                  <Icon size={15} aria-hidden="true" />
                  <span aria-hidden="true" className="max-w-full truncate text-2xs leading-tight">
                    {tab.shortLabel}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="relative flex shrink-0 items-center px-1">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setPickerOpen(open => !open)}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-label="Add or remove tabs"
          title="Add or remove tabs"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-muted hover:text-fg"
        >
          <Plus size={17} aria-hidden="true" />
        </button>
        {pickerOpen && (
          <div
            ref={popoverRef}
            id={pickerId}
            role="dialog"
            aria-label="Choose tabs"
            className="absolute right-0 top-full z-50 mt-1 w-[min(280px,calc(100vw-16px))] overflow-y-auto rounded-panel border border-border bg-surface p-2 shadow-popover"
            style={{ maxHeight: 'min(60dvh, 420px)' }}
          >
            <SidePaneTabPickerList
              all={all}
              openIds={order}
              onAdd={onAdd}
              onRemove={onRemove}
              onNewInstance={onNewInstance}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Phone: the single tab control. No tablist exists in this presentation —
 *  the control names the active tab and opens the switcher modal. */
function SidePaneTabControl({
  paneId,
  tabs,
  all,
  current,
  onSelect,
  onAdd,
  onRemove,
  onNewInstance,
}: Omit<SidePaneTabsProps, 'presentation'>) {
  const generatedId = useId();
  const modalId = `${paneId}-tab-switcher-${generatedId}`;
  const [open, setOpen] = useState(false);
  const active = tabs.find(tab => tab.id === current) ?? all.find(tab => tab.id === current) ?? null;
  const ActiveIcon = active?.icon;
  const activeName = active ? (active.instance ? active.instance.label : active.label) : null;

  const pick = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <>
      <div className="flex shrink-0 items-center border-b border-border-soft px-panel py-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? modalId : undefined}
          aria-label={activeName ? `Switch tab — ${activeName} is showing` : 'Switch tab'}
          title="Switch tab"
          className="flex min-h-[44px] w-full min-w-0 items-center gap-sm rounded-control border border-border px-2 text-left text-fg hover:border-accent-border"
        >
          {ActiveIcon && (
            <span className="shrink-0 text-accent" aria-hidden="true">
              <ActiveIcon size={15} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-ui font-semibold">{activeName ?? 'Choose a tab'}</span>
          <ChevronsUpDown size={15} aria-hidden="true" className="shrink-0 text-muted" />
        </button>
      </div>
      <BottomSheet
        id={modalId}
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel="Switch tab"
        closeLabel="Close tab switcher"
        panelClassName="overflow-hidden bg-surface"
        maxHeight="min(76dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
        zIndexClass="z-[80]"
      >
        <div className="overflow-y-auto p-panel">
          <SidePaneTabSwitcherList
            tabs={tabs}
            all={all}
            current={current}
            onSelect={id => pick(() => onSelect(id))}
            onAdd={id => pick(() => onAdd(id))}
            onRemove={onRemove}
            onNewInstance={onNewInstance ? kind => pick(() => onNewInstance(kind)) : undefined}
          />
        </div>
      </BottomSheet>
    </>
  );
}

export function SidePaneTabs(props: SidePaneTabsProps) {
  const { presentation, ...rest } = props;
  return presentation === 'pane' ? <SidePaneTabStrip {...rest} /> : <SidePaneTabControl {...rest} />;
}
