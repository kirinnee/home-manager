/**
 * Daemon speech-to-text wire contracts.
 *
 * Phase 1 is deliberately batch-only.  There is no partial-message type in
 * this file: callers record first and receive one final transcript after the
 * worker has decoded the complete utterance.
 */

export const STT_SAMPLE_RATE = 16_000;
export const STT_CHANNELS = 1;
export const STT_BITS_PER_SAMPLE = 16;
export const STT_MAX_DURATION_SECONDS = 120;
export const STT_MAX_SAMPLES = STT_SAMPLE_RATE * STT_MAX_DURATION_SECONDS;
export const STT_MAX_PCM_BYTES = STT_MAX_SAMPLES * (STT_BITS_PER_SAMPLE / 8);

export type SttErrorCode =
  | 'bad_request'
  | 'bad_audio'
  | 'too_long'
  | 'unsupported_language'
  | 'busy'
  | 'model_missing'
  | 'model_not_found'
  | 'model_installing'
  | 'install_failed'
  | 'native_missing'
  | 'load_failed'
  | 'decode_failed'
  | 'worker_unavailable'
  | 'worker_crashed'
  | 'service_closed'
  | 'not_found'
  | 'method_not_allowed';

export class SttError extends Error {
  constructor(
    readonly code: SttErrorCode,
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SttError';
  }
}

export interface SttErrorView {
  error: string;
  code: SttErrorCode;
}

export type SttModelKind = 'daemon' | 'browser';
export type SttModelState = 'not-installed' | 'installing' | 'ready' | 'error';
export type SttInstallPhase = 'idle' | 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed';

export interface SttCostView {
  /** Exact network payload represented by the pinned manifest. */
  downloadBytes: number;
  /** Exact published model payload; filesystem metadata is not included. */
  diskBytes: number;
  /** A measured/expected working-set estimate, not an allocation guarantee. */
  ramBytesApprox: number;
  summary: string;
}

export interface SttInstallStatus {
  modelId: string;
  phase: SttInstallPhase;
  receivedBytes: number;
  totalBytes: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  code?: SttErrorCode;
}

export interface SttModelStatus {
  id: string;
  kind: SttModelKind;
  label: string;
  state: SttModelState;
  languages: string[];
  costs: SttCostView;
  installedAt?: string;
  files?: Array<{ name: string; bytes: number; sha256: string }>;
  install: SttInstallStatus;
}

export type SttWorkerPhase = 'cold' | 'loading' | 'ready' | 'busy' | 'error' | 'closed';

export interface SttWorkerStatus {
  phase: SttWorkerPhase;
  pid?: number;
  modelId?: string;
  loadedAt?: string;
  lastError?: { code: SttErrorCode; message: string; at: string };
}

export interface SttStatus {
  available: boolean;
  /** An explicit product/API promise: Phase 1 never claims live text. */
  streaming: false;
  mode: 'batch';
  language: 'en';
  languages: ['en'];
  worker: SttWorkerStatus;
  models: {
    daemon: SttModelStatus;
    browser: SttModelStatus;
  };
  limits: {
    sampleRate: typeof STT_SAMPLE_RATE;
    channels: typeof STT_CHANNELS;
    bitsPerSample: typeof STT_BITS_PER_SAMPLE;
    maxDurationSeconds: number;
    maxPcmBytes: number;
  };
}

export interface SttTranscript {
  text: string;
  audioMs: number;
  decodeMs: number;
  rtf: number;
  modelId: string;
  language: 'en';
  mode: 'batch';
  streaming: false;
}

export interface SttWorkerModel {
  id: string;
  directory: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface SttWorkerLoadRequest {
  type: 'load';
  requestId: string;
  model: SttWorkerModel;
  threads: number;
}

export interface SttWorkerTranscribeRequest {
  type: 'transcribe';
  requestId: string;
  sampleRate: typeof STT_SAMPLE_RATE;
  audio: Float32Array;
}

export interface SttWorkerShutdownRequest {
  type: 'shutdown';
}

export type SttWorkerRequest = SttWorkerLoadRequest | SttWorkerTranscribeRequest | SttWorkerShutdownRequest;

export interface SttWorkerReadyResponse {
  type: 'ready';
  requestId: string;
  modelId: string;
  loadMs: number;
}

export interface SttWorkerResultResponse {
  type: 'result';
  requestId: string;
  modelId: string;
  text: string;
  audioMs: number;
  decodeMs: number;
}

export interface SttWorkerErrorResponse {
  type: 'error';
  requestId?: string;
  code: Extract<
    SttErrorCode,
    'bad_request' | 'bad_audio' | 'too_long' | 'model_missing' | 'native_missing' | 'load_failed' | 'decode_failed'
  >;
  message: string;
}

export interface SttWorkerByeResponse {
  type: 'bye';
}

export type SttWorkerResponse =
  | SttWorkerReadyResponse
  | SttWorkerResultResponse
  | SttWorkerErrorResponse
  | SttWorkerByeResponse;
