# Unified side pane tabs — design (board F146, per-instance rework)

## Goal

The side pane strip is IDE-shaped. Two kinds of tab:

1. **Utility tabs** — singletons, the defaults, toggled via the + picker:
   **pins, tasks, skills, tree (lineage), mcp, needs (attention), cost
   (analytics)**. Unchanged from wave 1.
2. **Instance tabs** — **one tab per open file, one per open browser page,
   one per terminal**. Open `api.ts` and `README.md` and you get TWO file
   tabs, each showing its own file, each closable independently. Two pages =
   two browser tabs, each with its own page state.

```
[Pins][Tasks][Skills][Tree][MCP][Needs][Cost][api.ts][README.md][github.com][term 1][+]
```

This corrects wave 1, which shipped `browser` and `files` as singletons (one
shared Browser tab, one shared Files tab). The human's ruling, verbatim:
_"i meant to add a single browser tab and a single file tab! for that
feature! …and the answer is 1 tab per file!"_

On mobile the tabs are NEVER a horizontal strip — a tab control opens a modal
to switch, exactly as before, now listing instance tabs with their labels and
per-tab close.

## One model, one file

`ui/src/lib/side-pane-tab-model.ts` owns tab identity and per-session state.
Module-level external stores (subscribe + versioned snapshot) read through
`useSyncExternalStore`, so an evicted-then-revisited session comes back to the
tabs it had.

### Instance identity

```ts
type SidePaneInstanceKind = 'file' | 'browser' | 'terminal';

interface SidePaneTabInstance {
  id: SidePaneTabId; // `${kind}:${key}` — file:src/api.ts, browser:page-7, terminal:t1
  kind: SidePaneInstanceKind;
  key: string; // file path | page id | terminal id
  label: string; // SHORT strip label: basename / page host or title / terminal name
  title: string; // FULL path or URL — the hover title and accessible name
  order: number; // insertion counter; kinds group files → pages → terminals
  destination?: BrowserDestination | null; // browser pages carry their own page state
  selection?: SidePaneFileSelection; // file tabs carry a delivered line range
  revision: number; // bumps on re-delivery, so "same tab, new line range" is observable
}
```

Ids carry the instance (`file:<path>`, `browser:<pageId>`, `terminal:<id>`);
utility tabs keep their plain singleton ids. `parseSidePaneInstanceTabId`
recognises exactly the three kinds — a wave-2 singleton id containing a colon
is not misread as an instance.

### The open calls — one path per kind

- `openSidePaneFileTab(sessionId, path, selection?)` — **one tab per file.**
  Opening a path already in the strip FOCUSES the existing tab (and updates
  its selection + revision); it never duplicates. Labels: basename in the
  strip, full path on hover. EVERY entry point that opens a file routes here:
  transcript file links and code references land via the host's
  `openCodeReference` (SidePane.tsx), and the files tree's row-open is a
  one-line integration through the same host callback.
- `openSidePaneBrowserTab(sessionId, destination?, {forceNew?})` — **one tab
  per page.** A destination already open in some page focuses that page;
  otherwise a new page tab with its own state. `forceNew` (the + picker's
  "New Browser tab") always creates a fresh empty page. With no destination,
  the most recent page is focused when one exists. Labels: page host (or
  "New page"), full URL on hover; `setSidePaneInstanceLabel` retitles on
  navigation.
- `openSidePaneTerminalTab(sessionId, terminalId, label?)` — **one tab per
  terminal**, same focus-not-duplicate contract. The terminals deck stays the
  working singleton until its owner lands the one-line calls (see
  Integration).

Closing an instance tab (`removeSidePaneTab` on an instance id) DISPOSES only
that instance: it leaves `open` and the `instances` map, its retained body
unmounts, and `subscribeSidePaneInstanceClose` listeners fire (the deck kills
its pty there). Closing the last file tab leaves NO phantom "Files"/"Browser"
tab — the strip simply shrinks to what is actually open, with the nearest
neighbour activated. Singleton removal keeps wave-1 semantics (a hidden
retained deck keeps its scrollback).

### Legacy singletons and the + picker

- The `browser` registry entry is now a CATALOGUE entry (`instanceKind:
'browser'`): its id never enters the strip. `openSidePaneTab(sessionId,
'browser')` — the bento launcher, old header toggles — redirects to
  focus-or-create a page instance. In the + picker it renders as an ACTION
  ("New Browser tab", "Opens a new tab"), never a pressed toggle, and always
  creates a fresh page (requirement: + adds a NEW instance).
- The `files` entry stays a singleton: it is the file PICKER — the directory
  tree. Files opened FROM it become per-file instance tabs. It is a tab only
  when the reader explicitly adds it; no file open ever materialises it.
- The `terminals` entry stays the deck singleton until integration; the model
  already speaks `terminal:<id>`.
- `SidePaneTabsState.browser` (the wave-1 singleton payload) survives as the
  back-compat seam for the historical `readSidePaneState` snapshot; live
  pages each carry their own `destination`.

### Rendering instance tabs

`resolveSidePaneTab(sessionId, id)` resolves registry entries as registered
and SYNTHESIZES a definition for an open instance (label = full path/URL,
shortLabel = basename/host, `closeLabel`, kind icon, kind-grouped strip
order, `retain` for browser/terminal, the instance attached). An id that is
neither registered nor a live instance resolves to nothing — an unknown tab
must not invent a position, and its body (if somehow active) says so.

Bodies:

- **file** — `FileInstanceSurface` in SidePane.tsx: fetches through the same
  daemon endpoint as the Files tree (`fsApi.file`), renders through the files
  surface's own exported `FileBody` (Markdown as prose, highlighting, the
  daemon's refusal verdicts), honours the delivered line range and scrolls it
  into view once per delivery (`revision`). Loading and failure render as
  themselves, with retry — never as an empty file.
- **browser** — one `UnifiedBrowserSurface` per page tab, each mounted (and
  retained) separately with its own destination, engine choice and history.
- **terminal** — `registerSidePaneInstanceBody('terminal', render)`: the
  wave-2 seam EXTENDED, not forked. `registerSidePaneTab` still covers
  singleton tabs exactly as wave 2 builds against it; an instance KIND
  registers one body for all its tabs, from its owner's module scope. Until
  the deck registers, a terminal tab renders the honest "no terminal body is
  registered" placeholder (and nothing in-tree opens one yet).

Retention: browser pages and terminals retain per instance (hidden, mounted,
desktop only); files remount per open — a fetch is cheap, and remount is what
keeps transient state honest. A retained id must still RESOLVE to stay
mounted: closing a page disposes it, it is not parked invisibly forever.

## SidePaneTabs.tsx — two presentations, never a mobile strip

- **Desktop (`pane`)**: the WAI-ARIA tablist of open tabs (roving tabindex,
  wrap-around arrows, Home/End) + the sibling + picker. THE STRIP IS EXACTLY
  ONE ROW: `overflow-x-auto overflow-y-hidden` — `overflow-x: auto` alone
  computes `overflow-y` as auto and grows the phantom vertical scrollbar the
  human flagged (2026-07-29 screenshot); the + button stays pinned at the
  end outside the scroller. Instance tabs render icon + basename/host
  (`max-w-[148px]`, truncated, full path/URL as hover title and accessible
  name) plus a close affordance: a pointer ✕ (presentation span — a nested
  button is invalid inside `role=tab`) and the **Delete key**
  (`aria-keyshortcuts="Delete"`). Singleton tabs are untouched.
- **Mobile (`sheet`, 390px)**: NO tablist, ever. The single 44px tab control
  names the active tab (instance tabs by short label) and opens the
  focus-trapped switcher modal (shared BottomSheet, z-[80]): every open tab
  with the current one marked and PER-TAB close — "Close api.ts tab" for
  instances, "Remove X tab" for singletons — then the "Add a tab" catalogue.
  An `instanceKind` entry stays offered even while pages are open ("one
  more"), and reads "New Browser tab".
- `sidePaneTabId`/`sidePanePanelId`/`nextSidePaneTab` keep their exports and
  the keyboard policy is unchanged.

## SidePane.tsx changes

- `openCodeReference` → `openSidePaneFileTab(sessionId, reference.path,
selection)`. The request-channel plumbing (`requestedCodeReference`,
  sequence ref) is gone: the line range rides ON the instance, revisioned by
  the model. Task/attention/pin deliveries are untouched.
- `openDestination` (transcript links via InAppBrowserContext) →
  `openSidePaneBrowserTab(sessionId, destination)`; the legacy singleton
  payload is still written for historical snapshot readers.
- `SurfaceBody` routes instance tabs first (file/browser built-in bodies,
  terminal via the registered kind body), then the wave-1 singleton switch,
  then registered wave-2 renders, then the explicit unknown placeholder.
- Announcements name the instance's short label; browser announcements append
  the page's own URL, not a shared payload.
- Focus rules (never steal on open, restore opener on close), the non-modal
  desktop pane, the mobile BottomSheet, resize, and the bento launcher are
  unchanged.

## Integration lines OUTSIDE this ownership (for the lead)

1. **Files tree (turner, FilesTab.tsx)** — in the tree's row-open path, call
   the host instead of appending an internal tab:
   `onCodeReferenceOpen?.({ path })` (the prop FilesTab already receives).
   Its internal `OpenFileTabs` strip can then retire.
2. **Terminals deck (WebTerminals.tsx)** — on terminal create/select:
   `openSidePaneTerminalTab(sessionId, term.id, term.title)`; subscribe
   `subscribeSidePaneInstanceClose` to kill the pty when a terminal tab is
   closed; register the per-terminal body with
   `registerSidePaneInstanceBody('terminal', …)`.
3. **Browser HUD (detrick)** — on navigation/title change:
   `setSidePaneInstanceLabel(sessionId, tabId, { label: title || host,
title: url, destination })`.

## Testing

- Model: one-tab-per-file focus-not-duplicate; selection re-delivery bumps
  revision; per-page tabs with same-href focus and `forceNew`; the legacy
  `browser` redirect; kind grouping and insertion order; instance disposal +
  close listeners; no-phantom-tab on last close; synthesized definitions;
  label derivation (basename/host, full title); id parsing; instance-body
  registration. Wave-1 suites (defaults, singleton removal, registry seam)
  unchanged and passing.
- SidePaneTabs: strip one-row overflow contract; instance tab label/title/✕/
  Delete markup; picker "New …" action rows; switcher modal instance rows.
- SidePane: two files = two tabs with no phantom Files tab; per-page
  announcement with the page's own URL; source contract that references and
  destinations route through the instance calls.
