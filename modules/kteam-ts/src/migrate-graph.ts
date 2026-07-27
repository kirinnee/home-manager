// Safe-migration GRAPH layer (phase 1, CLI-side — no daemon change).
//
// `kteam migrate` RELAUNCHES a session under a new fleet wrapper. The in-flight
// layer (migrate-preflight.ts) guards the SUBPROCESSES a relaunch kills; this
// module guards the SESSION GRAPH a relaunch could leave broken: the DAG of
// `config.parent` edges, teammate trees, and peers parked on a
// `kteam signal waiting --peer` against the migrating session.
//
// ── The load-bearing fact (established empirically, 2026-07-27) ──────────────
//
//   THE KTEAM SESSION ID IS STABLE ACROSS A MIGRATE.
//
// `migrate(id, agent)` (session-manager.ts) resolves ONE id and drives the whole
// relaunch through it — updateConfig(id), resume(id) — and never reallocates it.
// Only `config.binary`/`harness`/`model` (the WRAPPER ACCOUNT) change. Verified
// on a real migrated session (`mrx641u4-8bb55e52`, codex-auto-loio →
// codex-auto-ernest): the id, its `config.parent`, and its children's `parent`
// pointers were all identical before and after.
//
// Consequence — and this is the whole answer to "reattach the parent, reattach
// the child, fix the DAG": EVERY GRAPH EDGE KEYS ON THE STABLE ID
// (`config.parent`, the child→parent map in ui/src/lib/lineage.ts, and
// `state.waiting.peer`), so the edges are PRESERVED AUTOMATICALLY. There is
// nothing to rewrite. "Reattach" is a no-op — the edge never detached.
//
// ── What is NOT automatic (the real gap this module closes) ──────────────────
//
// A peer parked on `state.waiting.peer === <migrating id>` keeps a STRUCTURALLY
// valid wait (stable id; it resolves when the target next sends a peer message —
// session-manager.ts resolvePeerWait). But the relaunched agent only gets the
// canned "you were migrated, re-read your turn" message: it does NOT know a peer
// is blocked on a reply it owed. If it never sends that reply, the peer hangs
// FOREVER. That silent forever-hang is the exact thing the user asked to
// prevent. So the graph work is two things, neither of them edge-rewriting:
//
//   1. REPORT the blast radius BEFORE migrating (informed consent): how many
//      sessions are waiting on this one, how many children ride the same id.
//   2. RE-ARM by HANDOFF: tell the relaunched agent, in the migration report it
//      is pointed at, exactly which peers are parked on its reply — so it can
//      send it (or tell them plainly the wait is void). Handing the new agent a
//      note is the established re-arm shape (kayla's design §5); it mutates no
//      other session's state.
//
// Everything here is PURE — it folds a session snapshot into a report. Callers
// (the `kteam migrate` command) supply the snapshot from `list()`.

import type { SessionState, SessionStatus } from './types';

/** The minimal projection of a session this module reasons over — every field
 *  is a graph edge or a label. Built from a SessionView via `toGraphNode`. */
export interface GraphNode {
  id: string;
  teammate?: string;
  /** `config.parent` — the id of the session that started this one. */
  parent?: string;
  status: SessionStatus;
  /** `state.waiting.peer` — set when this session is PARKED awaiting a reply
   *  from the peer named here (by id). The re-arm target. */
  waitingPeer?: string;
  /** Display name of `waitingPeer` at declare time. */
  waitingPeerName?: string;
  /** Human-readable description of a non-peer declared wait. */
  waitingCondition?: string;
  /** ISO deadline of the wait, if any. */
  waitingUntil?: string;
}

/** A session PARKED on the migrating session's reply — the forever-hang risk. */
export interface GraphWaiter {
  id: string;
  teammate?: string;
  status: SessionStatus;
  /** ISO deadline if the wait was bounded; absent = open-ended (never self-wakes
   *  on the peer axis). */
  until?: string;
}

/** A session whose `parent` is the migrating session — rides the same stable id,
 *  so it stays attached across the relaunch. Listed for the blast-radius count. */
export interface GraphChild {
  id: string;
  teammate?: string;
  status: SessionStatus;
}

export interface GraphImpact {
  id: string;
  teammate?: string;
  /** Resolved parent, when `config.parent` points at a session that still
   *  exists. The edge survives the migrate untouched. */
  parent?: { id: string; teammate?: string };
  /** `config.parent` was set but no such session exists in the snapshot — a
   *  PRE-EXISTING dangling edge (a purged/old parent), surfaced but not "caused"
   *  by this migrate. */
  parentDangling: boolean;
  children: GraphChild[];
  /** Sessions parked on THIS session's reply. Non-empty => a re-arm is owed. */
  waiters: GraphWaiter[];
  /** True — documents that edges are preserved because the id does not change.
   *  A literal so tests and callers can assert the invariant this rests on. */
  idStable: true;
}

/** Project a SessionView-shaped record into a GraphNode. Kept structural (not
 *  importing SessionView) so the pure core has no service-layer dependency. */
export function toGraphNode(view: {
  config: { id: string; teammate?: string; parent?: string };
  state: Pick<SessionState, 'status' | 'waiting'>;
}): GraphNode {
  return {
    id: view.config.id,
    teammate: view.config.teammate,
    parent: view.config.parent,
    status: view.state.status,
    waitingPeer: view.state.waiting?.peer,
    waitingPeerName: view.state.waiting?.peerName,
    waitingCondition: view.state.waiting?.condition,
    waitingUntil: view.state.waiting?.until,
  };
}

/** Fold a whole-fleet snapshot into the graph impact of migrating `id`. Pure.
 *
 *  `id` is the ALREADY-RESOLVED session id (callers resolve teammate names to
 *  ids before this). The snapshot is every session's GraphNode — typically
 *  `(await client.list()).map(toGraphNode)`. */
export function computeGraphImpact(id: string, nodes: readonly GraphNode[]): GraphImpact {
  const self = nodes.find(node => node.id === id);
  const byId = new Map(nodes.map(node => [node.id, node]));

  // Parent: the edge is the migrating session's OWN `parent` pointer. It keys on
  // the parent's id, which the migrate does not touch — preserved. We resolve it
  // only to name it in the report and to flag a pre-existing dangling pointer.
  let parent: GraphImpact['parent'];
  let parentDangling = false;
  const parentId = self?.parent?.trim();
  if (parentId) {
    const parentNode = byId.get(parentId);
    if (parentNode) parent = { id: parentNode.id, teammate: parentNode.teammate };
    else parentDangling = true;
  }

  // Children: sessions pointing AT this id. They ride the stable id, so they
  // stay attached — nothing to re-point. Listed for the count and the handoff.
  const children: GraphChild[] = nodes
    .filter(node => node.id !== id && node.parent?.trim() === id)
    .map(node => ({ id: node.id, teammate: node.teammate, status: node.status }));

  // Waiters: sessions PARKED on this session's reply. The wait survives the
  // migrate structurally, but the relaunched agent must be told it owes a reply
  // or the peer hangs forever — this is the list the re-arm handoff carries.
  const waiters: GraphWaiter[] = nodes
    .filter(node => node.id !== id && node.waitingPeer?.trim() === id)
    .map(node => ({ id: node.id, teammate: node.teammate, status: node.status, until: node.waitingUntil }));

  return {
    id,
    teammate: self?.teammate,
    parent,
    parentDangling,
    children,
    waiters,
    idStable: true,
  };
}

/** Nothing worth reporting or handing off: no parent, no children, no waiters,
 *  no dangling edge. The blast-radius line and the graph handoff section are
 *  both suppressed on an empty impact so a solo session migrates as before. */
export function graphImpactEmpty(impact: GraphImpact): boolean {
  return (
    impact.parent === undefined && !impact.parentDangling && impact.children.length === 0 && impact.waiters.length === 0
  );
}

/** A migrate has an UNRESOLVED graph hazard iff someone is parked on its reply.
 *  Parent/children ride the stable id and never hazard anything; only waiters
 *  can hang. Callers use this to decide whether a re-arm handoff is owed. */
export function graphHasWaiters(impact: GraphImpact): boolean {
  return impact.waiters.length > 0;
}

// ── rendering ─────────────────────────────────────────────────────────────────

function label(node: { id: string; teammate?: string }): string {
  return node.teammate ? `${node.teammate} (${node.id})` : node.id;
}

/** One-line blast radius for the pre-flight, shown BEFORE the user consents so
 *  consent is informed by who this touches. Empty string on an empty impact. */
export function renderGraphImpactLine(impact: GraphImpact): string {
  if (graphImpactEmpty(impact)) return '';
  const parts: string[] = [];
  if (impact.waiters.length)
    parts.push(
      `${impact.waiters.length} session${impact.waiters.length === 1 ? '' : 's'} waiting on this session's reply`,
    );
  if (impact.children.length)
    parts.push(`${impact.children.length} child session${impact.children.length === 1 ? '' : 's'}`);
  if (impact.parent) parts.push(`parent ${label(impact.parent)}`);
  if (impact.parentDangling) parts.push('parent edge is dangling (parent no longer exists)');
  return `graph impact — ${parts.join('; ')}`;
}

/** The multi-line pre-flight detail (printed under the one-line summary on the
 *  CLI). Names the waiters explicitly, since they are the forever-hang risk, and
 *  states plainly that parent/child edges are preserved by the stable id. */
export function renderGraphImpactCli(impact: GraphImpact): string {
  if (graphImpactEmpty(impact)) return '';
  const lines: string[] = [renderGraphImpactLine(impact)];
  if (impact.waiters.length) {
    lines.push('  waiters (parked on this session — will hang unless it replies after relaunch):');
    for (const waiter of impact.waiters)
      lines.push(`    - ${label(waiter)}${waiter.until ? ` (until ${waiter.until})` : ' (open-ended)'}`);
  }
  if (impact.children.length || impact.parent || impact.parentDangling)
    lines.push('  parent/child edges key on the session id, which is STABLE across migrate — they stay attached.');
  return lines.join('\n');
}

/** The graph section appended to `<session dir>/migration-inflight.md` — the
 *  RE-ARM handoff the relaunched agent is pointed at. It carries the waiter list
 *  and tells the agent, in plain terms, that it owes those peers a reply or must
 *  release them. Empty string on an empty impact (no section written).
 *
 *  This mutates NO other session's state: it only informs the agent that keeps
 *  the stable id. Any active step that touches a waiter (see `waiterNotices`)
 *  is the caller's decision and must be journalled + visible. */
export function renderGraphHandoffSection(impact: GraphImpact): string {
  if (graphImpactEmpty(impact)) return '';
  const lines: string[] = ['## Session graph after this migrate', ''];
  lines.push(
    'Your kteam session id did NOT change — only the account/wrapper did. Your parent and child ' +
      'sessions stay attached automatically (every edge keys on the stable id).',
  );
  lines.push('');
  if (impact.parent) lines.push(`- Parent: ${label(impact.parent)} — still attached.`);
  if (impact.parentDangling)
    lines.push(
      '- Parent: the recorded parent no longer exists (a pre-existing dangling edge, not caused by this migrate).',
    );
  if (impact.children.length) {
    lines.push(`- Children (${impact.children.length}) — still attached under your id:`);
    for (const child of impact.children) lines.push(`  - ${label(child)} [${child.status}]`);
  }
  lines.push('');
  if (impact.waiters.length) {
    lines.push('### ⚠ Peers PARKED on your reply — re-arm these');
    lines.push('');
    lines.push(
      'These sessions ran `kteam signal waiting --peer` against you: each is BLOCKED until you send ' +
        'it something, and its wait does NOT self-expire on the peer axis. The relaunch did not notify ' +
        'them. If your interrupted turn owed a peer a reply, send it now (`kteam send <peer> "…"`). If ' +
        'you no longer owe one, tell them plainly so they can stop waiting — a silent forever-hang is ' +
        'the worst outcome.',
    );
    lines.push('');
    for (const waiter of impact.waiters)
      lines.push(
        `- ${label(waiter)}${waiter.until ? ` — bounded until ${waiter.until}` : ' — OPEN-ENDED (will not self-wake)'}`,
      );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export interface WaiterNotice {
  /** Waiter session id to send to. */
  id: string;
  /** A NON-peer informational message. It does NOT resolve the waiter's peer
   *  wait (only a real reply FROM the migrated session does, via resolvePeerWait)
   *  — it just prevents a blind hang by telling the waiter what happened. */
  message: string;
}

/** Optional active re-arm: a visible, journalled note for each waiter telling it
 *  the session it is parked on was migrated and is resuming, so its wait is
 *  intact but delayed. Touching another session is the caller's explicit choice
 *  (hard constraint: never SILENTLY rewrite another session's state) — the CLI
 *  gates this behind a flag and journals every send. Returns [] on no waiters. */
export function buildWaiterNotices(impact: GraphImpact): WaiterNotice[] {
  const who = impact.teammate ? `${impact.teammate} (${impact.id})` : impact.id;
  return impact.waiters.map(waiter => ({
    id: waiter.id,
    message:
      `The session you are parked on — ${who} — was migrated to a different account and is resuming. ` +
      'Your wait is still valid (its id did not change) and will resolve when it replies; nothing to do.',
  }));
}
