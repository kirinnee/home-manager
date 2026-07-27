// The model AND reasoning switches, ON the chat bar.
//
// The composer's status line already NAMES the model. The reader asked for the
// bar to be the place you CHANGE things too — one tap from where you already
// are, instead of buried in the `⋯` details sheet, which is a hard one-handed
// reach on a phone. That request was explicitly about the REASONING level, for
// BOTH harnesses ("can we change codex's level too?").
//
// So the bar carries TWO tap targets side by side, each opening a focused
// bottom sheet built from the SAME controls the details sheet uses — one
// implementation of the harness rules, not two:
//   - The MODEL chip opens RuntimeModelControls (Claude: account-advertised
//     choices; Codex: its native two-stage picker in Terminal).
//   - The REASONING chip opens RuntimeEffortControls:
//       · Claude effort (low|medium|high|xhigh) is set here — a real in-session
//         `/effort` command that persists to the account's settings.json now
//         that kfleet materialises it writable.
//       · Codex reasoning is NOT a `/reasoning <x>` string; it is chosen inside
//         the same native picker as its model, so the chip opens that.
//   - Only harness-OBSERVED truth is shown. The model and (Codex) reasoning
//     readouts go stale-until-evidence after a switch; Claude effort is shown as
//     the level last SENT this session (a confirmed persisted write), never as
//     an observed running value, because Claude does not echo it back.
//   - The IN-PLACE switches here are deliberately kept apart from the
//     destructive "move account + relaunch", which stays only in the details
//     sheet.
//
// Each trigger disables on a busy, terminal or read-only session (a switch
// cannot land on any of those), and the reason is carried non-visually.
//
// HIT AREA: both chips are ordinary buttons that take the app's standard 44px
// coarse-pointer target floor (index.css `--target-floor`). The row is
// `data-kb-hide`, so it is display:none while the keyboard is up — the same
// state the reclaimed composer height is measured in — which means a 44px rest
// height here costs the typing layout nothing. The chips no longer rely on the
// old downward `::after` overlay, which could only reach ~33px at the composer's
// bottom edge because there was no dead space beneath it to grow into.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Brain, ChevronsUpDown } from 'lucide-react';
import type { SessionView } from '../types';
import { cn, TERMINAL_STATUSES } from '../lib/utils';
import { useKeyboardOpen } from '../hooks/useAppViewport';
import {
  BottomSheet,
  RuntimeModelControls,
  RuntimeEffortControls,
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

/** The label shown on the model chip: the observed runtime model, going stale
 *  (not wrong) after a switch until fresh evidence lands. Falls back to the
 *  launch request only as a last resort, never presented as observed truth. */
function barModelLabel(view: SessionView, pending: boolean): string {
  const observed = observedModelPresentation(view.state.observedModel?.trim(), pending).value;
  if (observed) return observed;
  const requested = view.config.model?.trim() || view.config.modelHint?.trim();
  return requested || 'set model';
}

interface ChipProps {
  id: string;
  sheetId: string;
  open: boolean;
  onOpen: () => void;
  disabled: boolean;
  disabledReason?: string;
  reasonId: string;
  /** Full spoken purpose, e.g. "Switch model — currently claude-opus-5". */
  ariaLabel: string;
  title: string;
  /** Leading glyph; the model chip has none, the reasoning chip carries a Brain
   *  so the two are told apart without relying on their text alone. */
  leadingIcon?: React.ReactNode;
  label: string;
  /** Only the model/Codex-reasoning readouts are ever "switching"; Claude effort
   *  never claims a stale-until-evidence state (it is not observed). */
  pending?: boolean;
}

/** One bar chip: a small readout that is also a 44px dialog trigger. It takes
 *  the standard target floor rather than an overlay, so both chips share the
 *  row's real height. */
function RuntimeChip({
  id,
  sheetId,
  open,
  onOpen,
  disabled,
  disabledReason,
  reasonId,
  ariaLabel,
  title,
  leadingIcon,
  label,
  pending,
}: ChipProps) {
  return (
    <button
      type="button"
      id={id}
      onClick={onOpen}
      disabled={disabled}
      aria-disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? sheetId : undefined}
      aria-label={`${ariaLabel}${pending ? ', switching' : ''}`}
      aria-describedby={disabledReason ? reasonId : undefined}
      title={disabledReason ?? title}
      className={cn(
        'kt-composer__runtime mono inline-flex min-w-0 items-center gap-xs rounded-control px-1 text-chrome text-fg-soft',
        'hover:text-accent disabled:cursor-not-allowed disabled:hover:text-fg-soft',
      )}
    >
      {leadingIcon}
      <span className="min-w-0 truncate">{label}</span>
      {pending && (
        <span className="shrink-0 not-italic text-faint" aria-hidden="true">
          · switching…
        </span>
      )}
      <ChevronsUpDown size={11} aria-hidden="true" className="shrink-0" />
    </button>
  );
}

export function ComposerRuntime({ view, canControl, busy, onOpenTerminal }: ComposerRuntimeProps) {
  const { config, state } = view;
  const baseId = useId();
  const modelTriggerId = `${baseId}-model`;
  const effortTriggerId = `${baseId}-effort`;
  const modelSheetId = `${baseId}-model-sheet`;
  const effortSheetId = `${baseId}-effort-sheet`;
  const reasonId = `${baseId}-reason`;
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);

  // The row is `data-kb-hide`, and these chips own dialogs — the one thing that
  // subtree class must never hide with an open panel inside it. In practice a
  // chip tap blurs the composer so the keyboard is already down when a sheet is
  // open, but close defensively if the keyboard ever rises under an open sheet.
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => {
    if (keyboardOpen) {
      setModelOpen(false);
      setEffortOpen(false);
    }
  }, [keyboardOpen]);

  // Mirror the details sheet's stale-until-evidence machinery so the MODEL
  // readout is honest after a switch: mark pending on submit, clear when a new
  // observed model fact (value or timestamp) arrives.
  const observedModel = state.observedModel?.trim();
  const modelAtSwitchRef = useRef<ModelObservation | undefined>(undefined);
  const [modelPending, setModelPending] = useState(false);
  useEffect(() => {
    const before = modelAtSwitchRef.current;
    if (
      modelPending &&
      before &&
      modelObservationChanged(before, { model: observedModel, observedAt: state.observedModelAt })
    )
      setModelPending(false);
  }, [modelPending, observedModel, state.observedModelAt]);

  // Codex reports a reasoning level; there is no timestamp for it, so a switch
  // stays pending until the reported VALUE changes (or the session changes).
  // Claude never sets this — its effort is not observed.
  const observedReasoning = config.harness === 'codex' ? state.observedReasoningEffort?.trim() : undefined;
  const reasoningAtSwitchRef = useRef<string | undefined>(undefined);
  const [reasoningPending, setReasoningPending] = useState(false);
  useEffect(() => {
    if (reasoningPending && reasoningAtSwitchRef.current !== observedReasoning) setReasoningPending(false);
  }, [reasoningPending, observedReasoning]);

  // Claude effort is not observable, so the chip reflects the level last SENT
  // this session (a confirmed persisted write), and resets when the session does.
  const [sentClaudeEffort, setSentClaudeEffort] = useState<string | undefined>(undefined);

  useEffect(() => {
    modelAtSwitchRef.current = undefined;
    reasoningAtSwitchRef.current = undefined;
    setModelPending(false);
    setReasoningPending(false);
    setSentClaudeEffort(undefined);
  }, [config.id]);

  const markModelPending = useCallback(() => {
    modelAtSwitchRef.current = { model: observedModel, observedAt: state.observedModelAt };
    setModelPending(true);
  }, [observedModel, state.observedModelAt]);

  const markReasoningPending = useCallback(() => {
    reasoningAtSwitchRef.current = observedReasoning;
    setReasoningPending(true);
  }, [observedReasoning]);

  // Codex's picker (opened from either chip) can move the reasoning level, so
  // mark reasoning pending whenever the Terminal hand-off is accepted.
  const handleOpenTerminal = useCallback(() => {
    const accepted = onOpenTerminal?.() ?? false;
    if (accepted && config.harness === 'codex') markReasoningPending();
    return accepted;
  }, [onOpenTerminal, config.harness, markReasoningPending]);

  const terminal = TERMINAL_STATUSES.has(state.status);
  const disabledReason = !canControl
    ? 'Read-only origin: it cannot change the running session.'
    : terminal
      ? 'Session finished: resume it before switching.'
      : busy
        ? 'Busy: wait for an idle prompt to switch.'
        : undefined;
  const disabled = Boolean(disabledReason);

  const modelLabel = barModelLabel(view, modelPending);
  // The reasoning chip's readout: Codex shows its observed level; Claude shows
  // the level it last sent, else a neutral verb. Never an unverified claim.
  const effortLabel = config.harness === 'codex' ? observedReasoning || 'reasoning' : sentClaudeEffort || 'effort';
  const effortPending = config.harness === 'codex' && reasoningPending;
  const effortAria =
    config.harness === 'codex'
      ? `Set reasoning level — currently ${observedReasoning || 'unknown'}`
      : sentClaudeEffort
        ? `Set reasoning effort — last set to ${sentClaudeEffort} this session`
        : 'Set reasoning effort';

  return (
    <>
      <div className="kt-composer__runtime-row inline-flex min-w-0 items-center gap-xs" data-kb-hide>
        <RuntimeChip
          id={modelTriggerId}
          sheetId={modelSheetId}
          open={modelOpen}
          onOpen={() => setModelOpen(true)}
          disabled={disabled}
          disabledReason={disabledReason}
          reasonId={reasonId}
          ariaLabel={`Switch model — currently ${modelLabel}`}
          title="Switch model in place"
          label={modelLabel}
          pending={modelPending}
        />
        <RuntimeChip
          id={effortTriggerId}
          sheetId={effortSheetId}
          open={effortOpen}
          onOpen={() => setEffortOpen(true)}
          disabled={disabled}
          disabledReason={disabledReason}
          reasonId={reasonId}
          ariaLabel={effortAria}
          title="Change the reasoning level"
          leadingIcon={<Brain size={11} aria-hidden="true" className="shrink-0" />}
          label={effortLabel}
          pending={effortPending}
        />
      </div>
      {disabledReason && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}

      <BottomSheet
        id={modelSheetId}
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        labelledBy={modelTriggerId}
        ariaLabel="Switch model"
        closeLabel="Close model switcher"
        zIndexClass="z-50"
      >
        <SheetHead title="Switch model" harness={config.harness} />
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto w-full max-w-2xl px-panel py-row-y">
            <RuntimeModelControls
              view={view}
              open={modelOpen}
              canControl={canControl}
              onModelSwitch={markModelPending}
              onOpenTerminal={handleOpenTerminal}
              onClose={() => setModelOpen(false)}
            />
          </div>
        </div>
      </BottomSheet>

      <BottomSheet
        id={effortSheetId}
        open={effortOpen}
        onClose={() => setEffortOpen(false)}
        labelledBy={effortTriggerId}
        ariaLabel="Change reasoning level"
        closeLabel="Close reasoning switcher"
        zIndexClass="z-50"
      >
        <SheetHead title="Reasoning effort" harness={config.harness} />
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto w-full max-w-2xl px-panel py-row-y">
            <RuntimeEffortControls
              view={view}
              canControl={canControl}
              onEffortSwitch={config.harness === 'claude' ? setSentClaudeEffort : undefined}
              onOpenTerminal={handleOpenTerminal}
              onClose={() => setEffortOpen(false)}
            />
          </div>
        </div>
      </BottomSheet>
    </>
  );
}

/** Shared sheet header, so the two bar sheets read identically to each other
 *  and to the details sheet. */
function SheetHead({ title, harness }: { title: string; harness: string }) {
  return (
    <div className="shrink-0 border-b border-border-soft">
      <div className="mx-auto flex w-full max-w-2xl min-w-0 items-baseline gap-sm px-panel pb-row-y">
        <span className="min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg">
          {title}
        </span>
        <span className="kt-label shrink-0">{harness}</span>
      </div>
    </div>
  );
}
