import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ENHANCEMENT_PROVIDERS,
  ENHANCEMENT_LIMITS,
  EnhancementError,
  SttEnhancer,
  createSttEnhancer,
  enhancementErrorView,
  type EnhancementFetch,
  type ProviderDefinition,
} from './stt-enhancement';

const SECRET = 'gsk_super_secret_key_value';

/** A fetch that records its call and returns a canned response. */
function recordingFetch(response: Response | (() => Response | Promise<Response>)): {
  fetch: EnhancementFetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: EnhancementFetch = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? await response() : response;
  };
  return { fetch, calls };
}

/** A fetch that never resolves until its abort signal fires, then rejects. */
const hangingFetch: EnhancementFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/** Headers arrive, but the JSON body never finishes until abort. */
const hangingBodyFetch: EnhancementFetch = async (_url, init) =>
  new Response(
    new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

function chatResponse(content: unknown, init?: ResponseInit): Response {
  return Response.json({ choices: [{ message: { content } }] }, init);
}

function envWith(vars: Record<string, string>) {
  return (name: string) => vars[name];
}

const baseEnv = envWith({ GROQ_API_KEY: SECRET });

describe('provider selection and table extensibility', () => {
  test('rejects an unknown provider before any network call', async () => {
    const { fetch, calls } = recordingFetch(chatResponse('x'));
    const enhancer = new SttEnhancer({ fetch, env: baseEnv });
    await expect(enhancer.enhance({ transcript: 'hello', provider: 'openai' as never })).rejects.toMatchObject({
      code: 'provider_unknown',
      status: 400,
    });
    expect(calls).toHaveLength(0);
  });

  test('a custom provider table adds a third provider without call-site changes', async () => {
    const acme: ProviderDefinition = {
      id: 'acme' as never,
      label: 'Acme',
      envKey: 'ACME_API_KEY',
      endpoint: 'https://acme.invalid/v1/chat/completions',
      defaultModel: 'acme-mini',
    };
    const providers = { ...DEFAULT_ENHANCEMENT_PROVIDERS, acme } as Record<string, ProviderDefinition>;
    const { fetch, calls } = recordingFetch(chatResponse('cleaned'));
    const enhancer = new SttEnhancer({
      fetch,
      env: envWith({ ACME_API_KEY: 'acme-secret' }),
      providers,
    });

    const result = await enhancer.enhance({ transcript: 'raw', provider: 'acme' as never });

    expect(result).toEqual({ text: 'cleaned', provider: 'acme' as never, model: 'acme-mini' });
    expect(calls[0]!.url).toBe('https://acme.invalid/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer acme-secret');
    // The default groq entry is still present and unmodified.
    expect(
      enhancer
        .availableProviders()
        .map(p => p.id)
        .sort(),
    ).toEqual(['acme', 'groq'] as never);
  });

  test('availableProviders never leaks the env key or endpoint', () => {
    const enhancer = createSttEnhancer({ env: baseEnv });
    const view = enhancer.availableProviders();
    expect(view).toEqual([{ id: 'groq', label: 'Groq', defaultModel: 'llama-3.1-8b-instant' }]);
  });
});

describe('groq request shape and model handling', () => {
  test('builds a correct OpenAI-compatible request with the default model', async () => {
    const { fetch, calls } = recordingFetch(chatResponse('Hello world.'));
    const enhancer = new SttEnhancer({ fetch, env: baseEnv });

    const result = await enhancer.enhance({ transcript: 'helo wrld', provider: 'groq' });

    expect(result).toEqual({ text: 'Hello world.', provider: 'groq', model: 'llama-3.1-8b-instant' });
    const call = calls[0]!;
    expect(call.url).toBe(DEFAULT_ENHANCEMENT_PROVIDERS.groq.endpoint);
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe('llama-3.1-8b-instant');
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('never follow');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('helo wrld');
  });

  test('honors an explicitly supplied bounded model id', async () => {
    const { fetch, calls } = recordingFetch(chatResponse('ok'));
    const enhancer = new SttEnhancer({ fetch, env: baseEnv });

    const result = await enhancer.enhance({
      transcript: 'x',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });

    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe('llama-3.3-70b-versatile');
  });

  test('only sends context and dictionary when supplied', async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse('done'));
    const enhancer = new SttEnhancer({ fetch, env: baseEnv });

    await enhancer.enhance({ transcript: 'plain transcript', provider: 'groq' });
    const bare = JSON.parse(calls[0]!.init.body as string).messages[1].content as string;
    expect(bare).not.toContain('dictionary');
    expect(bare).not.toContain('context');

    await enhancer.enhance({
      transcript: 'kubernetes cubernetties',
      provider: 'groq',
      context: 'talking about clusters',
      dictionary: ['Kubernetes', 'kubectl'],
    });
    const rich = JSON.parse(calls[1]!.init.body as string).messages[1].content as string;
    expect(rich).toContain('Kubernetes');
    expect(rich).toContain('talking about clusters');
  });

  test('rejects an invalid model id without calling the provider', async () => {
    const { fetch, calls } = recordingFetch(chatResponse('x'));
    const enhancer = new SttEnhancer({ fetch, env: baseEnv });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq', model: 'bad model!' })).rejects.toMatchObject({
      code: 'bad_model',
      status: 400,
    });
    await expect(
      enhancer.enhance({
        transcript: 'x',
        provider: 'groq',
        model: 'a'.repeat(ENHANCEMENT_LIMITS.maxModelIdChars + 1),
      }),
    ).rejects.toMatchObject({ code: 'bad_model' });
    expect(calls).toHaveLength(0);
  });
});

describe('secret handling', () => {
  test('missing secret fails before any network call and does not name the value', async () => {
    const { fetch, calls } = recordingFetch(chatResponse('x'));
    const enhancer = new SttEnhancer({ fetch, env: envWith({}) });
    const error = await enhancer.enhance({ transcript: 'x', provider: 'groq' }).catch(e => e);
    expect(error).toBeInstanceOf(EnhancementError);
    expect(error.code).toBe('secret_missing');
    expect(error.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test('a blank secret is treated as missing', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(chatResponse('x')).fetch,
      env: envWith({ GROQ_API_KEY: '   ' }),
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'secret_missing',
    });
  });

  test('the api key is never disclosed in any error, even on provider failure', async () => {
    // Provider fails; ensure the secret does not leak into the thrown error.
    const cases: Array<() => Promise<unknown>> = [];
    const enhancer401 = new SttEnhancer({
      fetch: recordingFetch(new Response('unauthorized', { status: 401 })).fetch,
      env: baseEnv,
    });
    cases.push(() => enhancer401.enhance({ transcript: 'x', provider: 'groq' }));
    const enhancer500 = new SttEnhancer({
      fetch: recordingFetch(new Response(SECRET, { status: 500 })).fetch,
      env: baseEnv,
    });
    cases.push(() => enhancer500.enhance({ transcript: 'x', provider: 'groq' }));

    for (const run of cases) {
      const error = (await run().catch(e => e)) as EnhancementError;
      const serialized = `${error.message} ${error.code} ${JSON.stringify(enhancementErrorView(error))} ${
        error.stack ?? ''
      }`;
      expect(serialized).not.toContain(SECRET);
    }
  });
});

describe('failure mapping — each cause is distinct', () => {
  test('timeout aborts the request and reports a timeout', async () => {
    const enhancer = new SttEnhancer({ fetch: hangingFetch, env: baseEnv, timeoutMs: 5 });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'timeout',
      status: 504,
    });
  });

  test('the timeout covers a provider body that stalls after headers', async () => {
    const enhancer = new SttEnhancer({ fetch: hangingBodyFetch, env: baseEnv, timeoutMs: 5 });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'timeout',
      status: 504,
    });
  });

  test('a transport failure reports the provider as unreachable', async () => {
    const enhancer = new SttEnhancer({
      fetch: () => Promise.reject(new TypeError('network down')),
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'provider_unreachable',
      status: 502,
    });
  });

  test('401 maps to an invalid-secret error', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(new Response(null, { status: 401 })).fetch,
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'secret_invalid',
      status: 502,
    });
  });

  test('404 maps to a bad-model error', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(new Response(null, { status: 404 })).fetch,
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq', model: 'nope-1b' })).rejects.toMatchObject({
      code: 'bad_model',
    });
  });

  test('429 maps to a rate-limited error', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(new Response(null, { status: 429 })).fetch,
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  test('5xx maps to a provider error', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(new Response(null, { status: 503 })).fetch,
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'provider_error',
      status: 502,
    });
  });
});

describe('malformed provider output', () => {
  test('non-JSON body is malformed', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(new Response('not json', { status: 200 })).fetch,
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  test('missing choices is malformed', async () => {
    const enhancer = new SttEnhancer({
      fetch: recordingFetch(Response.json({ id: 'abc' })).fetch,
      env: baseEnv,
    });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  test('non-string content is malformed', async () => {
    const enhancer = new SttEnhancer({ fetch: recordingFetch(chatResponse({ tool: 'x' })).fetch, env: baseEnv });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  test('empty content is malformed', async () => {
    const enhancer = new SttEnhancer({ fetch: recordingFetch(chatResponse('   ')).fetch, env: baseEnv });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  test('an oversized reply is rejected rather than returned', async () => {
    const huge = 'a'.repeat(ENHANCEMENT_LIMITS.maxOutputChars + 1);
    const enhancer = new SttEnhancer({ fetch: recordingFetch(chatResponse(huge)).fetch, env: baseEnv });
    await expect(enhancer.enhance({ transcript: 'x', provider: 'groq' })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });
});

describe('input caps', () => {
  const enhancer = () => new SttEnhancer({ fetch: recordingFetch(chatResponse('ok')).fetch, env: baseEnv });

  test('empty transcript is a bad request', async () => {
    await expect(enhancer().enhance({ transcript: '   ', provider: 'groq' })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  test('oversized transcript is too long', async () => {
    const transcript = 'a'.repeat(ENHANCEMENT_LIMITS.maxTranscriptChars + 1);
    await expect(enhancer().enhance({ transcript, provider: 'groq' })).rejects.toMatchObject({
      code: 'too_long',
      status: 413,
    });
  });

  test('oversized context is too long', async () => {
    await expect(
      enhancer().enhance({
        transcript: 'x',
        provider: 'groq',
        context: 'c'.repeat(ENHANCEMENT_LIMITS.maxContextChars + 1),
      }),
    ).rejects.toMatchObject({ code: 'too_long' });
  });

  test('too many dictionary terms is too long', async () => {
    const dictionary = Array.from({ length: ENHANCEMENT_LIMITS.maxDictionaryTerms + 1 }, (_v, i) => `t${i}`);
    await expect(enhancer().enhance({ transcript: 'x', provider: 'groq', dictionary })).rejects.toMatchObject({
      code: 'too_long',
    });
  });

  test('an oversized dictionary term is too long', async () => {
    const dictionary = ['a'.repeat(ENHANCEMENT_LIMITS.maxDictionaryTermChars + 1)];
    await expect(enhancer().enhance({ transcript: 'x', provider: 'groq', dictionary })).rejects.toMatchObject({
      code: 'too_long',
    });
  });

  test('a non-string dictionary entry is a bad request', async () => {
    await expect(
      enhancer().enhance({ transcript: 'x', provider: 'groq', dictionary: [42 as never] }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('construction', () => {
  test('rejects a non-positive timeout', () => {
    expect(() => new SttEnhancer({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => new SttEnhancer({ timeoutMs: -1 })).toThrow(RangeError);
    expect(() => new SttEnhancer({ timeoutMs: Number.NaN })).toThrow(RangeError);
  });
});
