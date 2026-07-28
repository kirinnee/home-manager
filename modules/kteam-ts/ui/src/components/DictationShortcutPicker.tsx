import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { KeyRound, RotateCcw } from 'lucide-react';
import { Button } from './Primitives';
import {
  DEFAULT_DICTATION_SHORTCUT,
  beginDictationShortcutCapture,
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  sameDictationShortcutTrigger,
  validateDictationShortcut,
  type DictationShortcutBinding,
  type DictationShortcutVerdict,
} from '../lib/stt/dictation-shortcut';

export interface DictationShortcutPickerProps {
  binding: DictationShortcutBinding;
  onChange(binding: DictationShortcutBinding): void;
}

interface PendingShortcut {
  binding: DictationShortcutBinding;
  verdict: DictationShortcutVerdict;
}

function sameBinding(a: DictationShortcutBinding, b: DictationShortcutBinding): boolean {
  return a.code === b.code && a.key === b.key && a.modifiers.join('+') === b.modifiers.join('+');
}

/** A real key-capture control: saving requires the same primary key to arrive
 * on keydown AND keyup. A text field would make readers spell browser-specific
 * key names and could never prove the chosen release event is observable. */
export function DictationShortcutPicker({ binding, onChange }: DictationShortcutPickerProps) {
  const [capturing, setCapturing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackTone, setFeedbackTone] = useState<'muted' | 'warn' | 'ok'>('muted');
  const pending = useRef<PendingShortcut | null>(null);

  useEffect(() => {
    if (!capturing) return;
    // A retained Composer sits behind the mobile Settings sheet. Suppress its
    // global listener before the first key reaches this button.
    return beginDictationShortcutCapture();
  }, [capturing]);

  const cancelCapture = (message = 'Shortcut capture cancelled.'): void => {
    pending.current = null;
    setCapturing(false);
    setFeedbackTone('muted');
    setFeedback(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === 'Escape') {
      cancelCapture();
      return;
    }
    const candidate = dictationShortcutFromEvent(event.nativeEvent);
    pending.current = { binding: candidate, verdict: validateDictationShortcut(candidate) };
    setFeedbackTone('muted');
    setFeedback(`Release ${dictationShortcutLabel(candidate)} to test and confirm it.`);
  };

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    const candidate = pending.current;
    if (!candidate || !sameDictationShortcutTrigger(candidate.binding, event.nativeEvent)) return;
    pending.current = null;
    if (!candidate.verdict.ok) {
      setFeedbackTone('warn');
      setFeedback(candidate.verdict.reason ?? 'That shortcut cannot be used here. Try another.');
      return;
    }
    onChange(candidate.binding);
    setCapturing(false);
    if (candidate.verdict.warning) {
      setFeedbackTone('warn');
      setFeedback(candidate.verdict.warning);
    } else {
      setFeedbackTone('ok');
      setFeedback(`${dictationShortcutLabel(candidate.binding)} saved.`);
    }
  };

  const currentVerdict = validateDictationShortcut(binding);
  const isDefault = sameBinding(binding, DEFAULT_DICTATION_SHORTCUT);

  return (
    <section
      aria-labelledby="dictation-shortcut-title"
      className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 id="dictation-shortcut-title" className="text-ui font-semibold text-fg">
            Push to talk
          </h3>
          <p className="text-meta leading-base text-muted">
            Hold to record and release to finish, or tap once to latch and press again to finish.
          </p>
        </div>
        <kbd className="inline-flex min-h-8 items-center gap-1 rounded-control border border-accent bg-accent-soft px-2 font-ui text-meta font-semibold text-accent shadow-sm">
          <KeyRound size={13} aria-hidden="true" />
          {dictationShortcutLabel(binding)}
        </kbd>
      </div>

      <p className="text-meta leading-base text-muted">
        The final on-device decode and one enhancement pass insert at your current caret. The shortcut never sends the
        message. On a phone, use the mic button—the keyboard shortcut is optional.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={capturing ? 'primary' : undefined}
          className="min-h-[44px] min-w-[44px]"
          aria-pressed={capturing}
          onClick={() => {
            if (capturing) cancelCapture();
            else {
              pending.current = null;
              setFeedbackTone('muted');
              setFeedback('Press your shortcut, then release its main key. Escape cancels.');
              setCapturing(true);
            }
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            if (!capturing) return;
            cancelCapture(
              pending.current
                ? 'The browser or operating system took focus before keyup, so that chord cannot be trusted here.'
                : 'Shortcut capture cancelled.',
            );
          }}
        >
          <KeyRound size={14} aria-hidden="true" />
          <span className="ml-1">{capturing ? 'Listening — press a shortcut' : 'Change shortcut'}</span>
        </Button>
        {!isDefault && (
          <Button
            type="button"
            size="sm"
            className="min-h-[44px] min-w-[44px]"
            onClick={() => {
              onChange({ ...DEFAULT_DICTATION_SHORTCUT, modifiers: [] });
              setFeedbackTone('muted');
              setFeedback('Reset to Alt (either side).');
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span className="ml-1">Use default Alt</span>
          </Button>
        )}
      </div>

      {(feedback || currentVerdict.warning) && (
        <p
          className={`text-meta leading-base ${
            feedbackTone === 'warn' || (!feedback && currentVerdict.warning)
              ? 'text-warn'
              : feedbackTone === 'ok'
                ? 'text-ok'
                : 'text-faint'
          }`}
          role="status"
          aria-live="polite"
        >
          {feedback ?? currentVerdict.warning}
        </p>
      )}
    </section>
  );
}
