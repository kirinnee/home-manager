// FOLDER MODE — the deterministic scope machine (master-plan item 10 / §7.1).
//
// "Focus a folder" is one value: `projectScope`, a group KEY (a normalised
// project path, or a raw cwd for fallback groups — never a display name, which
// can collide). It lives in the persisted controls beside `query`/`mode`, and
// RENDERING READS THE STORE VALUE ONLY. The URL and history never feed a render
// directly; they only *write the store*, one way, which is what makes this
// machine loop-proof.
//
// THE R2-P0 DETERMINISM CONTRACT (audit-mandated, must not be re-lost):
//   - every in-app scope change writes the store FIRST, then pushes ONE history
//     entry carrying the scope in BOTH channels — the URL (`?project=…`) and
//     `history.state.projectScope`, INCLUDING an explicit `null` on clear;
//   - `popstate` (and boot) follow a fixed precedence: own history state →
//     URL tri-state → persisted store value;
//   - so set → clear → Back → Forward is deterministic: Forward lands on the
//     clear entry whose `state.projectScope === null` restores null, where a
//     URL-only rule would leave the stale earlier scope.
//
// WHY THIS OWNS THE URL DIRECTLY (and router.tsx is untouched). The precedence
// reads `window.history.state`, and the enter/exit writes push their own state —
// none of it flows through the router's `navigate`/`Link` (which write `{}` and
// would need scope-splitting there too). Keeping the whole contract in one
// owned, DOM-free-testable place is why the router needs no change: the pure
// core below is what the audit gate asserts, row by row.
//
// The package has no DOM in its test process, so the DECISIONS are pure
// functions (see useDialogFocus.test.ts / ChunkErrorBoundary.test.ts for the
// same discipline); the hook is a thin effect wrapper over them.

import { useEffect, useRef } from 'react';
import type { ProjectInfo, SessionView } from '../types';
import { useFleet, useStore, useUiControls, type FleetStore, type UiControls } from '../lib/store';
import { isScopeResolvable, normalizeProjectPath } from '../lib/grouping';

// ---------------------------------------------------------------------------
// Store bridge
// ---------------------------------------------------------------------------
//
// `projectScope` is an ADDITIVE controls-v1 field (plan F1) landed by the store
// owner. Until that ~12-line patch is applied the field is absent at runtime and
// unknown to the `UiControls` type, so both accessors go through a widening view:
// read degrades an absent/invalid value to `null` (which IS today's behaviour —
// no scope), and write asserts the extra key onto the patch. Once F1 lands these
// are no-ops. This is the "degrades safely while unwired" contract: with the
// field missing the whole feature simply behaves like a session that is never
// scoped.

type ScopedControls = { projectScope?: string | null };

/** The active folder scope, or `null` for "whole fleet". Empty string and any
 *  non-string both read as `null` — mirroring the store's field-by-field parse. */
export function readProjectScope(controls: UiControls): string | null {
  const s = (controls as UiControls & ScopedControls).projectScope;
  return typeof s === 'string' && s !== '' ? s : null;
}

function writeProjectScope(store: FleetStore, scope: string | null): void {
  // Cast: `projectScope` is not yet a known `UiControls` key until F1 lands, so
  // the fresh-literal excess-property check has to be silenced here. `setControls`
  // already no-ops when the value is unchanged, so repeated writes are cheap.
  store.setControls({ projectScope: scope } as Partial<UiControls>);
}

// ---------------------------------------------------------------------------
// Pure precedence core (audit gate asserts these directly)
// ---------------------------------------------------------------------------

/** URL tri-state on the dashboard route: a real path (deep link), `null`
 *  (`?project=` present but empty — an unambiguous deep-link clear), or
 *  `'absent'` (no param — the URL says nothing, so the persisted value applies). */
export function parseRouteScope(search: string): string | null | 'absent' {
  const params = new URLSearchParams(search);
  if (!params.has('project')) return 'absent';
  const raw = params.get('project') ?? '';
  return raw === '' ? null : raw;
}

export type ScopeDecision = { apply: true; scope: string | null } | { apply: false };

/** The precedence table, as a pure decision over the two navigation channels.
 *  `{ apply: false }` means "leave the persisted store value alone" — the
 *  off-dashboard and `'absent'` cases. Read `window.history.state`, NOT
 *  `event.state`: the synthetic PopStateEvent from an in-app push carries
 *  `state: null`, but `window.history.state` is correct in both the synthetic and
 *  the real back/forward case. */
export function resolveScopePrecedence(input: {
  pathname: string;
  historyState: unknown;
  search: string;
}): ScopeDecision {
  // Scope is only parsed on the dashboard; every other route ignores the param.
  if (input.pathname !== '/') return { apply: false };
  const state = input.historyState;
  if (state != null && typeof state === 'object' && 'projectScope' in state) {
    // Own-entry state wins, INCLUDING an explicit null (the clear entry).
    const s = (state as { projectScope?: unknown }).projectScope;
    return { apply: true, scope: typeof s === 'string' && s !== '' ? s : null };
  }
  const routeScope = parseRouteScope(input.search);
  if (routeScope === 'absent') return { apply: false };
  return { apply: true, scope: routeScope };
}

/** Whether the one-shot missing-folder recovery should fire this pass. Pure so
 *  the hydration gate, the null short-circuit, the "already recovered" guard and
 *  the "resolvable ⇒ keep (filtered-empty is preserved)" rule are all asserted
 *  without effects. */
export function scopeRecoveryDecision(input: {
  scope: string | null;
  sessions: readonly SessionView[] | null;
  projects: readonly ProjectInfo[];
  alreadyRecovered: boolean;
}): boolean {
  if (input.sessions === null) return false; // pre-hydration: never mis-clear a valid scope
  if (input.scope === null) return false;
  if (input.alreadyRecovered) return false;
  return !isScopeResolvable(input.scope, input.sessions, input.projects);
}

// ---------------------------------------------------------------------------
// Imperative enter / exit (called by the sidebar, palette and dashboard chip)
// ---------------------------------------------------------------------------

function applyScopeFromLocation(store: FleetStore): void {
  const decision = resolveScopePrecedence({
    pathname: window.location.pathname,
    historyState: window.history.state,
    search: window.location.search,
  });
  if (!decision.apply) return;
  writeProjectScope(store, decision.scope === null ? null : normalizeProjectPath(decision.scope));
}

/** Focus a folder. Store FIRST, then ONE history entry carrying the scope in
 *  both channels, then the synthetic popstate the router already listens for.
 *  A no-op when already scoped here on the dashboard (no junk history entry);
 *  from a session page it still pushes, folding navigation + scoping into one
 *  entry. `path` is any group key; it is normalised so the stored scope is
 *  canonical regardless of trailing-slash variance in the source. */
export function enterProjectScope(store: FleetStore, path: string): void {
  const scope = normalizeProjectPath(path);
  const onDashboard = window.location.pathname === '/';
  if (onDashboard && readProjectScope(store.getControls()) === scope) return;
  writeProjectScope(store, scope);
  window.history.pushState({ projectScope: scope }, '', '/?project=' + encodeURIComponent(scope));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Leave folder mode. Store cleared FIRST, then the clean-URL clear entry whose
 *  `state.projectScope === null` is what makes Forward-after-clear deterministic
 *  (it restores null, not the stale earlier scope). */
export function exitProjectScope(store: FleetStore): void {
  const onDashboard = window.location.pathname === '/';
  if (onDashboard && readProjectScope(store.getControls()) === null) return;
  writeProjectScope(store, null);
  window.history.pushState({ projectScope: null }, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// ---------------------------------------------------------------------------
// The hook — mounted once where the dashboard is (always-mounted route)
// ---------------------------------------------------------------------------

/** Mount the scope machine: boot + popstate precedence, and one-shot
 *  ref-guarded, hydration-gated missing-folder recovery. Mounted in
 *  SessionsListPage, which stays mounted for the app's life, so the listener is
 *  live on every route. Returns nothing — rendering reads the store value. */
export function useProjectScope(): void {
  const store = useStore();
  const { sessions, projects } = useFleet();
  const [controls] = useUiControls();
  const scope = readProjectScope(controls);

  // Boot once, then on every popstate (real back/forward AND the synthetic ones
  // enter/exit dispatch). `store` is a stable context value, so this binds once.
  useEffect(() => {
    applyScopeFromLocation(store);
    const onPop = () => applyScopeFromLocation(store);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [store]);

  // Missing-folder recovery: replaceState (no history growth), store cleared once
  // per episode. The ref resets whenever scope is null so a FUTURE stale scope
  // can recover again; a filtered-empty scope is resolvable and never triggers.
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (scope === null) {
      recoveredRef.current = false;
      return;
    }
    if (!scopeRecoveryDecision({ scope, sessions, projects, alreadyRecovered: recoveredRef.current })) return;
    recoveredRef.current = true;
    writeProjectScope(store, null);
    window.history.replaceState({ projectScope: null }, '', '/');
  }, [store, scope, sessions, projects]);
}
