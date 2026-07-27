// The dictation MINI PANEL — tap the mic, keep typing, speak, then review the
// text before it ever touches the message box.
//
// NON-MODAL IS THE PRODUCT REQUIREMENT. The first single-tap redesign used a
// BottomSheet: clearer than hold-to-talk, but it trapped focus and blocked the
// exact workflow the reader wanted to continue while recording. This panel has
// no scrim, no inert page, no focus trap and no mount-time focus call. It sits
// near the top edge, away from the composer and newest transcript rows, and can
// be hidden without cancelling the recording; the mic button brings it back.
//
// HONEST ABOUT LOCAL LIVE TEXT. Parakeet is a whole-buffer recogniser, not a
// word-streaming API. Silence-aligned phrases appear while the microphone is
// still open. The newest decoded phrase is PROVISIONAL and separately editable;
// the earlier text is COMMITTED and user-owned. A later phrase appends — it
// never assigns over either field or anything typed in the composer.
//   - FAILURE: the real reason, out loud — mic blocked, model not prepared,
//     local decode stalled — each with Try again / Cancel rather than a dead spinner.
//
import { useEffect, useId, useRef } from 'react';
import { Mic, Square, Loader2, AlertCircle, CornerDownLeft, RotateCcw, X } from 'lucide-react';
import { Button, Textarea } from './Primitives';
import { InputWaveform } from './InputWaveform';
import type { DictationPhase } from '../hooks/useDictation';
import type { CaptureMonitor } from '../lib/stt/audio-capture';
import { cn } from '../lib/utils';

/** The visible step, derived from the capture phase plus what has landed. Pure
 *  and exported so the whole "what does the reader see right now" rule has a
 *  test instead of living in JSX. `wasCapturing` distinguishes "just opened,
 *  waiting for the mic" from "recorded but the clip was too short to keep" —
 *  both are `idle` with no transcript, and only the second is a dead end worth
 *  telling the reader about. */
export type DictationStage = 'starting' | 'recording' | 'transcribing' | 'review' | 'empty' | 'error';

export function dictationStage(input: {
  phase: DictationPhase;
  hasTranscript: boolean;
  hasError: boolean;
  wasCapturing: boolean;
}): DictationStage {
  if (input.hasError || input.phase === 'error') return 'error';
  if (input.phase === 'transcribing') return 'transcribing';
  if (input.phase === 'requesting') return 'starting';
  if (input.phase === 'recording') return 'recording';
  if (input.hasTranscript) return 'review';
  if (input.wasCapturing) return 'empty';
  return 'starting';
}

/** m:ss from milliseconds. Clamps negatives to zero and never shows a partial
 *  leading digit on the seconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** A short, plain title for each failure, chosen from the error CODE (stable)
 *  rather than the message (not). The message itself is shown underneath — this
 *  is only the headline and the one actionable hint. */
export function dictationFailureCopy(code: string | undefined): { title: string; hint?: string } {
  switch (code) {
    case 'permission-denied':
      return {
        title: 'Microphone blocked',
        hint: 'Allow microphone access for this site in your browser, then try again.',
      };
    case 'no-microphone':
      return { title: 'No microphone found' };
    case 'audio-unavailable':
      return { title: 'Microphone busy', hint: 'Another app is using it. Close it and try again.' };
    case 'no-media-devices':
      return { title: 'Microphone unavailable', hint: 'This page needs a secure (https) connection to record.' };
    case 'not-prepared':
      return {
        title: 'Prepare this device first',
        hint: 'Open Settings → Dictation and prepare the local speech model, then try again.',
      };
    case 'backlog':
      return {
        title: 'This device is falling behind',
        hint: 'Recording stopped before any queued speech could be silently dropped. You can keep and insert the text below.',
      };
    case 'empty-segment':
      return {
        title: "One phrase wasn't readable",
        hint: 'Recording stopped rather than silently omitting voiced audio. You can keep and insert the text below.',
      };
    case 'too-long':
      return { title: 'Recording too long' };
    case 'bad-audio':
      return { title: "Didn't catch that", hint: 'No usable audio was captured. Try again.' };
    default:
      return { title: 'Dictation failed' };
  }
}

export interface DictationSheetProps {
  open: boolean;
  stage: DictationStage;
  /** Milliseconds elapsed in the CURRENT recording. Ignored off the recording
   *  stage. */
  elapsedMs: number;
  /** A read-only branch off the recorder's exact stream/audio graph. */
  inputMonitor: CaptureMonitor | null;
  /** Earlier silence-aligned phrases. Once displayed, this is reader-owned. */
  committedText: string;
  /** Newest decoded phrase; promoted only from the reader's current value. */
  provisionalText: string;
  pendingSegments: number;
  onCommittedTextChange(value: string): void;
  onProvisionalTextChange(value: string): void;
  errorCode?: string;
  errorMessage?: string;
  /** Hide only. Recording/transcription/review continues in the background. */
  onDismiss(): void;
  /** Stop recording and finish queued local transcription. */
  onStop(): void;
  /** Throw the recording/transcript away and close. */
  onCancel(): void;
  /** Start over from a fresh recording (review, empty, error). */
  onRetry(): void;
  /** Put the edited text into the composer draft and close. */
  onInsert(): void;
}

/** The recording indicator: a pulsing dot the reader reads as "live" without a
 *  word, plus the word for assistive tech. */
function LiveDot() {
  return (
    <span className="relative inline-flex h-3 w-3 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-err opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-err" />
    </span>
  );
}

export function DictationSheet({
  open,
  stage,
  elapsedMs,
  inputMonitor,
  committedText,
  provisionalText,
  pendingSegments,
  onCommittedTextChange,
  onProvisionalTextChange,
  errorCode,
  errorMessage,
  onDismiss,
  onStop,
  onCancel,
  onRetry,
  onInsert,
}: DictationSheetProps) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  // On review, drop the caret at the end of the transcript so a correction or a
  // follow-on word starts where the reader expects — but do NOT auto-focus:
  // focusing raises the keyboard under the reader's thumb the instant
  // transcription finishes, which would be a surprise on a phone. The reader
  // taps to edit; then the caret is already home.
  useEffect(() => {
    if (!open || stage !== 'review') return;
    const el = editRef.current;
    if (!el) return;
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [open, stage]);

  const failure = dictationFailureCopy(errorCode);
  const title =
    stage === 'review'
      ? 'Review dictation'
      : stage === 'transcribing'
        ? 'Finishing locally'
        : stage === 'recording'
          ? 'Recording'
          : stage === 'error'
            ? failure.title
            : stage === 'empty'
              ? "Didn't catch that"
              : 'Opening microphone';

  if (!open) return null;
  const hasEditableText = `${committedText}${provisionalText}`.trim().length > 0;

  return (
    <section
      id={`${baseId}-panel`}
      data-dictation-panel="non-modal"
      role="region"
      aria-labelledby={titleId}
      onKeyDown={event => {
        // Local Escape only: the panel must never install a document-level
        // handler that intercepts keys while the reader is typing elsewhere.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onDismiss();
      }}
      className={cn(
        'fixed right-3 top-[calc(env(safe-area-inset-top,0px)+3.75rem)] z-50 max-h-[calc(var(--app-h,100dvh)-4.5rem)] w-[calc(100vw-1.5rem)] max-w-sm overflow-y-auto rounded-panel border border-l-heavy border-border bg-surface font-ui shadow-panel',
        stage === 'recording' && 'border-l-err',
        (stage === 'starting' || stage === 'transcribing') && 'border-l-accent',
        (stage === 'empty' || stage === 'error') && 'border-l-warn',
        stage === 'review' && 'border-l-ok',
      )}
    >
      <div className="flex w-full min-w-0 flex-col gap-sm p-3">
        <div className="flex min-w-0 items-center gap-sm">
          {stage === 'recording' ? (
            <LiveDot />
          ) : stage === 'transcribing' ? (
            <Loader2
              size={16}
              aria-hidden="true"
              className="shrink-0 animate-spin text-accent motion-reduce:animate-none"
            />
          ) : stage === 'error' ? (
            <AlertCircle size={16} aria-hidden="true" className="shrink-0 text-warn" />
          ) : (
            <Mic size={16} aria-hidden="true" className="shrink-0 text-fg-soft" />
          )}
          <span
            id={titleId}
            className="min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg"
          >
            {title}
          </span>
          {stage === 'recording' && (
            <span className="mono shrink-0 tabular-nums text-ui text-muted" aria-hidden="true">
              {formatElapsed(elapsedMs)}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px] min-w-[44px] shrink-0 justify-center p-0"
            aria-label="Hide dictation panel; recording continues"
            title="Hide this panel — recording continues"
            onClick={onDismiss}
          >
            <X size={15} aria-hidden="true" />
          </Button>
        </div>

        {/* One polite live region carries stage changes. Editable transcript
            fields keep their own labels; repeatedly announcing every phrase
            here would interrupt someone correcting the previous one. */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {stage === 'recording'
            ? 'Recording'
            : stage === 'transcribing'
              ? 'Finishing transcription on this device'
              : stage === 'review'
                ? 'Transcript ready to review'
                : stage === 'empty'
                  ? 'No speech was captured'
                  : stage === 'error'
                    ? `Dictation failed: ${errorMessage ?? failure.title}`
                    : 'Starting'}
        </span>

        {(stage === 'starting' || stage === 'recording') && (
          <RecordingBody
            stage={stage}
            inputMonitor={inputMonitor}
            committedText={committedText}
            provisionalText={provisionalText}
            pendingSegments={pendingSegments}
            onCommittedTextChange={onCommittedTextChange}
            onProvisionalTextChange={onProvisionalTextChange}
            onStop={onStop}
            onCancel={onCancel}
          />
        )}

        {stage === 'transcribing' && (
          <TranscribingBody
            committedText={committedText}
            provisionalText={provisionalText}
            pendingSegments={pendingSegments}
            onCommittedTextChange={onCommittedTextChange}
            onProvisionalTextChange={onProvisionalTextChange}
            onCancel={onCancel}
          />
        )}

        {stage === 'review' && (
          <ReviewBody
            text={committedText}
            onTextChange={onCommittedTextChange}
            editRef={editRef}
            onInsert={onInsert}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        )}

        {stage === 'empty' && (
          <MessageBody
            body="No speech was captured. Speak, then tap Stop."
            onRetry={onRetry}
            retryLabel="Record again"
            onCancel={onCancel}
          />
        )}

        {stage === 'error' && hasEditableText && (
          <FailureWithText
            body={errorMessage ?? 'Local transcription stopped.'}
            hint={failure.hint}
            committedText={committedText}
            provisionalText={provisionalText}
            onCommittedTextChange={onCommittedTextChange}
            onProvisionalTextChange={onProvisionalTextChange}
            onInsert={onInsert}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        )}

        {stage === 'error' && !hasEditableText && (
          <MessageBody
            body={errorMessage ?? 'Dictation failed.'}
            hint={failure.hint}
            onRetry={onRetry}
            retryLabel="Try again"
            onCancel={onCancel}
          />
        )}
      </div>
    </section>
  );
}

function RecordingBody({
  stage,
  inputMonitor,
  committedText,
  provisionalText,
  pendingSegments,
  onCommittedTextChange,
  onProvisionalTextChange,
  onStop,
  onCancel,
}: {
  stage: DictationStage;
  inputMonitor: CaptureMonitor | null;
  committedText: string;
  provisionalText: string;
  pendingSegments: number;
  onCommittedTextChange(value: string): void;
  onProvisionalTextChange(value: string): void;
  onStop(): void;
  onCancel(): void;
}) {
  const starting = stage === 'starting';
  return (
    <div className="flex flex-col gap-sm">
      <p className="text-ui text-muted">
        {starting
          ? 'Opening the microphone and local speech model…'
          : 'Listening locally — pause naturally to preview a phrase. Keep typing if you like.'}
      </p>
      {!starting && <InputWaveform monitor={inputMonitor} />}
      {!starting && (
        <LiveTranscriptFields
          committedText={committedText}
          provisionalText={provisionalText}
          pendingSegments={pendingSegments}
          onCommittedTextChange={onCommittedTextChange}
          onProvisionalTextChange={onProvisionalTextChange}
        />
      )}
      <div className="flex gap-xs">
        <Button
          variant="primary"
          size="md"
          className="min-h-[44px] min-w-0 flex-1 justify-center gap-sm text-ui"
          disabled={starting}
          aria-label="Stop recording and finish local transcription"
          onClick={onStop}
        >
          <Square size={15} aria-hidden="true" />
          Stop &amp; finish
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="min-h-[44px] shrink-0 justify-center gap-xs"
          aria-label="Cancel dictation"
          onClick={onCancel}
        >
          <X size={14} aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface LiveTranscriptFieldsProps {
  committedText: string;
  provisionalText: string;
  pendingSegments: number;
  onCommittedTextChange(value: string): void;
  onProvisionalTextChange(value: string): void;
}

function LiveTranscriptFields({
  committedText,
  provisionalText,
  pendingSegments,
  onCommittedTextChange,
  onProvisionalTextChange,
}: LiveTranscriptFieldsProps) {
  const hasText = `${committedText}${provisionalText}`.trim().length > 0;
  if (!hasText && pendingSegments === 0) {
    return (
      <div
        data-live-transcript="waiting"
        className="rounded-control border border-dashed border-border bg-surface-2 px-3 py-2 text-meta leading-base text-faint"
      >
        Your first phrase will appear here after a natural pause. Audio stays on this device.
      </div>
    );
  }
  return (
    <div data-live-transcript="editable" className="flex flex-col gap-xs">
      <div className="rounded-control border border-ok-border bg-surface-2 p-2">
        <label className="mb-1 flex items-center justify-between gap-2 text-meta font-semibold text-ok">
          <span>Committed · yours to edit</span>
          <span className="font-normal text-faint">kept</span>
        </label>
        <Textarea
          value={committedText}
          onChange={event => onCommittedTextChange(event.target.value)}
          rows={2}
          aria-label="Committed dictated text"
          placeholder="Earlier phrases settle here. Later speech only appends."
          className="min-h-[64px] w-full bg-surface"
        />
      </div>
      <div className="rounded-control border border-accent-border bg-accent-soft p-2">
        <label className="mb-1 flex items-center justify-between gap-2 text-meta font-semibold text-accent">
          <span>Provisional · still settling</span>
          <span className="font-normal text-faint">editable</span>
        </label>
        <Textarea
          value={provisionalText}
          onChange={event => onProvisionalTextChange(event.target.value)}
          rows={2}
          aria-label="Provisional dictated text"
          placeholder={
            pendingSegments > 0 ? 'Recognising the next phrase on this device…' : 'Newest phrase appears here.'
          }
          className="min-h-[64px] w-full border-accent-border bg-surface italic"
        />
      </div>
      {pendingSegments > 0 && (
        <p className="text-meta text-accent" role="status">
          Recognising {pendingSegments === 1 ? 'one local phrase' : `${pendingSegments} local phrases`}…
        </p>
      )}
    </div>
  );
}

function TranscribingBody({
  committedText,
  provisionalText,
  pendingSegments,
  onCommittedTextChange,
  onProvisionalTextChange,
  onCancel,
}: LiveTranscriptFieldsProps & { onCancel(): void }) {
  return (
    <div className="flex flex-col gap-sm">
      <p className="text-ui text-muted">Finishing the last phrase on this device. You can keep editing.</p>
      <LiveTranscriptFields
        committedText={committedText}
        provisionalText={provisionalText}
        pendingSegments={pendingSegments}
        onCommittedTextChange={onCommittedTextChange}
        onProvisionalTextChange={onProvisionalTextChange}
      />
      {/* Indeterminate, MOVING bar: honest about "something is happening" without
          claiming a percentage the engine never reports. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div className="kt-dictation-bar h-full w-2/5 rounded-full bg-accent motion-reduce:animate-none" />
      </div>
      <Button
        variant="ghost"
        size="md"
        className="min-h-[44px] w-full justify-center gap-xs"
        aria-label="Cancel transcription"
        onClick={onCancel}
      >
        <X size={14} aria-hidden="true" />
        Cancel
      </Button>
    </div>
  );
}

function FailureWithText({
  body,
  hint,
  committedText,
  provisionalText,
  onCommittedTextChange,
  onProvisionalTextChange,
  onInsert,
  onRetry,
  onCancel,
}: Omit<LiveTranscriptFieldsProps, 'pendingSegments'> & {
  body: string;
  hint?: string;
  onInsert(): void;
  onRetry(): void;
  onCancel(): void;
}) {
  return (
    <div className="flex flex-col gap-sm">
      <p className="text-ui text-fg">{body}</p>
      {hint && <p className="text-meta leading-base text-muted">{hint}</p>}
      <LiveTranscriptFields
        committedText={committedText}
        provisionalText={provisionalText}
        pendingSegments={0}
        onCommittedTextChange={onCommittedTextChange}
        onProvisionalTextChange={onProvisionalTextChange}
      />
      <Button
        variant="primary"
        size="md"
        className="min-h-[48px] w-full justify-center gap-sm text-ui"
        aria-label="Insert the captured text into the message"
        onClick={onInsert}
      >
        <CornerDownLeft size={15} aria-hidden="true" />
        Insert captured text
      </Button>
      <div className="flex gap-sm">
        <Button
          variant="ghost"
          size="md"
          className="min-h-[44px] flex-1 justify-center gap-xs"
          aria-label="Discard and record again"
          onClick={onRetry}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Record again
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="min-h-[44px] flex-1 justify-center gap-xs"
          aria-label="Discard dictation"
          onClick={onCancel}
        >
          <X size={14} aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ReviewBody({
  text,
  onTextChange,
  editRef,
  onInsert,
  onRetry,
  onCancel,
}: {
  text: string;
  onTextChange(value: string): void;
  editRef: React.RefObject<HTMLTextAreaElement | null>;
  onInsert(): void;
  onRetry(): void;
  onCancel(): void;
}) {
  const empty = text.trim().length === 0;
  return (
    <div className="flex flex-col gap-sm">
      <label className="text-meta text-muted" htmlFor={`${editRef.current?.id ?? 'dictation-edit'}`}>
        Edit before inserting — nothing is sent.
      </label>
      <Textarea
        ref={editRef}
        value={text}
        onChange={e => onTextChange(e.target.value)}
        rows={4}
        aria-label="Dictated text"
        className="min-h-[96px] w-full"
      />
      <Button
        variant="primary"
        size="md"
        className="min-h-[48px] w-full justify-center gap-sm text-ui"
        disabled={empty}
        aria-disabled={empty}
        aria-label="Insert this text into the message"
        onClick={onInsert}
      >
        <CornerDownLeft size={15} aria-hidden="true" />
        Insert into message
      </Button>
      <div className="flex gap-sm">
        <Button
          variant="ghost"
          size="md"
          className="min-h-[44px] flex-1 justify-center gap-xs"
          aria-label="Discard and record again"
          onClick={onRetry}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Re-record
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="min-h-[44px] flex-1 justify-center gap-xs"
          aria-label="Discard dictation"
          onClick={onCancel}
        >
          <X size={14} aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

function MessageBody({
  body,
  hint,
  onRetry,
  retryLabel,
  onCancel,
}: {
  body: string;
  hint?: string;
  onRetry(): void;
  retryLabel: string;
  onCancel(): void;
}) {
  return (
    <div className="flex flex-col gap-sm">
      <p className="text-ui text-fg">{body}</p>
      {hint && <p className="text-meta text-muted">{hint}</p>}
      <Button
        variant="primary"
        size="md"
        className="min-h-[48px] w-full justify-center gap-sm text-ui"
        aria-label={retryLabel}
        onClick={onRetry}
      >
        <RotateCcw size={15} aria-hidden="true" />
        {retryLabel}
      </Button>
      <Button
        variant="ghost"
        size="md"
        className="min-h-[44px] w-full justify-center gap-xs"
        aria-label="Close dictation"
        onClick={onCancel}
      >
        <X size={14} aria-hidden="true" />
        Cancel
      </Button>
    </div>
  );
}
