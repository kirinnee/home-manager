// The dictation MINI PANEL — tap the mic, keep typing, speak, and watch the
// words land in your draft on their own.
//
// NON-MODAL IS THE PRODUCT REQUIREMENT. The first single-tap redesign used a
// BottomSheet: clearer than hold-to-talk, but it trapped focus and blocked the
// exact workflow the reader wanted to continue while recording. This panel has
// no scrim, no inert page, no focus trap and no mount-time focus call. It is a
// single slim strip anchored directly above the composer and can be hidden
// without cancelling the recording; the mic button brings it back.
//
// A READ-ONLY LIVE CAPTION, NOT AN EDITOR. The rolling on-device decoder now
// runs pause-independently: words appear WHILE the reader keeps speaking, with
// no wait for a silence boundary. That preview is disposable. There is no
// textarea, no committed-vs-provisional split, no review step and no Insert
// button — on Stop the hook runs one clean final decode, enhances once, and
// drops the result straight into the composer draft. The panel only shows what
// is being heard and offers Stop / Cancel / Hide.
//   - FAILURE: the real reason, out loud — mic blocked, model not prepared,
//     local decode stalled — each with Try again / Cancel rather than a dead spinner.
//
import { useId } from 'react';
import { Mic, Square, Loader2, AlertCircle, RotateCcw, EyeOff, X } from 'lucide-react';
import { Button } from './Primitives';
import type { DictationPhase } from '../hooks/useDictation';
import type { CaptureMonitor } from '../lib/stt/audio-capture';
import { cn } from '../lib/utils';

/** The visible step, derived from the capture phase plus whether the mic ever
 *  opened. Pure and exported so the whole "what does the reader see right now"
 *  rule has a test instead of living in JSX. `wasCapturing` distinguishes "just
 *  opened, waiting for the mic" from "recorded but the clip was too short to
 *  keep" — both are `idle`, and only the second is a dead end worth telling the
 *  reader about. There is no `review` stage: a landed transcript is inserted
 *  automatically and the panel closes itself. */
export type DictationStage = 'starting' | 'recording' | 'transcribing' | 'empty' | 'error';

export function dictationStage(input: {
  phase: DictationPhase;
  hasError: boolean;
  wasCapturing: boolean;
}): DictationStage {
  if (input.hasError || input.phase === 'error') return 'error';
  if (input.phase === 'transcribing') return 'transcribing';
  if (input.phase === 'requesting') return 'starting';
  if (input.phase === 'recording') return 'recording';
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
        hint: 'Recording stopped before any queued speech could be silently dropped. Try a shorter take.',
      };
    case 'empty-segment':
      return {
        title: "One phrase wasn't readable",
        hint: 'Recording stopped rather than silently omitting voiced audio. Try again.',
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
  /** The rolling on-device preview. READ-ONLY: the panel never edits it and it
   *  is not what gets inserted — the final decode is. */
  liveText: string;
  pendingSegments: number;
  errorCode?: string;
  errorMessage?: string;
  /** Hide only. Recording/transcription continues in the background. */
  onDismiss(): void;
  /** Stop recording; the hook finishes locally and inserts on its own. */
  onStop(): void;
  /** Throw the recording away and close. */
  onCancel(): void;
  /** Start over from a fresh recording (empty, error). */
  onRetry(): void;
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

function stripStatus(
  stage: DictationStage,
  liveText: string,
  pendingSegments: number,
  errorMessage: string | undefined,
  failure: ReturnType<typeof dictationFailureCopy>,
): string {
  const preview = liveText.trim();
  switch (stage) {
    case 'recording':
      if (preview) return `${preview}${pendingSegments > 0 ? ' …' : ''}`;
      if (pendingSegments > 0) return 'Listening locally…';
      return 'Words appear as you speak — you never have to pause. Audio stays on this device.';
    case 'transcribing':
      return `Final on-device decode and enhancement… ${
        preview ? `Last heard: ${preview}` : 'The result will be added to your draft.'
      }`;
    case 'empty':
      return 'No speech was captured. Record again when you are ready.';
    case 'error':
      return [errorMessage ?? failure.title, failure.hint, preview ? `Last heard: ${preview}` : undefined]
        .filter(Boolean)
        .join(' ');
    case 'starting':
      return 'Opening the microphone and local speech model…';
  }
}

export function DictationSheet({
  open,
  stage,
  elapsedMs,
  liveText,
  pendingSegments,
  errorCode,
  errorMessage,
  onDismiss,
  onStop,
  onCancel,
  onRetry,
}: DictationSheetProps) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const safetyId = `${baseId}-safety`;

  const failure = dictationFailureCopy(errorCode);
  const title =
    stage === 'transcribing'
      ? 'Finishing locally'
      : stage === 'recording'
        ? 'Recording'
        : stage === 'error'
          ? failure.title
          : stage === 'empty'
            ? "Didn't catch that"
            : 'Opening microphone';
  const status = stripStatus(stage, liveText, pendingSegments, errorMessage, failure);

  if (!open) return null;

  return (
    <section
      id={`${baseId}-panel`}
      data-dictation-panel="non-modal"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={safetyId}
      onKeyDown={event => {
        // Local Escape only: the panel must never install a document-level
        // handler that intercepts keys while the reader is typing elsewhere.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onDismiss();
      }}
      className={cn(
        'absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-panel border border-l-heavy border-border bg-surface font-ui shadow-panel',
        stage === 'recording' && 'border-l-err',
        (stage === 'starting' || stage === 'transcribing') && 'border-l-accent',
        (stage === 'empty' || stage === 'error') && 'border-l-warn',
      )}
    >
      <div className="flex min-h-[56px] w-full min-w-0 items-center gap-xs px-2 py-1.5">
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
        <span id={titleId} className="sr-only">
          {title}
        </span>
        {stage === 'recording' && (
          <span className="mono shrink-0 tabular-nums text-ui text-muted" aria-hidden="true">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <span
          data-live-transcript={liveText.trim() ? 'preview' : 'waiting'}
          aria-label="Live dictation status"
          title={status}
          className="min-w-0 flex-1 truncate text-ui leading-base text-fg"
        >
          {status}
        </span>

        {stage === 'recording' && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="min-h-[44px] min-w-[44px] shrink-0 justify-center p-0"
            aria-label="Stop recording and add text to your draft"
            title="Stop and add to draft"
            onClick={onStop}
          >
            <Square size={15} aria-hidden="true" />
          </Button>
        )}
        {(stage === 'empty' || stage === 'error') && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="min-h-[44px] min-w-[44px] shrink-0 justify-center p-0"
            aria-label={stage === 'empty' ? 'Record again' : 'Try again'}
            title={stage === 'empty' ? 'Record again' : 'Try again'}
            onClick={onRetry}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[44px] min-w-[44px] shrink-0 justify-center p-0"
          aria-label={stage === 'empty' ? 'Close dictation' : 'Cancel dictation'}
          title={stage === 'empty' ? 'Close dictation' : 'Cancel dictation'}
          onClick={onCancel}
        >
          <X size={15} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[44px] min-w-[44px] shrink-0 justify-center p-0"
          aria-label="Hide dictation panel; recording continues"
          title="Hide this panel — recording continues"
          onClick={onDismiss}
        >
          <EyeOff size={15} aria-hidden="true" />
        </Button>
      </div>

      {/* Announce stage changes, but never each provisional rewrite. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {stage === 'recording'
          ? 'Recording'
          : stage === 'transcribing'
            ? 'Finishing transcription on this device, then adding it to your draft'
            : stage === 'empty'
              ? 'No speech was captured'
              : stage === 'error'
                ? `Dictation failed: ${errorMessage ?? failure.title}`
                : 'Starting'}
      </span>
      <span id={safetyId} className="sr-only">
        Microphone audio and speech recognition stay on this device. Dictation only updates your draft and is never sent
        automatically.
      </span>
    </section>
  );
}
