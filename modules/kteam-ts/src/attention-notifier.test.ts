import { describe, expect, test } from 'bun:test';
import { AttentionNotifier, parseDirectNotificationBody } from './attention-notifier';
import type { AttentionItem } from './attention-types';
import type { InteractionMode } from './types';
import type { PushNotificationPayload } from './push-types';

const SID = 'ms3g6a8p-71542ce1';
const OTHER = 'ms2bkdxy-c845508e';

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Pick the release window',
  why: 'Deploy is blocked.',
  waitingSince: '2026-07-29T00:00:00.000Z',
  howToResolve: 'Answer on the board.',
  raisedBy: 'agent',
  raisedBySession: SID,
  raisedByName: 'zoe',
  ...over,
});

function harness(views: Record<string, { id: string; name?: string; teammate?: string; mode?: InteractionMode }>) {
  const sent: { payload: PushNotificationPayload; mode: InteractionMode }[] = [];
  const logs: string[] = [];
  const notifier = new AttentionNotifier(
    {
      get: async (ref: string) => {
        const config = views[ref];
        if (!config) throw new Error('missing');
        return { config: { mode: 'auto', ...config } } as never;
      },
    },
    {
      deliverDirect: async items => {
        sent.push(...items);
        return items.length;
      },
    },
    message => logs.push(message),
  );
  return { notifier, sent, logs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

describe('parseDirectNotificationBody', () => {
  test('requires a non-blank bounded body and validates title/kind', () => {
    expect(parseDirectNotificationBody({ body: 'Build green' })).toEqual({ body: 'Build green' });
    expect(parseDirectNotificationBody({ message: 'alias works', title: 'CI', kind: 'failed' })).toEqual({
      body: 'alias works',
      title: 'CI',
      kind: 'failed',
    });
    expect(() => parseDirectNotificationBody({})).toThrow(/non-blank body/);
    expect(() => parseDirectNotificationBody(null)).toThrow(/JSON object/);
    expect(() => parseDirectNotificationBody({ body: 'x', kind: 'question' })).toThrow(/completed, failed/);
    expect(() => parseDirectNotificationBody({ body: 'x'.repeat(501) })).toThrow(/maximum/);
    expect(() => parseDirectNotificationBody({ body: 'x', title: '   ' })).toThrow(/title/);
  });
});

describe('automatic new-item notifications', () => {
  test('agent-raised and task items push as attention; question items stay on the session path', async () => {
    const h = harness({ [SID]: { id: SID, teammate: 'noel' } });
    h.notifier.notifyNewItem(SID, item());
    h.notifier.notifyNewItem(SID, item({ id: 'A2', source: 'task', sourceRef: 'F31' }));
    h.notifier.notifyNewItem(SID, item({ id: 'A3', source: 'question', sourceRef: 'q1' }));
    await settle();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]!.payload).toMatchObject({
      kind: 'attention',
      eventKey: `attention:${SID}:A1`,
      body: 'Pick the release window',
      url: `/session/${encodeURIComponent(SID)}`,
    });
  });

  test('a missing session or failing delivery is logged, never thrown', async () => {
    const h = harness({});
    h.notifier.notifyNewItem('unknown', item());
    await settle();
    expect(h.sent).toHaveLength(0);
  });
});

describe('direct notifications', () => {
  test('an agent may notify its own session; the payload defaults to completed', async () => {
    const h = harness({ [SID]: { id: SID, teammate: 'noel' } });
    const result = await h.notifier.notifyDirect(SID, { body: 'Task shipped' }, { actor: SID });
    expect(result.delivered).toBe(1);
    expect(h.sent[0]!.payload).toMatchObject({ kind: 'completed', body: 'Task shipped', sessionId: SID });
    expect(h.sent[0]!.payload.eventKey.startsWith(`notify:${SID}:`)).toBe(true);
  });

  test('a custom title and failed kind pass through', async () => {
    const h = harness({ [SID]: { id: SID } });
    await h.notifier.notifyDirect(SID, { body: 'CI broke', title: 'nitroso', kind: 'failed' }, { actor: 'user' });
    expect(h.sent[0]!.payload).toMatchObject({ kind: 'failed', title: 'nitroso' });
  });

  test('cross-session and reserved actors are refused; unknown sessions 404', async () => {
    const h = harness({ [SID]: { id: SID }, [OTHER]: { id: OTHER } });
    await expect(h.notifier.notifyDirect(OTHER, { body: 'x' }, { actor: SID })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(h.notifier.notifyDirect(SID, { body: 'x' }, { actor: 'daemon' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(h.notifier.notifyDirect('missing', { body: 'x' }, { actor: 'user' })).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
