// ATTENTION — a durable, session-scoped attention ledger. Its visual language
// is an incident inbox: oldest request leads, source/provenance are explicit,
// and the resolution audit remains one disclosure away after an item leaves the
// active list. It reuses the existing BottomSheet/side-pane presentation split.

import { useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { BottomSheet } from './SessionDetails';
import { Button } from './Primitives';
import {
  useAttentionCache,
  useAttentionItems,
  useAttentionResolutions,
  useAttentionSession,
} from '../hooks/useAttention';
import {
  attentionStore,
  attentionReference,
  type AttentionBy,
  type AttentionItem,
  type AttentionSource,
  type ResolvedAttentionItem,
} from '../lib/attention';
import { cn } from '../lib/utils';
import { HAS_TOKEN } from '../lib/api';

const SOURCE: Record<AttentionSource, { label: string; icon: typeof CircleAlert }> = {
  task: { label: 'Blocked task', icon: ListChecks },
  question: { label: 'Question', icon: MessageCircleQuestion },
  permission: { label: 'Permission', icon: KeyRound },
  'agent-raised': { label: 'Agent request', icon: Bot },
};

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

export function waitingAgeCopy(waitingSince: string, at = Date.now()): string {
  const elapsed = Math.max(0, at - Date.parse(waitingSince));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'waiting now';
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${hours}h`;
  return `waiting ${Math.floor(hours / 24)}d`;
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
}: {
  sessionId: string;
  presentation: 'pane' | 'sheet';
  titleId?: string;
  onRequestClose: () => void;
}) {
  const status = useAttentionSession(sessionId);
  const items = useAttentionItems(sessionId);
  const resolutions = useAttentionResolutions(sessionId);
  const cache = useAttentionCache();
  const parseErrors = cache.sessions[sessionId]?.parseErrors ?? 0;
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const resolve = async (item: AttentionItem): Promise<void> => {
    setPending(current => new Set(current).add(item.id));
    setError(null);
    try {
      await attentionStore.resolve(sessionId, item.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not resolve this item.');
    } finally {
      setPending(current => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const Heading = presentation === 'pane' ? 'h2' : 'h1';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-soft">
        <div className="mx-auto flex w-full max-w-2xl min-w-0 items-center gap-sm px-panel pb-row-y">
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
            <p className="m-0 text-meta leading-base text-faint">{items.length} unresolved · oldest first</p>
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
        <p className="mx-auto w-full max-w-2xl px-panel pb-row-y text-meta leading-base text-faint">
          Durable until marked done. Status changes alone do not erase a request, and every resolution records who
          cleared it.
        </p>
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

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-2xl px-panel py-row-y">
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
            <ol className="m-0 flex list-none flex-col gap-sm p-0">
              {items.map((item, index) => (
                <AttentionRow
                  key={item.id}
                  item={item}
                  oldest={index === 0}
                  pending={pending.has(item.id)}
                  onResolve={() => void resolve(item)}
                />
              ))}
            </ol>
          )}

          <ResolutionAudit items={resolutions} />
        </div>
      </div>
    </div>
  );
}

function AttentionRow({
  item,
  oldest,
  pending,
  onResolve,
}: {
  item: AttentionItem;
  oldest: boolean;
  pending: boolean;
  onResolve: () => void;
}) {
  const source = SOURCE[item.source];
  const SourceIcon = source.icon;
  return (
    <li
      className={cn(
        'relative overflow-hidden rounded-control border bg-surface px-cell-x py-row-y',
        oldest ? 'border-warn/50 shadow-[inset_3px_0_0_var(--warn)]' : 'border-border-soft',
      )}
    >
      <div className="flex min-w-0 items-start gap-sm">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <SourceIcon size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
            <span className="kt-label text-muted">{source.label}</span>
            <span className="mono text-meta text-faint">{attentionReference(item.id)}</span>
            {oldest && <span className="kt-label text-warn">oldest</span>}
            <span className="ml-auto inline-flex items-center gap-xs text-meta text-faint">
              <Clock3 size={11} aria-hidden="true" /> {waitingAgeCopy(item.waitingSince)}
            </span>
          </div>
          <h3 className="m-0 mt-xs text-cell font-semibold leading-snug text-fg">{item.subject}</h3>
          <p className="m-0 mt-xs text-cell leading-base text-muted">{item.why}</p>
          <div className="mt-sm rounded-control border border-border-soft bg-surface-2 px-cell-x py-1.5">
            <span className="kt-label block text-faint">How to resolve</span>
            <p className="m-0 mt-0.5 text-meta leading-base text-muted">{item.howToResolve}</p>
          </div>
          <p className="m-0 mt-sm text-meta text-faint">
            Raised by {actorLabel(item.raisedBy, item.raisedByName)} · {new Date(item.waitingSince).toLocaleString()}
          </p>
        </div>
      </div>
      <div className="mt-sm flex justify-end">
        {HAS_TOKEN ? (
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
        ) : (
          <span className="text-meta text-faint">Read-only on this connection</span>
        )}
      </div>
    </li>
  );
}

function ResolutionAudit({ items }: { items: ResolvedAttentionItem[] }) {
  return (
    <details className="group mt-md border-t border-border-soft pt-row-y">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-sm rounded-control px-cell-x text-cell font-medium text-muted hover:bg-surface-2 hover:text-fg">
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="transition-transform motion-reduce:transition-none group-open:rotate-180"
        />
        Resolution audit
        <span className="mono ml-auto text-meta text-faint">{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <p className="m-0 px-cell-x py-row-y text-meta text-faint">No recorded resolutions.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-xs px-cell-x pb-row-y pt-xs">
          {items.map(item => (
            <li
              key={`${item.id}:${item.resolvedAt}`}
              className="border-l-2 border-border-soft pl-sm text-meta leading-base"
            >
              <p className="m-0 font-medium text-muted">{item.subject}</p>
              <p className="m-0 text-faint">
                {attentionReference(item.id)} · Resolved by {actorLabel(item.resolvedBy, item.resolvedByName)} ·{' '}
                {new Date(item.resolvedAt).toLocaleString()}
              </p>
              {item.resolutionNote && <p className="m-0 text-faint">{item.resolutionNote}</p>}
            </li>
          ))}
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
