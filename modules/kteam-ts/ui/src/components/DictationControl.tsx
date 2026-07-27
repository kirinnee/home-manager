// The microphone control — a self-contained bundle, ready to mount in the
// composer without the composer learning anything about speech.
//
// WHY A HOOK THAT RETURNS NODES, rather than two components. The button belongs
// in the action row and the status line belongs in the meta row — two different
// places in `Composer`'s layout — but they are one state machine. Two separate
// components would each call `useDictation` and each get their own microphone.
// So `useDictationBundle` owns the state once and hands back two nodes, and the
// integration puts them wherever it likes. `DictationControl` is the simple
// wrapper for the case where they can sit together.
//
// HOLD TO TALK. Press and hold; release to send it for transcription. This is
// not a toggle, and the difference matters on a phone: a toggle that fails to
// register its second tap leaves the microphone open indefinitely, and the
// reader has no way to know. A hold cannot: letting go of the button is the
// same physical act as ending the recording, and every release path —
// pointerup, pointercancel, lost pointer capture, keyup, blur — stops it.
//
// THE CLICK IS SUPPRESSED. A `<button>` fires `click` after `pointerup`, and
// again for Space/Enter. Without `preventDefault` on `onClick` the gesture
// would run twice. Nothing here is wired to click at all.
//
// HIDDEN, NOT DISABLED, when the browser has no microphone API. In an insecure
// context `navigator.mediaDevices` is UNDEFINED — the capability is absent, not
// refused — and a disabled button would tell the reader "not right now" about
// something that will never work at this URL.

import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Mic, Loader2, AlertCircle } from 'lucide-react';
import { Button } from './Primitives';
import { cn } from '../lib/utils';
import {
  useDictation,
  type DictationHandle,
  type DictationPhase,
  type DictationDraftResult,
} from '../hooks/useDictation';
import type { SelectionLike } from '../lib/stt/draft';
import { useSttSettings, type SttMode } from '../lib/stt/stt-settings';

export interface DictationControlProps {
  /** Only used to mine enhancement vocabulary. Dictation works without it. */
  sessionId?: string;
  /** The live draft. Read at commit time, so text typed during an utterance is
   *  preserved. */
  draft: string;
  /** The composer's textarea, for the caret. Without it the transcript is
   *  appended at the end — the right fallback, not an error. */
  selectionRef?: { current: SelectionLike | null };
  /** Receives the COMPLETE next draft plus where the caret should sit. It is
   *  the only thing this component ever calls with a transcript. */
  onDraftChange: (result: DictationDraftResult) => void;
  disabled?: boolean;
  /** `compact` drops the label text and keeps the 44 px square, for the mobile
   *  action row. `full` shows the word too. */
  layout?: 'compact' | 'full';
  className?: string;
}

/** What the reader is told, per phase. Pure, so the copy has a test and so the
 *  one rule — never claim live text — is checkable rather than remembered.
 *
 *  `Transcribing…` deliberately has no progress and no estimate: the daemon's
 *  measured behaviour on this fleet is a first partial at 48 s for a 7.4 s clip,
 *  so any number here would be a guess dressed as a fact. */
export function dictationStatusCopy(phase: DictationPhase, mode: SttMode, errorMessage?: string): string {
  switch (phase) {
    case 'requesting':
      return 'Waiting for microphone permission…';
    case 'recording':
      return 'Recording…';
    case 'transcribing':
      return mode === 'local' ? 'Transcribing on this device…' : 'Transcribing…';
    case 'error':
      return errorMessage ?? 'Dictation failed.';
    case 'idle':
      return '';
  }
}

/** The button's accessible name. It changes with state because a screen reader
 *  user cannot see the icon change. */
export function dictationButtonLabel(phase: DictationPhase): string {
  if (phase === 'recording') return 'Recording — release to transcribe';
  if (phase === 'transcribing') return 'Transcribing your recording';
  return 'Hold to dictate';
}

export interface DictationBundle {
  /** False when this browser has no microphone API. Render nothing. */
  supported: boolean;
  recording: boolean;
  busy: boolean;
  /** The 44 px hold-to-talk button, or `null` when unsupported. */
  control: ReactNode;
  /** A compact, FIXED-HEIGHT status line. Always returns a node (an empty one
   *  when idle) so mounting it cannot change the composer's height mid-stream —
   *  the composer's height contract is explicit about that. */
  status: ReactNode;
  handle: DictationHandle;
}

export function useDictationBundle(props: DictationControlProps): DictationBundle {
  const { draft, onDraftChange, sessionId, selectionRef, disabled, layout = 'compact', className } = props;
  const held = useRef(false);
  const { settings } = useSttSettings();

  const dictation = useDictation({
    sessionId,
    draft,
    selectionRef,
    onDraft: onDraftChange,
    disabled,
  });

  const beginHold = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Stops the press from moving focus out of the textarea and from starting
      // a text selection or a long-press menu on touch.
      event.preventDefault();
      if (held.current) return;
      held.current = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an optimisation — without it the pointerup may
        // land on another element, which is what `onPointerLeave` covers.
      }
      dictation.start();
    },
    [dictation],
  );

  const endHold = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    dictation.stop();
  }, [dictation]);

  const control = dictation.supported ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // 44 px in both axes, matching the attach control, and `touch-none` so a
      // hold on a phone does not scroll the page out from under the reader.
      className={cn('min-h-[44px] min-w-[44px] touch-none select-none px-2', className)}
      disabled={disabled || dictation.busy}
      aria-label={dictationButtonLabel(dictation.phase)}
      aria-pressed={dictation.recording}
      title="Hold to dictate. Your words go into the message box — nothing is ever sent for you."
      onPointerDown={beginHold}
      onPointerUp={endHold}
      onPointerCancel={endHold}
      onPointerLeave={endHold}
      onLostPointerCapture={endHold}
      // The keyboard equivalent of the same hold. `repeat` is ignored so
      // holding the key does not restart the utterance every autorepeat tick.
      onKeyDown={event => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        if (event.repeat) return;
        event.preventDefault();
        if (held.current) return;
        held.current = true;
        dictation.start();
      }}
      onKeyUp={event => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        endHold();
      }}
      onBlur={endHold}
      // Nothing is wired to click; suppressing it is what stops the pointer and
      // keyboard gestures from each firing a second time.
      onClick={event => event.preventDefault()}
      onContextMenu={event => event.preventDefault()}
    >
      {dictation.busy ? (
        <Loader2 size={15} aria-hidden="true" className="animate-spin" />
      ) : (
        <Mic size={15} aria-hidden="true" />
      )}
      {layout === 'full' ? <span className="ml-1 text-ui">Hold to talk</span> : null}
      <span className="sr-only">{dictationButtonLabel(dictation.phase)}</span>
    </Button>
  ) : null;

  const copy = dictationStatusCopy(dictation.phase, settings.mode, dictation.error?.message);
  const status = (
    <span
      // FIXED HEIGHT, single line, truncating. The composer's height must not
      // move because a status word arrived.
      className={cn(
        'flex h-5 min-w-0 items-center gap-1 overflow-hidden truncate text-meta leading-base',
        dictation.phase === 'error' ? 'text-warn' : 'text-faint',
      )}
      // State words only — polite and short. A live region that re-announced
      // streaming text would be unusable, which is one more reason there is no
      // streaming text.
      aria-live="polite"
      data-dictation-phase={dictation.phase}
    >
      {dictation.phase === 'error' ? <AlertCircle size={12} aria-hidden="true" /> : null}
      {copy}
    </span>
  );

  return {
    supported: dictation.supported,
    recording: dictation.recording,
    busy: dictation.busy,
    control,
    status,
    handle: dictation,
  };
}

/** The simple mounting form: button and status together. */
export function DictationControl(props: DictationControlProps) {
  const { supported, control, status } = useDictationBundle(props);
  if (!supported) return null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {control}
      {status}
    </span>
  );
}
