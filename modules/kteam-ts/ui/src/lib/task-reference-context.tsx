// App-wide proof for task references.
//
// A syntactically valid #F12 is not evidence that the task exists. This provider
// maintains one fleet task-id index from the existing aggregate endpoint and
// refreshes it when the one FleetStore socket reports `tasks.updated`. Every
// Markdown surface consumes the same resolver; none starts its own request.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { type TaskReferenceResolver } from './remark-task-references';
import { useFleetEvents } from './store';
import { parseTaskListResponse, type TaskSummary } from './tasks';

const unresolved: TaskReferenceResolver = () => false;
const TaskReferenceContext = createContext<TaskReferenceResolver>(unresolved);

export function createTaskReferenceResolver(tasks: readonly Pick<TaskSummary, 'id'>[]): TaskReferenceResolver {
  const ids = new Set(tasks.map(task => task.id.toUpperCase()));
  return id => ids.has(id.toUpperCase());
}

export function TaskReferenceProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [revision, setRevision] = useState(0);

  useFleetEvents(event => {
    if (event.type === 'tasks.updated') setRevision(value => value + 1);
  });

  const refresh = useCallback(() => {
    let current = true;
    void api
      .listTasks()
      .then(value => {
        if (current) setTasks(parseTaskListResponse(value).tasks);
      })
      .catch(() => {
        // Failure never manufactures proof. Keep the last positively parsed
        // snapshot when one exists; an initial failure therefore means no links.
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(refresh, [refresh, revision]);
  const resolver = useMemo(() => createTaskReferenceResolver(tasks), [tasks]);
  return <TaskReferenceContext.Provider value={resolver}>{children}</TaskReferenceContext.Provider>;
}

export function useTaskReferenceResolver(): TaskReferenceResolver {
  return useContext(TaskReferenceContext);
}
