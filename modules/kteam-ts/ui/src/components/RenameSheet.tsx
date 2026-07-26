import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, LoaderCircle, Pencil } from 'lucide-react';
import type { SessionView } from '../types';
import { api, ApiError, type RenameSessionPatch } from '../lib/api';
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';

interface Props {
  view: SessionView;
  open: boolean;
  onClose: () => void;
}

interface FieldErrors {
  title?: string;
  teammate?: string;
  form?: string;
}

function requestIdFor(current: { key: string; id: string } | null, key: string): { key: string; id: string } {
  return current?.key === key ? current : { key, id: crypto.randomUUID() };
}

function errorsFor(error: unknown): FieldErrors {
  const message = error instanceof ApiError ? error.message : String(error);
  if (/teammate|callsign/i.test(message)) return { teammate: message };
  if (/\bname\b|title/i.test(message)) return { title: message };
  return { form: message };
}

export function RenameSheet({ view, open, onClose }: Props) {
  const { config } = view;
  const titleId = useId();
  const titleHelpId = useId();
  const teammateHelpId = useId();
  const [title, setTitle] = useState(config.name ?? '');
  const [teammate, setTeammate] = useState(config.teammate ?? '');
  const [detach, setDetach] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const requestRef = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(config.name ?? '');
    setTeammate(config.teammate ?? '');
    setDetach(false);
    setSubmitting(false);
    setErrors({});
    requestRef.current = null;
  }, [open, config.id]);

  const patch = useMemo<RenameSessionPatch>(() => {
    const next: RenameSessionPatch = {};
    const normalizedTitle = title.trim();
    const normalizedTeammate = teammate.trim().toLowerCase();
    if (normalizedTitle !== (config.name ?? '').trim()) next.name = normalizedTitle;
    if (normalizedTeammate !== (config.teammate ?? '').trim().toLowerCase()) next.teammate = normalizedTeammate;
    if (config.parent && detach) next.clearParent = true;
    return next;
  }, [config.name, config.parent, config.teammate, detach, teammate, title]);

  const changed = Object.keys(patch).length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || submitting) return;
    if (!title.trim()) {
      setErrors({ title: 'Task title cannot be empty.' });
      return;
    }
    if (!teammate.trim()) {
      setErrors({ teammate: 'Callsign cannot be empty.' });
      return;
    }
    setErrors({});
    setSubmitting(true);
    const key = JSON.stringify(patch);
    requestRef.current = requestIdFor(requestRef.current, key);
    try {
      await api.rename(config.id, patch, requestRef.current.id);
      onClose();
    } catch (error) {
      setErrors(errorsFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      id={`rename-${config.id}`}
      open={open}
      onClose={submitting ? () => undefined : onClose}
      labelledBy={titleId}
      closeLabel="Close rename session"
      panelClassName="kt-details bg-surface"
      maxHeight="min(86dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <div className="flex items-center gap-sm">
          <Pencil size={15} aria-hidden="true" className="text-accent" />
          <h1 id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Rename session
          </h1>
        </div>
        <p className="mt-1 text-ui leading-base text-muted">
          Change its task title, callsign, or place in the session tree.
        </p>
      </div>

      <form noValidate onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4">
        <div className="mx-auto grid w-full max-w-2xl gap-4 py-3">
          <label className="grid gap-1.5 text-ui text-fg" htmlFor={`${titleId}-task`}>
            <span className="font-semibold">Task title</span>
            <input
              id={`${titleId}-task`}
              className="kt-input !min-h-[44px] w-full"
              value={title}
              onChange={event => {
                setTitle(event.target.value);
                setErrors(current => ({ ...current, title: undefined, form: undefined }));
              }}
              maxLength={120}
              required
              disabled={submitting}
              aria-describedby={`${titleHelpId}${errors.title ? ` ${titleHelpId}-error` : ''}`}
              aria-invalid={errors.title ? true : undefined}
            />
            <span id={titleHelpId} className="text-meta leading-base text-muted">
              Convention: plain Title Case, up to 5 words.
            </span>
            {errors.title && (
              <span id={`${titleHelpId}-error`} role="alert" className="text-ui leading-base text-err">
                {errors.title}
              </span>
            )}
          </label>

          <label className="grid gap-1.5 text-ui text-fg" htmlFor={`${titleId}-teammate`}>
            <span className="font-semibold">Callsign</span>
            <input
              id={`${titleId}-teammate`}
              className="kt-input !min-h-[44px] w-full mono"
              value={teammate}
              onChange={event => {
                setTeammate(event.target.value.toLowerCase());
                setErrors(current => ({ ...current, teammate: undefined, form: undefined }));
              }}
              pattern="[a-z][a-z0-9-]*"
              maxLength={32}
              required
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={submitting}
              aria-describedby={`${teammateHelpId}${errors.teammate ? ` ${teammateHelpId}-error` : ''}`}
              aria-invalid={errors.teammate ? true : undefined}
            />
            <span id={teammateHelpId} className="text-meta leading-base text-muted">
              Lowercase letters, digits, and hyphens; must not clash with a live teammate.
            </span>
            {errors.teammate && (
              <span id={`${teammateHelpId}-error`} role="alert" className="text-ui leading-base text-err">
                {errors.teammate}
              </span>
            )}
          </label>

          {config.parent && (
            <label className="flex min-h-[44px] items-start gap-sm rounded-control border border-border bg-surface-2 px-control-x py-2 text-ui text-fg">
              <input
                type="checkbox"
                checked={detach}
                onChange={event => setDetach(event.target.checked)}
                disabled={submitting}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>
                <span className="block font-semibold">Detach from parent</span>
                <span className="mt-0.5 block text-meta leading-base text-muted">
                  Re-roots this session in the list; nothing else changes.
                </span>
              </span>
            </label>
          )}

          {errors.form && (
            <div
              role="alert"
              className="flex items-start gap-sm rounded-control border border-err text-ui text-err p-3"
            >
              <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{errors.form}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
            <Button type="button" onClick={onClose} disabled={submitting} className="min-h-[44px]">
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!changed || submitting} className="min-h-[44px]">
              {submitting ? (
                <span className="inline-flex items-center gap-sm">
                  <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
                  Saving changes…
                </span>
              ) : (
                'Save changes'
              )}
            </Button>
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
