import { useRef, useState } from 'react';
import type { SendRecord } from '../types';
import { isLedgerUnconfirmed, sendBadge } from '../lib/sends';
import { peerFrom, type LedgerBlockPlacement } from '../lib/transcript';
import { displayCallsign } from '../lib/callsign';
import { cn, fmtAbsolute } from '../lib/utils';
import type { StoredTranscriptImage } from '../lib/attachments';
import { TranscriptImageGallery } from './AttachmentImage';

export const RESEND_RISK_COPY =
  'The original may still arrive. This creates a separate send with a new ID, so continue only if a duplicate is acceptable.';

export async function runResendOnce(
  latch: { current: boolean },
  action: () => Promise<boolean>,
): Promise<boolean | undefined> {
  if (latch.current) return undefined;
  latch.current = true;
  try {
    return await action();
  } finally {
    latch.current = false;
  }
}

export function ledgerPlacementCopy(placement: LedgerBlockPlacement): string | undefined {
  if (placement === 'before-loaded') return 'older than the loaded transcript · shown at the history boundary';
  if (placement === 'after-loaded') return 'newer than the loaded transcript · shown at the history boundary';
  if (placement === 'unknown-time') return 'time position unavailable · shown at the loaded-history boundary';
  return undefined;
}

export interface LedgerMessageProps {
  record: SendRecord;
  sessionId: string;
  placement?: LedgerBlockPlacement;
  asOf?: number;
  /** Returns true only when the daemon accepted the fresh-ID attempt. */
  onResend?: (record: SendRecord) => Promise<boolean>;
}

/** A durable send attempt whose transcript delivery is not represented by a
 * loaded proof row. Resend is intentionally a two-step disclosure: unconfirmed
 * means the original may have landed, so a one-click duplicate is too dangerous.
 * The component also latches the async action synchronously with a ref, making a
 * double activation one request rather than two. */
export function LedgerMessage({
  record,
  sessionId,
  placement = 'chronological',
  asOf = Date.now(),
  onResend,
}: LedgerMessageProps) {
  const { label, tone, detail } = sendBadge(record, asOf);
  const { from, body } = peerFrom(record.message);
  const boundary = ledgerPlacementCopy(placement);
  const attachments: StoredTranscriptImage[] = record.attachmentIds.map(attachmentId => ({
    kind: 'attachment',
    sessionId,
    attachmentId,
    filename: attachmentId,
  }));
  const actionHeld = useRef(false);
  const [resending, setResending] = useState(false);
  const [result, setResult] = useState<'accepted' | 'error' | null>(null);

  const resend = async () => {
    if (!onResend || actionHeld.current) return;
    setResending(true);
    setResult(null);
    try {
      const accepted = await runResendOnce(actionHeld, () => onResend(record));
      if (accepted !== undefined) setResult(accepted ? 'accepted' : 'error');
    } catch {
      setResult('error');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="kt-bubble-row" data-ledger-placement={placement}>
      <span className="sr-only">{from ? `${displayCallsign(from.name)} sent:` : 'You said:'}</span>
      <div className="kt-bubble">
        <div className="flex min-w-0 items-center gap-2 px-panel pt-1">
          {from && <span className="shrink-0 text-[10.5px] font-medium text-muted">{displayCallsign(from.name)}</span>}
          <span className="mono min-w-0 truncate text-[10.5px] tabular-nums text-faint">
            accepted {fmtAbsolute(record.acceptedAt)}
          </span>
          <span
            className={cn(
              'ml-auto inline-flex shrink-0 select-none items-center gap-1 rounded-sm border px-1.5 py-px text-[10.5px] font-medium leading-[1.5]',
              tone,
            )}
            title={detail}
          >
            {label}
          </span>
        </div>
        {boundary && (
          <div className="px-panel pt-0.5 text-[10.5px] leading-snug text-muted" data-ledger-boundary>
            {boundary}
          </div>
        )}
        {body && (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-1.5 pt-0.5 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
            {body}
          </div>
        )}
        <span className="sr-only">{detail}</span>
        <TranscriptImageGallery images={attachments} className="px-panel pb-2 pt-1" />

        {isLedgerUnconfirmed(record, asOf) && onResend && result !== 'accepted' && (
          <details className="mx-panel mb-2 border-t border-border-soft pt-1.5 text-[11px] text-muted">
            <summary className="w-fit cursor-pointer select-none rounded-sm px-1.5 py-1 font-medium hover:bg-surface-2 hover:text-fg">
              resend…
            </summary>
            <div className="mt-1.5 rounded-control border border-warn-border bg-warn-bg px-2 py-1.5 text-warn">
              <p>{RESEND_RISK_COPY}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void resend()}
                  disabled={resending}
                  className="rounded-sm border border-warn-border px-2 py-1 font-semibold hover:bg-surface disabled:cursor-wait disabled:opacity-60"
                >
                  {resending ? 'resending…' : 'resend as a new message'}
                </button>
                <span>new send ID; the original stays unconfirmed</span>
              </div>
            </div>
          </details>
        )}
        {result === 'accepted' && (
          <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
            New send accepted — awaiting its own confirmation. The original remains unconfirmed.
          </div>
        )}
        {result === 'error' && (
          <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
            The resend was not accepted. The original remains unconfirmed.
          </div>
        )}
      </div>
    </div>
  );
}
