import { useState } from 'react';
import { ChevronDown, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { Button } from './Primitives';
import type { BrowserLoginView } from '../lib/browser-login';
import { useLiveClock } from '../hooks/useLiveTick';

export function browserLoginRemaining(expiresAt: string | undefined, now = Date.now()): string {
  if (!expiresAt) return 'expiry unknown';
  const milliseconds = Date.parse(expiresAt) - now;
  if (!Number.isFinite(milliseconds)) return 'expiry unknown';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-xs py-1">
      <span className="font-medium text-muted">{label}</span>
      <code className="select-all font-mono text-meta text-fg">{value}</code>
      <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className="min-h-[32px] px-2">
        <Copy size={13} aria-hidden="true" />
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}

export function BrowserLoginBanner({
  status,
  onClose,
}: {
  status: BrowserLoginView | null;
  onClose: (primed: boolean) => Promise<BrowserLoginView>;
}) {
  const now = useLiveClock();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (status === null || status.state === 'closed') return null;
  const open = status.state === 'open';
  const close = async (primed: boolean) => {
    setBusy(true);
    await onClose(primed);
    setBusy(false);
    setMenuOpen(false);
  };

  if (!open) {
    const copy =
      status.state === 'unknown' ? `Browser login status unknown · ${status.error}` : `Browser login ${status.state}`;
    return (
      <aside
        role="status"
        aria-live="polite"
        className="shrink-0 border-b border-warn/30 bg-warn-soft px-panel py-1.5 text-ui text-warn"
      >
        <span className="flex min-w-0 items-center gap-xs">
          <ShieldAlert size={15} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{copy}</span>
        </span>
      </aside>
    );
  }

  const connection = status.connection;
  return (
    <aside
      className="shrink-0 border-b border-warn/30 bg-warn-soft px-panel py-1.5 text-ui text-warn"
      aria-label="Browser login window"
    >
      <div className="flex min-w-0 items-center gap-xs">
        <KeyRound size={15} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">
          Browser login window open · closes in {browserLoginRemaining(status.expiresAt, now)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setMenuOpen(value => !value)}
          aria-expanded={menuOpen}
          className="min-h-[32px] shrink-0 border-warn/40 bg-surface px-2 text-warn hover:text-fg"
        >
          Close <ChevronDown size={13} aria-hidden="true" />
        </Button>
      </div>
      {menuOpen && (
        <div
          className="mt-1 grid gap-xs border-t border-warn/30 pt-1"
          role="group"
          aria-label="Close browser login window"
        >
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void close(true)}
            className="min-h-[44px] justify-center"
          >
            Close — I signed in
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void close(false)}
            className="min-h-[44px] justify-center"
          >
            Close — not signed in
          </Button>
        </div>
      )}
      {connection && (
        <details className="mt-1 border-t border-warn/30 pt-1 text-fg">
          <summary className="cursor-pointer select-none text-meta font-medium text-warn">Connection details</summary>
          <div className="mt-1 max-h-36 overflow-auto rounded-control border border-warn/30 bg-surface px-2 py-1">
            <CopyLine label="VNC" value={`${connection.host}:${connection.port}`} />
            <CopyLine label="Password" value={connection.password} />
            <CopyLine label="SSH" value={connection.sshTunnel} />
          </div>
        </details>
      )}
    </aside>
  );
}
