// The model/reasoning switch, ON the chat bar.
//
// The composer's status line already NAMES the model. The user asked for it to
// be the place you CHANGE the model (and, for Codex, the reasoning level) too —
// one tap from where you already are, instead of buried in the details sheet.
//
// So this is a small tap target that reads the model and opens a focused "Switch
// model" bottom sheet built from the SAME RuntimeModelControls the details sheet
// uses — one implementation of the harness rules, not two:
//   - Claude has NO effort control (deliberately absent; the sheet explains why).
//   - Codex reasoning is set through its native two-stage picker (Terminal),
//     never a `/model <name>` string.
//   - Only harness-OBSERVED truth is shown, with the stale-until-evidence
//     labelling; a switch is never optimistically claimed.
//   - The IN-PLACE switch here is deliberately kept apart from the destructive
//     "move account + relaunch", which stays only in the details sheet.
//
// The trigger disables on a busy, terminal or read-only session (a switch cannot
// land on any of those), and the reason is carried non-visually.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import type { SessionView } from '../types';
import { cn, TERMINAL_STATUSES } from '../lib/utils';
import {
  BottomSheet,
  RuntimeModelControls,
  modelObservationChanged,
  observedModelPresentation,
  type ModelObservation,
} from './SessionDetails';

export interface ComposerRuntimeProps {
  view: SessionView;
  /** A token-less origin is read-only and cannot send a runtime command. */
  canControl: boolean;
  /** The session is mid-turn: a switch needs an idle prompt, so the trigger is
   *  disabled (matching the details sheet, which refuses a busy pane). */
  busy: boolean;
  /** Codex opens its native picker in the Terminal view; the page owns that tab
   *  switch. Returns true when the switch was accepted so the sheet can close. */
  onOpenTerminal?: () => boolean;
}

/** The label shown on the bar: the observed runtime model, going stale (not
 *  wrong) after a switch until fresh evidence lands. Falls back to the launch
 *  request only as a last resort, never presented as observed truth. */
function barModelLabel(view: SessionView, pending: boolean): string {
  const observed = observedModelPresentation(view.state.observedModel?.trim(), pending).value;
  if (observed) return observed;
  const requested = view.config.model?.trim() || view.config.modelHint?.trim();
  return requested || 'set model';
}

export function ComposerRuntime({ view, canControl, busy, onOpenTerminal }: ComposerRuntimeProps) {
  const { config, state } = view;
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const sheetId = `${triggerId}-runtime-sheet`;
  const reasonId = `${triggerId}-runtime-reason`;

  // Mirror the details sheet's stale-until-evidence machinery so the bar readout
  // is honest after a switch: mark pending on submit, clear when a new observed
  // model fact (value or timestamp) arrives.
  const observedModel = state.observedModel?.trim();
  const observedAtSwitchRef = useRef<ModelObservation | undefined>(undefined);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const before = observedAtSwitchRef.current;
    if (
      pending &&
      before &&
      modelObservationChanged(before, { model: observedModel, observedAt: state.observedModelAt })
    )
      setPending(false);
  }, [pending, observedModel, state.observedModelAt]);
  useEffect(() => {
    observedAtSwitchRef.current = undefined;
    setPending(false);
  }, [config.id]);
  const markPending = useCallback(() => {
    observedAtSwitchRef.current = { model: observedModel, observedAt: state.observedModelAt };
    setPending(true);
  }, [observedModel, state.observedModelAt]);

  const terminal = TERMINAL_STATUSES.has(state.status);
  const disabledReason = !canControl
    ? 'Read-only origin: it cannot switch the running model.'
    : terminal
      ? 'Session finished: resume it before switching model.'
      : busy
        ? 'Busy: wait for an idle prompt to switch model.'
        : undefined;
  const disabled = Boolean(disabledReason);
  const label = barModelLabel(view, pending);

  return (
    <>
      <button
        type="button"
        id={triggerId}
        // Rest-only, like the ctx readout beside it: you switch model at idle, not
        // mid-keystroke, so it hides while the keyboard is up and the meta line
        // collapses — the reclaimed composer height is preserved. Its 44px hit
        // area is an overlay (index.css `.kt-composer__runtime`), so it does NOT
        // grow the meta line's layout height.
        data-kb-hide
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        aria-label={`Switch model — currently ${label}${pending ? ', switching' : ''}`}
        aria-describedby={disabledReason ? reasonId : undefined}
        title={disabledReason ?? 'Switch model in place'}
        className={cn(
          'kt-composer__runtime mono relative inline-flex min-w-0 items-center gap-xs rounded-control px-1 text-chrome text-fg-soft',
          'hover:text-accent disabled:cursor-not-allowed disabled:hover:text-fg-soft',
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {pending && (
          <span className="shrink-0 not-italic text-faint" aria-hidden="true">
            · switching…
          </span>
        )}
        <ChevronsUpDown size={11} aria-hidden="true" className="shrink-0" />
      </button>
      {disabledReason && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}

      <BottomSheet
        id={sheetId}
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={triggerId}
        ariaLabel="Switch model"
        closeLabel="Close model switcher"
        zIndexClass="z-50"
      >
        <div className="shrink-0 border-b border-border-soft">
          <div className="mx-auto flex w-full max-w-2xl min-w-0 items-baseline gap-sm px-panel pb-row-y">
            <span className="min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg">
              Switch model
            </span>
            <span className="kt-label shrink-0">{config.harness}</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto w-full max-w-2xl px-panel py-row-y">
            <RuntimeModelControls
              view={view}
              open={open}
              canControl={canControl}
              onModelSwitch={markPending}
              onOpenTerminal={onOpenTerminal}
              onClose={() => setOpen(false)}
            />
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
