// THE UNIFIED SIDE-PANE TAB MODEL — single source of truth for tab identity
// and per-session tab state.
//
// Two halves, one file:
//
//   REGISTRY   which tabs exist at all. The ten built-in surfaces are declared
//              here; wave-2 modules (browser HUD, files bar, skills groups,
//              shared search) call `registerSidePaneTab` from their own module
//              scope and appear in the strip without touching the wave-1
//              files. The registry is versioned and subscribable, so late
//              registration re-renders any live strip.
//   STATE      which tabs are OPEN in a given session's strip and which one is
//              ACTIVE. Module state, not React state, for the same reason the
//              old per-session snapshot map was: retained session panes are
//              created and destroyed by the App-level LRU, and an evicted-
//              then-revisited session must come back to the tabs it had.
//
// Every session starts with the human's chosen default strip: pins, tasks,
// skills, tree (lineage), mcp, needs (attention) and cost (analytics). Web,
// files and terminals join the strip when something opens them — the + picker,
// a header toggle, a transcript link or a code-reference delivery.

import type { ReactNode } from 'react';
import {
  Cable,
  ChartNoAxesCombined,
  CircleAlert,
  FolderGit2,
  GitFork,
  Globe2,
  ListTodo,
  Pin,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { BrowserDestination } from '../components/InAppBrowser';

/** Built-in tabs use the historical SidePaneSurface literals as their ids. */
export type SidePaneTabId = string;

export type SidePaneTabPresentation = 'pane' | 'sheet';

/** The contract a registered (non-built-in) tab body renders against. Kept
 *  deliberately small: built-in surfaces need bespoke delivery props (task,
 *  code-reference, attention and pin requests) that this generic surface must
 *  not grow, so they render through SidePane's own switch instead. */
export interface SidePaneTabRenderProps {
  sessionId: string;
  presentation: SidePaneTabPresentation;
  titleId: string;
  onClose: () => void;
  cwd?: string;
  isActive: boolean;
}

export interface SidePaneTabDefinition {
  id: SidePaneTabId;
  /** Full accessible name ("Lineage"). */
  label: string;
  /** Compact strip name ("Tree"); the full label stays the accessible name. */
  shortLabel: string;
  /** Sheet dismiss label. */
  closeLabel: string;
  icon: LucideIcon;
  /** Strip position; open tabs render sorted by this, then by label. */
  order: number;
  /** Member of the default strip every fresh session starts with. */
  defaultOpen?: boolean;
  /** Honest capability gate. The tab still exists and is still selectable —
   *  its body renders an explicit placeholder, never a pretend data source. */
  unavailableReason?: string;
  /** Once opened, the surface stays mounted (hidden) on desktop: it owns
   *  something expensive or live (a socket, a scrollback, a logged-in page). */
  retain?: boolean;
  /** Body for tabs registered outside SidePane.tsx. Built-ins omit it. */
  render?: (props: SidePaneTabRenderProps) => ReactNode;
}

// ---- built-in tabs ---------------------------------------------------------
//
// Array order is the HISTORICAL SidePaneSurface key order (SIDE_PANE_SURFACES
// and the bento launcher preserve it); `order` is the STRIP order, which
// follows the human's default-tab listing: pins, tasks, skills, tree, mcp,
// needs, cost — then the on-demand surfaces web, files, terminals.

export const SIDE_PANE_BUILT_IN_TABS: readonly SidePaneTabDefinition[] = [
  {
    id: 'browser',
    label: 'Browser',
    shortLabel: 'Web',
    closeLabel: 'Close browser',
    icon: Globe2,
    order: 80,
    retain: true,
  },
  { id: 'files', label: 'Files', shortLabel: 'Files', closeLabel: 'Close files', icon: FolderGit2, order: 90 },
  {
    id: 'tasks',
    label: 'Tasks',
    shortLabel: 'Tasks',
    closeLabel: 'Close tasks',
    icon: ListTodo,
    order: 20,
    defaultOpen: true,
  },
  { id: 'pins', label: 'Pins', shortLabel: 'Pins', closeLabel: 'Close pins', icon: Pin, order: 10, defaultOpen: true },
  {
    id: 'terminals',
    label: 'Terminals',
    shortLabel: 'Term',
    closeLabel: 'Close terminals',
    icon: SquareTerminal,
    order: 100,
    retain: true,
  },
  {
    id: 'skills',
    label: 'Skills',
    shortLabel: 'Skill',
    closeLabel: 'Close skills',
    icon: Sparkles,
    order: 30,
    defaultOpen: true,
  },
  {
    id: 'lineage',
    label: 'Lineage',
    shortLabel: 'Tree',
    closeLabel: 'Close lineage',
    icon: GitFork,
    order: 40,
    defaultOpen: true,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    shortLabel: 'Cost',
    closeLabel: 'Close analytics',
    icon: ChartNoAxesCombined,
    order: 70,
    defaultOpen: true,
  },
  {
    id: 'attention',
    label: 'Attention',
    shortLabel: 'Needs',
    closeLabel: 'Close attention',
    icon: CircleAlert,
    order: 60,
    defaultOpen: true,
  },
  {
    id: 'mcp',
    label: 'MCP',
    shortLabel: 'MCP',
    closeLabel: 'Close MCP',
    icon: Cable,
    order: 50,
    defaultOpen: true,
    unavailableReason: 'No MCP data source is connected yet.',
  },
];

// ---- registry --------------------------------------------------------------

const registry = new Map<SidePaneTabId, SidePaneTabDefinition>(SIDE_PANE_BUILT_IN_TABS.map(def => [def.id, def]));
let registryVersion = 0;
const registryListeners = new Set<() => void>();

function bumpRegistry(): void {
  registryVersion += 1;
  definitionsCache = null;
  defaultOpenCache = null;
  for (const listener of registryListeners) listener();
}

/** Register (or replace — last registration wins, so hot reload cannot dupe)
 *  one tab definition. Returns the unregister function. Registering a tab
 *  with `defaultOpen` affects sessions whose strip has not been touched yet;
 *  sessions with existing state keep the tabs they had. */
export function registerSidePaneTab(definition: SidePaneTabDefinition): () => void {
  registry.set(definition.id, definition);
  bumpRegistry();
  return () => {
    if (registry.get(definition.id) !== definition) return;
    registry.delete(definition.id);
    bumpRegistry();
  };
}

export function getSidePaneTabDefinition(id: SidePaneTabId): SidePaneTabDefinition | undefined {
  return registry.get(id);
}

let definitionsCache: readonly SidePaneTabDefinition[] | null = null;

/** Every registered tab, in strip order. Snapshot identity is stable between
 *  registry versions, so this is safe as a `useSyncExternalStore` snapshot. */
export function getSidePaneTabDefinitions(): readonly SidePaneTabDefinition[] {
  definitionsCache ??= [...registry.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return definitionsCache;
}

export function subscribeSidePaneTabRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

/** Sort open-tab ids into strip order. Ids without a live definition sort
 *  last and render nowhere — an unknown tab must not invent a position. */
export function sortSidePaneTabs(ids: readonly SidePaneTabId[]): readonly SidePaneTabId[] {
  return [...ids].sort((a, b) => {
    const da = registry.get(a);
    const db = registry.get(b);
    if (!da && !db) return a.localeCompare(b);
    if (!da) return 1;
    if (!db) return -1;
    return da.order - db.order || da.label.localeCompare(db.label);
  });
}

// ---- per-session state -----------------------------------------------------

export interface SidePaneTabsState {
  /** The session's strip. Kept in strip order at every write. */
  open: readonly SidePaneTabId[];
  /** The showing tab; null means the pane is closed (the strip survives). */
  active: SidePaneTabId | null;
  /** The browser surface's payload rides with the session, as it always did. */
  browser: BrowserDestination | null;
}

const sessionTabStates = new Map<string, SidePaneTabsState>();
let stateVersion = 0;
const stateListeners = new Set<() => void>();
let defaultOpenCache: SidePaneTabsState | null = null;

function defaultState(): SidePaneTabsState {
  defaultOpenCache ??= {
    open: getSidePaneTabDefinitions()
      .filter(def => def.defaultOpen)
      .map(def => def.id),
    active: null,
    browser: null,
  };
  return defaultOpenCache;
}

function notifyState(): void {
  stateVersion += 1;
  for (const listener of stateListeners) listener();
}

export function subscribeSidePaneTabsState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Monotonic write counter — a cheap `useSyncExternalStore` snapshot key. */
export function getSidePaneTabsVersion(): number {
  return stateVersion;
}

/** Stable-identity read: the same object comes back until the next write to
 *  this session (or, for untouched sessions, the next registry change). */
export function readSidePaneTabsState(sessionId: string): SidePaneTabsState {
  return sessionTabStates.get(sessionId) ?? defaultState();
}

function write(sessionId: string, next: SidePaneTabsState): void {
  sessionTabStates.set(sessionId, next);
  notifyState();
}

/** Low-level whole-state write — the back-compat seam and test seam. */
export function writeSidePaneTabsState(sessionId: string, next: SidePaneTabsState): void {
  write(sessionId, { ...next, open: sortSidePaneTabs(next.open) });
}

/** Add a tab to the strip if absent and make it active. The single open path:
 *  the + picker, header toggles, transcript links and reference deliveries all
 *  land here, so opening a non-default surface always materialises its tab. */
export function openSidePaneTab(sessionId: string, id: SidePaneTabId): void {
  const current = readSidePaneTabsState(sessionId);
  const open = current.open.includes(id) ? current.open : sortSidePaneTabs([...current.open, id]);
  if (open === current.open && current.active === id) return;
  write(sessionId, { ...current, open, active: id });
}

/** Switch among already-open tabs; a tab outside the strip is a no-op (use
 *  `openSidePaneTab` to add). */
export function activateSidePaneTab(sessionId: string, id: SidePaneTabId): void {
  const current = readSidePaneTabsState(sessionId);
  if (!current.open.includes(id) || current.active === id) return;
  write(sessionId, { ...current, active: id });
}

/** Close the pane. The strip — which tabs the reader chose — survives. */
export function deactivateSidePane(sessionId: string): void {
  const current = readSidePaneTabsState(sessionId);
  if (current.active === null) return;
  write(sessionId, { ...current, active: null });
}

/** Take a tab out of the strip (picker toggle-off). Removing the active tab
 *  activates its nearest strip neighbour — the following tab when one exists,
 *  else the preceding one — and removing the last tab closes the pane.
 *  Removal never unmounts a retained surface: hiding the terminals tab must
 *  not drop scrollback, exactly as switching away from it does not. */
export function removeSidePaneTab(sessionId: string, id: SidePaneTabId): void {
  const current = readSidePaneTabsState(sessionId);
  const index = current.open.indexOf(id);
  if (index === -1) return;
  const open = current.open.filter(tab => tab !== id);
  const active = current.active === id ? (open[index] ?? open[index - 1] ?? null) : current.active;
  write(sessionId, { ...current, open, active });
}

/** Browser payload write; the destination rides in the same session state so
 *  a revisited session restores the page it was reading. */
export function setSidePaneBrowserDestination(sessionId: string, browser: BrowserDestination | null): void {
  const current = readSidePaneTabsState(sessionId);
  write(sessionId, { ...current, browser });
}

/** Test seam — the memory is module state, so tests must start from nothing. */
export function resetSidePaneTabsStates(): void {
  sessionTabStates.clear();
  notifyState();
}
