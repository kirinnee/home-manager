// The microphone control — a self-contained bundle that hands the composer a
// mic BUTTON and a non-modal dictation PANEL, without the composer learning about
// speech.
//
// TAP, NOT HOLD. The mic used to be a press-and-hold control living in the
// composer with no visible flow. A single tap now opens `DictationSheet` and
// starts recording, but the panel deliberately does NOT trap focus or block the
// composer: the reader can keep typing, hide it without cancelling, and bring it
// back with the same mic button.
//
// WHY A HOOK THAT RETURNS NODES. The button belongs in the composer's action
// column while the panel is fixed outside its layout; they are one state
// machine. So `useDictationBundle` owns the state once and hands back both
// nodes, and the composer drops them wherever it likes. `DictationControl` is
// the simple wrapper for mounting them together.
//
// THE ONE OUTPUT IS STILL THE DRAFT. On Insert, the EDITED transcript is placed
// into the composer draft at the caret via the same `insertTranscript` path
// dictation always used — never sent, never anywhere else. Editing happens in
// the sheet first, so the reader sees the words before they commit them.
//
// HIDDEN, NOT DISABLED, when the browser has no microphone API. In an insecure
// context `navigator.mediaDevices` is UNDEFINED — the capability is absent, not
// refused — and a disabled button would imply "not right now".

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mic } from 'lucide-react';
import { Button } from './Primitives';
import { cn } from './../lib/utils';
import {
  useDictation,
  type DictationHandle,
  type DictationPhase,
  type DictationDraftResult,
} from '../hooks/useDictation';
import { insertTranscript, readSelection, type SelectionLike } from '../lib/stt/draft';
import {
  completeTranscriptText,
  editCommittedTranscript,
  editProvisionalTranscript,
  emptyLiveTranscript,
  reduceLiveTranscript,
} from '../lib/stt/live-transcription';
import { DictationSheet, dictationStage, type DictationStage } from './DictationSheet';

export interface DictationControlProps {
  /** Only used to mine enhancement vocabulary. Dictation works without it. */
  sessionId?: string;
  /** The live draft. Read at INSERT time, so text typed during the flow is
   *  preserved and the transcript lands at the current caret. */
  draft: string;
  /** The composer's textarea, for the caret. Without it the transcript is
   *  appended at the end — the right fallback, not an error. */
  selectionRef?: { current: SelectionLike | null };
  /** Receives the COMPLETE next draft plus where the caret should sit, exactly
   *  as before. Called only from the sheet's explicit Insert. */
  onDraftChange: (result: DictationDraftResult) => void;
  disabled?: boolean;
  /** `compact` keeps the 44px square icon-only, for the mobile action column.
   *  `full` shows the word too, for the desktop action row. */
  layout?: 'compact' | 'full';
  className?: string;
}

/** Kept for the copy tests: finishing must be named as local and recording must
 *  not pretend every word is already settled. The sheet inlines its own stage
 *  copy, but this pure map still guards the vocabulary. */
export function dictationStatusCopy(phase: DictationPhase, errorMessage?: string): string {
  switch (phase) {
    case 'requesting':
      return 'Waiting for microphone permission…';
    case 'recording':
      return 'Recording…';
    case 'transcribing':
      return 'Finishing on this device…';
    case 'error':
      return errorMessage ?? 'Dictation failed.';
    case 'idle':
      return '';
  }
}

/** A mic-button press starts only when there is no flow to resume. This is the
 *  safety edge that makes hiding the panel non-destructive: recording,
 *  transcription, review, empty and error states all reopen in place. */
export function dictationTriggerStartsFresh(input: {
  phase: DictationPhase;
  hasTranscript: boolean;
  hasError: boolean;
  wasCapturing: boolean;
}): boolean {
  return input.phase === 'idle' && !input.hasTranscript && !input.hasError && !input.wasCapturing;
}

export interface DictationBundle {
  /** False when this browser has no microphone API. Render nothing. */
  supported: boolean;
  /** The 44px mic button that opens the sheet, or `null` when unsupported. */
  control: ReactNode;
  /** The dictation panel. Always returned (renders nothing while closed) so the
   *  composer can drop it in one place regardless of layout. */
  sheet: ReactNode;
  handle: DictationHandle;
  /** The visible panel stage, exposed for the composer/tests. */
  stage: DictationStage;
}

export function useDictationBundle(props: DictationControlProps): DictationBundle {
  const { draft, onDraftChange, sessionId, selectionRef, disabled, layout = 'compact', className } = props;

  const [open, setOpen] = useState(false);
  const [liveText, setLiveText] = useState(() => emptyLiveTranscript());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [wasCapturing, setWasCapturing] = useState(false);
  const startedAt = useRef(0);

  // The current draft/selection, read at INSERT time rather than captured when
  // the flow started — so a word typed while the sheet was open is not lost and
  // the transcript lands where the caret actually is.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const selectionRefRef = useRef(selectionRef);
  selectionRefRef.current = selectionRef;
  const liveTextRef = useRef(liveText);
  liveTextRef.current = liveText;

  // The capture machine. `draft: ''` so its commit returns the RAW spoken text
  // (it has nothing to insert into); the actual insertion into the composer
  // draft is done by this bundle on Insert, from the edited value.
  const dictation = useDictation({
    sessionId,
    draft: '',
    // The live event consumer below owns reconciliation. This fallback exists
    // only because `useDictation` remains usable without the sheet.
    onDraft: result =>
      setLiveText(current => ({
        ...emptyLiveTranscript(current.generation),
        committed: result.text,
        complete: true,
      })),
    onTranscriptEvent: event => setLiveText(current => reduceLiveTranscript(current, event)),
    disabled,
  });

  const phase = dictation.phase;

  // Once we have passed through a capturing phase, a return to idle with no
  // transcript is a too-short clip — a dead end worth naming ("didn't catch
  // that"), not the fresh-open state. Tracked as state so the stage recomputes.
  useEffect(() => {
    if (phase === 'requesting' || phase === 'recording' || phase === 'transcribing') setWasCapturing(true);
  }, [phase]);

  // Elapsed clock, only while the mic is open. 250ms is smooth enough for a m:ss
  // readout and cheap. Cleared the moment recording ends.
  useEffect(() => {
    if (phase !== 'recording') return;
    const tick = () => setElapsedMs(Math.max(0, performance.now() - startedAt.current));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  const reset = useCallback(() => {
    dictation.cancel();
    setOpen(false);
    setLiveText(emptyLiveTranscript());
    setElapsedMs(0);
    setWasCapturing(false);
  }, [dictation]);

  const beginRecording = useCallback(() => {
    setLiveText(current => emptyLiveTranscript(current.generation));
    setElapsedMs(0);
    setWasCapturing(false);
    startedAt.current = performance.now();
    dictation.dismissError();
    dictation.start();
  }, [dictation]);

  const openAndRecord = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    if (
      dictationTriggerStartsFresh({
        phase,
        hasTranscript: completeTranscriptText(liveText).trim().length > 0,
        hasError: dictation.error !== null,
        wasCapturing,
      })
    ) {
      beginRecording();
    }
  }, [beginRecording, dictation.error, disabled, liveText, phase, wasCapturing]);

  const dismissPanel = useCallback(() => {
    // Hiding is intentionally not cancellation. The recorder, transcript and
    // elapsed clock continue; the mic button reopens this exact flow.
    setOpen(false);
  }, []);

  const insert = useCallback(() => {
    const text = completeTranscriptText(liveTextRef.current).trim();
    if (text.length === 0) {
      reset();
      return;
    }
    const currentDraft = draftRef.current;
    const [start, end] = readSelection(selectionRefRef.current?.current ?? null, currentDraft);
    const result = insertTranscript(currentDraft, start, end, text);
    onDraftChangeRef.current(result);
    reset();
  }, [reset]);

  const hasTranscript = completeTranscriptText(liveText).trim().length > 0;

  const stage = dictationStage({
    phase,
    hasTranscript,
    hasError: dictation.error !== null,
    wasCapturing,
  });

  const flowActive = !dictationTriggerStartsFresh({
    phase,
    hasTranscript,
    hasError: dictation.error !== null,
    wasCapturing,
  });

  const control = dictation.supported ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('min-h-[44px] min-w-[44px] select-none px-2', dictation.recording && 'text-err', className)}
      disabled={disabled}
      aria-expanded={open}
      aria-pressed={dictation.recording}
      aria-label={flowActive ? 'Show dictation recorder' : 'Dictate a message'}
      title={
        flowActive
          ? 'Show the active dictation recorder'
          : 'Dictate locally — edit words while recording, then insert. Nothing is ever sent for you.'
      }
      onClick={openAndRecord}
    >
      <Mic size={15} aria-hidden="true" />
      {layout === 'full' ? <span className="ml-1 text-ui">Dictate</span> : null}
      <span className="sr-only">Dictate a message</span>
    </Button>
  ) : null;

  const sheet = dictation.supported ? (
    <DictationSheet
      open={open}
      stage={stage}
      elapsedMs={elapsedMs}
      inputMonitor={dictation.inputMonitor}
      committedText={liveText.committed}
      provisionalText={liveText.provisional}
      pendingSegments={dictation.pendingSegments}
      onCommittedTextChange={value => setLiveText(current => editCommittedTranscript(current, value))}
      onProvisionalTextChange={value => setLiveText(current => editProvisionalTranscript(current, value))}
      errorCode={dictation.error?.code}
      errorMessage={dictation.error?.message}
      onDismiss={dismissPanel}
      onStop={dictation.stop}
      onCancel={reset}
      onRetry={beginRecording}
      onInsert={insert}
    />
  ) : null;

  return { supported: dictation.supported, control, sheet, handle: dictation, stage };
}

/** The simple mounting form: mic button and its non-modal panel together. */
export function DictationControl(props: DictationControlProps) {
  const { supported, control, sheet } = useDictationBundle(props);
  if (!supported) return null;
  return (
    <>
      {control}
      {sheet}
    </>
  );
}
