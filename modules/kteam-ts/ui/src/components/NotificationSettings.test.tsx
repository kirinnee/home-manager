// Render-contract tests for the Notifications settings section, over the
// explicit-controls view (NotificationSettingsView) so no Notification global
// is needed — the same server-render approach as DictationSettings.test.tsx.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NOTIFY_DENIED_NOTE,
  NOTIFY_IOS_NOTE,
  NOTIFY_KIND_LABELS,
  NOTIFY_SCOPE_NOTE,
  NOTIFY_UNSUPPORTED_NOTE,
  NotificationSettingsView,
} from './NotificationSettings';
import { DEFAULT_NOTIFY_PREFS, NOTIFY_KINDS, type NotifyPrefs } from '../lib/notify';
import type { NotifyControls, NotifyPermission } from '../hooks/useNotifications';

function controls(permission: NotifyPermission, prefs: Partial<NotifyPrefs> = {}): NotifyControls {
  return {
    prefs: { ...DEFAULT_NOTIFY_PREFS, ...prefs, events: { ...DEFAULT_NOTIFY_PREFS.events, ...(prefs.events ?? {}) } },
    permission,
    setEnabled: () => Promise.resolve(),
    update: () => undefined,
    push: { mode: 'local-only', devices: [], currentDeviceId: null },
    revokeDevice: () => Promise.resolve(),
    refreshPush: () => Promise.resolve(),
  };
}

const render = (c: NotifyControls) =>
  renderToStaticMarkup(<NotificationSettingsView controls={c} />)
    .replace(/&#x27;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&');

describe('NotificationSettings — capability truth', () => {
  test('unsupported browsers get the explanation and no switch', () => {
    const html = render(controls('unsupported'));
    expect(html).toContain(NOTIFY_UNSUPPORTED_NOTE);
    expect(html).not.toContain('role="switch"');
  });

  test('a browser-level denial disables the switch and points at browser settings', () => {
    const html = render(controls('denied'));
    expect(html).toContain(NOTIFY_DENIED_NOTE);
    expect(html).toContain('disabled');
  });
});

describe('NotificationSettings — quiet by default', () => {
  test('default permission renders the master switch OFF with no event toggles yet', () => {
    const html = render(controls('default'));
    expect(html).toContain('aria-checked="false"');
    for (const kind of NOTIFY_KINDS) expect(html).not.toContain(NOTIFY_KIND_LABELS[kind].label);
    expect(html).toContain(NOTIFY_SCOPE_NOTE);
    expect(html).toContain(NOTIFY_IOS_NOTE);
  });

  test('enabled in prefs but permission not granted still reads OFF — the switch never lies', () => {
    const html = render(controls('default', { enabled: true }));
    // The master switch is the first role="switch"; active requires granted.
    expect(html.slice(html.indexOf('role="switch"'))).toContain('aria-checked="false"');
    expect(html).not.toContain(NOTIFY_KIND_LABELS.attention.label);
  });
});

describe('NotificationSettings — active state', () => {
  test('granted + enabled shows all four event toggles and both scoping toggles', () => {
    const html = render(controls('granted', { enabled: true }));
    for (const kind of NOTIFY_KINDS) {
      expect(html).toContain(NOTIFY_KIND_LABELS[kind].label);
      expect(html).toContain(NOTIFY_KIND_LABELS[kind].description);
    }
    expect(html).toContain('Only in the background');
    expect(html).toContain('Interactive sessions only');
  });

  test('a muted kind renders unchecked while the others stay checked', () => {
    const html = render(
      controls('granted', { enabled: true, events: { ...DEFAULT_NOTIFY_PREFS.events, completed: false } }),
    );
    const completedAt = html.indexOf(NOTIFY_KIND_LABELS.completed.label);
    expect(completedAt).toBeGreaterThan(-1);
    const before = html.slice(0, completedAt);
    const switchStart = before.lastIndexOf('role="switch"');
    expect(html.slice(switchStart, completedAt)).toContain('aria-checked="false"');
  });

  test('every toggle is a 44px-floor switch (touch target discipline)', () => {
    const html = render(controls('granted', { enabled: true }));
    const switches = html.match(/role="switch"/gu) ?? [];
    const floors = html.match(/min-h-\[44px\]/gu) ?? [];
    expect(switches.length).toBe(7); // master + 4 kinds + 2 scoping
    expect(floors.length).toBeGreaterThanOrEqual(switches.length);
  });

  test('active Web Push and per-device revocation are stated plainly', () => {
    const c = controls('granted', { enabled: true });
    c.push = {
      mode: 'active',
      currentDeviceId: 'push-phone',
      devices: [
        {
          id: 'push-phone',
          deviceName: 'iPhone',
          createdAt: '2026-07-28T00:00:00.000Z',
          updatedAt: '2026-07-28T00:00:00.000Z',
          expirationTime: null,
          prefs: { events: DEFAULT_NOTIFY_PREFS.events, interactiveOnly: false },
        },
      ],
    };
    const html = render(c);
    expect(html).toContain('closed-app delivery is ready');
    expect(html).toContain('iPhone');
    expect(html).toContain('· this device');
    expect(html).toContain('Revoke push notifications for iPhone');
  });
});
