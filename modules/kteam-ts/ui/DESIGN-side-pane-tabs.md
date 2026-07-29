# Unified side pane tabs — design (board F146, wave 1)

## Goal

Every session-scoped surface (web, files, tasks, terminals, pins, skills,
tree/lineage, mcp, needs/attention, cost/analytics) becomes ONE tab system in
the side pane. A **+ button** opens a picker to choose what is visible.
Default tabs: **pins, tasks, skills, tree, mcp, needs, cost**. On mobile the
tabs are NEVER a horizontal strip — a tab control opens a modal to switch.

## One model, one new file

`ui/src/lib/side-pane-tab-model.ts` owns BOTH halves of tab identity:

1. **The tab registry** — which tabs exist at all.
2. **The per-session tab state** — which tabs are open in a session's strip,
   and which one is active.

Both are module-level external stores (subscribe + versioned snapshot), read
by React through `useSyncExternalStore`. Module state, not React state, for
the same reason the old `sessionPanes` map was: retained session panes are
created and destroyed by the App-level LRU, and an evicted-then-revisited
session must come back to the tabs it had.

### Tab identity

```ts
type SidePaneTabId = string; // built-ins use the SidePaneSurface literals

interface SidePaneTabDefinition {
  id: SidePaneTabId;
  label: string; // full accessible name ("Lineage")
  shortLabel: string; // compact strip name ("Tree")
  closeLabel: string; // sheet dismiss label
  icon: LucideIcon;
  /** Strip position; open tabs render sorted by this, then by label. */
  order: number;
  /** Member of the default strip for every new session. */
  defaultOpen?: boolean;
  /** Honest capability gate: tab renders an explicit placeholder body. */
  unavailableReason?: string;
  /** Once opened, stays mounted (hidden) on desktop — live sockets etc. */
  retain?: boolean;
  /** Wave-2 seam: body for tabs registered OUTSIDE SidePane.tsx. Built-in
   *  surfaces omit it (SidePane renders them via its own switch, which needs
   *  bespoke delivery props the generic contract must not grow). */
  render?: (props: SidePaneTabRenderProps) => ReactNode;
}
```

The ten built-in surfaces are declared IN the model file (single source of
truth, no import cycle); `SIDE_PANE_SURFACES` in SidePane.tsx is re-derived
from them so every existing consumer (bento launcher, LineageSurface.test)
keeps its import unchanged.

**Registration surface (wave 2):** `registerSidePaneTab(def)` → unregister
fn; `getSidePaneTabDefinition(s)`, `subscribeSidePaneTabRegistry`. A wave-2
module (browser HUD, files bar, skills groups, shared search) registers from
its own module scope — every current surface module is already imported by
SidePane.tsx, so registration executes without touching wave-1 files. Late
registration is live: the registry is versioned and the strip re-renders.
Duplicate ids replace (last registration wins) so hot reload cannot dupe.

### Per-session state

```ts
interface SidePaneTabsState {
  open: readonly SidePaneTabId[]; // the strip, unordered set semantics
  active: SidePaneTabId | null; // null = pane closed
  browser: BrowserDestination | null; // browser payload rides along, as before
}
```

Defaults for a fresh session: `open` = the `defaultOpen` definitions —
**pins, tasks, skills, lineage (Tree), mcp, attention (Needs), analytics
(Cost)** — `active: null`.

Actions (all `(sessionId, …)`, all bump one global version so any workspace
or wave-2 listener can subscribe):

- `openSidePaneTab(id)` — add to `open` if absent, set active. This is the
  ONE path used by the + picker, header toggles, transcript links,
  `openTask`/`openCodeReference`/`openAttention`/`openPin` — so a programmatic
  open of a non-default surface (files, browser, terminals) adds its tab.
- `activateSidePaneTab(id)` — switch among open tabs.
- `deactivateSidePane()` — close the pane; the open set survives.
- `removeSidePaneTab(id)` — take a tab out of the strip (picker toggle-off).
  If it was active, activate its nearest open neighbour (or close the pane
  when it was the last tab). Any tab, including defaults, may be removed —
  "we can select what we want to see". Removal does NOT unmount a retained
  surface (terminals scrollback / browser profile survive being hidden;
  deliberate, same retention rules as switching away).
- `setSidePaneBrowserDestination(dest)` — browser payload write.

State is per-session and in-memory (module map), exactly the scope the old
snapshot had. Persisting the chosen tab set as a durable preference is a
possible follow-up, not in this wave.

**Back-compat seam:** `readSidePaneState` / `writeSidePaneState` /
`resetSidePaneStates` and the `SidePaneSnapshot {surface, browser}` shape stay
exported from SidePane.tsx as thin views over the model (`surface` ≡
`active`), so existing tests and any external caller keep working.

## SidePaneTabs.tsx — two presentations, never a mobile strip

- **Desktop (`presentation: 'pane'`)**: a real WAI-ARIA tablist of the OPEN
  tabs (roving tabindex, wrap-around arrows, Home/End — unchanged policy),
  followed by a sibling **+ button** (`aria-haspopup="dialog"`, label "Add or
  remove tabs") that opens an anchored non-modal picker popover (same
  pointer-down-outside + Escape dismissal as the launcher popover).
- **Mobile (`presentation: 'sheet'`)**: NO tablist at all. One **tab
  control** — a 44px button row showing the active tab's icon + label with an
  explicit "Switch tab" affordance — opens a **modal** (the shared
  focus-trapped BottomSheet, z-[80] above the surface sheet at z-[70]).
  The modal lists every OPEN tab (tap → activate + dismiss, current one marked
  `aria-current`) and, under a separator, the not-yet-open definitions ("Add a
  tab": tap → open + activate + dismiss) plus per-row remove toggles for open
  ones. So the one modal is both the switcher the requirement names and the
  mobile home of the + picker.
- **Picker rows** for unavailable tabs (mcp) stay ENABLED as tabs — the human
  named mcp a default tab; its body is the honest "no data source" placeholder
  (rule: absence renders as unknown, and a tab that exists but has no data is
  exactly that). The top-bar bento launcher keeps its old disabled treatment —
  it opens data sources, the strip shows chosen tabs.
- `sidePaneTabId` / `sidePanePanelId` / `nextSidePaneTab` keep their exports.
  `role=tabpanel` + `aria-labelledby` wiring is desktop-only; the mobile body
  is a plain region inside the sheet dialog (there is no tab element to label
  it, and the sheet itself is labelled by the surface title).

## SidePane.tsx changes

- Workspace reads `{open, active, browser}` from the model with
  `useSyncExternalStore` (snapshot identity is cached per session, version
  bumps on write). `host.open/close/toggle` map to model actions; delivery
  requests (task/code-ref/attention/pin sequences) stay exactly as they are.
- `SurfaceBody` keeps its bespoke switch for the ten built-ins; an active tab
  that is NOT a built-in renders its registered `render(props)`, and an id
  with no registration renders an explicit unknown-tab placeholder (never a
  confident default).
- Retention (`RETAINED_SURFACES`, everRetained, hidden-shell) is unchanged.
- Bento launcher, announcements, focus rules (never steal on open, restore
  opener on close), non-modal desktop pane, mobile BottomSheet: unchanged.

## Testing

- Model: defaults seed the human's seven tabs; open/activate/remove/neighbour
  policies; per-session isolation; registry register/replace/unregister and
  version bumps; back-compat snapshot views.
- SidePaneTabs: desktop markup (tablist, + button present, roving tabindex,
  no autofocus); mobile markup (NO role=tablist, no overflow-x strip, tab
  control advertises the modal); keyboard policy fn unchanged.
- SidePane.test.tsx updated where markup counts changed (compact sheet no
  longer renders 9 tabs; desktop strip shows the open set) — flagged to the
  lead: that file was pre-existing and is touched only to keep its contract
  assertions true.
