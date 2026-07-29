import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, LoaderCircle, LockKeyhole } from 'lucide-react';
import { unlockFailure, type UnlockFailure } from '../lib/attachments';
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';

interface Props {
  /** Rendered in the heading so the reader knows WHICH file wants a password. */
  filename: string;
  open: boolean;
  /** Resolve to unlock; reject to keep the sheet open with the reason shown. */
  onUnlock(password: string): Promise<void>;
  onCancel(): void;
}

/**
 * Password prompt for an encrypted attachment.
 *
 * A wrong password keeps the sheet open with the field selected, because it is
 * the one failure another attempt can fix. Anything else — a host with no memory
 * filesystem, a corrupt document — is stated once and the reader is left to
 * cancel: offering "try again" for a failure no password resolves would be
 * rendering a dead end as an invitation.
 *
 * The password is never put in component state longer than the attempt, never
 * logged, and never placed in a URL. Autofill is off: a document password is not
 * a site credential and does not belong in a password manager's site entry.
 */
export function AttachmentUnlockPrompt({ filename, open, onUnlock, onCancel }: Props) {
  const titleId = useId();
  const fieldId = useId();
  const helpId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<UnlockFailure | null>(null);

  useEffect(() => {
    if (open) return;
    // Never keep a document password across closes.
    setPassword('');
    setSubmitting(false);
    setFailure(null);
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || password.length === 0) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await onUnlock(password);
      setPassword('');
    } catch (error) {
      const next = unlockFailure(error);
      setFailure(next);
      if (next.retryable) {
        // Keep the wrong password selected so the next attempt is one keystroke
        // away rather than a manual clear.
        inputRef.current?.focus();
        inputRef.current?.select();
      } else setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      id="attachment-unlock"
      open={open}
      onClose={submitting ? () => undefined : onCancel}
      labelledBy={titleId}
      closeLabel="Close password prompt"
      panelClassName="bg-surface"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <div className="flex items-center gap-sm">
          <LockKeyhole size={15} aria-hidden="true" className="text-accent" />
          <h1 id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Unlock encrypted PDF
          </h1>
        </div>
        <p className="mt-1 break-words text-ui leading-base text-muted">
          <span className="mono">{filename}</span> needs a password.
        </p>
      </div>

      <form noValidate onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4">
        <div className="mx-auto grid w-full max-w-2xl gap-4 py-3">
          <label className="grid gap-1.5 text-ui text-fg" htmlFor={fieldId}>
            <span className="font-semibold">Document password</span>
            <input
              id={fieldId}
              ref={inputRef}
              type="password"
              className="kt-input !min-h-[44px] w-full"
              value={password}
              onChange={event => {
                setPassword(event.target.value);
                setFailure(null);
              }}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={submitting}
              aria-describedby={helpId}
              aria-invalid={failure?.retryable ? true : undefined}
            />
            <span id={helpId} className="text-meta leading-base text-muted">
              kteam decrypts the PDF in memory and gives the agent that copy. The decrypted file is never written to
              disk, the password is never stored, and the attached original stays encrypted.
            </span>
          </label>

          {failure && (
            <div
              role="alert"
              className="flex items-start gap-sm rounded-control border border-err p-3 text-ui text-err"
            >
              <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{failure.message}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
            <Button type="button" onClick={onCancel} disabled={submitting} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || password.length === 0}
              className="min-h-[44px]"
            >
              {submitting ? (
                <span className="inline-flex items-center gap-sm">
                  <LoaderCircle size={15} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                  Decrypting…
                </span>
              ) : failure?.retryable ? (
                'Try again'
              ) : (
                'Unlock'
              )}
            </Button>
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
