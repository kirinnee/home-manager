// EVERY request here is given an explicit credential.
//
// The alternative — planting `window.__KTEAM_TOKEN__` and hoping this file
// imports `lib/api` first — passes when this file runs alone and fails in the
// full suite, because whichever test file loads `lib/api` first fixes `TOKEN`
// for the whole process. `DaemonAuth` exists so the credential is an argument
// rather than a race.
import { describe, expect, test } from 'bun:test';
import {
  STT_STATUS_PATH,
  STT_TRANSCRIBE_PATH,
  SttRequestError,
  daemonReachable,
  daemonSttStatus,
  daemonTranscribe,
  parseDaemonSttStatus,
  parseDaemonTranscript,
  requestDaemonModelInstall,
  sttErrorForStatus,
  sttModelInstallPath,
  type DaemonAuth,
} from './daemon-engine';

/** A page that received a daemon credential — the only interesting case for a
 *  transcription client. */
const AUTH: DaemonAuth = { token: 'test-token', hasToken: true };
const NO_AUTH: DaemonAuth = { token: '', hasToken: false };

type Call = { url: string; init?: RequestInit };

function recorder(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A realistic `SttStatus`, shaped exactly like the daemon's own type. */
function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    streaming: false,
    mode: 'batch',
    language: 'en',
    languages: ['en'],
    worker: { phase: 'ready', pid: 42, modelId: 'parakeet-daemon-v2' },
    models: {
      daemon: {
        id: 'parakeet-daemon-v2',
        kind: 'daemon',
        label: 'Parakeet TDT 0.6B v2 int8 (English, daemon batch)',
        state: 'ready',
        languages: ['en'],
        costs: {
          downloadBytes: 482_468_385,
          diskBytes: 661_428_477,
          ramBytesApprox: 1_073_741_824,
          summary: '460 MB download.',
        },
        installedAt: '2026-07-27T00:00:00.000Z',
        install: { modelId: 'parakeet-daemon-v2', phase: 'ready', receivedBytes: 482_468_385, totalBytes: 482_468_385 },
      },
      browser: {
        id: 'parakeet-browser-v3',
        kind: 'browser',
        label: 'Parakeet TDT 0.6B v3 int8 (browser batch)',
        state: 'not-installed',
        languages: ['en', 'fr'],
        costs: {
          downloadBytes: 670_488_135,
          diskBytes: 670_488_135,
          ramBytesApprox: 1_073_741_824,
          summary: '640 MB download.',
        },
        install: { modelId: 'parakeet-browser-v3', phase: 'idle', receivedBytes: 0, totalBytes: 670_488_135 },
      },
    },
    limits: { sampleRate: 16_000, channels: 1, bitsPerSample: 16, maxDurationSeconds: 120, maxPcmBytes: 3_840_000 },
    ...overrides,
  };
}

describe('parseDaemonSttStatus — the NESTED daemon shape', () => {
  test('reads worker.phase, models.daemon and models.browser', () => {
    const status = parseDaemonSttStatus(statusBody());
    expect(status.available).toBe(true);
    expect(status.worker.phase).toBe('ready');
    expect(status.worker.modelId).toBe('parakeet-daemon-v2');
    expect(status.daemonModel?.id).toBe('parakeet-daemon-v2');
    expect(status.daemonModel?.state).toBe('ready');
    expect(status.daemonModel?.costs.downloadBytes).toBe(482_468_385);
    expect(status.browserModel?.id).toBe('parakeet-browser-v3');
    expect(status.browserModel?.state).toBe('not-installed');
    expect(status.browserModel?.install.totalBytes).toBe(670_488_135);
    expect(status.limits?.maxDurationSeconds).toBe(120);
  });

  test('carries the worker error through', () => {
    const status = parseDaemonSttStatus(
      statusBody({
        worker: { phase: 'error', lastError: { code: 'native_missing', message: 'dlopen failed', at: 'now' } },
      }),
    );
    expect(status.worker.phase).toBe('error');
    expect(status.worker.lastError).toEqual({ code: 'native_missing', message: 'dlopen failed', at: 'now' });
  });

  test('an unknown worker phase or model state falls back rather than leaking through', () => {
    const status = parseDaemonSttStatus(
      statusBody({
        worker: { phase: 'transcending' },
        models: { daemon: { id: 'x', kind: 'daemon', state: 'melting', install: { phase: 'hovering' } } },
      }),
    );
    expect(status.worker.phase).toBe('closed');
    expect(status.daemonModel?.state).toBe('not-installed');
    expect(status.daemonModel?.install.phase).toBe('idle');
  });

  test('a FLAT status from an older daemon degrades instead of half-reading', () => {
    const status = parseDaemonSttStatus({ available: true, worker: 'ready', model: { id: 'x' }, languages: ['en'] });
    expect(status.available).toBe(true);
    expect(status.worker.phase).toBe('closed');
    expect(status.daemonModel).toBeUndefined();
    expect(status.browserModel).toBeUndefined();
  });

  test('rubbish is unavailable, not a throw', () => {
    for (const body of [null, undefined, 'hello', 42, []]) {
      expect(parseDaemonSttStatus(body).available).toBe(false);
    }
  });

  test('`streaming` is only true when the daemon literally says so', () => {
    expect(parseDaemonSttStatus(statusBody()).streaming).toBe(false);
    expect(parseDaemonSttStatus(statusBody({ streaming: 'yes' })).streaming).toBe(false);
  });
});

describe('daemonSttStatus', () => {
  test('sends the bearer token to the documented path', async () => {
    const { calls, fetchImpl } = recorder(() => json(statusBody()));
    await daemonSttStatus(fetchImpl, undefined, AUTH);
    expect(calls[0]?.url).toBe(STT_STATUS_PATH);
    expect((calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer test-token');
  });

  test('a 404 is "this box has no dictation yet", not an error state', async () => {
    const { fetchImpl } = recorder(() => new Response('', { status: 404 }));
    const status = await daemonSttStatus(fetchImpl, undefined, AUTH);
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toContain('no dictation support yet');
  });

  test('a network failure is reported, not thrown', async () => {
    const status = await daemonSttStatus(
      async () => {
        throw new Error('offline');
      },
      undefined,
      AUTH,
    );
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toContain('could not be reached');
  });

  test('an unreadable body is reported, not thrown', async () => {
    const { fetchImpl } = recorder(
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const status = await daemonSttStatus(fetchImpl, undefined, AUTH);
    expect(status.available).toBe(false);
  });
});

describe('sttErrorForStatus', () => {
  test('prefers the daemon body code over the HTTP status', () => {
    expect(sttErrorForStatus(500, 'busy')).toBe('busy');
    expect(sttErrorForStatus(500, 'too_long')).toBe('too-long');
    expect(sttErrorForStatus(500, 'model_missing')).toBe('unavailable');
    expect(sttErrorForStatus(500, 'worker_unavailable')).toBe('unavailable');
  });

  test('falls back to the status when there is no body code', () => {
    expect(sttErrorForStatus(401)).toBe('unauthorized');
    expect(sttErrorForStatus(403)).toBe('unauthorized');
    expect(sttErrorForStatus(404)).toBe('unavailable');
    expect(sttErrorForStatus(503)).toBe('unavailable');
    expect(sttErrorForStatus(409)).toBe('busy');
    expect(sttErrorForStatus(413)).toBe('too-long');
    expect(sttErrorForStatus(400)).toBe('bad-audio');
    expect(sttErrorForStatus(500)).toBe('unknown');
  });
});

describe('daemonTranscribe', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 0.25]);

  test('posts a WAV with the language and session in the query', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'hello there', audioMs: 100, decodeMs: 400, rtf: 4 }));
    const result = await daemonTranscribe({ samples, language: 'en', sessionId: 'abc', fetchImpl, auth: AUTH });
    expect(result.text).toBe('hello there');
    const call = calls[0];
    expect(call?.url.startsWith(`${STT_TRANSCRIBE_PATH}?`)).toBe(true);
    expect(call?.url).toContain('language=en');
    expect(call?.url).toContain('sessionId=abc');
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('audio/wav');
    expect(headers['authorization']).toBe('Bearer test-token');
    // 44-byte header plus two bytes per sample.
    expect((call?.init?.body as Uint8Array).byteLength).toBe(44 + samples.length * 2);
  });

  test('can post raw L16 instead, with the rate in the content type', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'x' }));
    await daemonTranscribe({ samples, fetchImpl, encoding: 'raw', auth: AUTH });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('audio/L16; rate=16000; channels=1');
    expect((calls[0]?.init?.body as Uint8Array).byteLength).toBe(samples.length * 2);
  });

  test('refuses an empty utterance before touching the network', async () => {
    let called = false;
    await expect(
      daemonTranscribe({
        samples: new Float32Array(0),
        auth: AUTH,
        fetchImpl: async () => {
          called = true;
          return json({});
        },
      }),
    ).rejects.toMatchObject({ code: 'bad-audio' });
    expect(called).toBe(false);
  });

  test('maps a daemon refusal onto a code and keeps its message', async () => {
    const { fetchImpl } = recorder(() => json({ error: 'the worker is busy', code: 'busy' }, 409));
    await expect(daemonTranscribe({ samples, fetchImpl, auth: AUTH })).rejects.toMatchObject({
      code: 'busy',
      message: 'the worker is busy',
      status: 409,
    });
  });

  test('a non-JSON error body is still a typed failure', async () => {
    const { fetchImpl } = recorder(() => new Response('nope', { status: 503 }));
    await expect(daemonTranscribe({ samples, fetchImpl, auth: AUTH })).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('an abort is its own code, so the UI can stay silent about it', async () => {
    const fetchImpl = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(daemonTranscribe({ samples, fetchImpl, auth: AUTH })).rejects.toMatchObject({ code: 'aborted' });
  });

  test('a transport failure is `network`', async () => {
    const fetchImpl = async () => {
      throw new Error('connection reset');
    };
    await expect(daemonTranscribe({ samples, fetchImpl, auth: AUTH })).rejects.toBeInstanceOf(SttRequestError);
  });

  test('IGNORES a daemon-side `enhanced` field — enhancement happens in one place', async () => {
    const { fetchImpl } = recorder(() => json({ text: 'raw words', enhanced: 'REWRITTEN ENTIRELY' }));
    const result = await daemonTranscribe({ samples, fetchImpl, auth: AUTH });
    expect(result.text).toBe('raw words');
    expect(JSON.stringify(result)).not.toContain('REWRITTEN');
  });
});

describe('the read-only page, with no daemon credential', () => {
  test('is told so, rather than getting a guaranteed 401 from the network', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return json({});
    };
    const status = await daemonSttStatus(fetchImpl, undefined, NO_AUTH);
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toContain('without a daemon token');

    await expect(
      daemonTranscribe({ samples: new Float32Array([0.1]), fetchImpl, auth: NO_AUTH }),
    ).rejects.toMatchObject({ code: 'unauthorized' });

    expect(await requestDaemonModelInstall('x', fetchImpl, NO_AUTH)).toMatchObject({ started: false });
    expect(called).toBe(false);
  });

  test('daemonReachable answers the same question without a request', () => {
    expect(daemonReachable(AUTH)).toBe(true);
    expect(daemonReachable(NO_AUTH)).toBe(false);
  });
});

describe('parseDaemonTranscript', () => {
  test('reads the metrics when present', () => {
    expect(parseDaemonTranscript({ text: 'a', audioMs: 1, decodeMs: 2, rtf: 3, modelId: 'm' })).toEqual({
      text: 'a',
      audioMs: 1,
      decodeMs: 2,
      rtf: 3,
      modelId: 'm',
    });
  });

  test('an absent or hostile body is empty text, not a crash', () => {
    expect(parseDaemonTranscript(null).text).toBe('');
    expect(parseDaemonTranscript({ text: 42 }).text).toBe('');
  });
});

describe('requestDaemonModelInstall', () => {
  test('posts to the confirmed route for the given model', async () => {
    const { calls, fetchImpl } = recorder(() => json({ ok: true }));
    const result = await requestDaemonModelInstall('parakeet-browser-v3', fetchImpl, AUTH);
    expect(result.started).toBe(true);
    expect(calls[0]?.url).toBe('/v1/stt/models/parakeet-browser-v3/install');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  test('encodes an awkward model id rather than splicing it into the path', () => {
    expect(sttModelInstallPath('a/b c')).toBe('/v1/stt/models/a%2Fb%20c/install');
  });

  test('a 404 or 405 becomes an honest "not from the browser", not a failure', async () => {
    for (const status of [404, 405]) {
      const { fetchImpl } = recorder(() => new Response('', { status }));
      const result = await requestDaemonModelInstall('x', fetchImpl, AUTH);
      expect(result.started).toBe(false);
      expect(result.message).toContain('Install it on the box');
    }
  });

  test('surfaces the daemon error message when it refuses', async () => {
    const { fetchImpl } = recorder(() => json({ error: 'no disk space' }, 507));
    expect(await requestDaemonModelInstall('x', fetchImpl, AUTH)).toEqual({ started: false, message: 'no disk space' });
  });
});
