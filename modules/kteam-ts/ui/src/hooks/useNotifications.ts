// NOTIFICATION WIRING — the thin browser shell over lib/notify.ts.
//
// Two consumers, one module:
//   * the shell (App.tsx) mounts `useNotificationWatch()` once, which runs the
//     fleet-diff watch while (and only while) the master switch is on AND the
//     browser permission is granted;
//   * the Settings section (components/NotificationSettings.tsx) uses
//     `useNotifyControls()` to render the toggles and to run the ONE
//     user-initiated permission request.
//
// PERMISSION IS NEVER REQUESTED HERE. `requestPermission` exists on the
// controls object and is called from a click handler in Settings — never from
// an effect, never on load. Browsers punish ambient prompts (Chrome quiets
// them, Safari hard-requires a gesture), and the human asked for quiet by
// default anyway.
//
// DELIVERY PATH. `registration.showNotification` when a service worker is
// registered (survives the page being backgrounded; clicks land in the worker,
// which deep-links — sw/notify.ts), else `new Notification` with an onclick
// (dev server / no worker), else nothing. Truthful capability reporting: the
// Settings section shows "unsupported" rather than a switch that cannot work.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { getForegroundSession } from '../lib/pin-bridge';
import {
  getNotifyPrefs,
  setNotifyPrefs,
  startNotificationWatch,
  subscribeNotifyPrefs,
  type NotificationSpec,
  type NotifyPrefs,
} from '../lib/notify';

/** `Notification.permission`, or 'unsupported' where the API is absent
 *  (iOS Safari outside an installed PWA is the case that matters here). */
export type NotifyPermission = NotificationPermission | 'unsupported';

export function readPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

// Permission has no change event; re-read it whenever prefs change (the only
// moment the app can change it is the request call, which also bumps prefs)
// and on subscribe. A revocation from browser settings is caught on the next
// prefs interaction or reload — acceptable for a settings readout.
let permissionSnapshot: NotifyPermission | null = null;

function permission(): NotifyPermission {
  if (permissionSnapshot === null) permissionSnapshot = readPermission();
  return permissionSnapshot;
}

const permissionListeners = new Set<() => void>();

function refreshPermission(): void {
  const next = readPermission();
  if (next === permissionSnapshot) return;
  permissionSnapshot = next;
  for (const listener of permissionListeners) listener();
}

function subscribePermission(listener: () => void): () => void {
  permissionListeners.add(listener);
  refreshPermission();
  return () => permissionListeners.delete(listener);
}

/** Show one notification, preferring the service-worker registration.
 *
 *  Exported for tests; the watch passes it as `env.show`. The `data.url` ride
 *  is what the worker's notificationclick resolves (sw/notify.ts). The page
 *  fallback handles its own click, because a pageless click cannot reach it. */
export async function showNotification(spec: NotificationSpec): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const registration =
      typeof navigator !== 'undefined' && navigator.serviceWorker
        ? await navigator.serviceWorker.getRegistration()
        : null;
    if (registration) {
      await registration.showNotification(spec.title, {
        body: spec.body,
        tag: spec.tag,
        data: { url: spec.url },
      });
      return;
    }
  } catch {
    /* fall through to the page-level constructor */
  }
  try {
    const notification = new Notification(spec.title, { body: spec.body, tag: spec.tag });
    notification.onclick = () => {
      window.focus();
      navigate(spec.url);
      notification.close();
    };
  } catch {
    /* some engines (notably Android Chrome) throw on the constructor in a
       worker-controlled page — the registration path above is the real one */
  }
}

/** Mount ONCE in the shell. Starts/stops the fleet watch as prefs and
 *  permission move; while off it costs one subscription and nothing else. */
export function useNotificationWatch(): void {
  const store = useStore();
  const prefs = useNotifyPrefs();
  const perm = useSyncExternalStore(subscribePermission, permission, () => 'unsupported' as const);

  useEffect(() => {
    if (!prefs.enabled || perm !== 'granted') return;
    return startNotificationWatch(
      {
        subscribe: listener => store.subscribe(listener),
        sessions: () => store.getFleet().sessions,
      },
      {
        prefs: getNotifyPrefs,
        hidden: () => typeof document !== 'undefined' && document.hidden,
        foregroundSession: getForegroundSession,
        show: spec => void showNotification(spec),
        now: () => Date.now(),
      },
    );
    // `prefs.enabled` is the master gate; the other pref fields are read live
    // through getNotifyPrefs on every tick, so they need no restart.
  }, [store, prefs.enabled, perm]);
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(subscribeNotifyPrefs, getNotifyPrefs, () => getNotifyPrefs());
}

export interface NotifyControls {
  prefs: NotifyPrefs;
  permission: NotifyPermission;
  /** Flip the master switch. Enabling with permission still 'default' runs the
   *  browser prompt FIRST (this must be called from a click handler); a denial
   *  leaves the switch off so the UI never claims a capability it lacks. */
  setEnabled: (enabled: boolean) => Promise<void>;
  update: (patch: Partial<NotifyPrefs>) => void;
}

export function useNotifyControls(): NotifyControls {
  const prefs = useNotifyPrefs();
  const perm = useSyncExternalStore(subscribePermission, permission, () => 'unsupported' as const);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setNotifyPrefs({ enabled: false });
      return;
    }
    if (typeof Notification === 'undefined') return;
    let state: NotificationPermission = Notification.permission;
    if (state === 'default') {
      try {
        state = await Notification.requestPermission();
      } catch {
        state = Notification.permission;
      }
    }
    refreshPermission();
    setNotifyPrefs({ enabled: state === 'granted' });
  }, []);

  const update = useCallback((patch: Partial<NotifyPrefs>) => {
    setNotifyPrefs(patch);
  }, []);

  return { prefs, permission: perm, setEnabled, update };
}
