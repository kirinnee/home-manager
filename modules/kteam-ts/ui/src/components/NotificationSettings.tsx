// The Notifications section of the Settings surface. Rendered by
// SettingsContent (see notifications.patch.md — SettingsPage.tsx is contended)
// under the catalog entry in lib/settings.ts.
//
// SHAPE RULES it must keep:
//   * the permission request runs ONLY from the master-switch click — never an
//     ambient prompt;
//   * the section tells the truth about capability: unsupported browsers get an
//     explanation, a browser-level denial gets pointed at browser settings,
//     and the per-event toggles render only while the feature can actually
//     fire;
//   * quiet by default — the master switch starts off, and everything under it
//     is scoped to the explicit choices in lib/notify.ts DEFAULT_NOTIFY_PREFS.

import { useNotifyControls, type NotifyControls } from '../hooks/useNotifications';
import { NOTIFY_KINDS, type NotifyKind } from '../lib/notify';
import { cn } from '../lib/utils';

export const NOTIFY_KIND_LABELS: Record<NotifyKind, { label: string; description: string }> = {
  attention: { label: 'Attention', description: 'A session is waiting at the prompt (awaiting user).' },
  question: { label: 'Questions', description: 'A session asked you a structured question.' },
  failed: { label: 'Failures', description: 'A session failed, stalled, or could not be stopped.' },
  completed: { label: 'Completions', description: 'A session finished its task.' },
};

export const NOTIFY_UNSUPPORTED_NOTE =
  'This browser does not expose notifications to this app. On iPhone or iPad, install the app first (Share → Add to Home Screen) and open it from the Home Screen — Safari tabs cannot notify.';

export const NOTIFY_DENIED_NOTE =
  'Notifications are blocked for this site in the browser. Allow them in the browser’s site settings, then come back and turn this on.';

export const NOTIFY_SCOPE_NOTE =
  'The WebSocket is the fast path while the app is alive; Web Push covers backgrounded or fully closed. Both use one session tag, so the same event appears once.';

export const NOTIFY_IOS_NOTE =
  'On iPhone or iPad, real Web Push requires iOS/iPadOS 16.4+ and this PWA installed to the Home Screen. An ordinary Safari tab cannot receive it. Every browser also requires a secure HTTPS context; the Cloudflare tunnel satisfies that requirement.';

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="min-w-0">
        <span className={cn('block text-ui font-semibold', checked ? 'text-accent' : 'text-fg')}>{label}</span>
        <span className="block text-meta leading-tight text-muted">{description}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border bg-surface',
        )}
      >
        <span
          className={cn(
            'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-surface-2 transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

export function NotificationSettings() {
  return <NotificationSettingsView controls={useNotifyControls()} />;
}

/** The render half, over explicit controls — so tests can put every branch on
 *  screen without a Notification global (same split as the SW policy files). */
export function NotificationSettingsView({ controls }: { controls: NotifyControls }) {
  const { prefs, permission, setEnabled, update, push, revokeDevice } = controls;

  if (permission === 'unsupported') {
    return (
      <p role="status" className="m-0 text-ui leading-base text-warn">
        {NOTIFY_UNSUPPORTED_NOTE}
      </p>
    );
  }

  const denied = permission === 'denied';
  const active = prefs.enabled && permission === 'granted';

  return (
    <div className="flex flex-col gap-2">
      <Toggle
        checked={active}
        disabled={denied}
        onChange={next => void setEnabled(next)}
        label="Notify me"
        description="System notification when a session needs attention. Turning this on asks the browser for permission."
      />
      {denied && (
        <p role="status" className="m-0 text-ui leading-base text-warn">
          {NOTIFY_DENIED_NOTE}
        </p>
      )}
      {active && (
        <>
          <div role="group" aria-label="Notify about" className="flex flex-col gap-2">
            {NOTIFY_KINDS.map(kind => (
              <Toggle
                key={kind}
                checked={prefs.events[kind]}
                onChange={next => update({ events: { ...prefs.events, [kind]: next } })}
                label={NOTIFY_KIND_LABELS[kind].label}
                description={NOTIFY_KIND_LABELS[kind].description}
              />
            ))}
          </div>
          <Toggle
            checked={prefs.onlyWhenHidden}
            onChange={next => update({ onlyWhenHidden: next })}
            label="Only in the background"
            description="Stay quiet while you are looking at the app; the dashboard already shows the change."
          />
          <Toggle
            checked={prefs.interactiveOnly}
            onChange={next => update({ interactiveOnly: next })}
            label="Interactive sessions only"
            description="Skip auto sessions. Off means every session can notify, including auto ones hitting a permission prompt."
          />
        </>
      )}
      <p className="m-0 text-meta leading-base text-faint">{NOTIFY_SCOPE_NOTE}</p>
      <p className="m-0 text-meta leading-base text-faint">{NOTIFY_IOS_NOTE}</p>
      {permission === 'granted' && (
        <p
          role="status"
          className={cn(
            'm-0 text-ui leading-base',
            push.mode === 'active' ? 'text-ok' : push.mode === 'checking' ? 'text-muted' : 'text-warn',
          )}
        >
          {push.mode === 'active'
            ? 'Real Web Push is active for this device — closed-app delivery is ready.'
            : push.mode === 'checking'
              ? 'Checking closed-app Web Push…'
              : (push.message ?? 'Local notification fallback only; closed-app delivery is not active on this device.')}
        </p>
      )}
      {push.devices.length > 0 && (
        <div className="flex flex-col gap-1" aria-label="Push devices">
          <span className="text-meta font-semibold text-muted">Registered devices</span>
          {push.devices.map(device => (
            <div
              key={device.id}
              className="flex min-h-[44px] items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-control-x py-1"
            >
              <span className="min-w-0 text-ui text-fg">
                {device.deviceName}
                {device.id === push.currentDeviceId ? <span className="text-faint"> · this device</span> : null}
              </span>
              <button
                type="button"
                className="min-h-[44px] shrink-0 rounded-control px-2 text-ui font-semibold text-warn hover:bg-warn-bg"
                onClick={() => void revokeDevice(device.id)}
                aria-label={`Revoke push notifications for ${device.deviceName}`}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
