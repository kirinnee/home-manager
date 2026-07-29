// THE COMMAND PALETTE — Cmd/Ctrl+K, one dialog, mounted once for the app's life.
//
// Destinations, sessions and Settings share this one search surface. Settings
// metadata comes from lib/settings.ts, the same catalog the Settings UI maps, so
// searchable controls cannot drift from the page that owns them; destinations
// come from the top bar's own `APP_BAR_DESTINATIONS` through
// lib/palette-destinations.ts, for exactly the same reason — and every one of
// them is route-guarded there, so nothing is offered that the router would
// quietly resolve to somewhere else.
//
// On a phone this dialog is the primary navigation surface: the bar has one
// icon-sized opener, the session route hides the bar entirely, and a pull-down
// on the dashboard scroller opens this (hooks/usePullToPalette.ts).
//
// Four things this file is careful about:
//
//   CASING       — matching runs on RAW lowercase fields (lib/fuzzy.ts owns the
//                  scoring), rendering runs through `displayCallsign()`. The two
//                  must never be the same string; see lib/callsign.ts.
//   FOCUS        — `useDialogFocus` is the ONLY focus trap in this app and this
//                  file does not add a second one. It also owns restore-to-
//                  opener, which is what returns you to the composer you were
//                  typing in when you hit Escape.
//   COMBOBOX     — the input keeps focus the whole time and points at the active
//                  row with `aria-activedescendant`, rather than moving focus
//                  row to row (roving tabindex). Typing and arrowing interleave
//                  constantly here; focus that keeps jumping out of the input is
//                  the pattern that breaks IMEs and screen-reader typing echo.
//   COST WHEN    — closed, this renders `null` and does not subscribe to the
//   CLOSED         fleet store, so a globally-mounted palette costs the
//                  dashboard and the transcript exactly nothing.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Compass, CornerDownLeft, KeyRound, Plus, Search, Settings } from 'lucide-react';
import type { SessionView } from '../types';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { baseName, groupByProject } from '../lib/grouping';
import { displayCallsign } from '../lib/callsign';
import { shortSessionId } from '../lib/lineage';
import { MAX_SESSION_RESULTS, rankSessions, recentSessions, type SessionEntry } from '../lib/fuzzy';
import { TERMINAL_STATUSES } from '../lib/utils';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useDebouncedEffect } from '../hooks/useDebounce';
import { StatusMark, statusMark } from './StatusMark';
import { TaskName, parseTaskName } from './TaskName';
import { useLayoutMode } from '../hooks/useLayoutMode';
import { settingsHref, settingsPaletteEntries, type SettingsPaletteEntry } from '../lib/settings';
import { useInputModality } from '../hooks/useInputModality';
import { useSttSettings } from '../lib/stt/stt-settings';
import { dictationShortcutLabel } from '../lib/stt/dictation-shortcut';
import { actOnBrowserLogin } from '../lib/browser-login';
// THE BAR'S OWN LIST, not a copy of it — every top-bar destination is searchable
// here by construction, and one added there needs no edit in this file.
//
// This import closes a cycle (AppBar imports the shortcut label and keyshortcut
// string from here). It is safe ONLY because neither side touches the other at
// module scope: `APP_BAR_DESTINATIONS` is read inside `paletteDestinations`,
// which runs during render. Do not hoist it into a module-level constant.
import { APP_BAR_DESTINATIONS } from './AppBar';
import { destinationPaletteEntries, type DestinationPaletteEntry } from '../lib/palette-destinations';

/** Stable element ids. The palette is a SINGLETON (App mounts exactly one), so
 *  these are constants rather than `useId()` values — an option id that changed
 *  identity between renders would break `aria-activedescendant` for exactly the
 *  readers who depend on it. */
const PANEL_ID = 'kt-palette';
const INPUT_ID = 'kt-palette-input';
const LISTBOX_ID = 'kt-palette-listbox';
const COMMANDS_HEADING_ID = 'kt-palette-group-commands';
const DESTINATIONS_HEADING_ID = 'kt-palette-group-destinations';
const SETTINGS_HEADING_ID = 'kt-palette-group-settings';
const SESSIONS_HEADING_ID = 'kt-palette-group-sessions';
const commandOptionId = (id: string) => `kt-palette-option-command-${id}`;
const destinationOptionId = (id: string) => `kt-palette-option-${id}`;
const sessionOptionId = (sessionId: string) => `kt-palette-option-session-${sessionId}`;
const settingsOptionId = (id: string) => `kt-palette-option-${id}`;

/** Deliberately slower than the keystroke that changes the result set: a fast
 *  typist should hear one settled count, not a stream of intermediate ones.
 *  Same rationale (and same number) as the chat page's status region. */
const ANNOUNCE_DEBOUNCE_MS = 300;

/** True on Apple platforms, where the shortcut is ⌘K rather than Ctrl K. Reads
 *  the modern hint first and falls back to the deprecated `platform` string,
 *  because getting this wrong prints a key the reader does not have. */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const hint = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /mac|iphone|ipad|ipod/i.test(hint || navigator.platform || navigator.userAgent || '');
}

/** What the discoverability hint prints. Exported so the AppBar renders the same
 *  string this dialog answers to. */
export function paletteShortcutLabel(): string {
  return isApplePlatform() ? '⌘K' : 'Ctrl K';
}

/** The `aria-keyshortcuts` value, per the spec's key names. Both are live, on
 *  every platform, so both are declared. */
export const PALETTE_KEYSHORTCUTS = 'Meta+K Control+K';

/** A ranked session plus the two rendered facts the ranker does not own. */
interface PaletteSession extends SessionEntry {
  view: SessionView;
  /** The project group's display name, without the cwd the matcher also sees. */
  folderName: string;
}

const BROWSER_LOGIN_COMMAND = {
  id: 'browser-login',
  label: 'Open browser login window',
  description: 'Sign in to shared Chrome through the private browser-login window',
  searchTerms: 'browser login sign in shared chrome',
} as const;

type PaletteCommand = typeof BROWSER_LOGIN_COMMAND;
type PaletteResult =
  | { kind: 'command'; entry: PaletteCommand }
  | { kind: 'destination'; entry: DestinationPaletteEntry }
  | { kind: 'settings'; entry: SettingsPaletteEntry }
  | { kind: 'session'; entry: PaletteSession };

function paletteResultId(result: PaletteResult): string {
  switch (result.kind) {
    case 'command':
      return commandOptionId(result.entry.id);
    case 'destination':
      return destinationOptionId(result.entry.id);
    case 'settings':
      return settingsOptionId(result.entry.id);
    default:
      return sessionOptionId(result.entry.id);
  }
}

/** The searchable destinations, read from the top bar's own list. `taken` is
 *  every href the Settings group is ALREADY offering, so "settings" cannot
 *  return two rows that go to the same page. Exported so the destination
 *  coverage — and the route guard behind it — is assertable directly. */
export function paletteDestinations(query: string, taken: readonly string[] = []): DestinationPaletteEntry[] {
  return destinationPaletteEntries(query, APP_BAR_DESTINATIONS, { taken });
}

/** Where the Settings group is already sending people. A section row lands on
 *  its own anchor (`/settings#density`), which is a different destination from
 *  the page itself and does not suppress it. */
export function settingsDestinationHrefs(entries: readonly SettingsPaletteEntry[]): string[] {
  return entries.map(entry => entry.href ?? settingsHref(entry.settingId));
}

/** Icons come from the bar for its own destinations, so the same page is not
 *  drawn with two different marks in two places. */
function destinationIcon(id: string) {
  const barIcon = APP_BAR_DESTINATIONS.find(destination => `destination-${destination.id}` === id)?.Icon;
  if (barIcon) return barIcon;
  return id === 'destination-new-session' ? Plus : Compass;
}

export function matchesBrowserLoginCommand(query: string): boolean {
  const terms = query.trim().toLowerCase();
  return !terms || BROWSER_LOGIN_COMMAND.searchTerms.includes(terms);
}

/** Fleet state, subscribed to ONLY while the palette is open.
 *
 *  Same shape as SessionDetails' `useOpenFleet` and for the same reason: this
 *  component is mounted for the app's life, and a plain `useFleet()` would
 *  re-render it on every terminal frame of every session in the fleet, forever,
 *  to render nothing. */
function useOpenFleet(open: boolean) {
  const store = useStore();
  const subscribe = useCallback(
    (notify: () => void) => (open ? store.subscribe(notify) : () => undefined),
    [open, store],
  );
  return useSyncExternalStore(subscribe, store.getFleet, store.getFleet);
}

function countLabel(n: number): string {
  if (n === 0) return 'No results';
  return `${n} result${n === 1 ? '' : 's'}`;
}

export function paletteFocusPolicy(touchAffected: boolean): {
  dialogAutoFocus: boolean;
  inputAutoFocus: boolean;
} {
  return { dialogAutoFocus: touchAffected, inputAutoFocus: !touchAffected };
}

export function CommandPalette({
  open,
  /** Bumped every time the shortcut fires. Pressing ⌘K while the palette is
   *  already open must put you back in the query box (and select what is there)
   *  rather than doing nothing — a re-press is a reader saying "I meant this". */
  focusSignal,
  onClose,
}: {
  open: boolean;
  focusSignal: number;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const store = useStore();
  const layout = useLayoutMode();
  const { touchAffected } = useInputModality();
  const { settings: sttSettings } = useSttSettings();

  // Modality is latched for one opening so a convertible changing pointer mode
  // cannot re-run the dialog focus effect or summon a keyboard mid-use.
  const latchedTouch = useRef(touchAffected);
  if (!open) latchedTouch.current = touchAffected;
  const focusPolicy = paletteFocusPolicy(latchedTouch.current);

  // Escape, the Tab trap and restore-to-opener. `autoFocus: false` because the
  // container is not where focus belongs — the query input is, and the effect
  // below moves it there (the fleet drawer's pattern).
  const { onKeyDown: trapKeyDown } = useDialogFocus(open, panelRef, onClose, {
    autoFocus: focusPolicy.dialogAutoFocus,
  });

  const { sessions, projects } = useOpenFleet(open);

  const entries = useMemo<PaletteSession[]>(() => {
    const list = sessions ?? [];
    // The palette must file a session under the same project the sidebar and
    // dashboard do — one grouping implementation, three consumers.
    const groupOf = new Map<string, string>();
    for (const group of groupByProject(list, projects)) {
      for (const row of group.rows) groupOf.set(row.config.id, group.name);
    }
    return list.map(view => {
      const { config, state } = view;
      const folderName = groupOf.get(config.id) ?? (config.cwd ? baseName(config.cwd) : '');
      return {
        id: config.id,
        // RAW, never `displayCallsign()` — the search contract is lowercase.
        teammate: (config.teammate ?? '').trim(),
        task: parseTaskName(config.name).task,
        label: (config.label ?? '').trim(),
        // The group name AND the path: readers hunt by either, and the ranker
        // finds the tightest window inside whichever one hit.
        folder: [folderName, config.cwd].filter(Boolean).join(' '),
        activityAt: Date.parse(state.lastActivityAt ?? config.updatedAt ?? '') || 0,
        active: statusMark(view).klass === 'active',
        finished: TERMINAL_STATUSES.has(state.status),
        view,
        folderName,
      };
    });
  }, [sessions, projects]);

  const sessionResults = useMemo(
    () => (query.trim() ? rankSessions(entries, query, { limit: MAX_SESSION_RESULTS }) : recentSessions(entries)),
    [entries, query],
  );
  const shortcutLabel = dictationShortcutLabel(sttSettings.shortcut);
  const settingsResults = useMemo(
    () => settingsPaletteEntries(query, { dictationShortcutLabel: shortcutLabel }),
    [query, shortcutLabel],
  );
  const browserLoginCommand = matchesBrowserLoginCommand(query) ? BROWSER_LOGIN_COMMAND : null;
  // Destinations lead the list. On a phone the palette IS the navigation
  // surface — the pull-down is its opener and the bar has no room for tabs — so
  // opening it cold must answer "where can I go" before it answers anything
  // else.
  const destinationResults = useMemo(
    () => paletteDestinations(query, settingsDestinationHrefs(settingsResults)),
    [query, settingsResults],
  );
  const results = useMemo<PaletteResult[]>(
    () => [
      ...destinationResults.map(entry => ({ kind: 'destination' as const, entry })),
      ...(browserLoginCommand ? [{ kind: 'command' as const, entry: browserLoginCommand }] : []),
      ...settingsResults.map(entry => ({ kind: 'settings' as const, entry })),
      ...sessionResults.map(entry => ({ kind: 'session' as const, entry })),
    ],
    [browserLoginCommand, destinationResults, sessionResults, settingsResults],
  );
  // One arithmetic source for the rendered rows: every group's first index is
  // the running total of the groups above it, so a group appearing or vanishing
  // cannot leave `aria-activedescendant` pointing at the wrong row.
  const commandOffset = destinationResults.length;
  const settingsOffset = commandOffset + (browserLoginCommand ? 1 : 0);
  const sessionsOffset = settingsOffset + settingsResults.length;

  // The active row is DERIVED and clamped rather than corrected in an effect: a
  // streaming fleet can shrink the result list between renders, and an effect
  // would commit one frame pointing `aria-activedescendant` at an option that no
  // longer exists.
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const activeEntry = activeIndex >= 0 ? results[activeIndex] : undefined;

  // A new query is a new list; start at the top of it.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Opening (or re-pressing the shortcut) puts the caret in the box and selects
  // whatever is already there, so the next keystroke replaces it.
  useEffect(() => {
    if (!open || !focusPolicy.inputAutoFocus) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [open, focusSignal, focusPolicy.inputAutoFocus]);

  // Closing resets the query so the next ⌘K opens on the recents rather than on
  // a stale search. Kept out of the open-effect so it cannot fight the caret.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setActive(0);
    setAnnouncement('');
  }, [open]);

  // Keep the active row in the scroller. `block: 'nearest'` scrolls the palette's
  // own list and nothing else — the page below cannot scroll at all.
  useEffect(() => {
    if (!open || !activeEntry) return;
    document.getElementById(paletteResultId(activeEntry))?.scrollIntoView({ block: 'nearest' });
  }, [open, activeEntry]);

  useDebouncedEffect(
    () => {
      setAnnouncement(open ? countLabel(results.length) : '');
    },
    [open, results.length],
    ANNOUNCE_DEBOUNCE_MS,
  );

  const run = useCallback(
    (result: PaletteResult) => {
      if (result.kind === 'command') {
        onClose();
        void actOnBrowserLogin('start');
        return;
      }
      if (result.kind === 'session') {
        navigate(`/session/${encodeURIComponent(result.entry.id)}`);
        onClose();
        return;
      }
      if (result.kind === 'destination') {
        navigate(result.entry.href);
        onClose();
        return;
      }

      onClose();
      // Link rows (daemon-global settings that live on another page, e.g.
      // Warden & failover) navigate to their own destination on every layout —
      // the Settings sheet has no section to open for them.
      if (result.entry.href) {
        navigate(result.entry.href);
        return;
      }
      if (layout === 'drawer') {
        // The palette's focus trap must restore before the Settings sheet takes
        // focus, exactly like the Details → Settings handoff.
        requestAnimationFrame(() => store.openSettings(result.entry.settingId));
      } else {
        navigate(settingsHref(result.entry.settingId));
      }
    },
    [layout, onClose, store],
  );

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // An IME candidate window owns the arrow keys while it is up.
      if (event.nativeEvent.isComposing) return;
      const count = results.length;
      switch (event.key) {
        case 'ArrowDown':
          if (count === 0) return;
          event.preventDefault();
          setActive(index => (Math.min(index, count - 1) + 1) % count);
          return;
        case 'ArrowUp':
          if (count === 0) return;
          event.preventDefault();
          setActive(index => (Math.min(index, count - 1) - 1 + count) % count);
          return;
        case 'Home':
          if (count === 0) return;
          event.preventDefault();
          setActive(0);
          return;
        case 'End':
          if (count === 0) return;
          event.preventDefault();
          setActive(count - 1);
          return;
        case 'Enter':
          if (!activeEntry) return;
          event.preventDefault();
          run(activeEntry);
          return;
        default:
      }
    },
    [results.length, activeEntry, run],
  );

  // Hooks above, early return below: the restore-to-opener contract lives in
  // useDialogFocus's effects, and they only run if the hook is called on every
  // render — including the ones where there is nothing to draw.
  if (!open) return null;

  const trimmed = query.trim();

  return (
    <div className="kt-overlay fixed inset-x-0 z-50 flex justify-center px-3 pt-[12vh]">
      {/* Scrim. A real button, so a click and a keyboard activation dismiss the
          same way and a screen reader meets something with a name. */}
      <button
        type="button"
        aria-label="Close the command palette"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-scrim"
      />
      <div
        id={PANEL_ID}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={trapKeyDown}
        className="kt-panel relative z-10 flex w-[min(560px,92vw)] min-h-0 flex-col font-ui"
        style={{ maxHeight: 'min(60vh, calc(var(--app-h, 100dvh) - 14vh))' }}
      >
        <div className="flex shrink-0 items-center gap-sm border-b border-border-soft px-panel py-row-y">
          <Search size={14} className="shrink-0 text-faint" aria-hidden="true" />
          <input
            id={INPUT_ID}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeEntry ? paletteResultId(activeEntry) : undefined}
            aria-autocomplete="list"
            aria-label="Search commands, sessions, and settings"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search commands, sessions, and settings…"
            // Not `.kt-input`: the panel already draws the edge, and a second
            // bordered control inside it reads as a box in a box. Type size and
            // colour still come from tokens.
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-ui text-ui text-fg outline-none placeholder:text-faint"
          />
        </div>

        {/* The palette's OWN scroller. The page below still owns exactly one
            (the transcript); this is an overlay and never nests inside it. */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-xs py-xs">
          <div id={LISTBOX_ID} role="listbox" aria-label="Results">
            {destinationResults.length > 0 && (
              <div role="group" aria-labelledby={DESTINATIONS_HEADING_ID}>
                <div id={DESTINATIONS_HEADING_ID} className="kt-label px-cell-x pb-xs pt-xs">
                  Go to
                </div>
                {destinationResults.map((entry, index) => (
                  <DestinationOption
                    key={entry.id}
                    entry={entry}
                    selected={index === activeIndex}
                    onActivate={() => run({ kind: 'destination', entry })}
                    onHover={() => setActive(index)}
                  />
                ))}
              </div>
            )}
            {browserLoginCommand && (
              <div role="group" aria-labelledby={COMMANDS_HEADING_ID}>
                <div id={COMMANDS_HEADING_ID} className="kt-label px-cell-x pb-xs pt-xs">
                  {trimmed ? 'Commands' : 'Browser'}
                </div>
                <CommandOption
                  entry={browserLoginCommand}
                  selected={activeIndex === commandOffset}
                  onActivate={() => run({ kind: 'command', entry: browserLoginCommand })}
                  onHover={() => setActive(commandOffset)}
                />
              </div>
            )}
            {settingsResults.length > 0 && (
              <div role="group" aria-labelledby={SETTINGS_HEADING_ID}>
                <div id={SETTINGS_HEADING_ID} className="kt-label px-cell-x pb-xs pt-xs">
                  {trimmed ? 'Settings' : 'Commands'}
                </div>
                {settingsResults.map((entry, index) => {
                  const resultIndex = settingsOffset + index;
                  return (
                    <SettingsOption
                      key={entry.id}
                      entry={entry}
                      selected={resultIndex === activeIndex}
                      onActivate={() => run({ kind: 'settings', entry })}
                      onHover={() => setActive(resultIndex)}
                    />
                  );
                })}
              </div>
            )}
            {sessionResults.length > 0 && (
              <div role="group" aria-labelledby={SESSIONS_HEADING_ID}>
                <div id={SESSIONS_HEADING_ID} className="kt-label px-cell-x pb-xs pt-xs">
                  {trimmed ? 'Sessions' : 'Recent sessions'}
                </div>
                {sessionResults.map((entry, index) => {
                  const resultIndex = sessionsOffset + index;
                  return (
                    <SessionOption
                      key={entry.id}
                      entry={entry}
                      selected={resultIndex === activeIndex}
                      onActivate={() => run({ kind: 'session', entry })}
                      onHover={() => setActive(resultIndex)}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {results.length === 0 && (
            <p className="m-0 px-cell-x py-row-y text-cell text-muted">
              {trimmed ? (
                <>
                  Nothing matches <span className="mono text-fg-soft">{trimmed}</span>. Try a page (analytics, warden,
                  learning, settings), a setting, teammate callsign, task, project folder, or the start of a session id.
                </>
              ) : (
                'No sessions yet.'
              )}
            </p>
          )}
        </div>

        <Footer />

        {/* Spoken, never shown. `sr-only` and not `hidden`, which would take it
            straight back out of the accessibility tree. */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>
    </div>
  );
}

function CommandOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  entry: PaletteCommand;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <div
      id={commandOptionId(entry.id)}
      role="option"
      aria-selected={selected}
      data-active={selected ? 'true' : undefined}
      onClick={onActivate}
      onPointerMove={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      <KeyRound size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-fg">{entry.label}</span>
        <span className="truncate text-meta text-muted">{entry.description}</span>
      </span>
    </div>
  );
}

function DestinationOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  entry: DestinationPaletteEntry;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const Icon = destinationIcon(entry.id);
  return (
    <div
      id={destinationOptionId(entry.id)}
      role="option"
      aria-selected={selected}
      data-active={selected ? 'true' : undefined}
      onClick={onActivate}
      onPointerMove={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      <Icon size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-fg">{entry.label}</span>
        <span className="truncate text-meta text-muted">{entry.description}</span>
      </span>
    </div>
  );
}

function SettingsOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  entry: SettingsPaletteEntry;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <div
      id={settingsOptionId(entry.id)}
      role="option"
      aria-selected={selected}
      data-active={selected ? 'true' : undefined}
      onClick={onActivate}
      onPointerMove={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      <Settings size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-fg">{entry.label}</span>
        <span className="truncate text-meta text-muted">{entry.description}</span>
      </span>
    </div>
  );
}

function SessionOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  entry: PaletteSession;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const { config } = entry.view;
  const callsign = displayCallsign(entry.teammate);
  return (
    <div
      id={sessionOptionId(entry.id)}
      role="option"
      aria-selected={selected}
      data-active={selected ? 'true' : undefined}
      // Options are not buttons and must not be focusable: focus stays in the
      // combobox input, and `aria-activedescendant` is what points here.
      onClick={onActivate}
      onPointerMove={onHover}
      className="kt-navrow cursor-pointer items-start"
    >
      <StatusMark view={entry.view} size={8} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-sm">
          <span className="shrink-0 font-semibold text-fg">{callsign || config.name || shortSessionId(entry.id)}</span>
          {entry.task && (
            <TaskName
              name={config.name}
              teammate={config.teammate}
              size="sm"
              showPrefix={false}
              className="min-w-0 flex-1"
            />
          )}
        </span>
        <span className="flex min-w-0 items-baseline gap-sm text-meta text-muted">
          {entry.folderName && <span className="min-w-0 truncate">{entry.folderName}</span>}
          {entry.label && <span className="min-w-0 truncate">· {entry.label}</span>}
          <span className="mono ml-auto shrink-0 text-faint">{shortSessionId(entry.id)}</span>
        </span>
      </span>
    </div>
  );
}

/** What the keys do, and the one thing this shortcut is NOT. Cmd/Ctrl+F is the
 *  sibling feature (find inside a transcript) and readers will try it here; say
 *  so rather than letting them discover a browser find bar over a dialog. */
function Footer() {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-sm border-t border-border-soft px-panel py-row-y text-meta text-muted">
      <span className="inline-flex items-center gap-xs">
        <ArrowUp size={11} aria-hidden="true" />
        <ArrowDown size={11} aria-hidden="true" />
        move
      </span>
      <span className="inline-flex items-center gap-xs">
        <CornerDownLeft size={11} aria-hidden="true" />
        open
      </span>
      <span className="inline-flex items-center gap-xs">
        <span className="mono">esc</span>
        close
      </span>
      <span className="ml-auto text-faint">{paletteShortcutLabel()} anywhere · find in transcript comes later</span>
    </div>
  );
}
