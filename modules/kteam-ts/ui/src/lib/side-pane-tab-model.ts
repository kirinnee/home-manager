// THE UNIFIED SIDE-PANE TAB MODEL — single source of truth for tab identity
// and per-session tab state.
//
// Three halves, one file:
//
//   REGISTRY   which SINGLETON tabs exist at all. The built-in surfaces are
//              declared here; wave-2 modules (browser HUD, files bar, skills
//              groups, shared search) call `registerSidePaneTab` from their own
//              module scope and appear in the strip without touching the
//              wave-1 files. The registry is versioned and subscribable, so
//              late registration re-renders any live strip.
//   INSTANCES  IDE-style per-instance tabs: ONE TAB PER OPEN FILE, ONE PER
//              BROWSER PAGE, ONE PER TERMINAL. An instance tab's id carries
//              its identity (`file:<path>`, `browser:<pageId>`,
//              `terminal:<id>`); opening the same file twice focuses the
//              existing tab instead of duplicating it, and closing an
//              instance disposes only that instance — closing the last one
//              leaves no phantom singleton behind.
//   STATE      which tabs are OPEN in a given session's strip and which one is
//              ACTIVE. Module state, not React state, for the same reason the
//              old per-session snapshot map was: retained session panes are
//              created and destroyed by the App-level LRU, and an evicted-
//              then-revisited session must come back to the tabs it had.
//
// Every session starts with the human's chosen default strip: pins, tasks,
// skills, tree (lineage), mcp, needs (attention) and cost (analytics) — all
// singletons, all utility tabs. Files, browser pages and terminals join the
// strip as INSTANCE tabs when something opens them — a transcript link, a
// code reference, the files tree, the browser launcher, or the + picker.

import type { ReactNode } from 'react';
import {
  Cable,
  ChartNoAxesCombined,
  CircleAlert,
  FileCode2,
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

/** Built-in tabs use the historical SidePaneSurface literals as their ids;
 *  instance tabs carry their instance in the id (`file:<path>`, …). */
export type SidePaneTabId = string;

export type SidePaneTabPresentation = 'pane' | 'sheet';

// ---- instance identity -------------------------------------------------------

/** The three per-instance tab kinds. Utility tabs stay singletons. */
export type SidePaneInstanceKind = 'file' | 'browser' | 'terminal';

/** A code-reference line range riding with a file instance tab. */
export interface SidePaneFileSelection {
  line: number;
  endLine?: number;
  column?: number;
}

/** One open instance: a file, a browser page, or a terminal. */
export interface SidePaneTabInstance {
  id: SidePaneTabId;
  kind: SidePaneInstanceKind;
  /** Kind-scoped identity: the file path, the page id, the terminal id. */
  key: string;
  /** Short strip label: basename for files, page title or host for browser. */
  label: string;
  /** Full path/URL — the hover title and the accessible name. */
  title: string;
  /** Insertion counter; instances render after utility tabs, grouped by
   *  kind (files, then browser pages, then terminals), in opening order. */
  order: number;
  /** Browser instances: this page's destination (null = the "Where to?" home). */
  destination?: BrowserDestination | null;
  /** File instances: the delivered line range, cleared on plain re-open. */
  selection?: SidePaneFileSelection;
  /** Monotonic per-instance write counter, so a repeated delivery to an
   *  already-open tab (same file, new line range) is observable. */
  revision: number;
}

export function sidePaneInstanceTabId(kind: SidePaneInstanceKind, key: string): SidePaneTabId {
  return `${kind}:${key}`;
}

const INSTANCE_ID_PATTERN = /^(file|browser|terminal):(.+)$/u;

/** Parse an instance id. Singleton ids (no recognised kind prefix) parse to
 *  null — a registered wave-2 id that merely contains a colon is not ours. */
export function parseSidePaneInstanceTabId(id: SidePaneTabId): { kind: SidePaneInstanceKind; key: string } | null {
  const match = INSTANCE_ID_PATTERN.exec(id);
  if (!match) return null;
  return { kind: match[1] as SidePaneInstanceKind, key: match[2]! };
}

/** Strip block for each kind: instances render after every utility tab
 *  (utility orders are two-digit), files before pages before terminals. */
const INSTANCE_KIND_ORDER: Record<SidePaneInstanceKind, number> = { file: 1000, browser: 2000, terminal: 3000 };

const INSTANCE_KIND_ICON: Record<SidePaneInstanceKind, LucideIcon> = {
  file: FileCode2,
  browser: Globe2,
  terminal: SquareTerminal,
};

/** Browser pages and terminals hold live state (a logged-in page, a socket, a
 *  scrollback); a file body is a cheap re-fetch. */
const INSTANCE_KIND_RETAIN: Record<SidePaneInstanceKind, boolean> = { file: false, browser: true, terminal: true };

// ---- tab definitions ---------------------------------------------------------

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
  /** Present when this body renders an instance tab. */
  instance?: SidePaneTabInstance;
}

export interface SidePaneTabDefinition {
  id: SidePaneTabId;
  /** Full accessible name ("Lineage"; a file's full path). */
  label: string;
  /** Compact strip name ("Tree"; a file's basename); the full label stays the
   *  accessible name. */
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
  /** This catalogue entry opens PER-INSTANCE tabs instead of toggling a
   *  singleton: the + picker creates a NEW instance of this kind, and the
   *  entry's own id never sits in the strip. */
  instanceKind?: SidePaneInstanceKind;
  /** Present on the synthesized definition of an open instance tab. */
  instance?: SidePaneTabInstance;
}

// ---- built-in tabs ---------------------------------------------------------
//
// Array order is the HISTORICAL SidePaneSurface key order (SIDE_PANE_SURFACES
// and the bento launcher preserve it); `order` is the STRIP order, which
// follows the human's default-tab listing: pins, tasks, skills, tree, mcp,
// needs, cost — then the on-demand catalogue entries web, files, terminals.
//
// `browser` is a CATALOGUE entry, not a strip tab: every open of it becomes a
// per-page instance tab (`instanceKind`). `files` is the file PICKER — the
// directory tree surface; the files it opens become per-file instance tabs.
// `terminals` still hosts the multi-terminal deck as a singleton; the model
// already speaks `terminal:<id>` so the deck can hand each terminal its own
// tab without another model change (see DESIGN-side-pane-tabs.md).

export const SIDE_PANE_BUILT_IN_TABS: readonly SidePaneTabDefinition[] = [
  {
    id: 'browser',
    label: 'Browser',
    shortLabel: 'Web',
    closeLabel: 'Close browser',
    icon: Globe2,
    order: 80,
    retain: true,
    instanceKind: 'browser',
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

// ---- instance bodies (the wave-2 seam, extended) -----------------------------
//
// `registerSidePaneTab` covers singleton tabs; an instance KIND registers one
// body for every tab of that kind. SidePane renders file and browser instances
// through its own switch (they need FilesTab/UnifiedBrowserSurface plumbing);
// the terminals deck — or any wave-2 surface — claims its kind from its own
// module scope, exactly like `registerSidePaneTab`.

export type SidePaneInstanceBody = (props: SidePaneTabRenderProps) => ReactNode;

const instanceBodies = new Map<SidePaneInstanceKind, SidePaneInstanceBody>();

/** Register (or replace) the body for one instance kind. Returns the
 *  unregister function; a stale unregister cannot tear down a replacement. */
export function registerSidePaneInstanceBody(kind: SidePaneInstanceKind, render: SidePaneInstanceBody): () => void {
  instanceBodies.set(kind, render);
  bumpRegistry();
  return () => {
    if (instanceBodies.get(kind) !== render) return;
    instanceBodies.delete(kind);
    bumpRegistry();
  };
}

export function getSidePaneInstanceBody(kind: SidePaneInstanceKind): SidePaneInstanceBody | undefined {
  return instanceBodies.get(kind);
}

// ---- per-session state -----------------------------------------------------

export interface SidePaneTabsState {
  /** The session's strip. Kept in strip order at every write. */
  open: readonly SidePaneTabId[];
  /** The showing tab; null means the pane is closed (the strip survives). */
  active: SidePaneTabId | null;
  /** LEGACY singleton browser payload — the back-compat seam for callers of
   *  the historical snapshot shape. Live browser pages each carry their own
   *  destination in `instances`. */
  browser: BrowserDestination | null;
  /** Open instance tabs by id. Everything in here is also in `open`. */
  instances: Readonly<Record<SidePaneTabId, SidePaneTabInstance>>;
}

const NO_INSTANCES: Readonly<Record<SidePaneTabId, SidePaneTabInstance>> = Object.freeze({});

const sessionTabStates = new Map<string, SidePaneTabsState>();
let stateVersion = 0;
const stateListeners = new Set<() => void>();
let defaultOpenCache: SidePaneTabsState | null = null;
/** Monotonic insertion counter for instance ordering and page ids. */
let instanceSequence = 0;

function defaultState(): SidePaneTabsState {
  defaultOpenCache ??= {
    open: getSidePaneTabDefinitions()
      .filter(def => def.defaultOpen)
      .map(def => def.id),
    active: null,
    browser: null,
    instances: NO_INSTANCES,
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

export function readSidePaneTabInstance(sessionId: string, id: SidePaneTabId): SidePaneTabInstance | undefined {
  return readSidePaneTabsState(sessionId).instances[id];
}

/** Resolve any open tab id to a renderable definition: registry entries come
 *  back as registered; an instance id synthesizes its definition from the
 *  instance (label = full path/URL, shortLabel = basename/host). An unknown
 *  id resolves to nothing — absence must not invent a tab. */
export function resolveSidePaneTab(sessionId: string, id: SidePaneTabId): SidePaneTabDefinition | undefined {
  const registered = registry.get(id);
  if (registered) return registered;
  const instance = readSidePaneTabsState(sessionId).instances[id];
  if (!instance) return undefined;
  return {
    id,
    label: instance.title,
    shortLabel: instance.label,
    closeLabel: `Close ${instance.label}`,
    icon: INSTANCE_KIND_ICON[instance.kind],
    order: INSTANCE_KIND_ORDER[instance.kind] + instance.order,
    retain: INSTANCE_KIND_RETAIN[instance.kind],
    instance,
  };
}

type StripSortKey = readonly [number, number, string];

function stripSortKey(
  id: SidePaneTabId,
  instances: Readonly<Record<SidePaneTabId, SidePaneTabInstance>>,
): StripSortKey {
  const def = registry.get(id);
  if (def) return [def.order, 0, def.label];
  const instance = instances[id];
  if (instance) return [INSTANCE_KIND_ORDER[instance.kind], instance.order, instance.label];
  // Unknown tabs sort last and render nowhere — an unknown tab must not
  // invent a position.
  return [Number.MAX_SAFE_INTEGER, 0, id];
}

/** Sort open-tab ids into strip order: utility tabs by registry order, then
 *  instance tabs grouped files → pages → terminals in opening order. */
export function sortSidePaneTabs(
  ids: readonly SidePaneTabId[],
  instances: Readonly<Record<SidePaneTabId, SidePaneTabInstance>> = NO_INSTANCES,
): readonly SidePaneTabId[] {
  return [...ids].sort((a, b) => {
    const ka = stripSortKey(a, instances);
    const kb = stripSortKey(b, instances);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]) || a.localeCompare(b);
  });
}

function write(sessionId: string, next: SidePaneTabsState): void {
  sessionTabStates.set(sessionId, next);
  notifyState();
}

/** Low-level whole-state write — the back-compat seam and test seam. */
export function writeSidePaneTabsState(sessionId: string, next: SidePaneTabsState): void {
  const instances = next.instances ?? NO_INSTANCES;
  write(sessionId, { ...next, instances, open: sortSidePaneTabs(next.open, instances) });
}

/** Add a tab to the strip if absent and make it active. The single open path:
 *  the + picker, header toggles, transcript links and reference deliveries all
 *  land here, so opening a non-default surface always materialises its tab.
 *  A catalogue entry that spawns instances (`instanceKind`) redirects: it
 *  focuses the most recent instance of that kind, or creates a fresh one, so
 *  its singleton id never enters the strip. */
export function openSidePaneTab(sessionId: string, id: SidePaneTabId): void {
  const definition = registry.get(id);
  if (definition?.instanceKind === 'browser') {
    openSidePaneBrowserTab(sessionId, null);
    return;
  }
  const current = readSidePaneTabsState(sessionId);
  const open = current.open.includes(id) ? current.open : sortSidePaneTabs([...current.open, id], current.instances);
  if (open === current.open && current.active === id) return;
  write(sessionId, { ...current, open, active: id });
}

function openInstance(sessionId: string, instance: SidePaneTabInstance): void {
  const current = readSidePaneTabsState(sessionId);
  const instances = { ...current.instances, [instance.id]: instance };
  const open = current.open.includes(instance.id)
    ? current.open
    : sortSidePaneTabs([...current.open, instance.id], instances);
  write(sessionId, { ...current, open, instances, active: instance.id });
}

/** ONE TAB PER FILE. Opening a path already in the strip focuses its existing
 *  tab (updating the delivered line selection) instead of duplicating it. */
export function openSidePaneFileTab(sessionId: string, path: string, selection?: SidePaneFileSelection): SidePaneTabId {
  const id = sidePaneInstanceTabId('file', path);
  const existing = readSidePaneTabsState(sessionId).instances[id];
  const basename = path.split('/').filter(Boolean).pop() ?? path;
  openInstance(sessionId, {
    id,
    kind: 'file',
    key: path,
    label: basename,
    title: path,
    order: existing?.order ?? ++instanceSequence,
    ...(selection ? { selection } : {}),
    revision: (existing?.revision ?? 0) + 1,
  });
  return id;
}

function browserTabLabel(destination: BrowserDestination | null): { label: string; title: string } {
  if (!destination) return { label: 'New page', title: 'New browser page' };
  try {
    return { label: new URL(destination.href).host || destination.href, title: destination.href };
  } catch {
    return { label: destination.href, title: destination.href };
  }
}

/** ONE TAB PER BROWSER PAGE. A destination that is already open in some page
 *  focuses that page; otherwise a new page tab is created. `forceNew` (the +
 *  picker) always creates a fresh page. With no destination, the most recent
 *  page is focused when one exists — the reader asked for "the browser", and
 *  a pile of blank pages is not what they meant. */
export function openSidePaneBrowserTab(
  sessionId: string,
  destination: BrowserDestination | null = null,
  options: { forceNew?: boolean } = {},
): SidePaneTabId {
  const current = readSidePaneTabsState(sessionId);
  const pages = Object.values(current.instances).filter(instance => instance.kind === 'browser');
  if (!options.forceNew) {
    const match = destination
      ? pages.find(page => page.destination?.href === destination.href)
      : pages.sort((a, b) => b.order - a.order)[0];
    if (match) {
      openInstance(sessionId, destination ? { ...match, revision: match.revision + 1 } : match);
      return match.id;
    }
  }
  const key = `page-${++instanceSequence}`;
  const id = sidePaneInstanceTabId('browser', key);
  openInstance(sessionId, {
    id,
    kind: 'browser',
    key,
    ...browserTabLabel(destination),
    order: instanceSequence,
    destination,
    revision: 1,
  });
  return id;
}

/** ONE TAB PER TERMINAL. The terminals deck (or any launcher) hands each
 *  terminal its own tab; re-opening an id focuses the existing tab. */
export function openSidePaneTerminalTab(sessionId: string, terminalId: string, label?: string): SidePaneTabId {
  const id = sidePaneInstanceTabId('terminal', terminalId);
  const existing = readSidePaneTabsState(sessionId).instances[id];
  openInstance(sessionId, {
    id,
    kind: 'terminal',
    key: terminalId,
    label: label ?? existing?.label ?? terminalId,
    title: label ?? existing?.title ?? terminalId,
    order: existing?.order ?? ++instanceSequence,
    revision: (existing?.revision ?? 0) + 1,
  });
  return id;
}

/** Retitle a live instance tab (a browser page navigated, a terminal was
 *  renamed) without touching focus or strip membership. */
export function setSidePaneInstanceLabel(
  sessionId: string,
  id: SidePaneTabId,
  next: { label: string; title?: string; destination?: BrowserDestination | null },
): void {
  const current = readSidePaneTabsState(sessionId);
  const instance = current.instances[id];
  if (!instance) return;
  write(sessionId, {
    ...current,
    instances: {
      ...current.instances,
      [id]: {
        ...instance,
        label: next.label,
        title: next.title ?? instance.title,
        ...(next.destination !== undefined ? { destination: next.destination } : {}),
        revision: instance.revision + 1,
      },
    },
  });
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

// Closing an instance tab DISPOSES that instance; whoever owns its live
// backing (the terminals deck killing a pty) subscribes here.
export type SidePaneInstanceCloseListener = (sessionId: string, instance: SidePaneTabInstance) => void;
const instanceCloseListeners = new Set<SidePaneInstanceCloseListener>();

export function subscribeSidePaneInstanceClose(listener: SidePaneInstanceCloseListener): () => void {
  instanceCloseListeners.add(listener);
  return () => instanceCloseListeners.delete(listener);
}

/** Take a tab out of the strip (picker toggle-off, or an instance tab's ✕).
 *  Removing the active tab activates its nearest strip neighbour — the
 *  following tab when one exists, else the preceding one — and removing the
 *  last tab closes the pane.
 *  A SINGLETON removal never unmounts a retained surface: hiding the
 *  terminals deck must not drop scrollback, exactly as switching away does
 *  not. An INSTANCE removal is a real close — the instance is disposed, its
 *  close listeners run, and no phantom tab survives it. */
export function removeSidePaneTab(sessionId: string, id: SidePaneTabId): void {
  const current = readSidePaneTabsState(sessionId);
  const index = current.open.indexOf(id);
  if (index === -1) return;
  const open = current.open.filter(tab => tab !== id);
  const active = current.active === id ? (open[index] ?? open[index - 1] ?? null) : current.active;
  const closed = current.instances[id];
  let instances = current.instances;
  if (closed) {
    const next = { ...current.instances };
    delete next[id];
    instances = next;
  }
  write(sessionId, { ...current, open, active, instances });
  if (closed) for (const listener of instanceCloseListeners) listener(sessionId, closed);
}

/** LEGACY browser payload write; live pages carry their own destination. */
export function setSidePaneBrowserDestination(sessionId: string, browser: BrowserDestination | null): void {
  const current = readSidePaneTabsState(sessionId);
  write(sessionId, { ...current, browser });
}

/** Test seam — the memory is module state, so tests must start from nothing. */
export function resetSidePaneTabsStates(): void {
  sessionTabStates.clear();
  notifyState();
}
