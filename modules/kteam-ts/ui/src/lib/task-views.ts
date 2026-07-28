import {
  TASK_STATUSES,
  type TaskDag,
  type TaskDagEdge,
  type TaskDagNode,
  type TaskStatus,
  type TaskSummary,
} from './tasks';

/** `null` is the explicit All state, matching the lineage filter vocabulary. */
export function toggleTaskStatusFilter(
  current: ReadonlySet<TaskStatus> | null,
  status: TaskStatus,
): ReadonlySet<TaskStatus> | null {
  if (current === null) return new Set([status]);
  const next = new Set(current);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return next.size === 0 ? null : next;
}

export function taskStatusCounts(tasks: readonly TaskSummary[]): ReadonlyMap<TaskStatus, number> {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return counts;
}

/** Keep selected zero-count statuses mounted so a filter can always be removed. */
export function orderedTaskStatuses(
  counts: ReadonlyMap<TaskStatus, number>,
  selected: ReadonlySet<TaskStatus> | null,
): TaskStatus[] {
  const visible = new Set(counts.keys());
  if (selected) for (const status of selected) visible.add(status);
  return TASK_STATUSES.filter(status => visible.has(status));
}

export function filterTasksByStatuses(
  tasks: readonly TaskSummary[],
  statuses: ReadonlySet<TaskStatus> | null,
): TaskSummary[] {
  return statuses === null ? [...tasks] : tasks.filter(task => statuses.has(task.status));
}

export interface FilteredTaskDagNode extends TaskDagNode {
  /** False means this node is present only to preserve dependency ancestry. */
  matchesFilter: boolean;
}

export interface FilteredTaskDag {
  nodes: FilteredTaskDagNode[];
  edges: TaskDagEdge[];
  matchCount: number;
  contextCount: number;
}

/**
 * Exact-status DAG filtering without false roots. A matching task keeps every
 * transitive dependency, including missing records, and those non-matches are
 * exposed as PATH context. Unrelated branches disappear. Edges in TaskDag point
 * from dependent -> dependency, so ancestry traversal follows `edge.to`.
 */
export function filterTaskDag(dag: TaskDag, statuses: ReadonlySet<TaskStatus> | null): FilteredTaskDag {
  if (statuses === null) {
    return {
      nodes: dag.nodes.map(node => ({ ...node, matchesFilter: true })),
      edges: [...dag.edges],
      matchCount: dag.nodes.length,
      contextCount: 0,
    };
  }

  const directMatches = new Set(
    dag.nodes.flatMap(node => (node.task && statuses.has(node.task.status) ? [node.id] : [])),
  );
  const dependencies = new Map<string, string[]>();
  for (const edge of dag.edges) {
    const ids = dependencies.get(edge.from);
    if (ids) ids.push(edge.to);
    else dependencies.set(edge.from, [edge.to]);
  }

  const included = new Set(directMatches);
  const pending = [...directMatches];
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const dependency of dependencies.get(id) ?? []) {
      if (included.has(dependency)) continue;
      included.add(dependency);
      pending.push(dependency);
    }
  }

  const nodes = dag.nodes.flatMap<FilteredTaskDagNode>(node =>
    included.has(node.id) ? [{ ...node, matchesFilter: directMatches.has(node.id) }] : [],
  );
  return {
    nodes,
    edges: dag.edges.filter(edge => included.has(edge.from) && included.has(edge.to)),
    matchCount: directMatches.size,
    contextCount: nodes.length - directMatches.size,
  };
}

export function taskFilterSummary(matchCount: number, contextCount: number): string {
  return `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} · ${contextCount} ${contextCount === 1 ? 'path' : 'paths'}`;
}

export interface TaskDagLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  columnGap?: number;
  rowGap?: number;
  padding?: number;
}

export interface TaskDagLayoutNode extends FilteredTaskDagNode {
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export interface TaskDagLayoutEdge {
  /** Original TaskDag direction: dependent -> dependency. */
  dependentId: string;
  dependencyId: string;
  /** Rendered direction is dependency -> dependent, top to bottom. */
  fromId: string;
  toId: string;
  path: string;
}

export interface TaskDagLayout {
  width: number;
  height: number;
  nodes: TaskDagLayoutNode[];
  edges: TaskDagLayoutEdge[];
}

const nodeSortKey = (node: FilteredTaskDagNode): string => {
  const order = node.task?.order;
  const rank = order === null || order === undefined ? '999999999' : String(order).padStart(9, '0');
  return `${rank}\u0000${node.task?.title ?? node.id}\u0000${node.id}`;
};

/**
 * A deterministic, dependency-first layered layout. Longest dependency depth
 * places roots at the top; a barycentric pass keeps children near their parents
 * and reduces crossings without a runtime graph library.
 */
export function layoutTaskDag(dag: FilteredTaskDag, options: TaskDagLayoutOptions = {}): TaskDagLayout {
  const nodeWidth = options.nodeWidth ?? 228;
  const nodeHeight = options.nodeHeight ?? 92;
  const columnGap = options.columnGap ?? 38;
  const rowGap = options.rowGap ?? 88;
  const padding = options.padding ?? 32;
  if (dag.nodes.length === 0) return { width: padding * 2, height: padding * 2, nodes: [], edges: [] };

  const byId = new Map(dag.nodes.map(node => [node.id, node]));
  const dependencies = new Map<string, string[]>();
  for (const edge of dag.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const list = dependencies.get(edge.from);
    if (list) list.push(edge.to);
    else dependencies.set(edge.from, [edge.to]);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let result = 0;
    for (const dependency of dependencies.get(id) ?? []) result = Math.max(result, visit(dependency) + 1);
    visiting.delete(id);
    depth.set(id, result);
    return result;
  };
  for (const node of dag.nodes) visit(node.id);

  const levels = new Map<number, FilteredTaskDagNode[]>();
  for (const node of dag.nodes) {
    const level = depth.get(node.id) ?? 0;
    const list = levels.get(level);
    if (list) list.push(node);
    else levels.set(level, [node]);
  }
  const maxDepth = Math.max(...levels.keys());
  for (const nodes of levels.values()) nodes.sort((a, b) => nodeSortKey(a).localeCompare(nodeSortKey(b)));

  // One dependency-to-dependent sweep. Dependency ranks from every shallower
  // level are useful because longest-depth layouts can legitimately skip rows.
  const rank = new Map<string, number>();
  for (let level = 0; level <= maxDepth; level += 1) {
    const nodes = levels.get(level) ?? [];
    if (level > 0) {
      nodes.sort((a, b) => {
        const barycenter = (node: FilteredTaskDagNode): number => {
          const positions = (dependencies.get(node.id) ?? []).flatMap(id => {
            const position = rank.get(id);
            return position === undefined ? [] : [position];
          });
          return positions.length === 0
            ? Number.POSITIVE_INFINITY
            : positions.reduce((sum, position) => sum + position, 0) / positions.length;
        };
        const delta = barycenter(a) - barycenter(b);
        return Number.isFinite(delta) && delta !== 0 ? delta : nodeSortKey(a).localeCompare(nodeSortKey(b));
      });
    }
    nodes.forEach((node, index) => rank.set(node.id, index));
  }

  const widestLevel = Math.max(...[...levels.values()].map(nodes => nodes.length));
  const graphWidth = widestLevel * nodeWidth + Math.max(0, widestLevel - 1) * columnGap;
  const width = graphWidth + padding * 2;
  const height = (maxDepth + 1) * nodeHeight + maxDepth * rowGap + padding * 2;
  const positioned = new Map<string, TaskDagLayoutNode>();
  for (let level = 0; level <= maxDepth; level += 1) {
    const nodes = levels.get(level) ?? [];
    const levelWidth = nodes.length * nodeWidth + Math.max(0, nodes.length - 1) * columnGap;
    const offset = padding + (graphWidth - levelWidth) / 2;
    nodes.forEach((node, index) => {
      positioned.set(node.id, {
        ...node,
        x: offset + index * (nodeWidth + columnGap),
        y: padding + level * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
        depth: level,
      });
    });
  }

  const edges = dag.edges.flatMap<TaskDagLayoutEdge>(edge => {
    const dependency = positioned.get(edge.to);
    const dependent = positioned.get(edge.from);
    if (!dependency || !dependent) return [];
    const x1 = dependency.x + dependency.width / 2;
    const y1 = dependency.y + dependency.height;
    const x2 = dependent.x + dependent.width / 2;
    const y2 = dependent.y;
    const middle = y1 + (y2 - y1) / 2;
    return [
      {
        dependentId: edge.from,
        dependencyId: edge.to,
        fromId: edge.to,
        toId: edge.from,
        path: `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`,
      },
    ];
  });

  return { width, height, nodes: [...positioned.values()], edges };
}

/** A visual preview only; callers must expose the unchanged title in `title`/ARIA. */
export function taskTitlePreview(title: string, maxCharacters = 30): string {
  if (title.length <= maxCharacters) return title;
  return `${title.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`;
}
