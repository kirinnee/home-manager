// Harness-native /clear and /compact context commands.
//
// /clear immediately wipes the model's conversation context, so the UI gates
// it behind a two-step confirmation. kteam keeps its transcript; only the
// running model forgets. /compact summarises context and may run a short model
// turn on Claude. Both commands are idle-only and never queue.

import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, Minimize2, Trash2 } from 'lucide-react';
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
  const [busyCommand, setBusyCommand] = useState<'clear' | 'compact' | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    setBusyCommand(null);
    setConfirmingClear(false);
    setFailure(null);
    setNotice(null);
    setRestartRequired(false);
  }, [config.id]);
  useEffect(() => {
    if (open) {
      setRestartRequired(false);
      setConfirmingClear(false);
    }
  }, [open]);

  const ready = canControl && !terminal && promptReady && !restartRequired;

  async function run(action: 'clear' | 'compact') {
    if (!ready || busyCommand) return;
    setBusyCommand(action);
    setFailure(null);
    setNotice(null);
    try {
      await api.runtime(config.id, { action }, crypto.randomUUID());
      setConfirmingClear(false);
      setNotice(
        action === 'clear'
          ? 'Cleared the model’s context. This kteam transcript still shows the prior history — only the model forgot it.'
          : 'Compacting context. Claude runs a short turn to summarise (watch the transcript for completion); Codex compacts immediately.',
      );
    } catch (error) {
      if (isSessionCommandUnsupported(error)) {
        setRestartRequired(true);
        setConfirmingClear(false);
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
          Clearing and compacting context need a running session. Resume or relaunch this session first.
        </p>
      </div>
    );
  }
  if (!canControl) {
    return (
      <div className="mt-4 border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          This origin is read-only, so it cannot clear or compact the running session.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-border-soft pt-3">
      <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-meta leading-base text-muted">
        Clear or compact the running model’s context in place. These do not move accounts or relaunch the pane.
      </p>
      {!promptReady && (
        <p className="mt-2 text-meta leading-base text-warn">
          Wait for an idle prompt. The daemon refuses a busy pane instead of queueing these commands.
        </p>
      )}

      {restartRequired ? (
        <p role="alert" className="mt-2 rounded-control border border-warn-border bg-surface-2 p-3 text-ui text-warn">
          Daemon restart required to enable /clear and /compact from the web UI. Nothing was changed.
        </p>
      ) : (
        <div className="mt-3 grid gap-2">
          <button
            type="button"
            disabled={!ready || busyCommand !== null}
            onClick={() => void run('compact')}
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

          {confirmingClear ? (
            <div className="rounded-control border border-err-border bg-surface-2 p-3">
              <p className="m-0 flex items-start gap-xs text-ui leading-base text-err">
                <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>
                  Clear the model’s context? This is not undoable — the model forgets the conversation. (This kteam
                  transcript is kept and still shows the history.)
                </span>
              </p>
              <div className="mt-3 flex flex-wrap gap-sm">
                <button
                  type="button"
                  disabled={busyCommand !== null}
                  onClick={() => void run('clear')}
                  aria-label="Confirm: clear the model’s context"
                  data-variant="danger"
                  className="kt-btn flex min-h-[44px] flex-1 items-center justify-center gap-sm"
                >
                  {busyCommand === 'clear' ? (
                    <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Trash2 size={15} aria-hidden="true" />
                  )}
                  <span>Yes, clear context</span>
                </button>
                <button
                  type="button"
                  disabled={busyCommand !== null}
                  onClick={() => setConfirmingClear(false)}
                  className="kt-btn flex min-h-[44px] flex-1 items-center justify-center"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!ready || busyCommand !== null}
              onClick={() => {
                setFailure(null);
                setNotice(null);
                setConfirmingClear(true);
              }}
              aria-label="Clear this session’s context (asks for confirmation)"
              className="kt-btn flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-ui font-semibold text-err">Clear context…</span>
                <span className="block truncate text-meta text-muted">
                  Wipe the model’s memory. Destructive — asks first.
                </span>
              </span>
              <Trash2 size={15} aria-hidden="true" className="shrink-0 text-err" />
            </button>
          )}
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
