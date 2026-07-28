import { createInterface } from 'node:readline/promises';
import type { SessionView } from './service';

/**
 * Bulk stop stays entirely client-side. Each mutation is the existing
 * per-session POST /stop, so these helpers add no authorization surface and do
 * not turn the shared bearer into a new batch capability.
 */

const UNSTOPPABLE = new Set(['completed', 'failed', 'stalled', 'stopped']);

export type BulkStopSelector =
  | { kind: 'orphan'; rootId: string }
  | { kind: 'cascade'; rootId: string }
  | { kind: 'children'; rootId: string }
  | { kind: 'label'; label: string };

export interface StopTarget {
  id: string;
  name: string;
  teammate?: string;
  label?: string;
  parent?: string;
  status: string;
  depth: number;
  caller: boolean;
  callerAncestor: boolean;
}

export interface StopPlan {
  selector: BulkStopSelector;
  /** Every stoppable session selected before the caller safety exclusion. */
  candidates: StopTarget[];
  /** The exact ordered set that the confirmation authorizes. */
  targets: StopTarget[];
  /** Normally zero or one entry: the issuing session is excluded by default. */
  excluded: StopTarget[];
  /** ORPHAN only: live descendants deliberately left running/parentless. */
  leftRunning: StopTarget[];
  callerId?: string;
}

export interface StopOutcome {
  target: StopTarget;
  ok: boolean;
  status?: string;
  error?: string;
}

export interface StopSweepResult {
  kind: BulkStopSelector['kind'];
  outcomes: StopOutcome[];
  /** Matching stoppable sessions absent from the confirmed candidate set. */
  appeared: StopTarget[];
  /** ORPHAN only: the live descendants observed after the selected stop. */
  leftRunning: StopTarget[];
  /** ORPHAN only: descendants not present in the confirmation-time list. */
  appearedLeftRunning: StopTarget[];
  raceCheckError?: string;
}

export interface BulkStopOptions {
  reason?: string;
  dryRun?: boolean;
  yes?: boolean;
  includeCaller?: boolean;
}

/** Commander stores an option written before a subcommand on the parent
 * command. Preserve that explicit reason while still letting a reason written
 * on the named mode itself win. */
export function inheritStopReason(options: BulkStopOptions, parentReason?: string): BulkStopOptions {
  if (options.reason !== undefined || parentReason === undefined) return options;
  return { ...options, reason: parentReason };
}

export interface BulkStopIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isInteractive: boolean;
  confirm: (prompt: string) => Promise<string>;
}

export interface BulkStopDeps {
  list: () => Promise<SessionView[]>;
  /** Used only for lineage selectors so CLI aliases resolve exactly as `stop` does. */
  get: (id: string) => Promise<SessionView>;
  stop: (id: string, reason: string) => Promise<SessionView>;
  io: BulkStopIo;
}

export interface BulkStopRunResult {
  exitCode: number;
  plan: StopPlan;
  sweep?: StopSweepResult;
  confirmed: boolean;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function isStoppable(view: SessionView): boolean {
  // kill_failed deliberately remains stoppable: another Stop is its recovery
  // path. The four settled terminal states have no live work left to end.
  return !UNSTOPPABLE.has(view.state.status);
}

function normalizeParent(view: SessionView): string | undefined {
  const parent = view.config.parent?.trim();
  return parent ? parent : undefined;
}

function sessionMap(sessions: readonly SessionView[]): Map<string, SessionView> {
  const byId = new Map<string, SessionView>();
  for (const view of sessions) {
    const id = view.config.id.trim();
    if (id && !byId.has(id)) byId.set(id, view);
  }
  return byId;
}

/** Ancestors of the issuing session are the best locally knowable lead chain. */
export function callerAncestorIds(sessions: readonly SessionView[], callerId?: string): Set<string> {
  const ancestors = new Set<string>();
  if (!callerId) return ancestors;
  const byId = sessionMap(sessions);
  const normalizedCaller = callerId.trim();
  const seen = new Set<string>([normalizedCaller]);
  const caller = byId.get(normalizedCaller);
  let current = caller ? normalizeParent(caller) : undefined;
  while (current && !seen.has(current)) {
    ancestors.add(current);
    seen.add(current);
    const view = byId.get(current);
    current = view ? normalizeParent(view) : undefined;
  }
  return ancestors;
}

function subtreeDepths(byId: ReadonlyMap<string, SessionView>, rootId: string): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const view of byId.values()) {
    const parent = normalizeParent(view);
    if (!parent) continue;
    const existing = children.get(parent);
    const childId = view.config.id.trim();
    if (!childId) continue;
    if (existing) existing.push(childId);
    else children.set(parent, [childId]);
  }

  const depth = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    if (depth.has(next.id)) continue;
    depth.set(next.id, next.depth);
    for (const child of children.get(next.id) ?? []) {
      if (!depth.has(child)) queue.push({ id: child, depth: next.depth + 1 });
    }
  }
  return depth;
}

function lineageDepth(byId: ReadonlyMap<string, SessionView>, id: string): number {
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<string>([id]);
  while (current) {
    const parent = normalizeParent(current);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    depth += 1;
    current = byId.get(parent);
  }
  return depth;
}

function targetFrom(
  view: SessionView,
  depth: number,
  callerId: string | undefined,
  ancestors: ReadonlySet<string>,
): StopTarget {
  const id = view.config.id.trim();
  return {
    id,
    name: view.config.name || id,
    ...(view.config.teammate ? { teammate: view.config.teammate } : {}),
    ...(view.config.label ? { label: view.config.label } : {}),
    ...(normalizeParent(view) ? { parent: normalizeParent(view) } : {}),
    status: view.state.status,
    depth,
    caller: id === callerId?.trim(),
    callerAncestor: ancestors.has(id),
  };
}

function compareTargets(a: StopTarget, b: StopTarget): number {
  // Stop parents before children so each confirmed spawn source closes as early
  // as possible. The caller (when explicitly included) is the sole exception:
  // it stays last so this CLI can report every other outcome before its own pane
  // may disappear.
  if (a.caller !== b.caller) return a.caller ? 1 : -1;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return (a.teammate ?? a.name).localeCompare(b.teammate ?? b.name) || a.id.localeCompare(b.id);
}

function compareLineage(a: StopTarget, b: StopTarget): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return (a.teammate ?? a.name).localeCompare(b.teammate ?? b.name) || a.id.localeCompare(b.id);
}

/**
 * Reconstruct the selected set from session records. Both the subtree walk and
 * the caller-ancestor walk use visited sets, so malformed parent cycles cannot
 * recurse forever.
 */
export function buildStopPlan(
  sessions: readonly SessionView[],
  selector: BulkStopSelector,
  options: { callerId?: string; includeCaller?: boolean } = {},
): StopPlan {
  const byId = sessionMap(sessions);
  const ancestors = callerAncestorIds(sessions, options.callerId);
  const selected: StopTarget[] = [];
  const leftRunning: StopTarget[] = [];

  if (selector.kind === 'label') {
    const label = selector.label.trim();
    if (!label) throw new Error('label must not be empty');
    for (const view of byId.values()) {
      if (view.config.label === label && isStoppable(view)) {
        selected.push(targetFrom(view, lineageDepth(byId, view.config.id.trim()), options.callerId, ancestors));
      }
    }
  } else {
    const rootId = selector.rootId.trim();
    const depth = subtreeDepths(byId, rootId);
    for (const [id, itemDepth] of depth) {
      const view = byId.get(id);
      if (!view || !isStoppable(view)) continue;
      const target = targetFrom(view, itemDepth, options.callerId, ancestors);
      if (selector.kind === 'orphan') {
        if (id === rootId) selected.push(target);
        else leftRunning.push(target);
      } else if (selector.kind === 'children') {
        if (id !== rootId) selected.push(target);
      } else {
        selected.push(target);
      }
    }
  }

  selected.sort(compareTargets);
  leftRunning.sort(compareLineage);
  const excluded = options.includeCaller ? [] : selected.filter(target => target.caller);
  const targets = options.includeCaller ? selected : selected.filter(target => !target.caller);
  return {
    selector,
    candidates: selected,
    targets,
    excluded,
    leftRunning,
    ...(options.callerId ? { callerId: options.callerId } : {}),
  };
}

export function selectorDescription(selector: BulkStopSelector): string {
  switch (selector.kind) {
    case 'orphan':
      return `ORPHAN ${selector.rootId} (stop only this session; descendants keep running)`;
    case 'cascade':
      return `CASCADE ${selector.rootId} (stop this session + all transitive descendants)`;
    case 'children':
      return `CHILDREN ${selector.rootId} (stop all transitive descendants; keep this session running)`;
    case 'label':
      return `LABEL ${JSON.stringify(selector.label)} (exact match; independent of lineage)`;
  }
}

export function targetDisplay(target: StopTarget): string {
  const identity = target.teammate
    ? `${target.teammate} — ${target.name} (${target.id})`
    : `${target.name} (${target.id})`;
  const warnings = [
    target.caller ? 'CALLER' : '',
    target.callerAncestor ? 'CALLER ANCESTOR / POSSIBLE LEAD' : '',
  ].filter(Boolean);
  return `${identity}${warnings.length ? `  [${warnings.join('; ')}]` : ''}`;
}

export function renderStopPlan(plan: StopPlan): string {
  const lines = [`Stop selection: ${selectorDescription(plan.selector)}`];
  if (plan.selector.kind === 'orphan') {
    if (plan.leftRunning.length) {
      lines.push(
        `Will leave ${plan.leftRunning.length} live ${plan.leftRunning.length === 1 ? 'descendant' : 'descendants'} running without this parent:`,
      );
      for (const target of plan.leftRunning) lines.push(`  - ${targetDisplay(target)}`);
    } else {
      lines.push('No live descendants will be orphaned.');
    }
    lines.push('', `Will stop ${plan.targets.length} ${plan.targets.length === 1 ? 'session' : 'sessions'}:`);
  } else {
    lines.push(`Will stop ${plan.targets.length} ${plan.targets.length === 1 ? 'session' : 'sessions'}:`);
  }
  if (plan.targets.length === 0) lines.push('  (none)');
  else for (const target of plan.targets) lines.push(`  - ${targetDisplay(target)}`);

  if (plan.excluded.length) {
    lines.push('', `Excluded for caller safety (${plan.excluded.length}; will NOT be stopped):`);
    for (const target of plan.excluded) lines.push(`  - ${targetDisplay(target)}`);
    lines.push('Use --include-caller to include the issuing session explicitly; it will be stopped last.');
  }

  const leads = plan.targets.filter(target => target.callerAncestor);
  if (leads.length) {
    lines.push(
      '',
      `WARNING: ${leads.length} selected ${leads.length === 1 ? 'session is' : 'sessions are'} in the caller's ancestor/lead chain.`,
    );
  }
  if (plan.targets.some(target => target.caller)) {
    lines.push(
      '',
      'WARNING: the issuing session is selected and may terminate this CLI before its own outcome prints.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function confirmationPhrase(plan: StopPlan): string {
  const protectedKinds = [
    plan.targets.some(target => target.caller) ? 'caller' : '',
    plan.targets.some(target => target.callerAncestor) ? 'lead' : '',
  ].filter(Boolean);
  const orphanImpact =
    plan.selector.kind === 'orphan' && plan.leftRunning.length ? ` leaving ${plan.leftRunning.length}` : '';
  return `stop ${plan.targets.length}${orphanImpact}${protectedKinds.length ? ` including ${protectedKinds.join(' and ')}` : ''}`;
}

export function defaultStopReason(selector: BulkStopSelector): string {
  switch (selector.kind) {
    case 'orphan':
      return `stopped by kteam stop orphan ${selector.rootId}`;
    case 'cascade':
      return `stopped by kteam stop cascade ${selector.rootId}`;
    case 'children':
      return `stopped by kteam stop children ${selector.rootId}`;
    case 'label':
      return `stopped by kteam stop label ${selector.label}`;
  }
}

/** Execute only the already-confirmed target ids, then detect—not auto-kill—new matches. */
export async function executeStopSweep(
  plan: StopPlan,
  reason: string,
  deps: Pick<BulkStopDeps, 'list' | 'stop'>,
  options: { includeCaller?: boolean } = {},
): Promise<StopSweepResult> {
  const outcomes: StopOutcome[] = [];
  for (const target of plan.targets) {
    try {
      const stopped = await deps.stop(target.id, reason);
      outcomes.push({ target, ok: true, status: stopped.state.status });
    } catch (error) {
      outcomes.push({ target, ok: false, error: errorText(error) });
    }
  }

  try {
    const after = await deps.list();
    const rescanned = buildStopPlan(after, plan.selector, {
      callerId: plan.callerId,
      includeCaller: options.includeCaller,
    });
    const confirmedIds = new Set(plan.candidates.map(target => target.id));
    const knownLeftRunningIds = new Set(plan.leftRunning.map(target => target.id));
    return {
      kind: plan.selector.kind,
      outcomes,
      appeared: rescanned.candidates.filter(target => !confirmedIds.has(target.id)),
      leftRunning: rescanned.leftRunning,
      appearedLeftRunning: rescanned.leftRunning.filter(target => !knownLeftRunningIds.has(target.id)),
    };
  } catch (error) {
    return {
      kind: plan.selector.kind,
      outcomes,
      appeared: [],
      leftRunning: [],
      appearedLeftRunning: [],
      raceCheckError: errorText(error),
    };
  }
}

export function renderStopSweep(result: StopSweepResult): string {
  const lines = [`Stop outcomes (${result.outcomes.length}):`];
  if (!result.outcomes.length) lines.push('  (no stop calls made)');
  for (const outcome of result.outcomes) {
    lines.push(
      outcome.ok
        ? `  OK     ${targetDisplay(outcome.target)} — ${outcome.status ?? 'stopped'}`
        : `  FAILED ${targetDisplay(outcome.target)} — ${outcome.error ?? 'unknown error'}`,
    );
  }
  if (result.raceCheckError) {
    lines.push(
      '',
      `RACE CHECK FAILED: ${result.raceCheckError}`,
      'The fleet may contain unreported new matches; inspect it now.',
    );
  } else if (result.kind === 'orphan') {
    lines.push(
      '',
      `Left running after the orphan stop (${result.leftRunning.length} live ${result.leftRunning.length === 1 ? 'descendant' : 'descendants'}):`,
    );
    if (!result.leftRunning.length) lines.push('  (none)');
    else for (const target of result.leftRunning) lines.push(`  - ${targetDisplay(target)}`);
    if (result.appearedLeftRunning.length) {
      lines.push(
        '',
        `${result.appearedLeftRunning.length} live ${result.appearedLeftRunning.length === 1 ? 'descendant appeared' : 'descendants appeared'} after confirmation and ${result.appearedLeftRunning.length === 1 ? 'was' : 'were'} intentionally NOT stopped:`,
      );
      for (const target of result.appearedLeftRunning) lines.push(`  - ${targetDisplay(target)}`);
    } else {
      lines.push('Race check: no new live descendants appeared after confirmation.');
    }
  } else if (result.appeared.length) {
    lines.push(
      '',
      `${result.appeared.length} matching ${result.appeared.length === 1 ? 'session appeared' : 'sessions appeared'} after confirmation and ${result.appeared.length === 1 ? 'was' : 'were'} NOT stopped:`,
    );
    for (const target of result.appeared) lines.push(`  - ${targetDisplay(target)}`);
    lines.push('Re-run the same command to review and confirm the new set.');
  } else {
    lines.push('', 'Race check: no new matching sessions appeared during the sweep.');
  }
  return `${lines.join('\n')}\n`;
}

function withResolvedRoot(sessions: readonly SessionView[], root: SessionView | undefined): SessionView[] {
  if (!root || sessions.some(view => view.config.id.trim() === root.config.id.trim())) return [...sessions];
  return [...sessions, root];
}

export async function runBulkStop(
  selector: BulkStopSelector,
  options: BulkStopOptions,
  deps: BulkStopDeps,
  callerId = process.env.KTEAM_SESSION_ID,
): Promise<BulkStopRunResult> {
  const root = selector.kind === 'label' ? undefined : await deps.get(selector.rootId);
  const resolvedSelector: BulkStopSelector =
    selector.kind === 'label'
      ? { kind: 'label', label: selector.label.trim() }
      : { ...selector, rootId: root!.config.id.trim() };
  const sessions = withResolvedRoot(await deps.list(), root);
  const plan = buildStopPlan(sessions, resolvedSelector, {
    callerId,
    includeCaller: options.includeCaller,
  });
  deps.io.stdout(renderStopPlan(plan));

  if (options.dryRun) {
    deps.io.stdout('Dry run: no sessions were stopped.\n');
    return { exitCode: 0, plan, confirmed: false };
  }
  if (!plan.targets.length) {
    deps.io.stdout('Nothing eligible to stop.\n');
    return { exitCode: 0, plan, confirmed: false };
  }

  if (!options.yes) {
    if (!deps.io.isInteractive) {
      deps.io.stderr(
        'Refusing an unconfirmed bulk stop on non-interactive input; inspect the list and re-run with --yes.\n',
      );
      return { exitCode: 1, plan, confirmed: false };
    }
    const phrase = confirmationPhrase(plan);
    const answer = await deps.io.confirm(`Type ${JSON.stringify(phrase)} to confirm: `);
    if (answer.trim() !== phrase) {
      deps.io.stderr('Confirmation did not match; no sessions were stopped.\n');
      return { exitCode: 1, plan, confirmed: false };
    }
  }

  const reason = options.reason?.trim() || defaultStopReason(resolvedSelector);
  const sweep = await executeStopSweep(plan, reason, deps, { includeCaller: options.includeCaller });
  deps.io.stdout(renderStopSweep(sweep));
  const failed = sweep.outcomes.some(outcome => !outcome.ok) || sweep.appeared.length > 0 || !!sweep.raceCheckError;
  return { exitCode: failed ? 1 : 0, plan, sweep, confirmed: true };
}

export function processStopIo(): BulkStopIo {
  return {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    isInteractive: !!process.stdin.isTTY && !!process.stderr.isTTY,
    confirm: async prompt => {
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await readline.question(prompt);
      } finally {
        readline.close();
      }
    },
  };
}
