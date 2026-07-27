/**
 * Bun child-process entry for daemon batch transcription.
 *
 * The native module and ~1 GiB model live only in this process.  kteamd talks
 * to it over Bun's advanced IPC, which preserves Float32Array audio without a
 * JSON/base64 copy.  Phase 1 intentionally uses OfflineRecognizer only.
 */
import { lstat } from 'node:fs/promises';
import {
  STT_MAX_SAMPLES,
  STT_SAMPLE_RATE,
  type SttErrorCode,
  type SttWorkerErrorResponse,
  type SttWorkerLoadRequest,
  type SttWorkerModel,
  type SttWorkerRequest,
  type SttWorkerResponse,
  type SttWorkerTranscribeRequest,
} from './stt-types';

interface OfflineStreamLike {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decode(stream: OfflineStreamLike): void;
  getResult(stream: OfflineStreamLike): { text?: unknown };
}

interface SherpaModuleLike {
  OfflineRecognizer: new (config: unknown) => OfflineRecognizerLike;
}

let recognizer: OfflineRecognizerLike | undefined;
let loadedModel: SttWorkerModel | undefined;
let queue = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function send(message: SttWorkerResponse): void {
  if (typeof process.send !== 'function' || !process.connected) {
    throw new Error('STT worker has no Bun IPC channel');
  }
  process.send(message);
}

function classifyLoadError(error: unknown): Extract<SttErrorCode, 'model_missing' | 'native_missing' | 'load_failed'> {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|model.*missing/i.test(message)) return 'model_missing';
  if (/libstdc\+\+|shared object|dlopen|native|sherpa-onnx\.node/i.test(message)) return 'native_missing';
  return 'load_failed';
}

function safeMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : String(error || fallback)).slice(0, 1_000);
}

function workerError(
  code: SttWorkerErrorResponse['code'],
  message: string,
  requestId?: string,
): SttWorkerErrorResponse {
  return { type: 'error', requestId, code, message };
}

function isModel(value: unknown): value is SttWorkerModel {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.directory === 'string' &&
    typeof value.encoder === 'string' &&
    typeof value.decoder === 'string' &&
    typeof value.joiner === 'string' &&
    typeof value.tokens === 'string'
  );
}

function isLoadRequest(value: unknown): value is SttWorkerLoadRequest {
  return (
    isRecord(value) &&
    value.type === 'load' &&
    typeof value.requestId === 'string' &&
    isModel(value.model) &&
    typeof value.threads === 'number' &&
    Number.isInteger(value.threads) &&
    value.threads >= 1 &&
    value.threads <= 32
  );
}

function isTranscribeRequest(value: unknown): value is SttWorkerTranscribeRequest {
  return (
    isRecord(value) &&
    value.type === 'transcribe' &&
    typeof value.requestId === 'string' &&
    value.sampleRate === STT_SAMPLE_RATE &&
    value.audio instanceof Float32Array
  );
}

async function assertModelFiles(model: SttWorkerModel): Promise<void> {
  for (const file of [model.encoder, model.decoder, model.joiner, model.tokens]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`model file is not a regular file: ${file}`);
  }
}

async function load(request: SttWorkerLoadRequest): Promise<void> {
  if (recognizer && loadedModel?.id === request.model.id && loadedModel.directory === request.model.directory) {
    send({ type: 'ready', requestId: request.requestId, modelId: request.model.id, loadMs: 0 });
    return;
  }
  const started = performance.now();
  try {
    await assertModelFiles(request.model);
    // Non-literal import keeps typechecking independent of this untyped CJS
    // package while package.json still pins it on the target daemon host.
    const specifier = 'sherpa-onnx-node';
    const namespace = (await import(specifier)) as unknown as { default?: SherpaModuleLike } & SherpaModuleLike;
    const sherpa = namespace.default ?? namespace;
    if (typeof sherpa.OfflineRecognizer !== 'function') throw new Error('sherpa OfflineRecognizer export is missing');
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: request.model.encoder,
          decoder: request.model.decoder,
          joiner: request.model.joiner,
        },
        tokens: request.model.tokens,
        numThreads: request.threads,
        provider: 'cpu',
        modelType: 'nemo_transducer',
      },
      decodingMethod: 'greedy_search',
    });
    loadedModel = request.model;
    send({
      type: 'ready',
      requestId: request.requestId,
      modelId: request.model.id,
      loadMs: Math.max(0, performance.now() - started),
    });
  } catch (error) {
    recognizer = undefined;
    loadedModel = undefined;
    send(workerError(classifyLoadError(error), safeMessage(error, 'model load failed'), request.requestId));
  }
}

function transcribe(request: SttWorkerTranscribeRequest): void {
  if (!recognizer || !loadedModel) {
    send(workerError('model_missing', 'the batch model is not loaded', request.requestId));
    return;
  }
  if (request.audio.length === 0) {
    send(workerError('bad_audio', 'audio is empty', request.requestId));
    return;
  }
  if (request.audio.length > STT_MAX_SAMPLES) {
    send(workerError('too_long', 'audio exceeds the 120 second limit', request.requestId));
    return;
  }
  for (let index = 0; index < request.audio.length; index++) {
    if (!Number.isFinite(request.audio[index])) {
      send(workerError('bad_audio', 'audio samples must be finite', request.requestId));
      return;
    }
  }

  const started = performance.now();
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: STT_SAMPLE_RATE, samples: request.audio });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    send({
      type: 'result',
      requestId: request.requestId,
      modelId: loadedModel.id,
      text: typeof result.text === 'string' ? result.text : '',
      audioMs: (request.audio.length / STT_SAMPLE_RATE) * 1_000,
      decodeMs: Math.max(0, performance.now() - started),
    });
  } catch (error) {
    send(workerError('decode_failed', safeMessage(error, 'batch decode failed'), request.requestId));
  }
}

async function handle(message: unknown): Promise<void> {
  if (isRecord(message) && message.type === 'shutdown') {
    recognizer = undefined;
    loadedModel = undefined;
    send({ type: 'bye' });
    process.disconnect?.();
    setTimeout(() => process.exit(0), 0);
    return;
  }
  if (isLoadRequest(message)) {
    await load(message);
    return;
  }
  if (isTranscribeRequest(message)) {
    transcribe(message);
    return;
  }
  const requestId = isRecord(message) && typeof message.requestId === 'string' ? message.requestId : undefined;
  send(workerError('bad_request', 'invalid STT worker message', requestId));
}

if (typeof process.send !== 'function') {
  process.stderr.write('stt-worker must be launched by Bun with advanced IPC\n');
  process.exitCode = 2;
} else {
  process.on('message', (message: SttWorkerRequest | unknown) => {
    queue = queue
      .then(() => handle(message))
      .catch(error => {
        try {
          send(workerError('decode_failed', safeMessage(error, 'worker message failed')));
        } catch {
          process.exitCode = 1;
        }
      });
  });
}
