// A one-shot "focus the fleet search box" signal.
//
// WHY A BUS AND NOT A PROP. The search input lives inside `Controls`
// (AgentSidebar.tsx); the pull-to-search gesture lives on the sibling list
// scroller inside `Body`. They have no shared owner this feature is allowed to
// thread a ref through, so — exactly like pin-bridge's foreground signal — a
// tiny module-level pub/sub is the honest wiring: the gesture fires
// `requestSearchFocus()`, and whichever `Controls` is mounted focuses its input.
//
// It is a NOTIFY, not a state: there is nothing to snapshot, so it does not go
// through useSyncExternalStore. Subscribers just get called; the `/` keyboard
// shortcut in Controls is the established precedent for "focus the search box on
// a signal", and this is its programmatic sibling.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Ask the mounted fleet-search input to take focus. A deliberate user gesture
 *  (a pull-down on touch) drives this — summoning the keyboard here is intended,
 *  which is why the drawer does NOT autofocus search on open (that was unbidden;
 *  this is asked for). No-op when no Controls is mounted. */
export function requestSearchFocus(): void {
  for (const l of listeners) l();
}

/** Controls subscribes; the callback focuses its input ref. */
export function subscribeSearchFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
