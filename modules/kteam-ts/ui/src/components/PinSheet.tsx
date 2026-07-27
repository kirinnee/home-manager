// PINS — the header trigger + bottom sheet. ONE surface for BOTH pin kinds
// (pinning-design.md §1): free-text notes (a PR link, a status-report link) and
// pinned transcript messages that jump back into the conversation.
//
// ZERO PERMANENT VERTICAL COST. The trigger is a 44px icon button that rides in
// the existing SessionHeader row (width cost only, no new band); the sheet is an
// overlay that reuses the SessionDetails BottomSheet primitive (focus trap,
// Escape, swipe-to-dismiss) rather than inventing a second sheet system. On a
// phone the transcript loses no height.
//
// PER-BROWSER, AND THE SHEET SAYS SO. Phase 1 stores pins in localStorage
// (lib/pins.ts), which does not follow the reader between phone and desktop. The
// design's honest rule is to state that in the UI rather than let the reader
// discover it, so a one-line notice sits at the top of the sheet. Daemon-backed
// cross-device sync is phase 2.
//
// THE JUMP DEGRADES HONESTLY. A pin to a message older than the loaded (and
// locate-loaded) transcript window must NEVER scroll to a plausible-but-wrong
// message. It resolves by exact block id only; when it cannot, it says "older
// than the loaded history" and leaves the pin in place (pinning-design.md §6).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Pencil,
  Pin,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';
import {
  MAX_NOTE_LEN,
  parseGithubPr,
  pinsStore,
  type MessagePin,
  type NotePin,
  type Pin as PinItem,
} from '../lib/pins';
import { useSessionPins } from '../hooks/usePins';
import { requestJump, type JumpOutcome } from '../lib/pin-bridge';
import { useInputModality } from '../hooks/useInputModality';
import { cn, fmtClock } from '../lib/utils';

const UNDO_MS = 5_000;
/** Cap that mirrors the transcript controller's locate cap — display only. */
const LOCATE_PAGE_CAP = 10;

// ---- pure helpers (asserted in PinSheet.test.tsx; this package has no DOM) --

export function pinsTriggerLabel(count: number): string {
  return count > 0 ? `Pins (${count})` : 'Pins';
}

export function noteCharsRemaining(text: string): number {
  return MAX_NOTE_LEN - text.length;
}

/** The honest copy for a jump that did not land on the message. */
export function jumpOutcomeCopy(outcome: Exclude<JumpOutcome, 'jumped'>): string {
  return outcome === 'no-transcript'
    ? 'Open the Chat tab to jump to a message.'
    : "Can't find it — this message is older than the loaded history.";
}

export function locatingLabel(olderPagesLoaded: number): string {
  return olderPagesLoaded > 0
    ? `Locating… (loaded ${olderPagesLoaded}/${LOCATE_PAGE_CAP} older ${olderPagesLoaded === 1 ? 'page' : 'pages'})`
    : 'Locating…';
}

export interface LinkSegment {
  type: 'text' | 'url';
  value: string;
}

const URL_IN_TEXT = /(https?:\/\/[^\s]+)/gi;

/** Split note text into plain runs and bare URLs, for linkify-on-render. Pure
 *  and DOM-free so it is unit-testable. */
export function splitLinkified(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'url', value: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  if (out.length === 0) out.push({ type: 'text', value: text });
  return out;
}

const BLOCK_KIND_LABEL: Record<MessagePin['blockKind'], string> = {
  user: 'message',
  assistant: 'assistant',
  thinking: 'thinking',
  tools: 'tools',
  system: 'system',
  notice: 'notice',
};

// ---- the trigger ------------------------------------------------------------

export function PinsTrigger({
  id,
  count,
  onClick,
  expanded,
  controls,
}: {
  id: string;
  count: number;
  onClick: () => void;
  expanded: boolean;
  controls?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={pinsTriggerLabel(count)}
      title={pinsTriggerLabel(count)}
      className="relative inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control border border-border p-0 text-muted hover:border-accent-border hover:text-fg"
    >
      <Pin size={16} aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full border border-surface bg-accent px-1 text-[10px] font-semibold leading-[15px] text-accent-fg"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

// ---- the sheet --------------------------------------------------------------

export function PinSheet({
  id,
  sessionId,
  open,
  onClose,
  labelledBy,
}: {
  id: string;
  sessionId: string;
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
}) {
  const pins = useSessionPins(sessionId);
  const { touchAffected } = useInputModality();

  const [draft, setDraft] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ pin: PinItem; index: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [jumpState, setJumpState] = useState<{
    id: string;
    phase: 'locating' | 'done';
    pages: number;
    outcome?: Exclude<JumpOutcome, 'jumped'>;
  } | null>(null);

  const addInputRef = useRef<HTMLInputElement | null>(null);

  // Reset transient state whenever the sheet closes or the session changes: a
  // stale "not found" notice or a half-typed edit must not survive a reopen.
  useEffect(() => {
    if (open) return;
    setEditingId(null);
    setEditError(null);
    setNoteError(null);
    setJumpState(null);
  }, [open]);

  useEffect(() => {
    setDraft('');
    setNoteError(null);
    setEditingId(null);
    setUndo(null);
  }, [sessionId]);

  // Desktop only: land focus in the add-note field on open. NEVER on touch —
  // summoning the on-screen keyboard the instant a sheet opens is exactly the
  // behaviour the a11y contract forbids.
  useEffect(() => {
    if (open && !touchAffected) addInputRef.current?.focus();
  }, [open, touchAffected]);

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const commitNote = useCallback(() => {
    const result = pinsStore.addNote(sessionId, draft);
    if (result.ok) {
      setDraft('');
      setNoteError(null);
      return;
    }
    setNoteError(result.reason === 'too-long' ? `Too long by ${draft.length - MAX_NOTE_LEN} characters.` : null);
  }, [draft, sessionId]);

  const beginEdit = useCallback((note: NotePin) => {
    setEditingId(note.id);
    setEditText(note.text);
    setEditError(null);
  }, []);

  const saveEdit = useCallback(
    (noteId: string) => {
      const result = pinsStore.editNote(sessionId, noteId, editText);
      if (result.ok) {
        setEditingId(null);
        setEditError(null);
        return;
      }
      setEditError(
        result.reason === 'too-long' ? `Too long by ${editText.length - MAX_NOTE_LEN} characters.` : 'Empty.',
      );
    },
    [editText, sessionId],
  );

  const deleteWithUndo = useCallback(
    (pin: PinItem, index: number) => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      pinsStore.remove(sessionId, pin.id);
      setUndo({ pin, index });
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    },
    [sessionId],
  );

  const restoreUndo = useCallback(() => {
    if (!undo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    pinsStore.insertAt(sessionId, undo.pin, undo.index);
    setUndo(null);
  }, [sessionId, undo]);

  const jumpTo = useCallback(
    async (pin: MessagePin) => {
      setJumpState({ id: pin.id, phase: 'locating', pages: 0 });
      const outcome = await requestJump(pin.blockId, pages =>
        setJumpState(prev => (prev && prev.id === pin.id ? { ...prev, pages } : prev)),
      );
      if (outcome === 'jumped') {
        setJumpState(null);
        onClose();
        return;
      }
      setJumpState({ id: pin.id, phase: 'done', pages: 0, outcome });
    },
    [onClose],
  );

  return (
    <BottomSheet
      id={id}
      open={open}
      onClose={onClose}
      labelledBy={labelledBy}
      ariaLabel="Pins"
      closeLabel="Close pins"
      panelClassName="kt-details"
    >
      <div className="shrink-0 border-b border-border-soft">
        <div className="mx-auto flex w-full max-w-2xl min-w-0 items-baseline gap-sm px-panel pb-row-y">
          <span className="min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg">
            Pins
          </span>
          <span className="kt-label shrink-0">{pins.length} pinned</span>
        </div>
        {/* The cross-device truth, stated rather than discovered. */}
        <p className="mx-auto w-full max-w-2xl px-panel pb-row-y text-meta leading-base text-faint">
          Saved on <strong className="font-semibold text-muted">this browser only</strong> — pins do not follow you to
          another device yet.
        </p>
      </div>

      {/* Add-note form, pinned above the list so it never needs a scroll. */}
      <div className="shrink-0 border-b border-border-soft">
        <form
          className="mx-auto flex w-full max-w-2xl items-start gap-sm px-panel py-row-y"
          onSubmit={event => {
            event.preventDefault();
            commitNote();
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="sr-only">Add a note or link</span>
            <input
              ref={addInputRef}
              type="text"
              value={draft}
              onChange={event => {
                setDraft(event.target.value);
                if (noteError) setNoteError(null);
              }}
              placeholder="Add a note or link…"
              enterKeyHint="done"
              aria-invalid={noteError ? true : undefined}
              className="kt-input min-h-[44px] w-full"
            />
          </label>
          <Button type="submit" size="sm" variant="primary" className="min-h-[44px] shrink-0" aria-label="Add pin">
            Add
          </Button>
        </form>
        {(noteError || draft.length > MAX_NOTE_LEN * 0.8) && (
          <p
            className={cn(
              'mx-auto w-full max-w-2xl px-panel pb-row-y text-meta leading-base',
              noteError ? 'text-err' : 'text-faint',
            )}
            role={noteError ? 'alert' : undefined}
          >
            {noteError ?? `${noteCharsRemaining(draft)} characters left`}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-2xl px-panel py-row-y">
          {undo && (
            <div className="mb-sm flex items-center justify-between gap-sm rounded-control border border-border-soft bg-surface-2 px-cell-x py-1.5 text-cell text-muted">
              <span className="min-w-0 truncate">Deleted.</span>
              <button
                type="button"
                onClick={restoreUndo}
                className="inline-flex min-h-[44px] shrink-0 items-center gap-xs rounded-control px-cell-x font-medium text-accent hover:underline"
              >
                <Undo2 size={14} aria-hidden="true" /> Undo
              </button>
            </div>
          )}

          {pins.length === 0 && !undo ? (
            <p className="py-6 text-center text-cell text-faint">
              No pins yet. Add a link above, or pin a message from the transcript.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-sm p-0">
              {pins.map((pin, index) =>
                pin.kind === 'note' ? (
                  <NoteRow
                    key={pin.id}
                    note={pin}
                    editing={editingId === pin.id}
                    editText={editText}
                    editError={editError}
                    onEditTextChange={setEditText}
                    onBeginEdit={() => beginEdit(pin)}
                    onSaveEdit={() => saveEdit(pin.id)}
                    onCancelEdit={() => {
                      setEditingId(null);
                      setEditError(null);
                    }}
                    onDelete={() => deleteWithUndo(pin, index)}
                  />
                ) : (
                  <MessageRow
                    key={pin.id}
                    pin={pin}
                    jump={jumpState && jumpState.id === pin.id ? jumpState : null}
                    onJump={() => void jumpTo(pin)}
                    onDelete={() => deleteWithUndo(pin, index)}
                  />
                ),
              )}
            </ul>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

function RowShell({ children }: { children: React.ReactNode }) {
  return (
    <li className="rounded-control border border-border-soft bg-surface px-cell-x py-1.5">
      <div className="flex min-w-0 items-start gap-sm">{children}</div>
    </li>
  );
}

function IconButton({
  onClick,
  label,
  children,
  tone,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  tone?: 'danger' | 'accent';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2',
        tone === 'danger' && 'hover:text-err',
        tone === 'accent' && 'hover:text-accent',
      )}
    >
      {children}
    </button>
  );
}

function NoteRow({
  note,
  editing,
  editText,
  editError,
  onEditTextChange,
  onBeginEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: {
  note: NotePin;
  editing: boolean;
  editText: string;
  editError: string | null;
  onEditTextChange: (text: string) => void;
  onBeginEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  if (editing) {
    return (
      <RowShell>
        <form
          className="min-w-0 flex-1"
          onSubmit={event => {
            event.preventDefault();
            onSaveEdit();
          }}
        >
          <label className="block min-w-0">
            <span className="sr-only">Edit note</span>
            <input
              type="text"
              value={editText}
              onChange={event => onEditTextChange(event.target.value)}
              aria-invalid={editError ? true : undefined}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- focus follows an
              // explicit reader action (pressing Edit), not an unbidden open.
              autoFocus
              className="kt-input min-h-[44px] w-full"
            />
          </label>
          {editError && (
            <p role="alert" className="mt-1 text-meta text-err">
              {editError}
            </p>
          )}
        </form>
        <IconButton onClick={onSaveEdit} label="Save note" tone="accent">
          <Check size={16} aria-hidden="true" />
        </IconButton>
        <IconButton onClick={onCancelEdit} label="Cancel edit">
          <X size={16} aria-hidden="true" />
        </IconButton>
      </RowShell>
    );
  }

  const pr = parseGithubPr(note.text);
  return (
    <RowShell>
      <div className="min-w-0 flex-1 self-center break-words text-cell text-fg-soft">
        {pr ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={pr.url}
            aria-label={`${pr.org}/${pr.repo} pull request ${pr.number}`}
            className="inline-flex min-w-0 max-w-full items-center gap-xs rounded-badge border border-accent-border bg-surface-2 px-badge-x py-0.5 text-cell font-medium text-accent hover:underline"
          >
            <GitPullRequest size={13} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 truncate">
              {pr.repo}#{pr.number}
            </span>
            <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
          </a>
        ) : (
          <NoteText text={note.text} />
        )}
      </div>
      <IconButton onClick={onBeginEdit} label="Edit note" tone="accent">
        <Pencil size={15} aria-hidden="true" />
      </IconButton>
      <IconButton onClick={onDelete} label="Delete note" tone="danger">
        <Trash2 size={15} aria-hidden="true" />
      </IconButton>
    </RowShell>
  );
}

function NoteText({ text }: { text: string }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {splitLinkified(text).map((seg, i) =>
        seg.type === 'url' ? (
          <a
            key={i}
            href={seg.value}
            target="_blank"
            rel="noreferrer"
            className="break-all text-accent hover:underline"
          >
            {seg.value}
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </span>
  );
}

function MessageRow({
  pin,
  jump,
  onJump,
  onDelete,
}: {
  pin: MessagePin;
  jump: { phase: 'locating' | 'done'; pages: number; outcome?: Exclude<JumpOutcome, 'jumped'> } | null;
  onJump: () => void;
  onDelete: () => void;
}) {
  const locating = jump?.phase === 'locating';
  const clock = pin.ts ? fmtClock(pin.ts) : '';
  return (
    <RowShell>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-xs text-meta text-faint">
          <span className="kt-label">{BLOCK_KIND_LABEL[pin.blockKind]}</span>
          {clock && <span className="mono tabular-nums">{clock}</span>}
        </div>
        <p className="m-0 mt-0.5 line-clamp-3 break-words text-cell text-fg-soft">{pin.preview || '(empty message)'}</p>
        {jump?.phase === 'done' && jump.outcome && (
          <p role="status" className="mt-1 text-meta leading-base text-warn">
            {jumpOutcomeCopy(jump.outcome)}
          </p>
        )}
        {locating && (
          <p role="status" className="mt-1 inline-flex items-center gap-xs text-meta leading-base text-muted">
            <LoaderCircle size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            {locatingLabel(jump.pages)}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onJump}
        disabled={locating}
        aria-label={`Jump to message: ${pin.preview.slice(0, 60) || 'pinned message'}`}
        title="Jump to this message in the transcript"
        className="inline-flex min-h-[44px] shrink-0 items-center gap-xs rounded-control border border-border px-cell-x text-cell text-muted hover:border-accent-border hover:text-accent disabled:opacity-60"
      >
        <ArrowDownToLine size={14} aria-hidden="true" />
        Jump
      </button>
      <IconButton onClick={onDelete} label="Delete pinned message" tone="danger">
        <Trash2 size={15} aria-hidden="true" />
      </IconButton>
    </RowShell>
  );
}
