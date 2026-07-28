import type { KTeamPaths } from './paths';
import { decodeSttAudio, SttAudioError } from './stt-audio';
import {
  ENHANCEMENT_LIMITS,
  EnhancementError,
  SttEnhancer,
  enhancementErrorView,
  type EnhanceRequest,
  type EnhanceResult,
  type EnhancementProvider,
} from './stt-enhancement';
import { SttModelStore, type PublicSttModelFile, type SttModelStoreOptions } from './stt-model';
import { deriveSttPaths, type SttPaths } from './stt-paths';
import {
  STT_BITS_PER_SAMPLE,
  STT_CHANNELS,
  STT_MAX_DURATION_SECONDS,
  STT_SAMPLE_RATE,
  SttError,
  type SttErrorCode,
  type SttModelKind,
  type SttModelStatus,
  type SttStatus,
  type SttTranscript,
  type SttWorkerModel,
} from './stt-types';
import {
  SttWorkerClient,
  createBoundedSttLogSink,
  type SttWorkerClientLike,
  type SttWorkerClientOptions,
} from './stt-worker-client';
import { KTEAM_VERSION } from './version';

const WAV_CONTAINER_OVERHEAD_LIMIT = 64 * 1_024;
export const STT_ENHANCEMENT_BODY_LIMIT_BYTES = 64 * 1_024;

export interface SttEnhancerLike {
  enhance(request: EnhanceRequest): Promise<EnhanceResult>;
}

export interface SttModelManager {
  inventory(): Promise<{ daemon: SttModelStatus; browser: SttModelStatus }>;
  modelStatus(modelId: string): Promise<SttModelStatus>;
  startInstall(modelId: string): Promise<{ started: boolean; status: SttModelStatus }>;
  resolveDaemonModel(): Promise<SttWorkerModel | undefined>;
  resolvePublicFile(modelId: string, fileName: string): Promise<PublicSttModelFile | undefined>;
  definitionFor(kind: SttModelKind): { id: string };
}

export interface SttService {
  /** Status is read-only: it never warms a worker or downloads a model. */
  status(): Promise<SttStatus>;
  /** Called only after api-server's existing bearer-token authentication. */
  handleApi(request: Request, url: URL): Promise<Response>;
  /** Public because these are public CC-BY-4.0 weights and parakeet.js adds no bearer header. */
  handlePublicModel(request: Request, url: URL): Promise<Response>;
  close(): Promise<void>;
}

export interface CreateSttServiceOptions {
  paths: KTeamPaths;
  sttPaths?: SttPaths;
  maxDurationSeconds?: number;
  models?: SttModelManager;
  worker?: SttWorkerClientLike;
  enhancer?: SttEnhancerLike;
  modelOptions?: Omit<SttModelStoreOptions, 'paths'>;
  workerOptions?: Omit<SttWorkerClientOptions, 'resolveModel' | 'stderrLog'>;
}

const json = (value: unknown, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'no-store');
  responseHeaders.set('x-kteam-version', KTEAM_VERSION);
  return Response.json(value, { status, headers: responseHeaders });
};

const unknownRoute = (method: string, path: string) => ({
  error: `no route ${method} ${path}`,
  code: 'unknown_route',
  method,
  path,
});

function errorResponse(error: SttError, headers?: HeadersInit): Response {
  return json({ error: error.message, code: error.code }, error.status, headers);
}

function enhancementErrorResponse(error: EnhancementError): Response {
  return json(enhancementErrorView(error), error.status);
}

function routeError(code: SttErrorCode, message: string, status: number, headers?: HeadersInit): Response {
  return errorResponse(new SttError(code, message, status), headers);
}

function methodNotAllowed(allow: string): Response {
  return routeError('method_not_allowed', 'method not allowed', 405, { allow });
}

function boundedUnknownError(error: unknown): SttError {
  if (error instanceof SttError) return error;
  if (error instanceof SttAudioError) {
    return new SttError(error.code, error.message, error.code === 'too_long' ? 413 : 400, { cause: error });
  }
  return new SttError('worker_unavailable', 'speech-to-text request failed', 503, { cause: error });
}

function contentTypeKind(value: string | null): 'pcm' | 'wav' {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime === 'audio/l16' || mime === 'audio/pcm') return 'pcm';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  throw new SttError('bad_audio', 'content-type must be audio/wav or audio/L16; rate=16000; channels=1', 400);
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new SttError('bad_request', 'content-length is invalid', 400);
    if (Number(declared) > limit) throw new SttError('too_long', 'audio request exceeds the 120 second limit', 413);
  }
  if (!request.body) throw new SttError('bad_audio', 'audio body is empty', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new SttError('too_long', 'audio request exceeds the 120 second limit', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new SttError('bad_audio', 'audio body is empty', 400);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedEnhancementJson(request: Request): Promise<unknown> {
  const mime = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'application/json') {
    throw new EnhancementError('bad_request', 'content-type must be application/json');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new EnhancementError('bad_request', 'content-length is invalid');
    if (Number(declared) > STT_ENHANCEMENT_BODY_LIMIT_BYTES) {
      throw new EnhancementError('too_long', 'enhancement request exceeds the maximum size');
    }
  }
  if (!request.body) throw new EnhancementError('bad_request', 'enhancement request body is empty');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > STT_ENHANCEMENT_BODY_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EnhancementError('too_long', 'enhancement request exceeds the maximum size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new EnhancementError('bad_request', 'enhancement request body is empty');

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EnhancementError('bad_request', 'enhancement request is not valid UTF-8');
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new EnhancementError('bad_request', 'enhancement request is not valid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedEnhancementContext(contextValue: unknown, userContextValue: unknown): string | undefined {
  if (contextValue !== undefined && !Array.isArray(contextValue)) {
    throw new EnhancementError('bad_request', 'context must be an array of strings');
  }
  if (userContextValue !== undefined && typeof userContextValue !== 'string') {
    throw new EnhancementError('bad_request', 'user context must be a string');
  }

  const recent: string[] = [];
  if (Array.isArray(contextValue)) {
    for (const item of contextValue.slice(-10)) {
      if (typeof item !== 'string') {
        throw new EnhancementError('bad_request', 'context must be an array of strings');
      }
      const trimmed = item.trim();
      if (trimmed) recent.push(trimmed);
    }
  }

  const sections: string[] = [];
  const explicit = typeof userContextValue === 'string' ? userContextValue.trim() : '';
  if (explicit) sections.push(`Reader context:\n${explicit}`);
  if (recent.length > 0) sections.push(`Recent chat (oldest to newest):\n${recent.join('\n')}`);
  if (sections.length === 0) return undefined;
  return sections.join('\n\n').slice(0, ENHANCEMENT_LIMITS.maxContextChars);
}

function boundedEnhancementDictionary(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new EnhancementError('bad_request', 'dictionary must be an array of entries');
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  const append = (line: string): void => {
    if (lines.length >= ENHANCEMENT_LIMITS.maxDictionaryTerms) return;
    const key = line.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };

  for (const rawEntry of value) {
    if (lines.length >= ENHANCEMENT_LIMITS.maxDictionaryTerms) break;
    if (!isRecord(rawEntry) || typeof rawEntry['term'] !== 'string') {
      throw new EnhancementError('bad_request', 'dictionary entries must contain a term');
    }
    const term = rawEntry['term'].trim();
    if (!term) continue;
    if (term.length > ENHANCEMENT_LIMITS.maxDictionaryTermChars) {
      throw new EnhancementError('too_long', 'a dictionary term exceeds the maximum size');
    }
    append(term);

    const aliases = rawEntry['aliases'];
    if (aliases === undefined) continue;
    if (!Array.isArray(aliases)) {
      throw new EnhancementError('bad_request', 'dictionary aliases must be an array of strings');
    }
    for (const rawAlias of aliases) {
      if (typeof rawAlias !== 'string') {
        throw new EnhancementError('bad_request', 'dictionary aliases must be an array of strings');
      }
      const alias = rawAlias.trim();
      if (!alias) continue;
      if (alias.length > ENHANCEMENT_LIMITS.maxDictionaryTermChars) {
        throw new EnhancementError('too_long', 'a dictionary alias exceeds the maximum size');
      }
      const mapping = `${alias} -> ${term}`;
      if (mapping.length <= ENHANCEMENT_LIMITS.maxDictionaryTermChars) append(mapping);
    }
  }
  return lines.length > 0 ? lines : undefined;
}

function normalizeEnhancementPayload(value: unknown): EnhanceRequest {
  if (!isRecord(value)) throw new EnhancementError('bad_request', 'enhancement request must be an object');
  if (typeof value['text'] !== 'string') throw new EnhancementError('bad_request', 'transcript is required');
  if (value['text'].length > ENHANCEMENT_LIMITS.maxTranscriptChars) {
    throw new EnhancementError('too_long', 'transcript exceeds the maximum size');
  }
  if (typeof value['provider'] !== 'string') {
    throw new EnhancementError('bad_request', 'enhancement provider is required');
  }
  const model = value['model'];
  if (model !== undefined && typeof model !== 'string') {
    throw new EnhancementError('bad_model', 'model must be a string');
  }

  return {
    transcript: value['text'],
    provider: value['provider'] as EnhancementProvider,
    ...(model === undefined ? {} : { model }),
    context: boundedEnhancementContext(value['context'], value['userContext']),
    dictionary: boundedEnhancementDictionary(value['dictionary']),
  };
}

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(value: string | null, size: number): ByteRange | undefined | null {
  if (value === null) return undefined;
  if (value.includes(',')) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(size - 1, requestedEnd) };
}

function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  if (value === null) return false;
  const expected = etag.startsWith('W/') ? etag.slice(2) : etag;
  return value.split(',').some(candidate => {
    const tag = candidate.trim();
    if (tag === '*') return true;
    return (tag.startsWith('W/') ? tag.slice(2) : tag) === expected;
  });
}

function publicComponents(pathname: string): [string, string] | undefined {
  const prefix = '/stt-models/';
  if (!pathname.startsWith(prefix)) return undefined;
  const raw = pathname.slice(prefix.length).split('/');
  if (raw.length !== 2 || raw.some(component => component.length === 0)) return undefined;
  let decoded: string[];
  try {
    decoded = raw.map(component => decodeURIComponent(component));
  } catch {
    return undefined;
  }
  if (
    decoded.some(
      component =>
        component === '.' ||
        component === '..' ||
        component.includes('/') ||
        component.includes('\\') ||
        /[\0-\x1f\x7f]/.test(component),
    )
  ) {
    return undefined;
  }
  return [decoded[0]!, decoded[1]!];
}

class DefaultSttService implements SttService {
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly models: SttModelManager,
    private readonly worker: SttWorkerClientLike,
    private readonly enhancer: SttEnhancerLike,
    private readonly maxDurationSeconds: number,
  ) {}

  async status(): Promise<SttStatus> {
    const models = await this.models.inventory();
    const worker = this.worker.status();
    return {
      available:
        !this.closed && models.daemon.state === 'ready' && worker.phase !== 'closed' && worker.phase !== 'error',
      streaming: false,
      mode: 'batch',
      language: 'en',
      languages: ['en'],
      worker,
      models,
      limits: {
        sampleRate: STT_SAMPLE_RATE,
        channels: STT_CHANNELS,
        bitsPerSample: STT_BITS_PER_SAMPLE,
        maxDurationSeconds: this.maxDurationSeconds,
        maxPcmBytes: Math.floor(this.maxDurationSeconds * STT_SAMPLE_RATE * (STT_BITS_PER_SAMPLE / 8)),
      },
    };
  }

  async handleApi(request: Request, url: URL): Promise<Response> {
    try {
      if (url.pathname === '/v1/stt/status') {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return json(await this.status());
      }
      if (this.closed) throw new SttError('service_closed', 'speech-to-text service is closed', 503);
      if (url.pathname === '/v1/stt/enhance') {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return await this.enhance(request);
      }
      if (url.pathname === '/v1/stt/transcribe') {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return await this.transcribe(request, url);
      }
      if (url.pathname === '/v1/stt/models') {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return json({ models: await this.models.inventory() });
      }
      const installRoute = url.pathname.match(/^\/v1\/stt\/models\/([^/]+)\/install$/);
      if (installRoute) {
        let modelId: string;
        try {
          modelId = decodeURIComponent(installRoute[1]!);
        } catch {
          throw new SttError('bad_request', 'model id is malformed', 400);
        }
        if (request.method === 'GET') return json(await this.models.modelStatus(modelId));
        if (request.method !== 'POST') return methodNotAllowed('GET, POST');
        const result = await this.models.startInstall(modelId);
        if (!result.started && result.status.state === 'installing') {
          throw new SttError('model_installing', 'model installation is already in progress', 409);
        }
        return json(result.status, result.started ? 202 : 200);
      }
      return json(unknownRoute(request.method, url.pathname), 404);
    } catch (error) {
      if (error instanceof EnhancementError) return enhancementErrorResponse(error);
      return errorResponse(boundedUnknownError(error));
    }
  }

  async handlePublicModel(request: Request, url: URL): Promise<Response> {
    try {
      if (this.closed) throw new SttError('service_closed', 'speech-to-text service is closed', 503);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowed('GET, HEAD');
      }
      const components = publicComponents(url.pathname);
      if (!components) return routeError('not_found', 'model file not found', 404);
      const file = await this.models.resolvePublicFile(components[0], components[1]);
      if (!file || !file.definition.public) return routeError('not_found', 'model file not found', 404);

      const size = file.definition.bytes;
      const etag = `"sha256-${file.definition.sha256}"`;
      const baseHeaders = new Headers({
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': file.definition.mime,
        etag,
        'x-content-type-options': 'nosniff',
      });
      if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers: baseHeaders });
      }
      const range = parseRange(request.headers.get('range'), size);
      if (range === null) {
        baseHeaders.set('content-range', `bytes */${size}`);
        baseHeaders.set('content-length', '0');
        return new Response(null, { status: 416, headers: baseHeaders });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      const length = end - start + 1;
      baseHeaders.set('content-length', String(length));
      if (range) baseHeaders.set('content-range', `bytes ${start}-${end}/${size}`);
      const body = request.method === 'HEAD' ? null : Bun.file(file.path).slice(start, end + 1);
      return new Response(body, { status: range ? 206 : 200, headers: baseHeaders });
    } catch (error) {
      return errorResponse(boundedUnknownError(error));
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.worker.close();
    return this.closePromise;
  }

  private async transcribe(request: Request, url: URL): Promise<Response> {
    const language = url.searchParams.get('language') ?? 'en';
    if (language !== 'en')
      throw new SttError('unsupported_language', 'daemon transcription supports English only', 400);
    const models = await this.models.inventory();
    if (models.daemon.state !== 'ready') {
      const code = models.daemon.state === 'installing' ? 'model_installing' : 'model_missing';
      const status = code === 'model_installing' ? 409 : 503;
      throw new SttError(
        code,
        code === 'model_installing' ? 'daemon model is still installing' : 'daemon model is not installed',
        status,
      );
    }
    if (this.worker.status().phase === 'busy') throw new SttError('busy', 'the batch transcriber is busy', 409);

    const kind = contentTypeKind(request.headers.get('content-type'));
    const maxPcmBytes = Math.floor(this.maxDurationSeconds * STT_SAMPLE_RATE * (STT_BITS_PER_SAMPLE / 8));
    const bytes = await readBoundedBody(request, maxPcmBytes + (kind === 'wav' ? WAV_CONTAINER_OVERHEAD_LIMIT : 0));
    const audio = decodeSttAudio(bytes, request.headers.get('content-type')!, this.maxDurationSeconds);
    const result = await this.worker.transcribe(audio.samples);
    const transcript: SttTranscript = {
      text: result.text,
      audioMs: result.audioMs,
      decodeMs: result.decodeMs,
      rtf: result.audioMs > 0 ? result.decodeMs / result.audioMs : 0,
      modelId: result.modelId,
      language: 'en',
      mode: 'batch',
      streaming: false,
    };
    return json(transcript);
  }

  private async enhance(request: Request): Promise<Response> {
    const input = normalizeEnhancementPayload(await readBoundedEnhancementJson(request));
    const started = performance.now();
    const result = await this.enhancer.enhance(input);
    return json({ ...result, latencyMs: Math.max(0, performance.now() - started) });
  }
}

export function createSttService(options: CreateSttServiceOptions): SttService {
  const maxDurationSeconds = options.maxDurationSeconds ?? STT_MAX_DURATION_SECONDS;
  if (
    !Number.isFinite(maxDurationSeconds) ||
    maxDurationSeconds <= 0 ||
    maxDurationSeconds > STT_MAX_DURATION_SECONDS
  ) {
    throw new RangeError(`maxDurationSeconds must be in (0, ${STT_MAX_DURATION_SECONDS}]`);
  }
  const paths = options.sttPaths ?? deriveSttPaths(options.paths);
  const models =
    options.models ??
    new SttModelStore({
      paths,
      ...options.modelOptions,
    });
  const worker =
    options.worker ??
    new SttWorkerClient({
      resolveModel: () => models.resolveDaemonModel(),
      stderrLog: createBoundedSttLogSink(paths.workerLog),
      ...options.workerOptions,
    });
  const enhancer = options.enhancer ?? new SttEnhancer();
  return new DefaultSttService(models, worker, enhancer, maxDurationSeconds);
}
