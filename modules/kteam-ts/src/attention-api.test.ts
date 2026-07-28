import { describe, expect, test } from 'bun:test';
import {
  AttentionApi,
  isAttentionPath,
  matchAttentionRoute,
  attentionErrorStatus,
  attentionWardenDenial,
  parseAttentionActionBody,
  resolveAttentionApiActor,
  type AttentionApiService,
} from './attention-api';
import {
  emptyAttentionSnapshot,
  type AttentionActor,
  type AttentionItem,
  type AttentionSnapshot,
} from './attention-types';
import type { AddAttentionInput } from './attention-service';

const SID = 'ms3g6a8p-71542ce1';
const url = (value: string) => new URL(`http://daemon${value}`);

class FakeService implements AttentionApiService {
  calls: string[] = [];
  items: AttentionItem[] = [];

  private snapshot(): AttentionSnapshot {
    return { ...emptyAttentionSnapshot(SID, 'now'), items: this.items, count: this.items.length };
  }

  async list(id: string): Promise<AttentionSnapshot> {
    this.calls.push(`list:${id}`);
    return { ...this.snapshot(), sessionId: id };
  }

  async count(id: string): Promise<number> {
    this.calls.push(`count:${id}`);
    return this.items.length;
  }

  async add(id: string, input: AddAttentionInput, actor: AttentionActor): Promise<AttentionSnapshot> {
    this.calls.push(`add:${id}:${input.subject}:${actor.actor}`);
    this.items.push({
      id: `A${this.items.length + 1}`,
      source: input.source ?? 'agent-raised',
      sourceRef: input.sourceRef ?? null,
      subject: input.subject ?? '',
      why: input.why ?? '',
      waitingSince: '2026-07-28T00:00:00.000Z',
      howToResolve: input.howToResolve ?? '',
      raisedBy: 'human',
      raisedBySession: null,
      raisedByName: null,
    });
    return this.snapshot();
  }

  async resolve(id: string, itemId: string): Promise<AttentionSnapshot> {
    this.calls.push(`resolve:${id}:${itemId}`);
    this.items = this.items.filter(item => item.id !== itemId);
    return this.snapshot();
  }
}

describe('routing and scope', () => {
  test('matches only session-addressed attention routes', () => {
    expect(isAttentionPath(`/v1/sessions/${SID}/attention`)).toBe(true);
    expect(isAttentionPath('/v1/attention')).toBe(false);
    expect(matchAttentionRoute('GET', `/v1/sessions/${SID}/attention`)).toEqual({ id: SID, kind: 'read' });
    expect(matchAttentionRoute('POST', `/v1/sessions/${SID}/attention`)).toEqual({ id: SID, kind: 'write' });
    expect(matchAttentionRoute('DELETE', `/v1/sessions/${SID}/attention`)).toBeNull();
    expect(matchAttentionRoute('GET', '/v1/sessions/..%2Fevil/attention')).toBeNull();
    expect(matchAttentionRoute('GET', '/v1/sessions/%zz/attention')).toBeNull();
  });

  test('warden reads but cannot mutate', () => {
    expect(attentionWardenDenial('GET', `/v1/sessions/${SID}/attention`)).toBeNull();
    expect(attentionWardenDenial('POST', `/v1/sessions/${SID}/attention`)).toBe('change attention items');
  });

  test('HTTP actor resolution canonicalizes sessions and refuses reserved or unknown refs', async () => {
    const lookup = {
      get: async (ref: string) =>
        ref === 'zoe' ? { config: { id: SID, teammate: 'zoe', name: 'task title' } } : undefined,
    };
    expect(await resolveAttentionApiActor(lookup, 'admin-cli')).toEqual({ actor: 'user', actorName: 'user' });
    expect(await resolveAttentionApiActor(lookup, 'peer:zoe')).toEqual({ actor: SID, actorName: 'zoe' });
    await expect(resolveAttentionApiActor(lookup, 'peer:daemon')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveAttentionApiActor(lookup, 'peer:missing')).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('body parsing', () => {
  test('parses add and resolve without accepting unknown sources', () => {
    expect(
      parseAttentionActionBody({
        action: 'add',
        source: 'agent-raised',
        subject: 'Need a region',
        why: 'Deploy blocked',
        howToResolve: 'Choose one',
      }),
    ).toMatchObject({ action: 'add', input: { source: 'agent-raised', subject: 'Need a region' } });
    expect(parseAttentionActionBody({ action: 'done', id: '?A1', note: 'picked us-east' })).toEqual({
      action: 'resolve',
      id: 'A1',
      note: 'picked us-east',
    });
    expect(() => parseAttentionActionBody({ action: 'add', source: 'forged' })).toThrow();
    expect(() => parseAttentionActionBody({ action: 'resolve' })).toThrow();
  });
});

describe('AttentionApi', () => {
  test('GET list and count=1 take distinct read paths', async () => {
    const fake = new FakeService();
    const api = new AttentionApi(fake);
    expect((await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/attention`) }))?.status).toBe(200);
    const count = await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/attention?count=1`) });
    expect(count?.body).toEqual({ sessionId: SID, count: 0 });
    expect(fake.calls).toEqual([`list:${SID}`, `count:${SID}`]);
  });

  test('POST forwards resolved actor and resolves by id', async () => {
    const fake = new FakeService();
    const api = new AttentionApi(fake);
    await api.handle({
      method: 'POST',
      url: url(`/v1/sessions/${SID}/attention`),
      body: { action: 'add', subject: 'Need it', why: 'Blocked', howToResolve: 'Reply' },
      actor: { actor: SID, actorName: 'zoe' },
    });
    await api.handle({
      method: 'POST',
      url: url(`/v1/sessions/${SID}/attention`),
      body: { action: 'resolve', id: '?A1' },
      actor: { actor: 'user' },
    });
    expect(fake.calls).toContain(`add:${SID}:Need it:${SID}`);
    expect(fake.calls).toContain(`resolve:${SID}:A1`);
  });

  test('production actor sources resolve inside the mapped API error boundary', async () => {
    const fake = new FakeService();
    const lookup = {
      get: async (ref: string) => (ref === 'zoe' ? { config: { id: SID, teammate: 'zoe' } } : undefined),
    };
    const api = new AttentionApi(fake, lookup);
    const body = { action: 'add', subject: 'Need it', why: 'Blocked', howToResolve: 'Reply' };
    expect(
      (
        await api.handle({
          method: 'POST',
          url: url(`/v1/sessions/${SID}/attention`),
          body,
          actorSource: 'peer:daemon',
        })
      )?.status,
    ).toBe(403);
    expect(
      (
        await api.handle({
          method: 'POST',
          url: url(`/v1/sessions/${SID}/attention`),
          body,
          actorSource: 'peer:zoe',
        })
      )?.status,
    ).toBe(200);
    expect(fake.calls).toContain(`add:${SID}:Need it:${SID}`);
  });

  test('same request id and payload is applied once', async () => {
    const fake = new FakeService();
    const api = new AttentionApi(fake);
    const request = {
      method: 'POST',
      url: url(`/v1/sessions/${SID}/attention`),
      body: { action: 'add', subject: 'Once', why: 'x', howToResolve: 'y' },
      actor: { actor: 'user' },
      requestId: 'request-1',
    };
    for (let index = 0; index < 12; index += 1) {
      expect((await api.handle(request, 1_000))?.status).toBe(200);
    }
    expect(fake.calls.filter(call => call.startsWith('add:'))).toHaveLength(1);
  });

  test('writes are rate limited, reads are not', async () => {
    const fake = new FakeService();
    const api = new AttentionApi(fake);
    let status = 0;
    for (let index = 0; index < 12; index += 1) {
      status =
        (
          await api.handle(
            {
              method: 'POST',
              url: url(`/v1/sessions/${SID}/attention`),
              body: { action: 'add', subject: `n${index}`, why: 'x', howToResolve: 'y' },
              requestId: `r${index}`,
            },
            1_000,
          )
        )?.status ?? 0;
    }
    expect(status).toBe(429);
    for (let index = 0; index < 20; index += 1) {
      expect((await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/attention`) }, 1_000))?.status).toBe(200);
    }
  });

  test('non-route returns null and malformed body maps to 400', async () => {
    const api = new AttentionApi(new FakeService());
    expect(await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/pins`) })).toBeNull();
    expect((await api.handle({ method: 'POST', url: url(`/v1/sessions/${SID}/attention`), body: {} }))?.status).toBe(
      400,
    );
  });

  test('malformed writes do not consume the valid-action rate budget', async () => {
    const fake = new FakeService();
    const api = new AttentionApi(fake);
    for (let index = 0; index < 12; index += 1) {
      expect(
        (await api.handle({ method: 'POST', url: url(`/v1/sessions/${SID}/attention`), body: { nope: index } }, 1_000))
          ?.status,
      ).toBe(400);
    }
    expect(
      (
        await api.handle(
          {
            method: 'POST',
            url: url(`/v1/sessions/${SID}/attention`),
            body: { action: 'add', subject: 'valid', why: 'x', howToResolve: 'y' },
          },
          1_000,
        )
      )?.status,
    ).toBe(200);
  });
});

test('error status mapping', () => {
  expect(attentionErrorStatus('invalid')).toBe(400);
  expect(attentionErrorStatus('too-long')).toBe(413);
  expect(attentionErrorStatus('not-found')).toBe(404);
  expect(attentionErrorStatus('forbidden')).toBe(403);
  expect(attentionErrorStatus('rate-limited')).toBe(429);
  expect(attentionErrorStatus('full')).toBe(409);
  expect(attentionErrorStatus('corrupt')).toBe(409);
});
