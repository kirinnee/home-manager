// Inline structured question form (interaction.question). Mirrors the CLI
// contract the daemon enforces: single question → labels (+ other), multiple
// questions → responses (one per question).
//
// TWO RENDER MODES, ONE STATE MODEL, ONE SUBMIT PATH. On a phone (`compact`)
// a multi-question set is PAGED — one question per screen with Back/Next —
// because a 3-4 question set with an always-open textarea under each is a
// full-screen-plus wall on 390px. On desktop (and for a single-question set)
// every question renders at once, exactly as before. The two modes differ only
// in WHICH questions render and whether a nav row shows: `picks`/`others`/
// `otherSelected`, `buildPayload`, and the single final `api.answer` POST are
// mode-independent. See ms1lv08o-91f42cd0/question-paging-spec.md.
//
// Three latent bugs the spec found are fixed here:
//   1. multi-question sets rendered single-choice questions as checkboxes and
//      then submitted only the first pick — silent data loss. `optionIsMultiple`
//      is now `multiSelect && !multi-question-set`, so a multi-question set is
//      strictly single-choice per page, matching the wire.
//   2. no `requestId` was passed, defeating the server dedupe. One id is minted
//      per pending set (keyed to `toolUseId`) and reused across retries.
//   3. stale state when a NEW set arrived while mounted. The mount site now
//      keys on `toolUseId` (see questionform-mountsite.patch.md); as a safe
//      degrade when unwired, the component also resets on a `toolUseId` change.

import {
  Component,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
  type Ref,
} from 'react';
import { Button } from './Primitives';
import type { ChatRecord } from '../types';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/utils';
import { useInputModality } from '../hooks/useInputModality';

export interface PFQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

export interface ParsedQuestionRecord {
  questions: PFQuestion[];
  toolUseId?: string;
  malformed?: string;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract the stale-question binding without trusting any other payload field. */
export function questionToolUseId(question: ChatRecord): string | undefined {
  try {
    const value = recordValue(question.data)?.toolUseId;
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Text that remains safe to render when the structured payload itself is not.
 * Prefer the human-facing question strings, but retain a JSON fallback for a
 * partially loaded/legacy record whose prompt lives under an unexpected key.
 */
export function rawQuestionText(question: ChatRecord): string {
  try {
    const data = recordValue(question.data);
    if (!data) return 'Question text unavailable.';
    const rawQuestions = data.questions;
    if (Array.isArray(rawQuestions)) {
      const lines = rawQuestions.flatMap((value, index) => {
        if (typeof value === 'string' && value.trim()) return [`Question ${index + 1}: ${value}`];
        const raw = recordValue(value);
        if (!raw || typeof raw.question !== 'string' || !raw.question.trim()) return [];
        const header = typeof raw.header === 'string' && raw.header.trim() ? `${raw.header}: ` : '';
        return [`${header}${raw.question}`];
      });
      if (lines.length > 0) return lines.join('\n\n');
    }
    if (typeof data.question === 'string' && data.question.trim()) return data.question;
    const serialized = JSON.stringify(question.data, null, 2);
    return serialized && serialized !== '{}' ? serialized : 'Question text unavailable.';
  } catch {
    return 'Question text unavailable.';
  }
}

/**
 * Validate at the component edge. Unknown fields remain forward-compatible,
 * while a bad value in a field React would render/map degrades the whole form
 * to the raw-text recovery surface instead of throwing through the chat page.
 */
export function parseQuestionRecord(question: ChatRecord): ParsedQuestionRecord {
  const data = recordValue(question.data);
  if (!data) return { questions: [], malformed: 'The question payload is missing.' };

  const toolUseId = questionToolUseId(question);
  if (!Array.isArray(data.questions)) {
    return { questions: [], toolUseId, malformed: 'The question list is missing or malformed.' };
  }
  if (data.questions.length === 0) {
    return { questions: [], toolUseId, malformed: 'The question list is empty.' };
  }
  if (!toolUseId) {
    return { questions: [], malformed: 'The question has no usable tool id.' };
  }

  const questions: PFQuestion[] = [];
  for (const [questionIndex, value] of data.questions.entries()) {
    const raw = recordValue(value);
    if (!raw || typeof raw.question !== 'string' || raw.question.trim().length === 0) {
      return { questions: [], toolUseId, malformed: `Question ${questionIndex + 1} has no readable text.` };
    }
    if (raw.header !== undefined && typeof raw.header !== 'string') {
      return { questions: [], toolUseId, malformed: `Question ${questionIndex + 1} has a malformed header.` };
    }
    if (raw.multiSelect !== undefined && typeof raw.multiSelect !== 'boolean') {
      return { questions: [], toolUseId, malformed: `Question ${questionIndex + 1} has a malformed selection mode.` };
    }
    if (raw.options !== undefined && !Array.isArray(raw.options)) {
      return { questions: [], toolUseId, malformed: `Question ${questionIndex + 1} has malformed options.` };
    }
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      return { questions: [], toolUseId, malformed: `Question ${questionIndex + 1} has no usable options.` };
    }

    const options: NonNullable<PFQuestion['options']> = [];
    for (const [optionIndex, optionValue] of ((raw.options as unknown[] | undefined) ?? []).entries()) {
      const option = recordValue(optionValue);
      if (!option || typeof option.label !== 'string' || option.label.trim().length === 0) {
        return {
          questions: [],
          toolUseId,
          malformed: `Question ${questionIndex + 1}, option ${optionIndex + 1} has no readable label.`,
        };
      }
      if (option.description !== undefined && typeof option.description !== 'string') {
        return {
          questions: [],
          toolUseId,
          malformed: `Question ${questionIndex + 1}, option ${optionIndex + 1} has a malformed description.`,
        };
      }
      if (option.preview !== undefined && typeof option.preview !== 'string') {
        return {
          questions: [],
          toolUseId,
          malformed: `Question ${questionIndex + 1}, option ${optionIndex + 1} has a malformed preview.`,
        };
      }
      options.push({
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
        ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
      });
    }
    questions.push({
      question: raw.question,
      ...(typeof raw.header === 'string' ? { header: raw.header } : {}),
      ...(options.length > 0 || raw.options !== undefined ? { options } : {}),
      ...(typeof raw.multiSelect === 'boolean' ? { multiSelect: raw.multiSelect } : {}),
    });
  }
  return { questions, toolUseId };
}

/** Suppression is bound to one ask. A real tool id is authoritative; malformed
 *  records still get a deterministic fallback so Escape cannot trap the user. */
export function questionDismissalKey(question: ChatRecord): string {
  const toolUseId = questionToolUseId(question);
  if (toolUseId) return `tool:${toolUseId}`;
  return `malformed:${question.timestamp ?? ''}:${rawQuestionText(question)}`;
}

export function isQuestionSuppressed(currentKey: string | undefined, dismissedKey: string | null): boolean {
  return currentKey !== undefined && dismissedKey === currentKey;
}

/** A transiently absent store record is not evidence of a new ask. Retain the
 *  hatch until a concrete, different question arrives (or the session changes). */
export function shouldClearQuestionSuppression(currentKey: string | undefined, dismissedKey: string | null): boolean {
  return currentKey !== undefined && dismissedKey !== null && dismissedKey !== currentKey;
}

/** Dedupe ids are uniqueness tokens, not secrets. A non-secure origin may not
 *  expose randomUUID, so the form must never throw merely by rendering there. */
export function mintQuestionRequestId(
  randomUuid: (() => string) | null = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? () => crypto.randomUUID()
    : null,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  try {
    const value = randomUuid?.();
    if (value) return value;
  } catch {
    // Fall through to the local uniqueness token.
  }
  return `question-${now().toString(36)}-${random().toString(36).slice(2)}`;
}

export interface QuestionErrorBoundaryProps {
  active: boolean;
  rawText: string;
  resetKey: string;
  onDismiss(): void;
  children: ReactNode;
}

interface QuestionErrorBoundaryState {
  failed: boolean;
}

/**
 * The Escape listener lives OUTSIDE the form subtree it protects. If an option
 * throws midway through render, React replaces only that subtree while this
 * boundary stays mounted, keeps listening, and renders the original prompt.
 */
export class QuestionErrorBoundary extends Component<QuestionErrorBoundaryProps, QuestionErrorBoundaryState> {
  state: QuestionErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): QuestionErrorBoundaryState {
    return { failed: true };
  }

  componentDidMount(): void {
    if (typeof window !== 'undefined') window.addEventListener('keydown', this.handleKeyDown, true);
  }

  componentDidUpdate(previous: QuestionErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  componentWillUnmount(): void {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.handleKeyDown, true);
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('kteam: structured question failed to render', error, info?.componentStack);
  }

  handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.props.active || (event.key !== 'Escape' && event.key !== 'Esc')) return;
    event.preventDefault();
    event.stopPropagation();
    this.props.onDismiss();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <QuestionRecoverySurface rawText={this.props.rawText} onDismiss={this.props.onDismiss} />;
  }
}

export function QuestionRecoverySurface({
  rawText,
  reason = 'Something went wrong while rendering this question.',
  onDismiss,
}: {
  rawText: string;
  reason?: string;
  onDismiss(): void;
}) {
  return (
    <div className="my-2 rounded-md border border-err-border bg-err-bg p-3 text-[13px]" role="alert">
      <div className="font-semibold text-err">{reason}</div>
      <div className="mt-1 text-muted">Press Esc to decline it and return to normal chat.</div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface p-2 font-sans text-fg">
        {rawText}
      </pre>
      <button
        type="button"
        className="mt-2 min-h-[44px] min-w-[44px] rounded border border-border bg-surface px-3 py-2 text-fg"
        onClick={onDismiss}
      >
        Decline question
      </button>
    </div>
  );
}

/** All answer-in-progress state. Arrays are parallel to `questions`. */
export interface AnswerState {
  /** Selected option labels per question. */
  picks: string[][];
  /** Freeform "Other" text per question (kept even while Other is deselected). */
  others: string[];
  /** Whether the exclusive "Other" row is the selection for that question. */
  otherSelected: boolean[];
}

// ---- pure helpers (exported for unit tests) --------------------------------

export function initAnswerState(questions: PFQuestion[]): AnswerState {
  return {
    picks: questions.map(() => []),
    others: questions.map(() => ''),
    otherSelected: questions.map(() => false),
  };
}

/**
 * Checkboxes ONLY for a single-question multiSelect. Every question in a
 * multi-question set is single-choice — the wire carries one response string
 * per question (`responses[i]`), so a checkbox there collects picks the daemon
 * silently drops. This is the fix for the pre-existing `!!q.multiSelect ||
 * isMulti` quirk.
 */
export function optionIsMultiple(q: PFQuestion, isMultiSet: boolean): boolean {
  return !!q.multiSelect && !isMultiSet;
}

/** Toggle an option pick. Picking any option deselects the exclusive Other row
 *  (freeform beats selections on the wire, so the two can never coexist). */
export function applyOptionToggle(state: AnswerState, i: number, label: string, multiple: boolean): AnswerState {
  const picks = state.picks.slice();
  const cur = picks[i] ?? [];
  const has = cur.includes(label);
  picks[i] = multiple ? (has ? cur.filter(x => x !== label) : [...cur, label]) : [label];
  const otherSelected = state.otherSelected.slice();
  otherSelected[i] = false;
  return { ...state, picks, otherSelected };
}

/** Select the exclusive Other row, clearing any option picks for that question. */
export function applyOtherSelect(state: AnswerState, i: number): AnswerState {
  const picks = state.picks.slice();
  picks[i] = [];
  const otherSelected = state.otherSelected.slice();
  otherSelected[i] = true;
  return { ...state, picks, otherSelected };
}

export function setOtherText(state: AnswerState, i: number, text: string): AnswerState {
  const others = state.others.slice();
  others[i] = text;
  return { ...state, others };
}

/** A question is answered when an option is picked, or Other is selected with
 *  non-empty trimmed text. */
export function isAnswered(state: AnswerState, i: number): boolean {
  if (state.otherSelected[i]) return (state.others[i] ?? '').trim().length > 0;
  return (state.picks[i]?.length ?? 0) > 0;
}

export function allAnswered(state: AnswerState, questions: PFQuestion[]): boolean {
  return questions.every((_, i) => isAnswered(state, i));
}

/** First unanswered question index, or -1 if every question is answered. */
export function firstUnansweredIndex(state: AnswerState, questions: PFQuestion[]): number {
  return questions.findIndex((_, i) => !isAnswered(state, i));
}

export type AnswerPayload = { labels?: string[]; other?: string; responses?: string[] };

/**
 * Byte-identical wire semantics to the original form, only narrowed by the
 * Other-is-exclusive rule (never `labels` AND `other` together — a strict
 * subset of what the daemon already accepted):
 *   - single question → `{ labels, other? }`
 *   - N questions     → `{ responses }`, one string per question, freeform
 *     text taking precedence over the pick (matches tmux-controller).
 */
export function buildPayload(questions: PFQuestion[], state: AnswerState): AnswerPayload {
  if (questions.length <= 1) {
    if (state.otherSelected[0]) {
      return { labels: [], other: (state.others[0] ?? '').trim() || undefined };
    }
    return { labels: state.picks[0] ?? [], other: undefined };
  }
  const responses = questions.map((_, i) =>
    state.otherSelected[i] ? (state.others[i] ?? '').trim() : (state.picks[i]?.[0] ?? ''),
  );
  return { responses };
}

export function clampPage(page: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, page), count - 1);
}

/** Reveal-focus the Other textarea ONLY on a non-touch (mouse/keyboard)
 *  context. On touch, revealing it must never summon the keyboard unprompted
 *  (plan §4). Mirrors Composer's `shouldRefocusComposer`. */
export function shouldFocusOtherTextarea(touchAffected: boolean): boolean {
  return !touchAffected;
}

/**
 * One request id per pending question SET, reused across every attempt
 * (including a post-error retry) so the daemon dedupe (`api-server`
 * DEDUPED_ACTIONS) applies the answer exactly once. A new set (new
 * `toolUseId`) mints a fresh id. Pure so the contract is unit-testable without
 * a DOM: same key ⇒ same id object; changed key ⇒ freshly minted.
 */
export function resolveRequestId(
  prev: { id: string; key: string | undefined } | null,
  key: string | undefined,
  mint: () => string,
): { id: string; key: string | undefined } {
  if (prev && prev.key === key) return prev;
  return { id: mint(), key };
}

/**
 * Run an abandon attempt with an id owned by this pending question, rather
 * than by the answer submission. A failed request can therefore be retried
 * without allowing a later normal interrupt through after the daemon has
 * already cancelled the question.
 *
 * The attempt also NAMES the question it is abandoning. The retained request id
 * only makes the daemon apply the abandon once; it does not say WHICH question
 * the user was looking at. A retry of A's abandon that lands after A was
 * answered and B was asked would otherwise cancel B — so `toolUseId` travels
 * with the request and the daemon refuses a mismatch.
 */
export async function interruptPendingQuestion(opts: {
  requestIdRef: { current: { id: string; key: string | undefined } | null };
  toolUseId: string;
  mint: () => string;
  interrupt: (requestId: string, toolUseId: string) => Promise<unknown>;
}): Promise<unknown> {
  const { requestIdRef, toolUseId, mint, interrupt } = opts;
  requestIdRef.current = resolveRequestId(requestIdRef.current, toolUseId, mint);
  return await interrupt(requestIdRef.current.id, toolUseId);
}

/**
 * Submit orchestration with a synchronous double-fire guard. Extracted so the
 * "rapid double-tap issues exactly one api.answer" property is testable in a
 * DOM-free harness: two overlapping calls sharing `guard` run `send` once.
 * A validation failure or a rejected send releases the guard so a retry (with
 * the SAME request id) can proceed; a successful send keeps it held because the
 * form is about to unmount.
 */
export async function submitAnswers(opts: {
  guard: { current: boolean };
  validate: () => string | null;
  send: () => Promise<void>;
  setSubmitting: (v: boolean) => void;
  setError: (v: string | null) => void;
}): Promise<void> {
  const { guard, validate, send, setSubmitting, setError } = opts;
  if (guard.current) return;
  guard.current = true;
  const err = validate();
  if (err) {
    setError(err);
    guard.current = false;
    return;
  }
  setSubmitting(true);
  setError(null);
  try {
    await send();
  } catch (e) {
    setError(e instanceof ApiError ? e.message : String(e));
    guard.current = false;
  } finally {
    setSubmitting(false);
  }
}

// ---- presentational pieces --------------------------------------------------

export interface QuestionFormProps {
  sessionId: string;
  question: ChatRecord;
  onSubmit(): void;
  /** Synchronously suppress this exact ask in the parent, before networking. */
  onDismissed?(dismissalKey: string): void;
  /** A background decline failed after the local surface had already closed. */
  onDismissFailed?(message: string): void;
  /** Retained chat panes stay mounted; only the visible pane owns global Esc. */
  active?: boolean;
  /** Phone chrome: paged, one question per screen (multi-question sets only).
   *  Defaults false so the component is correct and shippable before the mount
   *  site threads it through (like `Composer`). */
  compact?: boolean;
}

/** The all-at-once / single-question submit button. Kept visible, labelled and
 *  ≥44px in every state (disabled while submitting, never hidden). */
export function QuestionSubmitControl({ submitting, onClick }: { submitting: boolean; onClick(): void }) {
  const submittingReasonId = useId();
  return (
    <>
      {submitting && (
        <span id={submittingReasonId} className="sr-only" role="status" aria-live="polite">
          Submitting answer…
        </span>
      )}
      <Button
        className="min-h-[44px] min-w-[44px]"
        variant="primary"
        size="sm"
        type="button"
        disabled={submitting}
        aria-disabled={submitting}
        aria-describedby={submitting ? submittingReasonId : undefined}
        onClick={onClick}
      >
        Submit answer
      </Button>
    </>
  );
}

/**
 * The paged nav row. Back + (Next | Submit answers), every control visible,
 * labelled and ≥44px in every state — disabled is allowed, hidden never (plan
 * §5). A disabled control always carries an `aria-describedby` reason.
 */
export function QuestionNav({
  page,
  pageCount,
  canAdvance,
  canSubmit,
  submitting,
  onBack,
  onNext,
  onSubmit,
}: {
  page: number;
  pageCount: number;
  canAdvance: boolean;
  canSubmit: boolean;
  submitting: boolean;
  onBack(): void;
  onNext(): void;
  onSubmit(): void;
}) {
  const backReasonId = useId();
  const nextReasonId = useId();
  const submitReasonId = useId();
  const isLast = page >= pageCount - 1;
  const backDisabled = page <= 0;
  const nextDisabled = !canAdvance;
  const submitDisabled = submitting || !canSubmit;
  const submitReason = submitting ? 'Submitting answer…' : 'Answer every question to submit';

  return (
    <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
      {backDisabled && (
        <span id={backReasonId} className="sr-only">
          You are on the first question.
        </span>
      )}
      <Button
        className="min-h-[44px] min-w-[44px]"
        variant="outline"
        size="sm"
        type="button"
        disabled={backDisabled}
        aria-disabled={backDisabled}
        aria-describedby={backDisabled ? backReasonId : undefined}
        onClick={onBack}
      >
        Back
      </Button>
      {isLast ? (
        <>
          {submitDisabled && (
            <span
              id={submitReasonId}
              className="sr-only"
              role={submitting ? 'status' : undefined}
              aria-live={submitting ? 'polite' : undefined}
            >
              {submitReason}
            </span>
          )}
          <Button
            className="min-h-[44px] min-w-[44px]"
            variant="primary"
            size="sm"
            type="button"
            disabled={submitDisabled}
            aria-disabled={submitDisabled}
            aria-describedby={submitDisabled ? submitReasonId : undefined}
            onClick={onSubmit}
          >
            Submit answers
          </Button>
        </>
      ) : (
        <>
          {nextDisabled && (
            <span id={nextReasonId} className="sr-only">
              Select an option or write a response first.
            </span>
          )}
          <Button
            className="min-h-[44px] min-w-[44px]"
            variant="primary"
            size="sm"
            type="button"
            disabled={nextDisabled}
            aria-disabled={nextDisabled}
            aria-describedby={nextDisabled ? nextReasonId : undefined}
            onClick={onNext}
          >
            Next
          </Button>
        </>
      )}
    </div>
  );
}

/** One question: heading (focus target), option rows, exclusive Other row, and
 *  the revealed Other textarea. Every tappable row is ≥44px. */
function QuestionBlock({
  q,
  i,
  isMultiSet,
  compact,
  state,
  progressLabel,
  headingRef,
  otherRef,
  onOption,
  onSelectOther,
  onOtherText,
}: {
  q: PFQuestion;
  i: number;
  isMultiSet: boolean;
  compact: boolean;
  state: AnswerState;
  progressLabel?: string;
  headingRef?: Ref<HTMLDivElement>;
  otherRef?: Ref<HTMLTextAreaElement>;
  onOption(i: number, label: string, multiple: boolean): void;
  onSelectOther(i: number): void;
  onOtherText(i: number, text: string): void;
}) {
  const multiple = optionIsMultiple(q, isMultiSet);
  const otherSel = state.otherSelected[i] ?? false;
  const headingText = `${q.header || `Question ${i + 1}`}: ${q.question}`;
  const inputType = multiple ? 'checkbox' : 'radio';
  const rowClass = 'flex items-start gap-2 rounded px-2 min-h-[44px] py-2 hover:bg-surface cursor-pointer text-[13px]';

  return (
    <div
      role="group"
      aria-label={progressLabel ? `${progressLabel}: ${headingText}` : headingText}
      className="mb-2 last:mb-0"
    >
      {progressLabel && (
        <div className="mb-1 text-[10.5px] uppercase tracking-wider text-muted font-semibold">{progressLabel}</div>
      )}
      {/* Focus target on user-initiated page change. `tabIndex=-1` + a non-text
          element cannot summon the touch keyboard. Never focused on mount. */}
      <div ref={headingRef} tabIndex={-1} className="text-[13px] font-semibold outline-none">
        {headingText}
      </div>
      <div className="mt-1 space-y-0.5">
        {(q.options ?? []).map(opt => {
          const selected = !otherSel && (state.picks[i] ?? []).includes(opt.label);
          return (
            <label key={opt.label} className={rowClass}>
              <input
                type={inputType}
                name={`q${i}`}
                checked={selected}
                onChange={() => onOption(i, opt.label, multiple)}
                className="mt-0.5"
              />
              <span>
                {opt.label}
                {opt.description && <span className="text-muted"> — {opt.description}</span>}
              </span>
            </label>
          );
        })}
        {/* "Other" is an explicit, EXCLUSIVE row — the daemon delivers freeform
            instead of selections whenever text is present, so the UI now says
            that plainly rather than implying you can check boxes AND type. */}
        <label className={rowClass}>
          <input
            type={inputType}
            name={`q${i}`}
            checked={otherSel}
            onChange={() => onSelectOther(i)}
            className="mt-0.5"
          />
          <span>Other…</span>
        </label>
        {otherSel && (
          <textarea
            ref={otherRef}
            className={cn(
              'mt-1 w-full min-h-[44px] rounded border border-border bg-surface p-2 text-[13px]',
              compact ? 'resize-none' : 'resize-y',
            )}
            placeholder="Type your response"
            value={state.others[i] ?? ''}
            onChange={e => onOtherText(i, e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

// ---- the component ----------------------------------------------------------

export function QuestionForm({
  sessionId,
  question,
  onSubmit,
  onDismissed,
  onDismissFailed,
  active = true,
  compact = false,
}: QuestionFormProps) {
  const rawText = rawQuestionText(question);
  const resetKey = questionDismissalKey(question);
  const toolUseId = questionToolUseId(question);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const dismissGuard = useRef(false);
  const dismissRequestIdRef = useRef<{ id: string; key: string | undefined } | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setLocallyDismissed(false);
    setDismissError(null);
    dismissGuard.current = false;
    dismissRequestIdRef.current = null;
  }, [resetKey]);

  const dismiss = useCallback(() => {
    if (dismissGuard.current) return;
    dismissGuard.current = true;

    // The human gets control back in THIS tick. Server reconciliation follows,
    // but a refusal cannot remount this exact ask because the parent suppresses
    // `resetKey` until a genuinely new question arrives (or the page reloads).
    setLocallyDismissed(true);
    setDismissError(null);
    onDismissed?.(resetKey);

    if (!toolUseId) {
      // An omitted binding means "generic interrupt" at the API. That could
      // Escape unrelated work if this malformed/stale record is not the
      // daemon's current question, so recovery stays local and says so loudly.
      const message = 'No daemon interrupt was sent because this question has no tool id';
      dismissGuard.current = false;
      if (mounted.current) setDismissError(message);
      onDismissFailed?.(message);
      return;
    }

    void interruptPendingQuestion({
      requestIdRef: dismissRequestIdRef,
      toolUseId,
      mint: mintQuestionRequestId,
      interrupt: (requestId, boundToolUseId) => api.interrupt(sessionId, requestId, boundToolUseId),
    })
      .then(() => onSubmit())
      .catch(error => {
        const message = error instanceof ApiError ? error.message : String(error);
        dismissGuard.current = false;
        if (mounted.current) setDismissError(message);
        onDismissFailed?.(message);
      });
  }, [onDismissed, onDismissFailed, onSubmit, resetKey, sessionId, toolUseId]);

  if (locallyDismissed) {
    return (
      <div className="my-2 rounded-md border border-border bg-surface p-3 text-[12px] text-muted" role="status">
        <div>Question declined locally. Returning control to normal chat…</div>
        {dismissError && (
          <div className="mt-2 text-err" role="alert">
            The daemon did not confirm the decline: {dismissError}. Reloading will show the still-pending question
            again.
          </div>
        )}
        {dismissError && (
          <button
            type="button"
            className="mt-2 min-h-[44px] min-w-[44px] rounded border border-border px-3 py-2 text-fg"
            onClick={dismiss}
          >
            Retry decline
          </button>
        )}
      </div>
    );
  }

  return (
    <QuestionErrorBoundary active={active} rawText={rawText} resetKey={resetKey} onDismiss={dismiss}>
      <ValidatedQuestionForm
        sessionId={sessionId}
        question={question}
        onSubmit={onSubmit}
        onDismiss={dismiss}
        compact={compact}
      />
    </QuestionErrorBoundary>
  );
}

function ValidatedQuestionForm({
  sessionId,
  question,
  onSubmit,
  onDismiss,
  compact,
}: {
  sessionId: string;
  question: ChatRecord;
  onSubmit(): void;
  onDismiss(): void;
  compact: boolean;
}) {
  const parsed = parseQuestionRecord(question);
  if (parsed.malformed) {
    return (
      <QuestionRecoverySurface rawText={rawQuestionText(question)} reason={parsed.malformed} onDismiss={onDismiss} />
    );
  }
  return (
    <QuestionFormBody
      sessionId={sessionId}
      questions={parsed.questions}
      toolUseId={parsed.toolUseId}
      onSubmit={onSubmit}
      onDismiss={onDismiss}
      compact={compact}
    />
  );
}

function QuestionFormBody({
  sessionId,
  questions,
  toolUseId,
  onSubmit,
  onDismiss,
  compact,
}: {
  sessionId: string;
  questions: PFQuestion[];
  toolUseId?: string;
  onSubmit(): void;
  onDismiss(): void;
  compact: boolean;
}) {
  const isMultiSet = questions.length > 1;
  const paged = compact && isMultiSet;

  const [state, setState] = useState<AnswerState>(() => initAnswerState(questions));
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abandonConfirm, setAbandonConfirm] = useState(false);
  const { touchAffected } = useInputModality();
  const submitGuard = useRef(false);
  const requestIdRef = useRef<{ id: string; key: string | undefined } | null>(null);

  // Degrade safely when the mount site has not (yet) keyed on `toolUseId`: a
  // NEW question set arriving while mounted resets the in-progress answers
  // instead of leaving `picks`/`others` stale against the new questions. The
  // real fix is `key={toolUseId}` (mount-site patch); this is belt-and-braces.
  useEffect(() => {
    setState(initAnswerState(questions));
    setPage(0);
    setError(null);
    setAbandonConfirm(false);
    submitGuard.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolUseId]);

  requestIdRef.current = resolveRequestId(requestIdRef.current, toolUseId, mintQuestionRequestId);
  const requestId = requestIdRef.current.id;

  const safePage = clampPage(page, questions.length);

  // Focus-follows-wizard-step: move focus to the new page's heading ONLY after
  // a user-initiated Back/Next, never on mount/reconnect/compact flip.
  const headingRef = useRef<HTMLDivElement>(null);
  const navigatedRef = useRef(false);
  useLayoutEffect(() => {
    if (navigatedRef.current) {
      headingRef.current?.focus();
      navigatedRef.current = false;
    }
  }, [safePage]);

  // Reveal-focus the Other textarea on non-touch only.
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const focusOtherFor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focusOtherFor.current !== null && otherRef.current) {
      otherRef.current.focus();
      focusOtherFor.current = null;
    }
  });

  function goTo(next: number) {
    navigatedRef.current = true;
    setPage(clampPage(next, questions.length));
  }

  function onOption(i: number, label: string, multiple: boolean) {
    setState(s => applyOptionToggle(s, i, label, multiple));
  }
  function onSelectOther(i: number) {
    setState(s => applyOtherSelect(s, i));
    if (shouldFocusOtherTextarea(touchAffected)) focusOtherFor.current = i;
  }
  function onOtherText(i: number, text: string) {
    setState(s => setOtherText(s, i, text));
  }

  function runSubmit() {
    void submitAnswers({
      guard: submitGuard,
      validate: () => {
        if (!toolUseId) return 'This question has no tool id. Refresh the session before answering.';
        if (!isMultiSet) {
          if (!isAnswered(state, 0)) return 'Pick an option or write a response first';
          return null;
        }
        if (!allAnswered(state, questions)) return 'Answer every question (option or text)';
        return null;
      },
      send: async () => {
        try {
          await api.answer(sessionId, { toolUseId: toolUseId!, ...buildPayload(questions, state) }, requestId);
        } catch (error) {
          // A stale form is rejected by toolUseId binding. Refresh immediately
          // even if the WebSocket is reconnecting, so question B replaces A
          // instead of leaving the user retrying an answer the daemon will never
          // (and must never) drive into a different menu.
          onSubmit();
          throw error;
        }
        onSubmit();
      },
      setSubmitting,
      setError,
    });
  }

  const errorRow = error && (
    <div className="mt-2 rounded border border-err-border bg-err-bg px-2 py-1.5 text-[12px] text-err" role="alert">
      <div>{error}</div>
      <div className="mt-1 text-muted">
        No success was recorded. Submitting again safely rechecks the terminal pane before sending any keys.
      </div>
    </div>
  );

  const recoveryRow = (
    <div className="mt-2 rounded border border-border bg-surface px-2 py-1.5 text-[12px] text-muted">
      {abandonConfirm ? (
        <div>
          <div>
            Decline this question and return to normal chat? The form closes immediately while the daemon reconciles in
            the background.
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button className="min-h-[44px] min-w-[44px]" variant="danger" size="sm" type="button" onClick={onDismiss}>
              Confirm decline
            </Button>
            <Button
              className="min-h-[44px] min-w-[44px]"
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setAbandonConfirm(false)}
            >
              Keep question
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>Question stuck? Retry the answer, or explicitly return control to chat.</span>
          <Button
            className="min-h-[44px] min-w-[44px]"
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setAbandonConfirm(true)}
          >
            Abandon question
          </Button>
        </div>
      )}
    </div>
  );

  // border-accent, not border-accent-border: this block marks the transcript's
  // one actionable spot while the session is BLOCKED on an answer.
  const shell = 'my-2 rounded-md border border-accent bg-accent-soft p-3';

  if (paged) {
    const q = questions[safePage]!;
    return (
      // Card is a bounded flex column: the question body scrolls internally and
      // the nav row sits OUTSIDE the scroller, so an open keyboard shrinks the
      // shell (--app-h) without ever pushing Back/Next off screen (spec §7).
      <div className={cn(shell, 'flex max-h-[calc(var(--app-h,100dvh)-9rem)] flex-col')}>
        <div className="mb-1 shrink-0 text-[10.5px] uppercase tracking-wider text-muted font-semibold">
          Structured question — {safePage + 1} of {questions.length}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <QuestionBlock
            key={safePage}
            q={q}
            i={safePage}
            isMultiSet={isMultiSet}
            compact={compact}
            state={state}
            progressLabel={`Question ${safePage + 1} of ${questions.length}`}
            headingRef={headingRef}
            otherRef={otherRef}
            onOption={onOption}
            onSelectOther={onSelectOther}
            onOtherText={onOtherText}
          />
          {errorRow}
        </div>
        {recoveryRow}
        <QuestionNav
          page={safePage}
          pageCount={questions.length}
          canAdvance={isAnswered(state, safePage)}
          canSubmit={allAnswered(state, questions)}
          submitting={submitting}
          onBack={() => goTo(safePage - 1)}
          onNext={() => goTo(safePage + 1)}
          onSubmit={runSubmit}
        />
      </div>
    );
  }

  // All-at-once (desktop, or a compact single-question set).
  return (
    <div className={shell}>
      <div className="mb-2 text-[10.5px] uppercase tracking-wider text-muted font-semibold">Structured question</div>
      {questions.map((q, i) => (
        <QuestionBlock
          key={i}
          q={q}
          i={i}
          isMultiSet={isMultiSet}
          compact={compact}
          state={state}
          otherRef={focusOtherFor.current === i ? otherRef : undefined}
          onOption={onOption}
          onSelectOther={onSelectOther}
          onOtherText={onOtherText}
        />
      ))}
      {errorRow}
      {recoveryRow}
      <div className="mt-2">
        <QuestionSubmitControl submitting={submitting} onClick={runSubmit} />
      </div>
    </div>
  );
}
