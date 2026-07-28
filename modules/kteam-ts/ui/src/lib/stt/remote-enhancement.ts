// Optional POST-dictation correction through the daemon.
//
// The browser owns only two non-secrets: provider id and model id. The provider
// credential is intentionally impossible to pass through this API: the daemon
// reads GROQ_API_KEY from its already-loaded ~/.secrets environment. This file
// never logs request/response bodies, because both contain dictated text.

import { HAS_TOKEN, TOKEN } from '../api';
import type { DictionaryEntry } from './enhancement';

export const STT_ENHANCE_PATH = '/v1/stt/enhance';
export const REMOTE_ENHANCEMENT_TIMEOUT_MS = 2_500;
export const MAX_REMOTE_ENHANCEMENT_TEXT_CHARS = 8_000;

export type RemoteEnhancementErrorCode =
  | 'unauthorized'
  | 'unavailable'
  | 'not-configured'
  | 'provider-auth'
  | 'rate-limit'
  | 'bad-request'
  | 'too-long'
  | 'bad-model'
  | 'timeout'
  | 'provider-unreachable'
  | 'provider'
  | 'invalid-response'
  | 'network'
  | 'aborted';

export class RemoteEnhancementError extends Error {
  constructor(
    readonly code: RemoteEnhancementErrorCode,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'RemoteEnhancementError';
  }
}

export interface EnhancementAuth {
  token: string;
  hasToken: boolean;
}

export type RemoteEnhancementFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface RemoteEnhancementInput {
  provider: 'groq';
  model: string;
  text: string;
  dictionary: readonly DictionaryEntry[];
  context: readonly string[];
  userContext: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: RemoteEnhancementFetch;
  auth?: EnhancementAuth;
}

export interface RemoteEnhancementResult {
  text: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
}

function pageAuth(): EnhancementAuth {
  return { token: TOKEN, hasToken: HAS_TOKEN };
}

function errorCode(status: number, code: unknown): RemoteEnhancementErrorCode {
  if (code === 'secret_missing') return 'not-configured';
  if (code === 'secret_invalid') return 'provider-auth';
  if (code === 'rate_limited') return 'rate-limit';
  if (code === 'bad_request' || code === 'provider_unknown') return 'bad-request';
  if (code === 'too_long') return 'too-long';
  if (code === 'bad_model') return 'bad-model';
  if (code === 'timeout') return 'timeout';
  if (code === 'provider_unreachable') return 'provider-unreachable';
  if (code === 'malformed_response') return 'invalid-response';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rate-limit';
  return 'provider';
}

function boundedMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 400) : fallback;
}

export async function requestRemoteEnhancement(input: RemoteEnhancementInput): Promise<RemoteEnhancementResult> {
  const auth = input.auth ?? pageAuth();
  if (!auth.hasToken) {
    throw new RemoteEnhancementError('unauthorized', 'This page was served without a daemon token.', 401);
  }
  if (!input.text.trim()) return { text: input.text };
  if (input.text.length > MAX_REMOTE_ENHANCEMENT_TEXT_CHARS) {
    throw new RemoteEnhancementError('invalid-response', 'The transcript is too long for remote enhancement.');
  }
  if (input.signal?.aborted) throw new RemoteEnhancementError('aborted', 'Enhancement was cancelled.');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.max(1, input.timeoutMs ?? REMOTE_ENHANCEMENT_TIMEOUT_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();

  try {
    let response: Response;
    try {
      const fetchImpl: RemoteEnhancementFetch = input.fetchImpl ?? ((request, init) => fetch(request, init));
      response = await fetchImpl(STT_ENHANCE_PATH, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: input.provider,
          model: input.model,
          text: input.text,
          dictionary: input.dictionary,
          context: input.context,
          userContext: input.userContext,
        }),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) {
        throw new RemoteEnhancementError(
          'timeout',
          `Groq enhancement exceeded ${timeoutMs} ms; raw dictation was kept.`,
        );
      }
      if (input.signal?.aborted) throw new RemoteEnhancementError('aborted', 'Enhancement was cancelled.');
      throw new RemoteEnhancementError('network', 'The daemon could not be reached for enhancement.');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (timedOut) {
        throw new RemoteEnhancementError(
          'timeout',
          `Groq enhancement exceeded ${timeoutMs} ms; raw dictation was kept.`,
        );
      }
      if (input.signal?.aborted) throw new RemoteEnhancementError('aborted', 'Enhancement was cancelled.');
      throw new RemoteEnhancementError(
        response.ok ? 'invalid-response' : errorCode(response.status, undefined),
        response.ok
          ? 'The enhancement provider returned an unreadable response; raw dictation was kept.'
          : `Enhancement failed (HTTP ${response.status}); raw dictation was kept.`,
        response.status,
      );
    }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (!response.ok) {
      const code = errorCode(response.status, record['code']);
      const fallback =
        code === 'unavailable'
          ? 'This daemon does not support remote enhancement yet; raw dictation was kept.'
          : `Enhancement failed (HTTP ${response.status}); raw dictation was kept.`;
      throw new RemoteEnhancementError(code, boundedMessage(record['error'], fallback), response.status);
    }
    const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
    if (!text || text.length > MAX_REMOTE_ENHANCEMENT_TEXT_CHARS) {
      throw new RemoteEnhancementError(
        'invalid-response',
        'The enhancement provider returned no usable text; raw dictation was kept.',
        response.status,
      );
    }
    return {
      text,
      provider: typeof record['provider'] === 'string' ? record['provider'] : undefined,
      model: typeof record['model'] === 'string' ? record['model'] : undefined,
      latencyMs:
        typeof record['latencyMs'] === 'number' && Number.isFinite(record['latencyMs'])
          ? record['latencyMs']
          : undefined,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
