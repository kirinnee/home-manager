import { describe, expect, test } from 'bun:test';
import {
  MAX_REMOTE_ENHANCEMENT_TEXT_CHARS,
  RemoteEnhancementError,
  STT_ENHANCE_PATH,
  requestRemoteEnhancement,
} from './remote-enhancement';

const auth = { token: 'daemon-token', hasToken: true };
const base = {
  provider: 'groq' as const,
  model: 'llama-3.1-8b-instant',
  text: 'raw words',
  dictionary: [{ term: 'kteam', aliases: ['kayteam'] }],
  context: ['recent context'],
  userContext: 'project vocabulary',
  auth,
};

function code(error: unknown): string | undefined {
  return error instanceof RemoteEnhancementError ? error.code : undefined;
}

describe('requestRemoteEnhancement', () => {
  test('posts only provider/model/content through the authenticated daemon route', async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    const result = await requestRemoteEnhancement({
      ...base,
      fetchImpl: async (input, init) => {
        request = { input: String(input), init };
        return Response.json({ text: 'corrected words', provider: 'groq', model: base.model, latencyMs: 42 });
      },
    });
    expect(result).toEqual({ text: 'corrected words', provider: 'groq', model: base.model, latencyMs: 42 });
    expect(request?.input).toBe(STT_ENHANCE_PATH);
    expect(request?.init?.method).toBe('POST');
    const body = JSON.parse(String(request?.init?.body));
    expect(body).toMatchObject({ provider: 'groq', model: base.model, text: 'raw words' });
    expect(JSON.stringify(body).toLowerCase()).not.toContain('api_key');
    expect(JSON.stringify(body)).not.toContain(auth.token);
  });

  test('requires daemon auth without making a request', async () => {
    let called = false;
    const outcome = requestRemoteEnhancement({
      ...base,
      auth: { token: '', hasToken: false },
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      },
    }).catch(error => error);
    expect(code(await outcome)).toBe('unauthorized');
    expect(called).toBe(false);
  });

  test('surfaces the daemon/provider real reason and code', async () => {
    const outcome = requestRemoteEnhancement({
      ...base,
      fetchImpl: async () =>
        Response.json({ code: 'secret_missing', error: 'enhancement provider is not configured' }, { status: 503 }),
    }).catch(error => error);
    const error = await outcome;
    expect(code(error)).toBe('not-configured');
    expect(error.message).toBe('enhancement provider is not configured');
  });

  test('maps every stable daemon/provider failure distinctly', async () => {
    for (const [status, body, expected] of [
      [502, { code: 'secret_invalid', error: 'Provider rejected the daemon credentials.' }, 'provider-auth'],
      [429, { code: 'rate_limited', error: 'Provider rate limit reached.' }, 'rate-limit'],
      [400, { code: 'bad_request', error: 'Transcript is required.' }, 'bad-request'],
      [413, { code: 'too_long', error: 'Transcript is too long.' }, 'too-long'],
      [400, { code: 'bad_model', error: 'Model is invalid.' }, 'bad-model'],
      [502, { code: 'provider_unreachable', error: 'Provider is unreachable.' }, 'provider-unreachable'],
      [502, { code: 'malformed_response', error: 'Provider response was malformed.' }, 'invalid-response'],
      [404, { code: 'unknown_route' }, 'unavailable'],
      [200, {}, 'invalid-response'],
    ] as const) {
      const outcome = requestRemoteEnhancement({
        ...base,
        fetchImpl: async () => Response.json(body, { status }),
      }).catch(error => error);
      expect(code(await outcome)).toBe(expected);
    }
  });

  test('has a hard client timeout and keeps transcript/error bodies out of the error', async () => {
    const outcome = requestRemoteEnhancement({
      ...base,
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        }),
    }).catch(error => error);
    const error = await outcome;
    expect(code(error)).toBe('timeout');
    expect(error.message).not.toContain(base.text);
    expect(error.message).not.toContain(auth.token);
  });

  test('the client timeout also covers a response body that stalls after headers', async () => {
    const outcome = requestRemoteEnhancement({
      ...base,
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }).catch(error => error);
    expect(code(await outcome)).toBe('timeout');
  });

  test('an already-aborted utterance never starts remote work', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const outcome = requestRemoteEnhancement({
      ...base,
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        called = true;
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return Response.json({ text: 'unexpected' });
      },
    }).catch(error => error);
    expect(code(await outcome)).toBe('aborted');
    expect(called).toBe(false);
  });

  test('refuses oversized input before fetch', async () => {
    let called = false;
    const outcome = requestRemoteEnhancement({
      ...base,
      text: 'x'.repeat(MAX_REMOTE_ENHANCEMENT_TEXT_CHARS + 1),
      fetchImpl: async () => {
        called = true;
        return Response.json({ text: 'no' });
      },
    }).catch(error => error);
    expect(code(await outcome)).toBe('invalid-response');
    expect(called).toBe(false);
  });
});
