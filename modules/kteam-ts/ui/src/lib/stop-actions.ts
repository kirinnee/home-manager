import type { SessionView } from '../types';
import { sessionActionSpecs } from './session-actions';

/** The four explicit fleet stop scopes deliberately mirror the CLI; lineage and labels
 * are independent selectors and are never combined. */
export type StopScope = 'orphan' | 'cascade' | 'children' | 'label';

/** A session can participate in a bulk stop exactly when the row UI offers its
 * retry-safe Stop action (including `kill_failed`, excluding other terminals). */
export function isStoppable(view: SessionView): boolean {
  return sessionActionSpecs(view, true).some(spec => spec.action === 'stop');
}

function descendantIds(sessions: readonly SessionView[], selectedId: string, includeSelected: boolean): Set<string> {
  const childIds = new Map<string, string[]>();
  for (const view of sessions) {
    const parent = view.config.parent?.trim();
    if (!parent) continue;
    const children = childIds.get(parent) ?? [];
    children.push(view.config.id);
    childIds.set(parent, children);
  }

  const ids = new Set<string>();
  const queue = includeSelected ? [selectedId] : [...(childIds.get(selectedId) ?? [])];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (ids.has(id)) continue;
    ids.add(id);
    queue.push(...(childIds.get(id) ?? []));
  }
  return ids;
}

/** Live descendants are not stop targets for orphan mode: they are the exact
 * sessions a person is consciously leaving running after their parent stops. */
export function selectLiveDescendants(sessions: readonly SessionView[], selectedId: string): SessionView[] {
  const selected = sessions.find(view => view.config.id === selectedId);
  if (!selected) return [];
  const ids = descendantIds(sessions, selectedId, false);
  return shallowestFirst(
    sessions,
    sessions.filter(view => view.config.id !== selectedId && ids.has(view.config.id) && isStoppable(view)),
  );
}

/** Sort confirmed parents before their descendants. Closing the shallowest
 * spawners first minimizes the window in which they can create more children. */
function shallowestFirst(sessions: readonly SessionView[], targets: SessionView[]): SessionView[] {
  const byId = new Map(sessions.map(view => [view.config.id, view]));
  const depth = (view: SessionView): number => {
    const seen = new Set<string>([view.config.id]);
    let parent = view.config.parent?.trim();
    let result = 0;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      result++;
      parent = byId.get(parent)?.config.parent?.trim();
    }
    return result;
  };
  return targets
    .map((view, index) => ({ view, index, depth: depth(view) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(item => item.view);
}

/**
 * Return the currently eligible targets for one explicit stop scope. Parent
 * links form untrusted input, so the traversal records visited IDs and remains
 * finite even for an accidental self-parent or a longer cycle. Source order is
 * retained to make confirmations stable and easy to compare with the fleet.
 */
export function selectStopTargets(
  sessions: readonly SessionView[],
  selectedId: string,
  scope: StopScope,
): SessionView[] {
  const selected = sessions.find(view => view.config.id === selectedId);
  if (!selected) return [];

  if (scope === 'label') {
    const label = selected.config.label;
    if (!label?.trim()) return [];
    return shallowestFirst(
      sessions,
      sessions.filter(view => view.config.label === label && isStoppable(view)),
    );
  }

  // Orphan has one deliberately narrow target; it must not traverse a
  // malformed descendant graph merely to decide that fact.
  if (scope === 'orphan') return isStoppable(selected) ? [selected] : [];

  const ids = descendantIds(sessions, selectedId, scope !== 'children');
  const targets = sessions.filter(
    view => view.config.id !== (scope === 'children' ? selectedId : '') && ids.has(view.config.id) && isStoppable(view),
  );
  return shallowestFirst(sessions, targets);
}

export function stopScopeLabel(scope: StopScope): string {
  switch (scope) {
    case 'orphan':
      return 'Stop · orphan this session';
    case 'cascade':
      return 'Stop · cascade whole tree';
    case 'children':
      return 'Stop · children only (keep this)';
    case 'label':
      return 'Stop · label';
  }
}

/** One explicit reason is carried to every per-session stop request in a
 * confirmed sweep, so daemon history explains why a session stopped. */
export function stopScopeReason(scope: StopScope, selection: string): string {
  switch (scope) {
    case 'orphan':
      return `stopped orphan ${selection} from browser`;
    case 'cascade':
      return `stopped cascade ${selection} from browser`;
    case 'children':
      return `stopped children of ${selection} from browser`;
    case 'label':
      return `stopped label ${selection} from browser`;
  }
}
