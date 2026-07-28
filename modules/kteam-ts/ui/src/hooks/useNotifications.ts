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
// DELIVERY PATHS. The live WebSocket presents through the registered worker
// while the page exists. A daemon-sent encrypted push reaches that same worker
// when the installed PWA is suspended or closed. Both carry one eventKey/tag;
// `renotify:false` makes a transport twin a silent replacement. A page-level
// Notification constructor remains only the no-worker development fallback.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
import { applicationServerKey, pushApi, type PushDeviceView } from '../lib/push-api';
import { groupedNotificationBody, showGroupedNotification } from '../../sw/notify';

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
      await showGroupedNotification(registration, { version: 1, ...spec });
      return;
    }
  } catch {
    /* fall through to the page-level constructor */
  }
  try {
    const options: NotificationOptions & { renotify: boolean } = {
      body: groupedNotificationBody(spec.body, spec.count),
      tag: spec.tag,
      renotify: false,
    };
    const notification = new Notification(spec.title, options);
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
  push: PushControlState;
  /** Admin-token-gated, per-device revocation. Revoking this browser also
   * unsubscribes its PushManager endpoint and turns the local master off. */
  revokeDevice: (id: string) => Promise<void>;
  refreshPush: () => Promise<void>;
}

export type PushControlMode = 'checking' | 'active' | 'local-only' | 'unsupported';

export interface PushControlState {
  mode: PushControlMode;
  devices: PushDeviceView[];
  currentDeviceId: string | null;
  message?: string;
}

export const PUSH_DEVICE_KEY = 'kteam-ui-push-device-v1';

function currentDeviceId(): string | null {
  try {
    return localStorage.getItem(PUSH_DEVICE_KEY);
  } catch {
    return null;
  }
}

function rememberDevice(id: string | null): void {
  try {
    if (id) localStorage.setItem(PUSH_DEVICE_KEY, id);
    else localStorage.removeItem(PUSH_DEVICE_KEY);
  } catch {
    /* private mode: endpoint still works; the next load re-identifies by endpoint */
  }
}

export function supportsWebPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined'
  );
}

function deviceName(): string {
  if (typeof navigator === 'undefined') return 'Browser device';
  return navigator.platform?.trim() || 'Browser device';
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!supportsWebPush()) throw new Error('Web Push needs a secure context and a service worker');
  return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker is not ready')), 5_000)),
  ]);
}

async function registerPush(
  prefs: NotifyPrefs,
  create: boolean,
): Promise<{ device: PushDeviceView; subscription: PushSubscription }> {
  const registration = await serviceWorkerRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription && create) {
    const publicKey = await pushApi.vapid();
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });
  }
  if (!subscription) throw new Error('this browser has no push subscription');
  const device = await pushApi.register(subscription, deviceName(), prefs);
  rememberDevice(device.id);
  return { device, subscription };
}

export function useNotifyControls(): NotifyControls {
  const prefs = useNotifyPrefs();
  const perm = useSyncExternalStore(subscribePermission, permission, () => 'unsupported' as const);
  const [push, setPush] = useState<PushControlState>(() => ({
    mode: supportsWebPush() ? 'checking' : 'unsupported',
    devices: [],
    currentDeviceId: null,
  }));

  const refreshPush = useCallback(async () => {
    if (!supportsWebPush()) {
      setPush({
        mode: 'unsupported',
        devices: [],
        currentDeviceId: null,
        message: 'Real Web Push is unavailable here; local notifications still work while the app is alive.',
      });
      return;
    }
    setPush(current => ({ ...current, mode: 'checking', message: undefined }));
    try {
      let id = currentDeviceId();
      if (getNotifyPrefs().enabled && Notification.permission === 'granted') {
        const registered = await registerPush(getNotifyPrefs(), false).catch(() => null);
        if (registered) id = registered.device.id;
      }
      const devices = await pushApi.list();
      setPush({
        mode: id && devices.some(device => device.id === id) ? 'active' : 'local-only',
        devices,
        currentDeviceId: id,
        ...(id && devices.some(device => device.id === id)
          ? {}
          : { message: 'Local fallback only on this device; closed-app delivery is not active.' }),
      });
    } catch (error) {
      setPush({
        mode: 'local-only',
        devices: [],
        currentDeviceId: currentDeviceId(),
        message: error instanceof Error ? error.message : 'Could not reach the daemon push service.',
      });
    }
  }, []);

  useEffect(() => {
    void refreshPush();
  }, [refreshPush, prefs.enabled, prefs.events, prefs.interactiveOnly]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!enabled) {
        setNotifyPrefs({ enabled: false });
        const id = currentDeviceId();
        rememberDevice(null);
        try {
          if (id) await pushApi.revoke(id);
        } catch {
          // Unsubscribe locally anyway. A daemon copy left by an offline revoke
          // is removed on the next 404/410 response from the push service.
        }
        try {
          const registration = supportsWebPush() ? await serviceWorkerRegistration() : null;
          await (await registration?.pushManager.getSubscription())?.unsubscribe();
        } catch {
          /* already absent / browser refused cleanup */
        }
        await refreshPush();
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
      if (state !== 'granted') {
        setNotifyPrefs({ enabled: false });
        return;
      }
      const next = setNotifyPrefs({ enabled: true });
      setPush(current => ({ ...current, mode: 'checking', message: undefined }));
      try {
        const registered = await registerPush(next, true);
        const devices = await pushApi.list();
        setPush({ mode: 'active', devices, currentDeviceId: registered.device.id });
      } catch (error) {
        // Permission still has value: preserve the WebSocket/local path and say
        // plainly that closed-app delivery did not provision.
        setPush({
          mode: supportsWebPush() ? 'local-only' : 'unsupported',
          devices: [],
          currentDeviceId: currentDeviceId(),
          message: error instanceof Error ? error.message : 'Could not create a Web Push subscription.',
        });
      }
    },
    [refreshPush],
  );

  const update = useCallback(
    (patch: Partial<NotifyPrefs>) => {
      const next = setNotifyPrefs(patch);
      if (next.enabled && Notification.permission === 'granted') {
        void registerPush(next, false)
          .then(() => refreshPush())
          .catch(error =>
            setPush(current => ({
              ...current,
              mode: 'local-only',
              message: error instanceof Error ? error.message : 'Could not sync push preferences.',
            })),
          );
      }
    },
    [refreshPush],
  );

  const revokeDevice = useCallback(
    async (id: string) => {
      await pushApi.revoke(id);
      if (id === currentDeviceId()) {
        rememberDevice(null);
        setNotifyPrefs({ enabled: false });
        try {
          const registration = await serviceWorkerRegistration();
          await (await registration.pushManager.getSubscription())?.unsubscribe();
        } catch {
          /* endpoint is already revoked server-side */
        }
      }
      await refreshPush();
    },
    [refreshPush],
  );

  return { prefs, permission: perm, setEnabled, update, push, revokeDevice, refreshPush };
}
