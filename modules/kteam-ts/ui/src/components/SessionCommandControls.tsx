// Harness-native /compact context command.
//
// /compact summarises the model's conversation context and may run a short
// model turn on Claude (Codex compacts locally). The command is idle-only and
// never queues. kteam keeps its transcript; only the running model's context
// is affected.

import { useEffect, useState } from 'react';
import { LoaderCircle, Minimize2 } from 'lucide-react';
import type { SessionView } from '../types';
import { api, ApiError } from '../lib/api';
import { TERMINAL_STATUSES } from '../lib/utils';

/** Older daemons either reject the new runtime action or lack the route. Both
 * cases require a daemon restart, and both refuse the request before injecting
 * anything into the harness. */
export function isSessionCommandUnsupported(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 404 && error.code === 'unknown_route') return true;
  return error instanceof ApiError && error.status === 400 && /runtime action/i.test(error.message);
}

interface SessionCommandControlsProps {
  view: SessionView;
  /** Reopening the sheet retries a stale restart-required verdict. */
  open: boolean;
  canControl: boolean;
}

export function SessionCommandControls({ view, open, canControl }: SessionCommandControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptReady = state.promptReady === true;
  const [busyCommand, setBusyCommand] = useState<'compact' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    setBusyCommand(null);
    setFailure(null);
    setNotice(null);
    setRestartRequired(false);
  }, [config.id]);
  useEffect(() => {
    if (open) {
      setRestartRequired(false);
    }
  }, [open]);

  const ready = canControl && !terminal && promptReady && !restartRequired;

  async function run() {
    if (!ready || busyCommand) return;
    setBusyCommand('compact');
    setFailure(null);
    setNotice(null);
    try {
      await api.runtime(config.id, { action: 'compact' }, crypto.randomUUID());
      setNotice(
        'Compacting context. Claude runs a short turn to summarise (watch the transcript for completion); Codex compacts immediately.',
      );
    } catch (error) {
      if (isSessionCommandUnsupported(error)) {
        setRestartRequired(true);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusyCommand(null);
    }
  }

  const title = 'Session context';
  if (terminal) {
    return (
      <div className="mt-4 border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          Compacting context needs a running session. Resume or relaunch this session first.
        </p>
      </div>
    );
  }
  if (!canControl) {
    return (
      <div className="mt-4 border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          This origin is read-only, so it cannot compact the running session.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-border-soft pt-3">
      <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-meta leading-base text-muted">
        Compact the running model’s context in place. This does not move accounts or relaunch the pane.
      </p>
      {!promptReady && (
        <p className="mt-2 text-meta leading-base text-warn">
          Wait for an idle prompt. The daemon refuses a busy pane instead of queueing these commands.
        </p>
      )}

      {restartRequired ? (
        <p role="alert" className="mt-2 rounded-control border border-warn-border bg-surface-2 p-3 text-ui text-warn">
          Daemon restart required to enable /compact from the web UI. Nothing was changed.
        </p>
      ) : (
        <div className="mt-3 grid gap-2">
          <button
            type="button"
            disabled={!ready || busyCommand !== null}
            onClick={() => void run()}
            aria-label="Compact this session’s context"
            className="kt-btn flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
          >
            <span className="min-w-0">
              <span className="block truncate text-ui font-semibold">
                {busyCommand === 'compact' ? 'Compacting…' : 'Compact context'}
              </span>
              <span className="block truncate text-meta text-muted">
                Summarise to reclaim context. Keeps the conversation.
              </span>
            </span>
            {busyCommand === 'compact' ? (
              <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
            ) : (
              <Minimize2 size={15} aria-hidden="true" className="shrink-0" />
            )}
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="mt-2 text-ui leading-base text-ok">
          {notice}
        </p>
      )}
      {failure && (
        <p
          role="alert"
          className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-ui leading-base text-err"
        >
          {failure}
        </p>
      )}
    </div>
  );
}
