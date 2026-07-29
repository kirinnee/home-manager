// ATTENTION — a durable, session-scoped attention ledger.
//
// The surface reads like a short note, not a form (&F157). One container (the
// pane) holds a hairline-divided list; an item is NOT a card. Two colour
// families do the work that borders used to do:
//
//   the row's `data-kind`  — WHAT THE HUMAN DOES (permission / multiple choice /
//                            answer review / open question), worn by the left
//                            rail and the headline chip.
//   a block's `data-part`  — WHICH PART this is (why / background / what clears
//                            it), worn by that part's gutter icon and label.
//
// Both resolve through `attention-views.css` to contrast-checked theme tokens,
// so every theme inherits the treatment. Reading order leads with the ask; the
// ask and the action are always visible, and long background collapses. An item
// with no recorded ask keeps the NEUTRAL tone and says so: absence renders as
// unknown, never as a confident kind.

import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldQuestion,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { BottomSheet } from './SessionDetails';
import { Button, Textarea } from './Primitives';
import {
  useAttentionCache,
  useAttentionItems,
  useAttentionResolutions,
  useAttentionSession,
} from '../hooks/useAttention';
import {
  attentionStore,
  attentionReference,
  describeAttentionResponse,
  type AttentionAsk,
  type AttentionBy,
  type AttentionDisposition,
  type AttentionId,
  type AttentionItem,
  type AttentionResponse,
  type AttentionSessionStatus,
  type AttentionSource,
  type ResolvedAttentionItem,
} from '../lib/attention';
import { cn } from '../lib/utils';
import { HAS_TOKEN } from '../lib/api';
import type { CodeReference } from '../lib/references';
import type { PinReferenceLookup } from '../lib/pin-links';
import { Markdown } from './Markdown';
import './attention-views.css';

const SOURCE: Record<AttentionSource, { label: string; icon: typeof CircleAlert }> = {
  task: { label: 'Blocked task', icon: ListChecks },
  question: { label: 'Question', icon: MessageCircleQuestion },
  permission: { label: 'Permission', icon: KeyRound },
  'agent-raised': { label: 'Agent request', icon: Bot },
};

/** A source the reader's build does not know about is named as unknown rather
 * than quietly rendered as one of the four it does know. */
const UNKNOWN_SOURCE = { label: 'Unknown source', icon: CircleHelp } as const;

export function attentionSourceMeta(source: AttentionSource): { label: string; icon: typeof CircleAlert } {
  return SOURCE[source] ?? UNKNOWN_SOURCE;
}

/** `data-kind` values understood by attention-views.css. `none` is the neutral
 * tone used when the record carries no ask at all. */
export type AttentionKindTone = AttentionAsk['kind'] | 'none';

export interface AttentionKindMeta {
  tone: AttentionKindTone;
  /** The chip label — what this ask IS, in the human's words. */
  label: string;
  icon: typeof CircleAlert;
  /** What the human does about it, one short phrase. */
  action: string;
}

const KIND: Record<AttentionAsk['kind'], AttentionKindMeta> = {
  permission: { tone: 'permission', label: 'Permission', icon: ShieldQuestion, action: 'Approve or reject' },
  'multiple-choice': { tone: 'multiple-choice', label: 'Pick one', icon: ListChecks, action: 'Choose an answer' },
  'answer-review': {
    tone: 'answer-review',
    label: 'Review answer',
    icon: BadgeCheck,
    action: 'Accept it, or ask for more',
  },
  'open-question': {
    tone: 'open-question',
    label: 'Open question',
    icon: MessageCircleQuestion,
    action: 'Write an answer',
  },
};

/** A record whose ask this build cannot name is reported as unknown, never
 * silently rendered as one of the four kinds it does know. */
const UNKNOWN_KIND: AttentionKindMeta = {
  tone: 'none',
  label: 'Unknown ask',
  icon: CircleHelp,
  action: 'This build does not know how to answer this ask',
};

/** The row's headline. A KIND is only claimed when the record actually carries
 * an ask; without one the chip falls back to the item's source and stays
 * neutral, and the action line says the answer shape is unknown instead of
 * inventing one. */
export function attentionKindMeta(item: Pick<AttentionItem, 'source' | 'ask'>): AttentionKindMeta {
  if (item.ask) return KIND[item.ask.kind] ?? UNKNOWN_KIND;
  const source = attentionSourceMeta(item.source);
  return {
    tone: 'none',
    label: source.label,
    icon: source.icon,
    action: 'No answer shape recorded — clear it by acting',
  };
}

export function attentionTriggerLabel(count: number): string {
  return count > 0 ? `Attention (${count})` : 'Attention';
}

export function attentionUnreachableCopy(): string {
  return "Can't reach the daemon — this attention list may be out of date.";
}

export function actorLabel(by: AttentionBy, name: string | null): string {
  if (by === 'agent') return name ? `agent ${name}` : 'an agent';
  return by === 'human' ? 'you' : 'the daemon';
}

/** Long background is collapsed on arrival so the ask and the action stay on a
 * 390px screen together. Short background is left open — hiding two lines
 * behind a tap costs more than it saves. */
export const ATTENTION_COLLAPSE_CHARS = 220;

export function attentionCollapsesByDefault(text: string): boolean {
  return text.trim().length > ATTENTION_COLLAPSE_CHARS || text.trim().split('\n').length > 4;
}

/** Expansion is remembered per item AND per part, for as long as the pane is
 * open — the state lives in the surface, so a live snapshot update or a
 * reordering of the list never silently re-collapses what the reader opened. */
export function attentionSectionKey(id: AttentionId, part: string): string {
  return `${id}:${part}`;
}

export function attentionSectionOpen(
  state: Readonly<Record<string, boolean>>,
  key: string,
  fallbackOpen: boolean,
): boolean {
  return state[key] ?? fallbackOpen;
}

/** Who cleared an item — and HOW — as a visible badge, not just an audit
 * sentence. A human answer, a human dismissal and an agent dismissal are
 * different facts: the human must be able to scan the audit for everything
 * cleared WITHOUT them. */
export function resolutionBadge(
  by: AttentionBy,
  name: string | null,
  disposition?: AttentionDisposition,
): { label: string; cls: string; icon: typeof Check } {
  if (disposition === 'dismissed') {
    if (by === 'agent') {
      return {
        label: `dismissed by agent ${name ?? '(unnamed)'}`,
        cls: 'border-warn/50 bg-warn/10 text-warn',
        icon: Bot,
      };
    }
    if (by === 'human') {
      return { label: 'dismissed by you', cls: 'border-border bg-surface-2 text-muted', icon: UserRoundCheck };
    }
    return { label: 'dismissed by the daemon', cls: 'border-border bg-surface-2 text-muted', icon: Check };
  }
  if (by === 'agent') {
    return {
      label: `retracted by agent ${name ?? '(unnamed)'}`,
      cls: 'border-warn/50 bg-warn/10 text-warn',
      icon: Bot,
    };
  }
  if (by === 'human') return { label: 'done by you', cls: 'border-ok/50 bg-ok/10 text-ok', icon: UserRoundCheck };
  return { label: 'cleared by the daemon', cls: 'border-border bg-surface-2 text-muted', icon: Check };
}

export function waitingAgeCopy(waitingSince: string, at = Date.now()): string {
  const elapsed = Math.max(0, at - Date.parse(waitingSince));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'waiting now';
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${hours}h`;
  return `waiting ${Math.floor(hours / 24)}d`;
}

export interface AttentionOpenRequest {
  id: AttentionId;
  sequence: number;
}

export function attentionReferenceDomId(id: AttentionId): string {
  return `attention-reference-${id}`;
}

export type AttentionRequestOutcome = 'pending' | 'active' | 'resolved' | 'missing' | 'unavailable';

export function attentionRequestOutcome(
  id: AttentionId,
  status: AttentionSessionStatus,
  items: readonly Pick<AttentionItem, 'id'>[],
  resolutions: readonly Pick<ResolvedAttentionItem, 'id'>[],
): AttentionRequestOutcome {
  if (items.some(item => item.id === id)) return 'active';
  if (resolutions.some(item => item.id === id)) return 'resolved';
  if (status === 'error') return 'unavailable';
  if (status === 'ready') return 'missing';
  return 'pending';
}

export function AttentionTrigger({
  id,
  count,
  onClick,
  expanded,
  controls,
}: {
  id: string;
  count: number;
  onClick: (opener?: HTMLElement) => void;
  expanded: boolean;
  controls?: string;
}) {
  const label = attentionTriggerLabel(count);
  return (
    <button
      id={id}
      type="button"
      onClick={event => onClick(event.currentTarget)}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'relative inline-flex h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border p-0',
        count > 0
          ? 'border-warn/50 bg-warn/10 text-warn hover:border-warn hover:bg-warn/15'
          : 'border-border text-muted hover:border-accent-border hover:text-fg',
      )}
    >
      <CircleAlert size={17} aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="mono absolute -right-1 -top-1 inline-flex min-w-[17px] items-center justify-center rounded-full border border-surface bg-warn px-1 text-[10px] font-semibold leading-[16px] text-surface"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

export function AttentionSurface({
  sessionId,
  presentation,
  titleId,
  onRequestClose,
  cwd,
  requestedAttention,
  onRequestedAttentionHandled,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: {
  sessionId: string;
  presentation: 'pane' | 'sheet';
  titleId?: string;
  onRequestClose: () => void;
  cwd?: string;
  requestedAttention?: AttentionOpenRequest | null;
  onRequestedAttentionHandled?: (sequence: number) => void;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
}) {
  const status = useAttentionSession(sessionId);
  const items = useAttentionItems(sessionId);
  const resolutions = useAttentionResolutions(sessionId);
  const cache = useAttentionCache();
  const parseErrors = cache.sessions[sessionId]?.parseErrors ?? 0;
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const [targetedId, setTargetedId] = useState<AttentionId | null>(null);
  // Per-item, per-part expansion. Held here, not in the row, so it survives
  // live snapshot updates and list reordering for as long as the pane is open.
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string, fallbackOpen: boolean): void =>
    setSections(current => ({ ...current, [key]: !attentionSectionOpen(current, key, fallbackOpen) }));

  useEffect(() => {
    if (!requestedAttention) return;
    const outcome = attentionRequestOutcome(requestedAttention.id, status, items, resolutions);
    if (outcome === 'pending') return;

    if (outcome === 'missing' || outcome === 'unavailable') {
      setTargetedId(null);
      setReferenceNotice(
        outcome === 'unavailable'
          ? `Could not verify ${attentionReference(requestedAttention.id)} because the attention ledger is unavailable.`
          : `${attentionReference(requestedAttention.id)} is no longer in this attention ledger.`,
      );
      onRequestedAttentionHandled?.(requestedAttention.sequence);
      return;
    }

    setReferenceNotice(null);
    setTargetedId(requestedAttention.id);
    // Landing on an item must never leave its background hidden behind a tap.
    setSections(current => ({
      ...current,
      [attentionSectionKey(requestedAttention.id, 'context')]: true,
    }));
    if (typeof document === 'undefined') {
      onRequestedAttentionHandled?.(requestedAttention.sequence);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(attentionReferenceDomId(requestedAttention.id));
      if (target) {
        const audit = target.closest('details');
        if (audit instanceof HTMLDetailsElement) audit.open = true;
        const scroller = target.closest<HTMLElement>('[data-attention-scroller]');
        if (scroller) {
          const scrollerBox = scroller.getBoundingClientRect();
          const targetBox = target.getBoundingClientRect();
          scroller.scrollTo({
            top: Math.max(0, scroller.scrollTop + targetBox.top - scrollerBox.top - scroller.clientHeight / 3),
          });
        }
      }
      // Clear the request only after the landing work. Clearing it before this
      // frame would run the effect cleanup and cancel the exact-target jump.
      onRequestedAttentionHandled?.(requestedAttention.sequence);
    });
    return () => cancelAnimationFrame(frame);
  }, [items, onRequestedAttentionHandled, requestedAttention, resolutions, status]);

  const act = async (item: AttentionItem, operation: () => Promise<void>, failure: string): Promise<void> => {
    setPending(current => new Set(current).add(item.id));
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setPending(current => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };
  const resolve = (item: AttentionItem): Promise<void> =>
    act(item, () => attentionStore.resolve(sessionId, item.id), 'Could not resolve this item.');
  const respond = (item: AttentionItem, response: AttentionResponse): Promise<void> =>
    act(item, () => attentionStore.respond(sessionId, item.id, response), 'Could not send this answer.');
  const dismiss = (item: AttentionItem): Promise<void> =>
    act(item, () => attentionStore.dismiss(sessionId, item.id), 'Could not dismiss this item.');

  const Heading = presentation === 'pane' ? 'h2' : 'h1';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-soft">
        <div className="mx-auto flex w-full min-w-0 max-w-2xl items-center gap-sm px-panel pb-row-y">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-warn/40 bg-warn/10 text-warn">
            <CircleAlert size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <Heading
              id={titleId}
              className="m-0 truncate font-display text-title font-semibold tracking-display text-fg"
            >
              Attention
            </Heading>
            <p className="m-0 text-meta leading-base text-faint">
              {items.length} unresolved · oldest first · every clear records who did it
            </p>
          </div>
          {presentation === 'pane' && (
            <button
              type="button"
              onClick={onRequestClose}
              aria-label="Close attention"
              title="Close attention"
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {(status === 'error' || parseErrors > 0 || error) && (
        <div
          className="shrink-0 border-b border-err/30 bg-err/5 px-panel py-row-y text-meta leading-base text-err"
          role="alert"
        >
          {error ??
            (parseErrors > 0
              ? `The daemon reported ${parseErrors} parse error${parseErrors === 1 ? '' : 's'}; repair the file before trusting this list.`
              : attentionUnreachableCopy())}
        </div>
      )}

      {referenceNotice && (
        <div className="shrink-0 border-b border-warn/30 bg-warn/5 px-panel py-row-y text-meta text-warn" role="status">
          {referenceNotice}
        </div>
      )}

      <div data-attention-scroller="" className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full min-w-0 max-w-2xl px-panel">
          {status === 'loading' && items.length === 0 ? (
            <p role="status" className="flex items-center justify-center gap-xs py-8 text-cell text-muted">
              <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Loading attention ledger…
            </p>
          ) : items.length === 0 ? (
            <div className="py-10 text-center">
              <span className="mx-auto mb-sm inline-flex h-10 w-10 items-center justify-center rounded-full border border-border-soft bg-surface-2 text-muted">
                <Check size={18} aria-hidden="true" />
              </span>
              <p className="m-0 text-cell font-medium text-fg">Nothing needs attention.</p>
              <p className="m-0 mt-xs text-meta text-faint">Resolved items remain in the audit below.</p>
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
              {items.map((item, index) => (
                <AttentionRow
                  key={item.id}
                  item={item}
                  oldest={index === 0}
                  pending={pending.has(item.id)}
                  targeted={targetedId === item.id}
                  sections={sections}
                  onToggleSection={toggleSection}
                  sessionId={sessionId}
                  cwd={cwd}
                  onTaskOpen={onTaskOpen}
                  onCodeReferenceOpen={onCodeReferenceOpen}
                  onAttentionOpen={onAttentionOpen}
                  onPinOpen={onPinOpen}
                  onResolve={() => void resolve(item)}
                  onRespond={response => void respond(item, response)}
                  onDismiss={() => void dismiss(item)}
                />
              ))}
            </ol>
          )}

          <ResolutionAudit
            items={resolutions}
            targetedId={targetedId}
            sessionId={sessionId}
            cwd={cwd}
            onTaskOpen={onTaskOpen}
            onCodeReferenceOpen={onCodeReferenceOpen}
            onAttentionOpen={onAttentionOpen}
            onPinOpen={onPinOpen}
          />
        </div>
      </div>
    </div>
  );
}

/** One part of an item, always open: a coloured gutter icon, a quiet label, and
 * the prose. No box, no wash — the colour IS the separation. */
function AttentionPart({
  part,
  icon: Icon,
  label,
  children,
  className,
}: {
  part: 'why' | 'context' | 'action';
  icon: typeof CircleAlert;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-part={part} className={cn('kt-attn-part min-w-0', className)}>
      <span className="kt-label kt-attn-part-ink inline-flex items-center gap-1">
        <Icon size={11} aria-hidden="true" />
        {label}
      </span>
      {children}
    </div>
  );
}

/** A collapsible part. Controlled by the surface so expansion survives live
 * updates; a 44px toggle row on purpose, phone first. */
function AttentionDisclosure({
  part,
  icon: Icon,
  label,
  open,
  onToggle,
  regionId,
  children,
}: {
  part: 'why' | 'context' | 'action';
  icon: typeof CircleAlert;
  label: string;
  open: boolean;
  onToggle: () => void;
  regionId: string;
  children: ReactNode;
}) {
  return (
    <div data-part={part} className="kt-attn-part min-w-0">
      <button type="button" className="kt-attn-toggle" aria-expanded={open} aria-controls={regionId} onClick={onToggle}>
        <ChevronRight size={13} aria-hidden="true" className="kt-attn-chevron" />
        <Icon size={11} aria-hidden="true" className="shrink-0" />
        <span className="kt-label kt-attn-part-ink">{label}</span>
        {!open && <span className="ml-auto text-meta text-faint">show</span>}
      </button>
      <div id={regionId} hidden={!open} className="min-w-0">
        {children}
      </div>
    </div>
  );
}

function AttentionRow({
  item,
  oldest,
  pending,
  targeted,
  sections,
  onToggleSection,
  sessionId,
  cwd,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
  onResolve,
  onRespond,
  onDismiss,
}: {
  item: AttentionItem;
  oldest: boolean;
  pending: boolean;
  targeted: boolean;
  sections: Readonly<Record<string, boolean>>;
  onToggleSection: (key: string, fallbackOpen: boolean) => void;
  sessionId: string;
  cwd?: string;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
  onResolve: () => void;
  onRespond: (response: AttentionResponse) => void;
  onDismiss: () => void;
}) {
  const kind = attentionKindMeta(item);
  const KindIcon = kind.icon;
  const source = attentionSourceMeta(item.source);
  const contextKey = attentionSectionKey(item.id, 'context');
  const contextFallbackOpen = !attentionCollapsesByDefault(item.context ?? '');
  const contextOpen = attentionSectionOpen(sections, contextKey, contextFallbackOpen);
  const prose = { sessionId, cwd, onTaskOpen, onCodeReferenceOpen, onAttentionOpen, onPinOpen };
  return (
    <li
      id={attentionReferenceDomId(item.id)}
      data-reference-target={targeted || undefined}
      data-kind={kind.tone}
      className={cn(
        'kt-attn kt-attn-rail relative min-w-0 py-md pl-sm',
        targeted && 'rounded-control ring-2 ring-accent ring-offset-2 ring-offset-surface',
      )}
      {...(oldest ? { 'data-oldest': 'true' } : {})}
    >
      {/* The tag line: what kind of ask, which item, how long it has waited. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
        <span className="kt-attn-chip kt-label inline-flex shrink-0 items-center gap-1 px-badge-x py-0.5">
          <KindIcon size={11} aria-hidden="true" />
          {kind.label}
        </span>
        <span className="mono text-meta text-faint">{attentionReference(item.id)}</span>
        {oldest && <span className="kt-label kt-attn-ink">oldest</span>}
        <span className="ml-auto inline-flex shrink-0 items-center gap-xs text-meta text-faint">
          <Clock3 size={11} aria-hidden="true" /> {waitingAgeCopy(item.waitingSince)}
        </span>
      </div>

      {/* THE ASK leads. Nothing above it but its own tag line. */}
      <Markdown
        {...prose}
        text={item.subject}
        className="kt-attn-prose mt-xs text-row font-semibold leading-tight text-fg"
      />

      {/* Why it needs you now — reads straight on from the ask, warn-inked. */}
      <AttentionPart part="why" icon={CircleAlert} label="Why now" className="mt-sm">
        <Markdown {...prose} text={item.why} className="kt-attn-prose mt-0.5 text-cell leading-base text-muted" />
      </AttentionPart>

      {item.context && (
        <AttentionDisclosure
          part="context"
          icon={BookOpen}
          label="Background"
          open={contextOpen}
          onToggle={() => onToggleSection(contextKey, contextFallbackOpen)}
          regionId={`${attentionReferenceDomId(item.id)}-context`}
        >
          <Markdown {...prose} text={item.context} className="kt-attn-prose pb-xs text-meta leading-base text-muted" />
        </AttentionDisclosure>
      )}

      {/* What clears it — the action stays visible, never collapsed. */}
      <AttentionPart part="action" icon={ArrowRight} label="What clears this" className="kt-attn-part-rail mt-sm pl-sm">
        <Markdown
          {...prose}
          text={item.howToResolve}
          className="kt-attn-prose mt-0.5 text-cell leading-base text-muted"
        />
      </AttentionPart>

      {HAS_TOKEN ? (
        <div className="mt-sm flex flex-col gap-xs">
          {item.ask ? (
            <AttentionAnswerControls ask={item.ask} pending={pending} onRespond={onRespond} />
          ) : (
            <>
              <p className="m-0 text-meta text-faint">{kind.action}.</p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={pending}
                  onClick={onResolve}
                >
                  {pending ? (
                    <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <UserRoundCheck size={14} aria-hidden="true" />
                  )}
                  Mark done
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="m-0 mt-sm text-meta text-faint">Read-only on this connection.</p>
      )}

      {/* Provenance last: it explains the item, it is not the item. */}
      <div className="mt-sm flex flex-wrap items-center gap-x-sm gap-y-xs text-meta text-faint">
        <span>
          {source.label} · raised by {actorLabel(item.raisedBy, item.raisedByName)} ·{' '}
          {new Date(item.waitingSince).toLocaleString()}
        </span>
        {HAS_TOKEN && (
          <button
            type="button"
            disabled={pending}
            onClick={onDismiss}
            className="ml-auto inline-flex min-h-[44px] items-center gap-xs rounded-control px-cell-x text-meta text-faint hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            <X size={13} aria-hidden="true" />
            Dismiss without answering
          </button>
        )}
      </div>
    </li>
  );
}

/** One control set per attention kind, keyed by what the human DOES. Buttons
 * stack full-width so a 390px phone never scrolls sideways. */
function AttentionAnswerControls({
  ask,
  pending,
  onRespond,
}: {
  ask: AttentionAsk;
  pending: boolean;
  onRespond: (response: AttentionResponse) => void;
}) {
  const [text, setText] = useState('');
  const [clarifying, setClarifying] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const spinner = pending ? (
    <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
  ) : null;

  if (ask.kind === 'permission') {
    return (
      <div className="flex flex-col gap-xs sm:flex-row sm:justify-end">
        <Button
          type="button"
          size="sm"
          variant="danger"
          className="min-h-[44px]"
          disabled={pending}
          onClick={() => onRespond({ kind: 'permission', decision: 'reject' })}
        >
          {spinner ?? <X size={14} aria-hidden="true" />}
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="min-h-[44px]"
          disabled={pending}
          onClick={() => onRespond({ kind: 'permission', decision: 'approve' })}
        >
          {spinner ?? <Check size={14} aria-hidden="true" />}
          Approve
        </Button>
      </div>
    );
  }

  if (ask.kind === 'multiple-choice') {
    return (
      <div className="flex min-w-0 flex-col gap-xs" role="group" aria-label="Pick an answer">
        {/* A plain button, not `<Button>`: an option is prose the human reads,
            and `.kt-btn` would shout it in uppercase and truncate the
            description — hiding the very words that tell two options apart. */}
        {ask.options.map(option => (
          <button
            type="button"
            key={option.label}
            className="kt-attn-option"
            disabled={pending}
            onClick={() => {
              setChosen(option.label);
              onRespond({ kind: 'multiple-choice', choice: option.label });
            }}
          >
            {pending && chosen === option.label ? spinner : null}
            <span className="kt-attn-option__body">
              <span className="kt-attn-option__label">{option.label}</span>
              {option.description && <span className="kt-attn-option__hint">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>
    );
  }

  if (ask.kind === 'answer-review') {
    return (
      <div className="flex flex-col gap-xs">
        {clarifying ? (
          <>
            <Textarea
              value={text}
              onChange={event => setText(event.target.value)}
              rows={3}
              placeholder="What needs clarifying?"
              aria-label="Clarification request"
              className="w-full"
            />
            <div className="flex flex-col gap-xs sm:flex-row sm:justify-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-[44px]"
                disabled={pending}
                onClick={() => setClarifying(false)}
              >
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                className="min-h-[44px]"
                disabled={pending || !text.trim()}
                onClick={() => onRespond({ kind: 'answer-review', verdict: 'clarify', clarification: text })}
              >
                {spinner}
                Ask to clarify
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-xs sm:flex-row sm:justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-[44px]"
              disabled={pending}
              onClick={() => setClarifying(true)}
            >
              <MessageCircleQuestion size={14} aria-hidden="true" />
              Needs clarification
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="min-h-[44px]"
              disabled={pending}
              onClick={() => onRespond({ kind: 'answer-review', verdict: 'good' })}
            >
              {spinner ?? <Check size={14} aria-hidden="true" />}
              The answer is good
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-xs">
      <Textarea
        value={text}
        onChange={event => setText(event.target.value)}
        rows={3}
        placeholder="Write your answer…"
        aria-label="Your answer"
        className="w-full"
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="min-h-[44px]"
          disabled={pending || !text.trim()}
          onClick={() => onRespond({ kind: 'open-question', answer: text })}
        >
          {spinner}
          Send answer
        </Button>
      </div>
    </div>
  );
}

function ResolutionAudit({
  items,
  targetedId,
  sessionId,
  cwd,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: {
  items: ResolvedAttentionItem[];
  targetedId: AttentionId | null;
  sessionId: string;
  cwd?: string;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
}) {
  return (
    <details className="group mt-md border-t border-border-soft pt-row-y">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-sm rounded-control text-cell font-medium text-muted hover:bg-surface-2 hover:text-fg">
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="transition-transform motion-reduce:transition-none group-open:rotate-180"
        />
        Resolution audit
        <span className="mono ml-auto text-meta text-faint">{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <p className="m-0 py-row-y text-meta text-faint">No recorded resolutions.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-sm p-0 pb-row-y pt-xs">
          {items.map(item => {
            const badge = resolutionBadge(item.resolvedBy, item.resolvedByName, item.disposition);
            const BadgeIcon = badge.icon;
            return (
              <li
                key={`${item.id}:${item.resolvedAt}`}
                id={attentionReferenceDomId(item.id)}
                data-reference-target={targetedId === item.id || undefined}
                className={cn(
                  'min-w-0 border-l-2 pl-sm text-meta leading-base',
                  item.resolvedBy === 'agent' ? 'border-warn/60' : 'border-border-soft',
                  targetedId === item.id && 'rounded-control ring-2 ring-accent ring-offset-2 ring-offset-surface',
                )}
              >
                <Markdown
                  text={item.subject}
                  sessionId={sessionId}
                  cwd={cwd}
                  onTaskOpen={onTaskOpen}
                  onCodeReferenceOpen={onCodeReferenceOpen}
                  onAttentionOpen={onAttentionOpen}
                  onPinOpen={onPinOpen}
                  className="kt-attn-prose font-medium text-muted"
                />
                <p className="m-0 flex flex-wrap items-center gap-x-sm gap-y-xs text-faint">
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
                      badge.cls,
                    )}
                  >
                    <BadgeIcon size={11} aria-hidden="true" />
                    {badge.label}
                  </span>
                  <span>
                    {attentionReference(item.id)} · {new Date(item.resolvedAt).toLocaleString()}
                  </span>
                </p>
                {item.response && (
                  <p className="m-0 font-medium text-muted">{describeAttentionResponse(item.response)}</p>
                )}
                {item.resolutionNote && (
                  <Markdown
                    text={item.resolutionNote}
                    sessionId={sessionId}
                    cwd={cwd}
                    onTaskOpen={onTaskOpen}
                    onCodeReferenceOpen={onCodeReferenceOpen}
                    onAttentionOpen={onAttentionOpen}
                    onPinOpen={onPinOpen}
                    className="kt-attn-prose text-faint"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

export function AttentionSheet({
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
  return (
    <BottomSheet
      id={id}
      open={open}
      onClose={onClose}
      labelledBy={labelledBy}
      ariaLabel="Attention"
      closeLabel="Close attention"
      panelClassName="kt-details"
    >
      {open && <AttentionSurface sessionId={sessionId} presentation="sheet" onRequestClose={onClose} />}
    </BottomSheet>
  );
}
