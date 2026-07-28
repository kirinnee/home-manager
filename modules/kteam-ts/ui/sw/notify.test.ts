// NOTIFICATION-CLICK CONTRACT TESTS. Imports `./notify`, never the worker
// entry (which pulls the gitignored precache.gen.ts) — same rule as sw.test.ts,
// and the same reason: these must run on a clean checkout.

import { describe, expect, test } from 'bun:test';
import {
  alreadyAt,
  groupedNotificationBody,
  parsePushPayload,
  planClick,
  planNotificationPresentation,
  runClick,
  showGroupedNotification,
  targetPath,
  type ClientLike,
  type PushNotificationPayload,
} from './notify';

const ORIGIN = 'https://kteam.example.com';

const payload: PushNotificationPayload = {
  version: 1,
  eventKey: 's1:question:awaiting_question:2:q2',
  title: '[Noel] Diene Exec',
  body: 'Use the new release?',
  tag: 'kteam-s1',
  url: '/session/s1',
  count: 1,
  sessionId: 's1',
  kind: 'question',
};

interface FakeClient extends ClientLike {
  focused: boolean;
  navigatedTo: string | null;
}

function client(url: string, overrides: Partial<ClientLike> = {}): FakeClient {
  const record: FakeClient = {
    url,
    focused: false,
    navigatedTo: null,
    focus: () => {
      record.focused = true;
      return Promise.resolve(undefined);
    },
    navigate: (to: string) => {
      record.navigatedTo = to;
      return Promise.resolve(undefined);
    },
  };
  return Object.assign(record, overrides);
}

describe('targetPath', () => {
  test('reads the SPA path off notification data', () => {
    expect(targetPath({ url: '/session/ms1abc-12' })).toBe('/session/ms1abc-12');
  });

  test('absent, malformed, absolute or protocol-relative payloads fall back to the dashboard', () => {
    expect(targetPath(undefined)).toBe('/');
    expect(targetPath(null)).toBe('/');
    expect(targetPath('a string')).toBe('/');
    expect(targetPath({ url: 42 })).toBe('/');
    expect(targetPath({ url: 'https://evil.example.com/x' })).toBe('/');
    expect(targetPath({ url: '//evil.example.com/x' })).toBe('/');
  });
});

describe('push payload and grouped presentation', () => {
  test('accepts the bounded same-origin contract and rejects arbitrary URLs/tags/counts', () => {
    expect(parsePushPayload(payload)).toEqual(payload);
    expect(parsePushPayload({ ...payload, kind: 'needsYou' })).toEqual({ ...payload, kind: 'attention' });
    expect(parsePushPayload({ ...payload, url: 'https://evil.example/x' })).toBeNull();
    expect(parsePushPayload({ ...payload, tag: 'other-s1' })).toBeNull();
    expect(parsePushPayload({ ...payload, count: 0 })).toBeNull();
    expect(parsePushPayload({ ...payload, kind: 'surprise' })).toBeNull();
  });

  test('latest line plus count reads like one Telegram conversation', () => {
    expect(groupedNotificationBody('Latest line', 1)).toBe('Latest line');
    expect(groupedNotificationBody('Latest line', 4)).toBe('Latest line\n+3 more');
  });

  test('same event key is the WebSocket/push twin and is skipped', () => {
    expect(planNotificationPresentation(payload, [{ eventKey: payload.eventKey, count: 1 }])).toEqual({
      action: 'skip',
    });
  });

  test('a later line replaces silently with the highest honest collapsed count', () => {
    const plan = planNotificationPresentation({ ...payload, eventKey: 'next', count: 2, body: 'Latest' }, [
      { eventKey: payload.eventKey, count: 3 },
    ]);
    expect(plan).toMatchObject({ action: 'show', count: 4, body: 'Latest\n+3 more' });
  });

  test('showGroupedNotification uses one tag and renotify=false', async () => {
    const shown: Array<{ title: string; options?: NotificationOptions & { renotify?: boolean } }> = [];
    const result = await showGroupedNotification(
      {
        getNotifications: async () => [{ data: { eventKey: 'old', count: 1 } }],
        showNotification: async (title, options) => {
          shown.push({ title, options });
        },
      },
      { ...payload, eventKey: 'new', count: 2 },
    );
    expect(result).toBe('shown');
    expect(shown[0]).toMatchObject({
      title: '[Noel] Diene Exec',
      options: { tag: 'kteam-s1', renotify: false, body: 'Use the new release?\n+1 more' },
    });
  });
});

describe('alreadyAt', () => {
  test('matches on pathname, ignoring query and hash', () => {
    expect(alreadyAt(`${ORIGIN}/session/s1?tab=files#x`, '/session/s1', ORIGIN)).toBe(true);
    expect(alreadyAt(`${ORIGIN}/session/s2`, '/session/s1', ORIGIN)).toBe(false);
  });

  test('another origin or an unparseable URL never matches', () => {
    expect(alreadyAt('https://other.example.com/session/s1', '/session/s1', ORIGIN)).toBe(false);
    expect(alreadyAt('not a url', '/session/s1', ORIGIN)).toBe(false);
  });
});

describe('planClick', () => {
  test('no clients → open a window', () => {
    expect(planClick([], '/session/s1', ORIGIN)).toEqual({ action: 'open' });
  });

  test('an app window elsewhere → focus it and navigate', () => {
    const c = client(`${ORIGIN}/`);
    const plan = planClick([c], '/session/s1', ORIGIN);
    expect(plan).toEqual({ action: 'focus', client: c, navigate: true });
  });

  test('an app window already on the session → focus only, never a reload over drafts', () => {
    const c = client(`${ORIGIN}/session/s1`);
    const plan = planClick([c], '/session/s1', ORIGIN);
    expect(plan.action).toBe('focus');
    if (plan.action === 'focus') expect(plan.navigate).toBe(false);
  });

  test('cross-origin and unparseable clients are skipped', () => {
    const foreign = client('https://other.example.com/');
    const broken = client('not a url');
    const ours = client(`${ORIGIN}/warden`);
    const plan = planClick([foreign, broken, ours], '/', ORIGIN);
    expect(plan.action).toBe('focus');
    if (plan.action === 'focus') expect(plan.client).toBe(ours);
  });
});

describe('runClick', () => {
  test('open plan opens the window at the path', async () => {
    const opened: string[] = [];
    await runClick({ action: 'open' }, '/session/s1', url => {
      opened.push(url);
      return Promise.resolve(undefined);
    });
    expect(opened).toEqual(['/session/s1']);
  });

  test('focus plan focuses then navigates', async () => {
    const c = client(`${ORIGIN}/`);
    await runClick({ action: 'focus', client: c, navigate: true }, '/session/s1', () => Promise.resolve(undefined));
    expect(c.focused).toBe(true);
    expect(c.navigatedTo).toBe('/session/s1');
  });

  test('focus without navigate leaves the client where it was', async () => {
    const c = client(`${ORIGIN}/session/s1`);
    await runClick({ action: 'focus', client: c, navigate: false }, '/session/s1', () => Promise.resolve(undefined));
    expect(c.focused).toBe(true);
    expect(c.navigatedTo).toBeNull();
  });

  test('a client without navigate() is focused and nothing throws', async () => {
    const c = client(`${ORIGIN}/`, { navigate: undefined });
    await runClick({ action: 'focus', client: c, navigate: true }, '/session/s1', () => Promise.resolve(undefined));
    expect(c.focused).toBe(true);
  });

  test('rejections from focus, navigate and openWindow are all swallowed', async () => {
    const c = client(`${ORIGIN}/`, {
      focus: () => Promise.reject(new Error('gone')),
      navigate: () => Promise.reject(new Error('refused')),
    });
    await runClick({ action: 'focus', client: c, navigate: true }, '/x', () => Promise.reject(new Error('popup')));
    await runClick({ action: 'open' }, '/x', () => Promise.reject(new Error('popup')));
  });
});
