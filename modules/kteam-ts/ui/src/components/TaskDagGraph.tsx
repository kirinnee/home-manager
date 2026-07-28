import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { navigate } from '../lib/router';
import {
  TASK_STATUS_META,
  taskReference,
  type TaskDagNode,
  type TaskFileConflict,
  type TaskStatus,
} from '../lib/tasks';
import { layoutTaskDag, taskTitlePreview, type FilteredTaskDag, type TaskDagLayout } from '../lib/task-views';
import { taskAssigneePresentation } from './TaskAssigneeLink';
import './task-dag.css';

interface DagTransform {
  x: number;
  y: number;
  scale: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

// Keep fitted nodes at least 46 CSS px tall (92 graph units × 0.5) so a phone
// user can still identify and tap them. Larger graphs remain pannable.
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const DEFAULT_VIEWPORT: ViewportSize = { width: 390, height: 520 };
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function fitTaskDagTransform(
  layout: Pick<TaskDagLayout, 'width' | 'height'>,
  viewport: ViewportSize,
): DagTransform {
  const availableWidth = Math.max(1, viewport.width - 24);
  const availableHeight = Math.max(1, viewport.height - 24);
  const scale = clamp(Math.min(availableWidth / layout.width, availableHeight / layout.height), MIN_SCALE, 1.25);
  return {
    x: (viewport.width - layout.width * scale) / 2,
    y: (viewport.height - layout.height * scale) / 2,
    scale,
  };
}

type NodeVariables = CSSProperties & {
  '--task-node-color': string;
  '--task-node-fill': string;
};

const STATUS_COLORS: Record<TaskStatus, [string, string]> = {
  todo: ['var(--muted)', 'var(--surface-2)'],
  researched: ['var(--warn)', 'var(--warn-bg)'],
  designed: ['var(--accent)', 'var(--accent-soft)'],
  in_progress: ['var(--warn)', 'var(--warn-bg)'],
  built: ['var(--accent)', 'var(--accent-soft)'],
  live: ['var(--ok)', 'var(--ok-bg)'],
  done: ['var(--ok)', 'var(--ok-bg)'],
  blocked: ['var(--err)', 'var(--err-bg)'],
  dropped: ['var(--err)', 'var(--err-bg)'],
};

const taskVisualStatus = (node: TaskDagNode): TaskStatus | null => {
  if (!node.task) return null;
  return node.task.blocked ? 'blocked' : node.task.status;
};

const nodeVariables = (node: TaskDagNode): NodeVariables => {
  const visualStatus = taskVisualStatus(node);
  const [color, fill] = visualStatus ? STATUS_COLORS[visualStatus] : ['var(--warn)', 'var(--surface-2)'];
  return { '--task-node-color': color, '--task-node-fill': fill };
};

const pointerPoint = (event: ReactPointerEvent): { x: number; y: number } => ({
  x: event.clientX,
  y: event.clientY,
});

export function shouldNavigateTaskAgentLink(
  event: Pick<MouseEvent, 'altKey' | 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}

export function TaskDagGraph({
  dag,
  conflicts,
  onOpen,
  onShowAll,
}: {
  dag: FilteredTaskDag;
  conflicts?: ReadonlyMap<string, readonly TaskFileConflict[]>;
  onOpen: (node: TaskDagNode) => void;
  onShowAll?: () => void;
}) {
  const layout = useMemo(() => layoutTaskDag(dag), [dag]);
  const markerId = `task-dag-arrow-${useId().replaceAll(':', '')}`;
  const canvasRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, pinchDistance: 0 });
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [transform, setTransform] = useState(() => fitTaskDagTransform(layout, DEFAULT_VIEWPORT));
  const layoutWidth = layout.width;
  const layoutHeight = layout.height;

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const size = canvas
      ? { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) }
      : DEFAULT_VIEWPORT;
    setViewport(current => (current.width === size.width && current.height === size.height ? current : size));
    setTransform(fitTaskDagTransform({ width: layoutWidth, height: layoutHeight }, size));
  }, [layoutHeight, layoutWidth]);

  useEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [fit]);

  const zoomAt = useCallback((factor: number, anchorX: number, anchorY: number) => {
    setTransform(current => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      if (scale === current.scale) return current;
      const graphX = (anchorX - current.x) / current.scale;
      const graphY = (anchorY - current.y) / current.scale;
      return { x: anchorX - graphX * scale, y: anchorY - graphY * scale, scale };
    });
  }, []);

  // React delegates wheel events through a passive root listener, where
  // preventDefault() cannot stop the page scrolling beneath the graph. Bind the
  // canvas directly so wheel zoom owns that gesture without console warnings.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(Math.pow(1.0016, -event.deltaY), event.clientX - rect.left, event.clientY - rect.top);
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [zoomAt]);

  const zoomCenter = (factor: number) => zoomAt(factor, viewport.width / 2, viewport.height / 2);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-task-agent-link]')) return;
    pointers.current.set(event.pointerId, pointerPoint(event));
    if (pointers.current.size === 1) gesture.current.moved = false;
    if (pointers.current.size === 2) gesture.current.pinchDistance = 0;
    event.currentTarget.dataset.panning = 'true';
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a progressive enhancement; windowless tests omit it.
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const next = pointerPoint(event);
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size >= 2) {
      const [first, second] = [...pointers.current.values()];
      if (!first || !second) return;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const rect = event.currentTarget.getBoundingClientRect();
      const anchorX = (first.x + second.x) / 2 - rect.left;
      const anchorY = (first.y + second.y) / 2 - rect.top;
      if (gesture.current.pinchDistance > 0) zoomAt(distance / gesture.current.pinchDistance, anchorX, anchorY);
      gesture.current.pinchDistance = distance;
      gesture.current.moved = true;
    } else {
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) gesture.current.moved = true;
      setTransform(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
    }
    event.preventDefault();
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current.pinchDistance = 0;
    if (pointers.current.size === 0) delete event.currentTarget.dataset.panning;
  };

  const openNode = (node: TaskDagNode) => {
    if (!gesture.current.moved && !node.missing) onOpen(node);
  };

  const onNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, node: TaskDagNode) => {
    if (node.missing || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onOpen(node);
  };

  return (
    <section data-task-graph="layered-svg" aria-label="Task dependency graph" className="kt-task-dag-shell">
      <div className="kt-task-dag-toolbar">
        <p className="kt-task-dag-help">Dependencies flow down · drag to pan · pinch or buttons to zoom</p>
        <div className="kt-task-dag-zoom" aria-label="Graph zoom controls">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomCenter(1 / 1.25)}>
            <Minus size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Fit graph" title="Fit graph" onClick={fit}>
            <Maximize2 size={15} aria-hidden="true" />
            <span>Fit</span>
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomCenter(1.25)}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={canvasRef}
        className="kt-task-dag-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {layout.nodes.length === 0 ? (
          <div className="kt-task-dag-empty" role="status">
            <span>No task nodes match this status filter.</span>
            {onShowAll && (
              <button type="button" onClick={onShowAll}>
                Show all
              </button>
            )}
          </div>
        ) : (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${viewport.width} ${viewport.height}`}
            role="group"
            aria-label={`${dag.matchCount} matching task ${dag.matchCount === 1 ? 'node' : 'nodes'} and ${dag.contextCount} dependency ${dag.contextCount === 1 ? 'path' : 'paths'}`}
          >
            <defs>
              <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path className="kt-task-dag-arrow" d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
              <g aria-hidden="true">
                {layout.edges.map(edge => (
                  <path
                    key={`${edge.dependentId}->${edge.dependencyId}`}
                    data-task-edge={`${edge.dependentId}->${edge.dependencyId}`}
                    className="kt-task-dag-edge"
                    d={edge.path}
                    markerEnd={`url(#${markerId})`}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
              {layout.nodes.map(node => {
                const task = node.task;
                const title = task?.title ?? taskReference(node.id);
                const visualStatus = taskVisualStatus(node);
                const status = visualStatus ? TASK_STATUS_META[visualStatus].label : 'Missing dependency';
                const identity = task ? taskAssigneePresentation(task) : null;
                const agentHref = identity?.href ?? null;
                const nodeConflicts = conflicts?.get(node.id) ?? [];
                const context = node.matchesFilter ? '' : ' — PATH dependency context';
                const crossSession = node.crossSession ? ' — owned by another session' : '';
                const conflictText =
                  nodeConflicts.length > 0
                    ? ` — shares files with ${nodeConflicts.map(conflict => taskReference(conflict.taskId)).join(', ')}`
                    : '';
                const accessible = `${taskReference(node.id)}: ${title} — ${status}${identity ? ` — ${identity.label}` : ''}${context}${crossSession}${conflictText}`;
                return (
                  <g
                    key={node.id}
                    data-task-node={node.id}
                    data-task-status={visualStatus ?? 'missing'}
                    data-task-filter={node.matchesFilter ? 'match' : 'context'}
                    data-task-cross-session={node.crossSession ? 'true' : undefined}
                    data-task-missing={node.missing ? 'true' : undefined}
                    data-task-conflicts={nodeConflicts.length || undefined}
                    className="kt-task-dag-node"
                    transform={`translate(${node.x} ${node.y})`}
                    style={nodeVariables(node)}
                  >
                    <title>{accessible}</title>
                    <g
                      data-task-node-hit
                      className="kt-task-dag-node-hit"
                      role={node.missing ? 'img' : 'button'}
                      tabIndex={node.missing ? undefined : 0}
                      aria-label={accessible}
                      onClick={() => openNode(node)}
                      onKeyDown={event => onNodeKeyDown(event, node)}
                    >
                      <rect
                        className="kt-task-dag-node-box"
                        width={node.width}
                        height={node.height}
                        rx="5"
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle className="kt-task-dag-node-dot" cx="16" cy="18" r="4" />
                      <text className="kt-task-dag-node-title" x="27" y="23">
                        {taskTitlePreview(title)}
                      </text>
                      <text className="kt-task-dag-node-meta" x="16" y="49">
                        {taskReference(node.id)} · {status.toUpperCase()}
                      </text>
                      {identity && (
                        <circle
                          className="kt-task-dag-agent-dot"
                          data-health={task?.live.assigneeHealth ?? 'unknown'}
                          cx="16"
                          cy="72"
                          r="3"
                        />
                      )}
                      {identity && !identity.href && (
                        <text className="kt-task-dag-node-agent kt-task-dag-node-agent--plain" x="27" y="76">
                          {taskTitlePreview(identity.name, 24)}
                        </text>
                      )}
                      {(!node.matchesFilter || node.crossSession) && (
                        <text className="kt-task-dag-node-context" x={node.width - 10} y="48" textAnchor="end">
                          {[!node.matchesFilter ? 'PATH' : '', node.crossSession ? 'OTHER' : '']
                            .filter(Boolean)
                            .join(' · ')}
                        </text>
                      )}
                      {nodeConflicts.length > 0 && (
                        <text className="kt-task-dag-node-conflicts" x={node.width - 10} y="76" textAnchor="end">
                          ⚠ {nodeConflicts.length}
                        </text>
                      )}
                    </g>
                    {identity && agentHref && (
                      <a
                        href={agentHref}
                        data-task-agent-link
                        aria-label={`Open ${identity.name}'s session`}
                        onPointerDown={event => event.stopPropagation()}
                        onClick={event => {
                          event.stopPropagation();
                          if (!shouldNavigateTaskAgentLink(event)) return;
                          event.preventDefault();
                          navigate(agentHref);
                        }}
                      >
                        <text className="kt-task-dag-node-agent" x="27" y="76">
                          {taskTitlePreview(identity.name, 24)}
                        </text>
                      </a>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </section>
  );
}
