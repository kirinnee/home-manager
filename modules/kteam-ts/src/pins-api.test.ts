import { describe, expect, test } from 'bun:test';
import {
  PinApi,
  isPinPath,
  matchPinRoute,
  parsePinActionBody,
  pinErrorStatus,
  pinWardenDenial,
  type PinApiService,
} from './pins-api';
import { emptySnapshot, type Pin, type PinActor, type PinSnapshot } from './pins-types';

const SID = 'ms3g6a8p-71542ce1';

/** An in-memory PinApiService that records calls and returns a small snapshot. */
class FakeService implements PinApiService {
  calls: string[] = [];
  pins: Pin[] = [];
  async list(id: string): Promise<PinSnapshot> {
    this.calls.push(`list:${id}`);
    return { v: 1, sessionId: id, pins: this.pins, updatedAt: 'now' };
  }
  async add(id: string, input: { text?: string }, actor: PinActor): Promise<PinSnapshot> {
    this.calls.push(`add:${id}:${input.text}:${actor.actor}`);
    this.pins = [
      {
        id: `p${this.pins.length}`,
        kind: 'note',
        text: input.text ?? '',
        at: 1,
        by: 'human',
        createdBy: null,
        createdByName: null,
      },
      ...this.pins,
    ];
    return { v: 1, sessionId: id, pins: this.pins, updatedAt: 'now' };
  }
  async edit(id: string): Promise<PinSnapshot> {
    this.calls.push(`edit:${id}`);
    return emptySnapshot(id, 'now');
  }
  async remove(id: string, pinId: string): Promise<PinSnapshot> {
    this.calls.push(`remove:${id}:${pinId}`);
    this.pins = this.pins.filter(p => p.id !== pinId);
    return { v: 1, sessionId: id, pins: this.pins, updatedAt: 'now' };
  }
  async importPins(id: string): Promise<PinSnapshot> {
    this.calls.push(`import:${id}`);
    return emptySnapshot(id, 'now');
  }
}

const url = (p: string) => new URL(`http://d${p}`);

describe('routing', () => {
  test('isPinPath / matchPinRoute', () => {
    expect(isPinPath(`/v1/sessions/${SID}/pins`)).toBe(true);
    expect(isPinPath(`/v1/sessions/${SID}/send`)).toBe(false);
    expect(matchPinRoute('GET', `/v1/sessions/${SID}/pins`)).toEqual({ kind: 'list', id: SID });
    expect(matchPinRoute('POST', `/v1/sessions/${SID}/pins`)).toEqual({ kind: 'action', id: SID });
    expect(matchPinRoute('DELETE', `/v1/sessions/${SID}/pins`)).toBeNull();
    expect(matchPinRoute('GET', '/v1/sessions/..%2Fevil/pins')).toBeNull(); // path-unsafe id rejected
  });
  test('warden denial: reads yes, writes no', () => {
    expect(pinWardenDenial('GET', `/v1/sessions/${SID}/pins`)).toBeNull();
    expect(pinWardenDenial('POST', `/v1/sessions/${SID}/pins`)).toBe('change pins');
    expect(pinWardenDenial('GET', '/v1/tasks')).toBeNull();
  });
});

describe('parsePinActionBody', () => {
  test('add note / message / remove / edit / import', () => {
    expect(parsePinActionBody({ action: 'add', kind: 'note', text: 'hi' })).toMatchObject({ action: 'add' });
    expect(parsePinActionBody({ action: 'remove', id: 'p1' })).toEqual({ action: 'remove', id: 'p1' });
    expect(parsePinActionBody({ action: 'edit', id: 'p1', text: 'x' })).toEqual({
      action: 'edit',
      id: 'p1',
      text: 'x',
    });
    const imp = parsePinActionBody({ action: 'import', pins: [{ id: 'a', kind: 'note', text: 'z', at: 1 }] });
    expect(imp).toMatchObject({ action: 'import' });
  });
  test('bad bodies throw', () => {
    expect(() => parsePinActionBody({})).toThrow();
    expect(() => parsePinActionBody({ action: 'add' })).toThrow();
    expect(() => parsePinActionBody({ action: 'remove' })).toThrow();
  });
});

describe('PinApi.handle', () => {
  test('GET lists, POST add/remove routed', async () => {
    const fake = new FakeService();
    const api = new PinApi(fake);
    const list = await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/pins`) });
    expect(list?.status).toBe(200);
    const add = await api.handle({
      method: 'POST',
      url: url(`/v1/sessions/${SID}/pins`),
      body: { action: 'add', kind: 'note', text: 'hi' },
      actor: { actor: 'user' },
    });
    expect(add?.status).toBe(200);
    expect(fake.calls).toContain(`add:${SID}:hi:user`);
  });

  test('non-pins path returns null', async () => {
    const api = new PinApi(new FakeService());
    expect(await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/send`) })).toBeNull();
  });

  test('client errors map to statuses, not throws', async () => {
    const api = new PinApi(new FakeService());
    const bad = await api.handle({ method: 'POST', url: url(`/v1/sessions/${SID}/pins`), body: {} });
    expect(bad?.status).toBe(400);
  });

  test('idempotency: same request id replays, adding at most one pin', async () => {
    const fake = new FakeService();
    const api = new PinApi(fake);
    const req = {
      method: 'POST',
      url: url(`/v1/sessions/${SID}/pins`),
      body: { action: 'add', kind: 'note', text: 'once' },
      actor: { actor: 'user' } as PinActor,
      requestId: 'req-1',
    };
    await api.handle(req);
    await api.handle(req);
    expect(fake.calls.filter(c => c.startsWith('add:')).length).toBe(1);
  });

  test('rate limit: a burst is 429ed once the bucket empties', async () => {
    const fake = new FakeService();
    const api = new PinApi(fake);
    let last: number | undefined;
    // Fixed clock so no refill happens mid-burst.
    for (let i = 0; i < 12; i += 1) {
      const res = await api.handle(
        {
          method: 'POST',
          url: url(`/v1/sessions/${SID}/pins`),
          body: { action: 'add', kind: 'note', text: `n${i}` },
          actor: { actor: 'user' },
          requestId: `r${i}`,
        },
        1_000_000,
      );
      last = res?.status;
    }
    expect(last).toBe(429);
  });

  test('reads are never rate-limited', async () => {
    const api = new PinApi(new FakeService());
    for (let i = 0; i < 30; i += 1) {
      const res = await api.handle({ method: 'GET', url: url(`/v1/sessions/${SID}/pins`) }, 1_000_000);
      expect(res?.status).toBe(200);
    }
  });
});

test('pinErrorStatus mapping', () => {
  expect(pinErrorStatus('invalid')).toBe(400);
  expect(pinErrorStatus('too-long')).toBe(413);
  expect(pinErrorStatus('not-found')).toBe(404);
  expect(pinErrorStatus('forbidden')).toBe(403);
  expect(pinErrorStatus('rate-limited')).toBe(429);
  expect(pinErrorStatus('read-only')).toBe(403);
});
