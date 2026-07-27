// The DAEMON engine — the default, and the recommendation.
//
// It is a batch engine and it says so. The honest measurement behind that: on
// this fleet's box, a genuine ONLINE Parakeet recogniser produced its first
// partial after 48.35 s for a 7.43 s sample and its final at around 325 s —
// roughly 44× slower than real time. There is no version of that which can be
// rendered as "live". So there is no WebSocket here, no partial frames, and no
// `streaming` flag to tempt anyone: the reader holds the button, sees
// `Recording…`, lets go, sees `Transcribing…`, and gets text.
//
// It owns ~25 lines of `fetch` rather than routing through `lib/api.ts`'s
// `request()` because it posts BINARY with an audio content-type and needs an
// `AbortSignal` per utterance. `TOKEN`/`HAS_TOKEN` are imported READ-ONLY from
// that module — it is already the sole owner of the daemon credential and this
// file does not become a second one.

import { TOKEN, HAS_TOKEN } from '../api';
import { TARGET_SAMPLE_RATE, encodeWav, floatToPcm16 } from './audio-capture';

export const STT_STATUS_PATH = '/v1/stt/status';
export const STT_TRANSCRIBE_PATH = '/v1/stt/transcribe';

/** Start a box-side model download. Progress is then read from
 *  `models.<kind>.install` on the next `GET /v1/stt/status`.
 *
 *  CONFIRMED with the daemon owner. It is still a single constant on purpose:
 *  a 404 or 405 from it is treated as "this box cannot install models from the
 *  browser", which is also exactly the right behaviour against a daemon older
 *  than this page. */
export const sttModelInstallPath = (modelId: string): string => `/v1/stt/models/${encodeURIComponent(modelId)}/install`;

/* ── The daemon's status shape ───────────────────────────────────────────────

   MIRRORS `modules/kteam-ts/src/stt-types.ts` (`SttStatus`), which is the
   authority. It is mirrored rather than imported because that file belongs to
   the daemon's TypeScript project — a different tsconfig, a different lib set,
   and a cross-project import would drag the daemon's whole type graph into the
   browser build.

   Mirrored, but NOT trusted: every field below is read defensively, because
   this page can be served by a daemon older than itself. A daemon with no STT
   routes at all answers 404, and that is a normal, expected state — the reader
   sees "this box has no dictation support yet", not an error.            */

export type DaemonWorkerPhase = 'cold' | 'loading' | 'ready' | 'busy' | 'error' | 'closed';
export type DaemonModelState = 'not-installed' | 'installing' | 'ready' | 'error';
export type DaemonInstallPhase = 'idle' | 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed';

export interface DaemonModelCosts {
  downloadBytes: number;
  diskBytes: number;
  ramBytesApprox: number;
  /** The daemon's own one-line summary. Rendered VERBATIM — the box knows the
   *  real numbers for the model it pinned and the UI must not paraphrase. */
  summary: string;
}

export interface DaemonModelInstall {
  phase: DaemonInstallPhase;
  receivedBytes: number;
  totalBytes: number;
  message?: string;
  code?: string;
}

export interface DaemonModelStatus {
  id: string;
  kind: 'daemon' | 'browser';
  label: string;
  state: DaemonModelState;
  languages: string[];
  costs: DaemonModelCosts;
  installedAt?: string;
  install: DaemonModelInstall;
}

export interface DaemonSttStatus {
  /** False when the route is missing, the subsystem is unwired, or no model is
   *  installed. The control still renders — local mode may be available — but
   *  daemon mode says why it cannot run. */
  available: boolean;
  /** The daemon's own promise that it never claims live text. Read so the UI
   *  can assert it rather than assume it. */
  streaming: boolean;
  worker: { phase: DaemonWorkerPhase; modelId?: string; lastError?: { code?: string; message?: string; at?: string } };
  /** What the daemon can transcribe. English only today. */
  languages: string[];
  /** The model the daemon itself runs. */
  daemonModel?: DaemonModelStatus;
  /** The model the daemon HOSTS for browsers. Its `state` is the honest answer
   *  to "can this device even download the browser model?" — if the box has
   *  not fetched the weights, no browser can. */
  browserModel?: DaemonModelStatus;
  limits?: { maxDurationSeconds?: number; maxPcmBytes?: number; sampleRate?: number };
  /** Present when `available` is false and we know why. */
  unavailableReason?: string;
}

export interface DaemonTranscript {
  text: string;
  audioMs?: number;
  decodeMs?: number;
  rtf?: number;
  modelId?: string;
}

export type SttErrorCode =
  | 'unauthorized'
  | 'unavailable'
  | 'busy'
  | 'too-long'
  | 'bad-audio'
  | 'network'
  | 'aborted'
  | 'unknown';

export class SttRequestError extends Error {
  code: SttErrorCode;
  status: number;
  constructor(code: SttErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'SttRequestError';
    this.code = code;
    this.status = status;
  }
}

/** HTTP status → the code the UI branches on. The daemon also returns its own
 *  `code` in the body and that wins when present; this is the floor. */
export function sttErrorForStatus(status: number, bodyCode?: string): SttErrorCode {
  if (bodyCode === 'busy') return 'busy';
  if (bodyCode === 'too_long') return 'too-long';
  if (bodyCode === 'bad_audio') return 'bad-audio';
  if (bodyCode === 'model_missing' || bodyCode === 'worker_unavailable') return 'unavailable';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404 || status === 503) return 'unavailable';
  if (status === 409) return 'busy';
  if (status === 413) return 'too-long';
  if (status === 400) return 'bad-audio';
  return 'unknown';
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/** The page's daemon credential.
 *
 *  `lib/api` remains its SOLE owner — it is imported read-only here and this
 *  module never reads `window.__KTEAM_TOKEN__` itself. But it is passed as a
 *  parameter rather than reached for as a module constant, for one concrete
 *  reason: `TOKEN` is evaluated once, when `lib/api` is first imported, which in
 *  a test process is whenever some other file happened to import it first. A
 *  test that has to win a module-load race is a test that passes alone and
 *  fails in the suite. */
export interface DaemonAuth {
  token: string;
  hasToken: boolean;
}

export function pageAuth(): DaemonAuth {
  return { token: TOKEN, hasToken: HAS_TOKEN };
}

function authHeaders(auth: DaemonAuth): Record<string, string> {
  return auth.hasToken ? { authorization: `Bearer ${auth.token}` } : {};
}

/** The read-only page (no daemon token) can neither post audio nor be told
 *  anything useful about the worker, so it is answered locally instead of with
 *  a guaranteed 401. */
export function daemonReachable(auth: DaemonAuth = pageAuth()): boolean {
  return auth.hasToken;
}

export async function daemonSttStatus(
  fetchImpl: FetchLike = defaultFetch(),
  signal?: AbortSignal,
  auth: DaemonAuth = pageAuth(),
): Promise<DaemonSttStatus> {
  if (!auth.hasToken) return unavailableStatus('This page was served without a daemon token.');
  let response: Response;
  try {
    response = await fetchImpl(STT_STATUS_PATH, { headers: authHeaders(auth), signal });
  } catch {
    return unavailableStatus('The daemon could not be reached.');
  }
  if (!response.ok) {
    // A 404 is the normal answer from a daemon built before this feature: the
    // route simply is not there. That is "unavailable", not "broken".
    return unavailableStatus(
      response.status === 404
        ? 'This box has no dictation support yet.'
        : `The daemon answered HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailableStatus('The daemon sent an unreadable status.');
  }
  return parseDaemonSttStatus(body);
}

function unavailableStatus(reason: string): DaemonSttStatus {
  return { available: false, streaming: false, worker: { phase: 'closed' }, languages: [], unavailableReason: reason };
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function num(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const WORKER_PHASES: readonly DaemonWorkerPhase[] = ['cold', 'loading', 'ready', 'busy', 'error', 'closed'];
const MODEL_STATES: readonly DaemonModelState[] = ['not-installed', 'installing', 'ready', 'error'];
const INSTALL_PHASES: readonly DaemonInstallPhase[] = [
  'idle',
  'downloading',
  'extracting',
  'verifying',
  'ready',
  'failed',
];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function parseModelStatus(value: unknown, kind: 'daemon' | 'browser'): DaemonModelStatus | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const costs = record(obj['costs']) ?? {};
  const install = record(obj['install']) ?? {};
  return {
    id: str(obj, 'id') ?? '',
    kind: obj['kind'] === 'daemon' || obj['kind'] === 'browser' ? (obj['kind'] as 'daemon' | 'browser') : kind,
    label: str(obj, 'label') ?? '',
    state: oneOf(obj['state'], MODEL_STATES, 'not-installed'),
    languages: Array.isArray(obj['languages'])
      ? (obj['languages'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
    costs: {
      downloadBytes: num(costs, 'downloadBytes', 0),
      diskBytes: num(costs, 'diskBytes', 0),
      ramBytesApprox: num(costs, 'ramBytesApprox', 0),
      summary: str(costs, 'summary') ?? '',
    },
    installedAt: str(obj, 'installedAt'),
    install: {
      phase: oneOf(install['phase'], INSTALL_PHASES, 'idle'),
      receivedBytes: num(install, 'receivedBytes', 0),
      totalBytes: num(install, 'totalBytes', 0),
      message: str(install, 'message'),
      code: str(install, 'code'),
    },
  };
}

/** Defensive shape read of `SttStatus`. Exported so the parse has a test that
 *  does not need a server. */
export function parseDaemonSttStatus(body: unknown): DaemonSttStatus {
  const obj = record(body);
  if (!obj) return unavailableStatus('The daemon sent an unreadable status.');

  const workerRaw = record(obj['worker']) ?? {};
  const errorRaw = record(workerRaw['lastError']);
  const models = record(obj['models']) ?? {};

  const languages = Array.isArray(obj['languages'])
    ? (obj['languages'] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];

  return {
    available: obj['available'] === true,
    // Only a literal `false` counts as the daemon's no-live-text promise; a
    // missing field is read as "we do not know", which the UI treats the same
    // way it treats every other unknown — by saying nothing about it.
    streaming: obj['streaming'] === true,
    worker: {
      phase: oneOf(workerRaw['phase'], WORKER_PHASES, 'closed'),
      modelId: str(workerRaw, 'modelId'),
      lastError: errorRaw
        ? { code: str(errorRaw, 'code'), message: str(errorRaw, 'message'), at: str(errorRaw, 'at') }
        : undefined,
    },
    languages,
    daemonModel: parseModelStatus(models['daemon'], 'daemon'),
    browserModel: parseModelStatus(models['browser'], 'browser'),
    limits: (() => {
      const limits = record(obj['limits']);
      if (!limits) return undefined;
      return {
        maxDurationSeconds:
          typeof limits['maxDurationSeconds'] === 'number' ? (limits['maxDurationSeconds'] as number) : undefined,
        maxPcmBytes: typeof limits['maxPcmBytes'] === 'number' ? (limits['maxPcmBytes'] as number) : undefined,
        sampleRate: typeof limits['sampleRate'] === 'number' ? (limits['sampleRate'] as number) : undefined,
      };
    })(),
  };
}

/** Ask the box to download a model it does not have. See `sttModelInstallPath`
 *  for the one unconfirmed part of this contract. Progress is then read from
 *  `models.<kind>.install` on the next status poll. */
export async function requestDaemonModelInstall(
  modelId: string,
  fetchImpl: FetchLike = defaultFetch(),
  auth: DaemonAuth = pageAuth(),
): Promise<{ started: boolean; message?: string }> {
  if (!auth.hasToken) return { started: false, message: 'This page was served without a daemon token.' };
  let response: Response;
  try {
    response = await fetchImpl(sttModelInstallPath(modelId), { method: 'POST', headers: authHeaders(auth) });
  } catch {
    return { started: false, message: 'The daemon could not be reached.' };
  }
  if (response.status === 404 || response.status === 405) {
    return {
      started: false,
      message: 'This box cannot start a model download from the browser. Install it on the box instead.',
    };
  }
  if (!response.ok) {
    let message: string | undefined;
    try {
      message = ((await response.json()) as { error?: string }).error;
    } catch {
      /* a non-JSON error body is still an error */
    }
    return { started: false, message: message ?? `The daemon refused the install (HTTP ${response.status}).` };
  }
  return { started: true };
}

export interface DaemonTranscribeOptions {
  /** 16 kHz mono float samples, straight out of `audio-capture`. */
  samples: Float32Array;
  /** Ignored by an English-only daemon, sent anyway so a future multilingual
   *  model needs no client change. */
  language?: string;
  sessionId?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  auth?: DaemonAuth;
  /** WAV by default. `raw` posts `audio/L16`, which is 44 bytes smaller and
   *  exactly as correct — kept because the daemon accepts both and a raw body
   *  is easier to reason about at the boundary. */
  encoding?: 'wav' | 'raw';
}

export async function daemonTranscribe(options: DaemonTranscribeOptions): Promise<DaemonTranscript> {
  const { samples, language = 'en', sessionId, signal } = options;
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const auth = options.auth ?? pageAuth();
  if (!auth.hasToken) throw new SttRequestError('unauthorized', 'This page was served without a daemon token.', 401);
  if (samples.length === 0) throw new SttRequestError('bad-audio', 'No audio was captured.', 0);

  const pcm = floatToPcm16(samples);
  const body =
    options.encoding === 'raw'
      ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      : encodeWav(pcm, TARGET_SAMPLE_RATE);
  const contentType = options.encoding === 'raw' ? `audio/L16; rate=${TARGET_SAMPLE_RATE}; channels=1` : 'audio/wav';

  const query = new URLSearchParams({ language });
  if (sessionId) query.set('sessionId', sessionId);

  let response: Response;
  try {
    response = await fetchImpl(`${STT_TRANSCRIBE_PATH}?${query}`, {
      method: 'POST',
      headers: { ...authHeaders(auth), 'content-type': contentType },
      body: body as unknown as BodyInit,
      signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new SttRequestError('aborted', 'Transcription was cancelled.', 0);
    }
    throw new SttRequestError('network', 'The daemon could not be reached.', 0);
  }

  if (!response.ok) {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const parsed = (await response.json()) as { code?: string; error?: string };
      code = parsed.code;
      message = parsed.error;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new SttRequestError(
      sttErrorForStatus(response.status, code),
      message ?? `The daemon refused the recording (HTTP ${response.status}).`,
      response.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new SttRequestError('unknown', 'The daemon sent an unreadable transcript.', response.status);
  }
  return parseDaemonTranscript(parsed);
}

export function parseDaemonTranscript(body: unknown): DaemonTranscript {
  if (!body || typeof body !== 'object') return { text: '' };
  const obj = body as Record<string, unknown>;
  // ONLY the raw `text` is read. The daemon may also send an `enhanced` field;
  // this client deliberately ignores it and runs its OWN enhancer over `text`,
  // so daemon and browser modes produce identical output from identical audio
  // and there is exactly one place where a substitution can happen.
  return {
    text: typeof obj['text'] === 'string' ? (obj['text'] as string) : '',
    audioMs: typeof obj['audioMs'] === 'number' ? (obj['audioMs'] as number) : undefined,
    decodeMs: typeof obj['decodeMs'] === 'number' ? (obj['decodeMs'] as number) : undefined,
    rtf: typeof obj['rtf'] === 'number' ? (obj['rtf'] as number) : undefined,
    modelId: typeof obj['modelId'] === 'string' ? (obj['modelId'] as string) : undefined,
  };
}
