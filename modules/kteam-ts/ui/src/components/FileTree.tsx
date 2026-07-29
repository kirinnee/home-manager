// Collapsible navigation tree for the Files surface — beside the flat list on
// desktop, over it at phone widths (files.css owns that switch; this component
// renders one markup for both).
//
// The tree paints exactly what `file-tree-model.ts` says the daemon has
// answered: an expanded directory shows its listed children, or one honest
// loading / error / empty / truncated note. Nothing is prefetched beyond the
// visible expanded set, and a directory the daemon refuses (denylist,
// gitignore, symlink, unaddressable name) is shown inert with the reason —
// never offered as a branch to descend into.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, FileText, Folder, Link2Off, Loader2, Lock, RefreshCw } from 'lucide-react';
import { describeFsError, fsApi, isAbort } from './files-api';
import { formatBytes } from './files-model';
import {
  createFileTreeState,
  markTreeDirLoading,
  pendingTreeDirs,
  resetTreeDir,
  revealTreeDir,
  setTreeDirError,
  setTreeDirListing,
  invalidateTree,
  toggleTreeDir,
  treeRows,
  type TreeRow,
} from './file-tree-model';

function depthStyle(depth: number): CSSProperties {
  return { '--kt-fs-tree-depth': depth } as CSSProperties;
}

/** Presentational half: rows in, markup out. Exported so the row contract is
 *  testable without a fetch layer, exactly like BrowseList. */
export function FileTreeRows({
  rows,
  onToggle,
  onEnter,
  onOpenFile,
  onRetry,
}: {
  rows: readonly TreeRow[];
  onToggle: (path: string) => void;
  onEnter: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRetry: (dir: string) => void;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {rows.map(row => {
        if (row.kind === 'note') {
          const key = `${row.note}:${row.dir}`;
          if (row.note === 'loading') {
            return (
              <li key={key}>
                <div className="kt-fs-tree-note" role="status" style={depthStyle(row.depth)}>
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  Loading…
                </div>
              </li>
            );
          }
          if (row.note === 'error') {
            return (
              <li key={key}>
                <div className="kt-fs-tree-note" data-tone="err" role="alert" style={depthStyle(row.depth)}>
                  <span>
                    Could not list {row.dir || 'the session root'}: {row.error}
                  </span>
                  <button
                    type="button"
                    className="kt-btn kt-btn--sm kt-fs-retry"
                    onClick={() => onRetry(row.dir)}
                    aria-label={`Retry listing ${row.dir || 'the session root'}`}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Retry
                  </button>
                </div>
              </li>
            );
          }
          return (
            <li key={key}>
              <div className="kt-fs-tree-note" role="status" style={depthStyle(row.depth)}>
                {row.note === 'empty' ? 'Empty.' : 'Listing truncated by the daemon.'}
              </div>
            </li>
          );
        }

        const icon = row.refusal?.includes('leaves') ? (
          <Link2Off size={14} className="kt-fs-icon" aria-hidden="true" />
        ) : row.refusal ? (
          <Lock size={14} className="kt-fs-icon" aria-hidden="true" />
        ) : row.kind === 'dir' ? (
          <Folder size={14} className="kt-fs-icon" aria-hidden="true" />
        ) : (
          <FileText size={14} className="kt-fs-icon" aria-hidden="true" />
        );

        if (row.refusal) {
          // Same rule as the flat list: a control that exists only to refuse is
          // a worse answer than an inert row that states the reason.
          return (
            <li key={`${row.kind}:${row.path}`}>
              <div
                className="kt-fs-tree-row"
                data-kind={row.kind}
                data-inert="true"
                style={depthStyle(row.depth)}
                title={row.refusal}
                aria-label={`${row.name}${row.kind === 'dir' ? '/' : ''} — ${row.refusal}`}
              >
                {icon}
                <span className="kt-fs-tree-name">
                  {row.name}
                  {row.kind === 'dir' ? '/' : ''}
                </span>
              </div>
            </li>
          );
        }

        if (row.kind === 'dir') {
          return (
            <li key={`dir:${row.path}`}>
              <div
                className="kt-fs-tree-row"
                data-kind="dir"
                data-selected={row.selected || undefined}
                style={depthStyle(row.depth)}
              >
                <button
                  type="button"
                  className="kt-fs-tree-toggle"
                  aria-expanded={row.expanded}
                  onClick={() => onToggle(row.path)}
                  aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.path}`}
                  title={row.expanded ? 'Collapse' : 'Expand'}
                >
                  <ChevronRight
                    size={14}
                    className={row.expanded ? 'rotate-90 transition-transform' : 'transition-transform'}
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  className="kt-fs-tree-open"
                  aria-current={row.selected ? 'location' : undefined}
                  onClick={() => onEnter(row.path)}
                  aria-label={`Go to folder ${row.path}`}
                  title={row.path}
                >
                  {icon}
                  <span className="kt-fs-tree-name">{row.name}/</span>
                </button>
              </div>
            </li>
          );
        }

        return (
          <li key={`file:${row.path}`}>
            <div className="kt-fs-tree-row" data-kind="file" style={depthStyle(row.depth)}>
              <button
                type="button"
                className="kt-fs-tree-open"
                onClick={() => onOpenFile(row.path)}
                aria-label={`Open file ${row.path}${row.size != null ? `, ${formatBytes(row.size)}` : ''}`}
                title={row.path}
              >
                {icon}
                <span className="kt-fs-tree-name">{row.name}</span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface FileTreeProps {
  sessionId: string;
  /** The browse pane's current directory: revealed (ancestors expanded) and
   *  marked as the selected row. */
  dir: string;
  /** Bumps when the bar's refresh runs: every listing is forgotten and
   *  re-asked; the reader's expansion survives. */
  refreshNonce?: number;
  /** Kept mounted (hidden) while a file is open so expansion survives. */
  hidden?: boolean;
  onEnter: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export function FileTree({ sessionId, dir, refreshNonce = 0, hidden, onEnter, onOpenFile }: FileTreeProps) {
  const [state, setState] = useState(createFileTreeState);
  const inflight = useRef(new Map<string, AbortController>());

  useEffect(() => {
    setState(current => revealTreeDir(current, dir));
  }, [dir]);

  useEffect(() => {
    if (refreshNonce === 0) return;
    // A response already in flight belongs to the pre-refresh world; letting it
    // land would resurrect stale children as if they were fresh.
    for (const controller of inflight.current.values()) controller.abort();
    inflight.current.clear();
    setState(invalidateTree);
  }, [refreshNonce]);

  useEffect(() => {
    for (const pendingDir of pendingTreeDirs(state)) {
      if (inflight.current.has(pendingDir)) continue;
      const controller = new AbortController();
      inflight.current.set(pendingDir, controller);
      setState(current => markTreeDirLoading(current, pendingDir));
      fsApi
        .list(sessionId, pendingDir, controller.signal)
        .then(listing => {
          if (!controller.signal.aborted) setState(current => setTreeDirListing(current, pendingDir, listing));
        })
        .catch(error => {
          if (controller.signal.aborted || isAbort(error)) return;
          setState(current => setTreeDirError(current, pendingDir, describeFsError(error)));
        })
        .finally(() => {
          // A refresh may have already registered a NEWER request for this dir.
          if (inflight.current.get(pendingDir) === controller) inflight.current.delete(pendingDir);
        });
    }
  }, [state, sessionId]);

  useEffect(() => {
    const registry = inflight.current;
    return () => {
      for (const controller of registry.values()) controller.abort();
    };
  }, []);

  return (
    <nav className="kt-fs-tree scroll-thin" aria-label="Folder tree" hidden={hidden || undefined}>
      <FileTreeRows
        rows={treeRows(state, dir)}
        onToggle={path => setState(current => toggleTreeDir(current, path))}
        onEnter={onEnter}
        onOpenFile={onOpenFile}
        onRetry={retryDir => setState(current => resetTreeDir(current, retryDir))}
      />
    </nav>
  );
}
