import { describe, expect, test } from 'bun:test';
import { api } from './api';

const ATTACHMENT_ID = `att_${'a'.repeat(64)}`;

async function captureRequest<T>(
  response: Response,
  action: () => Promise<T>,
): Promise<{ value: T; input: string | URL | Request; init?: RequestInit }> {
  const original = globalThis.fetch;
  let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = { input, ...(init ? { init } : {}) };
    return response;
  }) as typeof fetch;
  try {
    const value = await action();
    if (!captured) throw new Error('fetch was not called');
    return { value, ...captured };
  } finally {
    globalThis.fetch = original;
  }
}

describe('attachment API transport', () => {
  test('upload preserves the browser multipart boundary and carries a request id', async () => {
    const view = {
      id: ATTACHMENT_ID,
      filename: 'probe.png',
      mime: 'image/png',
      size: 3,
      sha256: 'a'.repeat(64),
      path: '/daemon-only/probe.png',
      createdAt: '2026-07-25T12:00:00.000Z',
    };
    const file = new File(['png'], 'probe.png', { type: 'image/png' });
    const captured = await captureRequest(
      new Response(JSON.stringify(view), { status: 201, headers: { 'content-type': 'application/json' } }),
      () => api.upload('ms1images-12345678', file),
    );
    expect(captured.value).toEqual(view);
    expect(String(captured.input)).toContain('/v1/sessions/ms1images-12345678/attachments');
    expect(captured.init?.method).toBe('POST');
    const headers = new Headers(captured.init?.headers);
    expect(headers.get('content-type')).toBeNull();
    expect(headers.get('x-kteam-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.init?.body).toBeInstanceOf(FormData);
    expect((captured.init?.body as FormData).get('file')).toBeInstanceOf(File);
  });

  test('send serializes attachment ids under the logical message request id', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ disposition: 'queued' }), { headers: { 'content-type': 'application/json' } }),
      () => api.send('session', 'caption', false, 'logical-request', [ATTACHMENT_ID]),
    );
    expect(captured.value.disposition).toBe('queued');
    expect(new Headers(captured.init?.headers).get('x-kteam-request-id')).toBe('logical-request');
    expect(JSON.parse(String(captured.init?.body))).toEqual({
      message: 'caption',
      now: false,
      attachmentIds: [ATTACHMENT_ID],
    });
  });

  test('replay accepts the daemon bare-array response', async () => {
    const events = [
      {
        sequence: 1,
        time: '2026-07-25T12:00:00.000Z',
        sessionId: 'session',
        type: 'control.send',
        source: 'client' as const,
        data: { message: 'hello', attachmentIds: [] },
      },
    ];
    const captured = await captureRequest(
      new Response(JSON.stringify(events), { headers: { 'content-type': 'application/json' } }),
      () => api.replay('session', -2000, 2000),
    );
    expect(captured.value).toEqual(events);
    expect(String(captured.input)).toContain('after=-2000&limit=2000');
  });

  test('authenticated attachment reads stay binary instead of becoming text', async () => {
    const captured = await captureRequest(
      new Response(new Blob(['png'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }),
      () => api.attachment('session', ATTACHMENT_ID),
    );
    expect(captured.value).toBeInstanceOf(Blob);
    expect(captured.value.type).toBe('image/png');
    expect(String(captured.input)).toContain(`/attachments/${ATTACHMENT_ID}`);
  });
});

describe('task API transport', () => {
  test('lists tasks through the read-only board route', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ tasks: [], parseErrors: 0 }), {
        headers: { 'content-type': 'application/json' },
      }),
      () => api.listTasks(),
    );
    expect(String(captured.input)).toBe('/v1/tasks');
    expect(captured.init?.method).toBeUndefined();
    expect(captured.init?.body).toBeUndefined();
  });

  test('escapes task ids and never turns the detail adapter into a write', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ task: {}, activity: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
      () => api.getTask('F/1 ?'),
    );
    expect(String(captured.input)).toBe('/v1/tasks/F%2F1%20%3F');
    expect(captured.init?.method).toBeUndefined();
    expect(captured.init?.body).toBeUndefined();
  });
});

describe('session administration API transport', () => {
  test('rename sends the caller-owned logical request id and exact patch', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ config: { id: 'session/odd' }, state: {}, directory: '/tmp/session' }), {
        headers: { 'content-type': 'application/json' },
      }),
      () => api.rename('session/odd', { name: 'New Task', teammate: 'new-name', clearParent: true }, 'rename-gesture'),
    );

    expect(String(captured.input)).toContain('/v1/sessions/session%2Fodd/rename');
    expect(captured.init?.method).toBe('POST');
    expect(new Headers(captured.init?.headers).get('x-kteam-request-id')).toBe('rename-gesture');
    expect(JSON.parse(String(captured.init?.body))).toEqual({
      name: 'New Task',
      teammate: 'new-name',
      clearParent: true,
    });
  });

  test('migrate keeps the informed downgrade opt-in under its own request id', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ config: { id: 'session' }, state: {}, directory: '/tmp/session' }), {
        headers: { 'content-type': 'application/json' },
      }),
      () =>
        api.migrate(
          'session',
          { agent: 'codex-auto-atomi', model: 'gpt-5.6-terra', allowContextDowngrade: true },
          'migrate-gesture',
        ),
    );

    expect(String(captured.input)).toContain('/v1/sessions/session/migrate');
    expect(captured.init?.method).toBe('POST');
    expect(new Headers(captured.init?.headers).get('x-kteam-request-id')).toBe('migrate-gesture');
    expect(JSON.parse(String(captured.init?.body))).toEqual({
      agent: 'codex-auto-atomi',
      model: 'gpt-5.6-terra',
      allowContextDowngrade: true,
    });
  });

  test('runtime model control uses its dedicated route and caller-owned request id', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ config: { id: 'session/odd' }, state: {}, directory: '/tmp/session' }), {
        headers: { 'content-type': 'application/json' },
      }),
      () => api.runtime('session/odd', { action: 'model', model: 'claude-opus-5' }, 'runtime-gesture'),
    );

    expect(String(captured.input)).toContain('/v1/sessions/session%2Fodd/runtime');
    expect(captured.init?.method).toBe('POST');
    expect(new Headers(captured.init?.headers).get('x-kteam-request-id')).toBe('runtime-gesture');
    expect(JSON.parse(String(captured.init?.body))).toEqual({ action: 'model', model: 'claude-opus-5' });
  });

  test('runtime Codex picker omits the model so the native account-aware picker decides it', async () => {
    const captured = await captureRequest(
      new Response(JSON.stringify({ config: { id: 'session' }, state: {}, directory: '/tmp/session' }), {
        headers: { 'content-type': 'application/json' },
      }),
      () => api.runtime('session', { action: 'model' }, 'codex-runtime-gesture'),
    );

    expect(JSON.parse(String(captured.init?.body))).toEqual({ action: 'model' });
  });
});
