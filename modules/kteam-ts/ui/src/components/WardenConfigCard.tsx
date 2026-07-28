// Warden account failover editor — the `#config` card on /warden.
//
// This is daemon-global server state behind the admin token (NOT a per-browser
// preference), which is why it lives here beside the warden's sweeps and
// verdicts rather than inside /settings; Settings carries a link row that
// lands on this card. Reads GET /v1/warden/config + /v1/warden/status
// (health), writes PATCH /v1/warden/config — applied live, no daemon restart.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, ShieldCheck, X } from 'lucide-react';
import { api, HAS_TOKEN } from '../lib/api';
import type {
  WardenAccountConfig,
  WardenConfigView,
  WardenFailoverPolicy,
  WardenFailoverStatus,
  WrapperInfo,
} from '../types';
import { cn, fmtRelative } from '../lib/utils';

const POLICY_OPTIONS: ReadonlyArray<{ id: WardenFailoverPolicy; label: string; description: string }> = [
  { id: 'fallback', label: 'Fallback', description: 'Always prefer the first healthy account, in order.' },
  { id: 'round_robin', label: 'Round-robin', description: 'Rotate spawns across healthy accounts.' },
];

/** Normalize a config account entry (string shorthand allowed) for editing. */
export function editableAccounts(view: WardenConfigView | null): WardenAccountConfig[] {
  if (!view) return [];
  return view.accounts.map(account => ({ ...account }));
}

/** Installed auto wrappers whose harness has completed the warden loop. */
export function pickableWardenWrappers(
  wrappers: readonly WrapperInfo[],
  accounts: readonly WardenAccountConfig[],
): string[] {
  return wrappers
    .filter(item => (item.harness === 'claude' || item.harness === 'codex') && item.mode === 'auto' && item.launchable)
    .map(item => item.name)
    .filter(name => !accounts.some(account => account.wrapper === name));
}

/** One account's health line, joined from the status failover block. */
export function accountHealthLabel(
  wrapper: string,
  failover: WardenFailoverStatus | undefined,
): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  const account = failover?.accounts.find(item => item.wrapper === wrapper);
  if (!account) return { label: 'health unknown', tone: 'muted' };
  if (account.eligible) {
    const quota = account.quota;
    const percent =
      quota?.fiveHourPercent !== undefined || quota?.weeklyPercent !== undefined
        ? ` · 5h ${quota.fiveHourPercent ?? '—'}% wk ${quota.weeklyPercent ?? '—'}%`
        : '';
    return { label: `healthy${percent}`, tone: 'ok' };
  }
  if (account.demotedUntil) return { label: `cooling down until ${fmtRelative(account.demotedUntil)}`, tone: 'warn' };
  return { label: account.reason ?? 'ineligible', tone: 'warn' };
}

export function WardenConfigCard() {
  const [view, setView] = useState<WardenConfigView | null>(null);
  const [failover, setFailover] = useState<WardenFailoverStatus | undefined>(undefined);
  const [accounts, setAccounts] = useState<WardenAccountConfig[]>([]);
  const [policy, setPolicy] = useState<WardenFailoverPolicy>('fallback');
  const [threshold, setThreshold] = useState(2);
  const [cooldown, setCooldown] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [wrappers, setWrappers] = useState<WrapperInfo[]>([]);
  const [picker, setPicker] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);

  const adopt = useCallback((next: WardenConfigView) => {
    setView(next);
    setAccounts(next.accounts.map(account => ({ ...account })));
    setPolicy(next.config.failover?.policy ?? 'fallback');
    setThreshold(next.config.failover?.failureThreshold ?? 2);
    setCooldown(next.config.failover?.cooldownMinutes ?? 30);
    setEnabled(next.config.enabled === true);
    setWarnings(next.warnings ?? []);
    setDirty(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [config, status, wrapperList] = await Promise.all([
          api.wardenConfig(),
          api.wardenStatus().catch(() => null),
          api.wrappers().catch(() => [] as WrapperInfo[]),
        ]);
        if (cancelled) return;
        adopt(config);
        setFailover(status?.failover);
        setWrappers(wrapperList);
      } catch {
        // Older daemon without the route: hide entirely rather than render a
        // dead editor (same posture as WardenStrip).
        if (!cancelled) setHidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  // Codex completed the same live sweep → report → scoped done → reap loop as
  // Claude. Keep the picker narrower than arbitrary future harnesses: each one
  // must prove that supervision loop before it is offered here.
  const pickable = useMemo(() => pickableWardenWrappers(wrappers, accounts), [wrappers, accounts]);

  const mutate = (updater: (previous: WardenAccountConfig[]) => WardenAccountConfig[]) => {
    setAccounts(previous => updater(previous));
    setDirty(true);
  };

  const move = (index: number, delta: -1 | 1) =>
    mutate(previous => {
      const next = [...previous];
      const swap = index + delta;
      if (swap < 0 || swap >= next.length) return previous;
      const [entry] = next.splice(index, 1);
      next.splice(swap, 0, entry!);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateWardenConfig({
        enabled,
        accounts,
        failover: { policy, failureThreshold: threshold, cooldownMinutes: cooldown },
      });
      adopt(result);
      setSavedAt(Date.now());
      const status = await api.wardenStatus().catch(() => null);
      setFailover(status?.failover ?? undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (hidden || !view) return null;

  const active = failover?.lastSelection?.wrapper;

  return (
    <section
      id="config"
      aria-labelledby="warden-config-heading"
      className="kt-panel flex flex-col gap-3 p-panel"
      data-testid="warden-config-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="warden-config-heading" className="m-0 flex items-center gap-1.5 text-title font-semibold text-fg">
          <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
          Warden accounts & failover
        </h2>
        {failover?.exhaustedSince && (
          <span className="rounded-control bg-warn/15 px-2 py-0.5 text-meta font-medium text-warn">
            all accounts unhealthy since {fmtRelative(failover.exhaustedSince)}
          </span>
        )}
      </div>
      <p className="m-0 text-ui leading-base text-muted">
        Ordered warden account list. Changes apply live — no daemon restart. Under Fallback the first healthy account
        wins; a failed account cools down and recovers automatically.
      </p>

      {!HAS_TOKEN && (
        <p className="m-0 rounded-control bg-surface-2 px-3 py-2 text-ui text-warn">
          Read-only: this page was served without a daemon token, so the editor cannot save.
        </p>
      )}

      <div role="radiogroup" aria-label="Failover policy" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {POLICY_OPTIONS.map(option => {
          const checked = policy === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => {
                setPolicy(option.id);
                setDirty(true);
              }}
              className={cn(
                'flex min-h-[44px] min-w-0 flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent',
              )}
            >
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-tight text-muted">{option.description}</span>
            </button>
          );
        })}
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Warden accounts">
        {accounts.map((account, index) => {
          const health = accountHealthLabel(account.wrapper, failover);
          return (
            <li
              key={account.wrapper}
              className="flex flex-wrap items-center gap-2 rounded-control border border-border-soft bg-surface-2 px-3 py-2"
            >
              <span className="mono text-ui font-medium text-fg">
                {index + 1}. {account.wrapper}
              </span>
              {account.model && <span className="mono text-meta text-muted">model={account.model}</span>}
              {account.wrapper === active && (
                <span className="rounded-control bg-accent-soft px-1.5 py-0.5 text-meta font-medium text-accent">
                  active
                </span>
              )}
              <span
                className={cn(
                  'text-meta',
                  health.tone === 'ok' ? 'text-ok' : health.tone === 'warn' ? 'text-warn' : 'text-faint',
                )}
              >
                {health.label}
              </span>
              <span className="ml-auto inline-flex items-center gap-1">
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  aria-label={`Move ${account.wrapper} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  aria-label={`Move ${account.wrapper} down`}
                  disabled={index === accounts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  aria-label={`Remove ${account.wrapper}`}
                  disabled={accounts.length <= 1}
                  onClick={() => mutate(previous => previous.filter((_, i) => i !== index))}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-ui text-fg">
          <span className="text-muted">Add account</span>
          <select
            aria-label="Add warden account"
            className="kt-input min-h-[36px] rounded-control border border-border bg-surface-2 px-2 text-ui"
            value={picker}
            onChange={event => setPicker(event.target.value)}
          >
            <option value="">choose a wrapper…</option>
            {pickable.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="kt-btn inline-flex items-center gap-1"
          disabled={!picker}
          onClick={() => {
            if (!picker) return;
            mutate(previous => [...previous, { wrapper: picker }]);
            setPicker('');
          }}
        >
          <Plus size={14} aria-hidden="true" /> Add
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-ui text-muted">
          Failure threshold
          <input
            type="number"
            min={1}
            aria-label="Failure threshold"
            className="kt-input w-24 min-h-[36px] rounded-control border border-border bg-surface-2 px-2 text-fg"
            value={threshold}
            onChange={event => {
              setThreshold(Number(event.target.value));
              setDirty(true);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui text-muted">
          Cooldown (minutes)
          <input
            type="number"
            min={0}
            aria-label="Cooldown minutes"
            className="kt-input w-24 min-h-[36px] rounded-control border border-border bg-surface-2 px-2 text-fg"
            value={cooldown}
            onChange={event => {
              setCooldown(Number(event.target.value));
              setDirty(true);
            }}
          />
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-ui text-fg">
          <input
            type="checkbox"
            aria-label="Enable LLM escalation"
            checked={enabled}
            onChange={event => {
              setEnabled(event.target.checked);
              setDirty(true);
            }}
          />
          LLM escalation enabled
        </label>
        <button
          type="button"
          className="kt-btn ml-auto min-h-[44px]"
          data-variant="primary"
          disabled={!dirty || busy || !HAS_TOKEN || accounts.length === 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && (
        <p role="alert" className="m-0 text-ui text-err">
          {error}
        </p>
      )}
      {warnings.map(warning => (
        <p key={warning} className="m-0 text-ui text-warn">
          {warning}
        </p>
      ))}
      {savedAt !== null && !dirty && !error && (
        <p role="status" className="m-0 text-meta text-ok">
          Saved — the next sweep uses this configuration.
        </p>
      )}
      {failover?.lastSelection && (
        <p className="m-0 text-meta text-faint">
          Last selection: {failover.lastSelection.wrapper} ({failover.lastSelection.reason},{' '}
          {fmtRelative(failover.lastSelection.at)})
        </p>
      )}
    </section>
  );
}
