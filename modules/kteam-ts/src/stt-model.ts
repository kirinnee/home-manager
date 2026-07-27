import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run as runCommand } from './io';
import { sttModelDirectory, type SttPaths } from './stt-paths';
import {
  SttError,
  type SttInstallStatus,
  type SttModelKind,
  type SttModelStatus,
  type SttWorkerModel,
} from './stt-types';

export const DAEMON_STT_MODEL_ID = 'parakeet-tdt-0.6b-v2-int8';
export const BROWSER_STT_MODEL_ID = 'parakeet-browser-v3';
export const STT_MODEL_MANIFEST = '.stt-model.json';

export interface SttModelFileDefinition {
  name: string;
  bytes: number;
  sha256: string;
  url?: string;
  mime: string;
  public: boolean;
}

export interface SttModelDefinition {
  id: string;
  kind: SttModelKind;
  label: string;
  languages: readonly string[];
  costs: SttModelStatus['costs'];
  files: readonly SttModelFileDefinition[];
  archive?: {
    url: string;
    bytes: number;
    sha256: string;
    rootDirectory: string;
  };
}

const DAEMON_FILES = [
  {
    name: 'encoder.int8.onnx',
    bytes: 652_184_296,
    sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab',
    mime: 'application/octet-stream',
    public: false,
  },
  {
    name: 'decoder.int8.onnx',
    bytes: 7_257_753,
    sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e',
    mime: 'application/octet-stream',
    public: false,
  },
  {
    name: 'joiner.int8.onnx',
    bytes: 1_739_080,
    sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2',
    mime: 'application/octet-stream',
    public: false,
  },
  {
    name: 'tokens.txt',
    bytes: 9_384,
    sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d',
    mime: 'text/plain; charset=utf-8',
    public: false,
  },
  {
    name: 'test_wavs/0.wav',
    bytes: 237_964,
    sha256: '5fceacff0315d49cb59fcc505bcecf1ed5f2f35c2897b1e65a59f30e5d922150',
    mime: 'audio/wav',
    public: false,
  },
] as const satisfies readonly SttModelFileDefinition[];

const BROWSER_REVISION = 'f88260fa0777fe0868dda6df85d1a98f012a4a7a';
const BROWSER_BASE = `https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx/resolve/${BROWSER_REVISION}`;

const BROWSER_FILES = [
  {
    name: 'encoder-model.int8.onnx',
    bytes: 652_183_999,
    sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09',
    url: `${BROWSER_BASE}/encoder-model.int8.onnx`,
    mime: 'application/octet-stream',
    public: true,
  },
  {
    name: 'decoder_joint-model.int8.onnx',
    bytes: 18_202_004,
    sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70',
    url: `${BROWSER_BASE}/decoder_joint-model.int8.onnx`,
    mime: 'application/octet-stream',
    public: true,
  },
  {
    name: 'vocab.txt',
    bytes: 102_132,
    sha256: 'ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742',
    url: `${BROWSER_BASE}/vocab.txt`,
    mime: 'text/plain; charset=utf-8',
    public: true,
  },
] as const satisfies readonly SttModelFileDefinition[];

/**
 * Pinned, measured production manifests. Downloads never start merely because
 * this module or status() is used; SttModelStore.startInstall() is the only
 * entry point that performs network I/O.
 */
export const DEFAULT_STT_MODELS = [
  {
    id: DAEMON_STT_MODEL_ID,
    kind: 'daemon',
    label: 'Parakeet TDT 0.6B v2 int8 (English, daemon batch)',
    languages: ['en'],
    costs: {
      downloadBytes: 482_468_385,
      diskBytes: 661_428_477,
      ramBytesApprox: 1_073_741_824,
      summary: '460 MB download, 631 MB extracted, about 1 GB RAM while the batch worker is loaded.',
    },
    archive: {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
      bytes: 482_468_385,
      sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
      rootDirectory: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    },
    files: DAEMON_FILES,
  },
  {
    id: BROWSER_STT_MODEL_ID,
    kind: 'browser',
    label: 'Parakeet TDT 0.6B v3 int8 (browser batch)',
    languages: ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'ko', 'zh'],
    costs: {
      downloadBytes: 670_488_135,
      diskBytes: 670_488_135,
      ramBytesApprox: 1_073_741_824,
      summary: '640 MB download per browser model; about 1 GB+ RAM, with WebGPU expansion potentially near 2.4 GB.',
    },
    files: BROWSER_FILES,
  },
] as const satisfies readonly SttModelDefinition[];

interface InstalledModelManifest {
  schema: 1;
  modelId: string;
  kind: SttModelKind;
  installedAt: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

export interface InstalledSttModel {
  definition: SttModelDefinition;
  directory: string;
  installedAt: string;
}

export interface PublicSttModelFile {
  path: string;
  definition: SttModelFileDefinition;
}

export interface SttRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SttRun = (
  argv: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<SttRunResult>;
export type SttFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SttModelStoreOptions {
  paths: SttPaths;
  definitions?: readonly SttModelDefinition[];
  fetch?: SttFetch;
  run?: SttRun;
  now?: () => string;
  randomId?: () => string;
}

function boundedMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : String(value || fallback);
  return message.slice(0, 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fileSignature(info: {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

function installIdle(definition: SttModelDefinition): SttInstallStatus {
  return {
    modelId: definition.id,
    phase: 'idle',
    receivedBytes: 0,
    totalBytes: definition.costs.downloadBytes,
  };
}

function sameInstalledFiles(manifest: InstalledModelManifest, definition: SttModelDefinition): boolean {
  if (manifest.files.length !== definition.files.length) return false;
  return definition.files.every((file, index) => {
    const installed = manifest.files[index];
    return installed?.name === file.name && installed.bytes === file.bytes && installed.sha256 === file.sha256;
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('download write made no progress');
    offset += bytesWritten;
  }
}

export class SttModelStore {
  private readonly definitions: readonly SttModelDefinition[];
  private readonly byId: Map<string, SttModelDefinition>;
  private readonly fetcher: SttFetch;
  private readonly runner: SttRun;
  private readonly now: () => string;
  private readonly randomId: () => string;
  private readonly installs = new Map<string, SttInstallStatus>();
  private readonly active = new Map<string, Promise<SttModelStatus>>();
  /** Covers the asynchronous inspect-before-start window for one model id. */
  private readonly starting = new Map<string, Promise<{ started: boolean; status: SttModelStatus }>>();
  /** Hashes are reused only while the regular file's identity and timestamps match. */
  private readonly verifiedFiles = new Map<string, { signature: string; sha256: string }>();
  private readonly verifyingFiles = new Map<string, Promise<boolean>>();

  constructor(private readonly options: SttModelStoreOptions) {
    this.definitions = options.definitions ?? DEFAULT_STT_MODELS;
    this.byId = new Map(this.definitions.map(definition => [definition.id, definition]));
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.runner = options.run ?? ((argv, runOptions) => runCommand(argv, runOptions));
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    if (this.byId.size !== this.definitions.length) throw new Error('STT model ids must be unique');
    if (this.definitions.filter(definition => definition.kind === 'daemon').length !== 1) {
      throw new Error('exactly one daemon STT model is required');
    }
    if (this.definitions.filter(definition => definition.kind === 'browser').length !== 1) {
      throw new Error('exactly one browser STT model is required');
    }
  }

  definition(modelId: string): SttModelDefinition {
    const definition = this.byId.get(modelId);
    if (!definition) throw new SttError('model_not_found', `unknown STT model: ${modelId}`, 400);
    return definition;
  }

  definitionFor(kind: SttModelKind): SttModelDefinition {
    return this.definitions.find(definition => definition.kind === kind)!;
  }

  installStatus(modelId: string): SttInstallStatus {
    const definition = this.definition(modelId);
    return { ...(this.installs.get(modelId) ?? installIdle(definition)) };
  }

  async inspect(modelId: string): Promise<InstalledSttModel | undefined> {
    const definition = this.definition(modelId);
    const directory = sttModelDirectory(this.options.paths, definition.id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, STT_MODEL_MANIFEST), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (!isRecord(parsed)) return undefined;
    const manifest = parsed as unknown as InstalledModelManifest;
    if (
      manifest.schema !== 1 ||
      manifest.modelId !== definition.id ||
      manifest.kind !== definition.kind ||
      typeof manifest.installedAt !== 'string' ||
      !Number.isFinite(Date.parse(manifest.installedAt)) ||
      !Array.isArray(manifest.files) ||
      !sameInstalledFiles(manifest, definition)
    ) {
      return undefined;
    }
    for (const file of definition.files) {
      if (!(await this.fileMatches(path.join(directory, file.name), file))) return undefined;
    }
    return { definition, directory, installedAt: manifest.installedAt };
  }

  async verify(modelId: string): Promise<InstalledSttModel | undefined> {
    return await this.inspect(modelId);
  }

  async modelStatus(modelId: string): Promise<SttModelStatus> {
    const definition = this.definition(modelId);
    const install = this.installStatus(modelId);
    const installed = await this.inspect(modelId);
    const state = installed
      ? 'ready'
      : this.active.has(modelId)
        ? 'installing'
        : install.phase === 'failed'
          ? 'error'
          : 'not-installed';
    return {
      id: definition.id,
      kind: definition.kind,
      label: definition.label,
      state,
      languages: [...definition.languages],
      costs: { ...definition.costs },
      installedAt: installed?.installedAt,
      files: installed
        ? definition.files.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 }))
        : undefined,
      install: installed
        ? {
            modelId,
            phase: 'ready',
            receivedBytes: definition.costs.downloadBytes,
            totalBytes: definition.costs.downloadBytes,
            finishedAt: installed.installedAt,
          }
        : install,
    };
  }

  async inventory(): Promise<{ daemon: SttModelStatus; browser: SttModelStatus }> {
    const daemon = this.definitionFor('daemon');
    const browser = this.definitionFor('browser');
    const [daemonStatus, browserStatus] = await Promise.all([
      this.modelStatus(daemon.id),
      this.modelStatus(browser.id),
    ]);
    return { daemon: daemonStatus, browser: browserStatus };
  }

  async startInstall(modelId: string): Promise<{ started: boolean; status: SttModelStatus }> {
    const definition = this.definition(modelId);
    const starting = this.starting.get(modelId);
    if (starting) {
      await starting;
      return { started: false, status: await this.modelStatus(modelId) };
    }
    const operation = this.beginInstall(definition);
    this.starting.set(modelId, operation);
    try {
      return await operation;
    } finally {
      if (this.starting.get(modelId) === operation) this.starting.delete(modelId);
    }
  }

  private async beginInstall(definition: SttModelDefinition): Promise<{ started: boolean; status: SttModelStatus }> {
    const modelId = definition.id;
    if (this.active.has(modelId)) return { started: false, status: await this.modelStatus(modelId) };
    const installed = await this.inspect(modelId);
    if (installed) return { started: false, status: await this.modelStatus(modelId) };

    const promise = this.performInstall(definition);
    this.active.set(modelId, promise);
    void promise.then(
      () => {
        if (this.active.get(modelId) === promise) this.active.delete(modelId);
      },
      () => {
        if (this.active.get(modelId) === promise) this.active.delete(modelId);
      },
    );
    return { started: true, status: await this.modelStatus(modelId) };
  }

  async install(modelId: string): Promise<SttModelStatus> {
    await this.startInstall(modelId);
    const promise = this.active.get(modelId);
    return promise ? await promise : await this.modelStatus(modelId);
  }

  async resolveDaemonModel(): Promise<SttWorkerModel | undefined> {
    const definition = this.definitionFor('daemon');
    const installed = await this.inspect(definition.id);
    if (!installed) return undefined;
    return {
      id: definition.id,
      directory: installed.directory,
      encoder: path.join(installed.directory, 'encoder.int8.onnx'),
      decoder: path.join(installed.directory, 'decoder.int8.onnx'),
      joiner: path.join(installed.directory, 'joiner.int8.onnx'),
      tokens: path.join(installed.directory, 'tokens.txt'),
    };
  }

  async resolvePublicFile(modelId: string, fileName: string): Promise<PublicSttModelFile | undefined> {
    const definition = this.byId.get(modelId);
    if (!definition || definition.kind !== 'browser') return undefined;
    const file = definition.files.find(candidate => candidate.public && candidate.name === fileName);
    if (!file) return undefined;
    const installed = await this.inspect(modelId);
    if (!installed) return undefined;
    const candidate = path.join(installed.directory, file.name);
    const info = await lstat(candidate).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== file.bytes) return undefined;
    const [root, resolved] = await Promise.all([realpath(installed.directory), realpath(candidate)]);
    if (!resolved.startsWith(`${root}${path.sep}`)) return undefined;
    return { path: resolved, definition: file };
  }

  private updateInstall(modelId: string, update: Partial<SttInstallStatus>): void {
    const definition = this.definition(modelId);
    this.installs.set(modelId, {
      ...(this.installs.get(modelId) ?? installIdle(definition)),
      ...update,
      modelId,
      totalBytes: definition.costs.downloadBytes,
    });
  }

  private async performInstall(definition: SttModelDefinition): Promise<SttModelStatus> {
    const startedAt = this.now();
    this.updateInstall(definition.id, {
      phase: 'downloading',
      receivedBytes: 0,
      startedAt,
      finishedAt: undefined,
      message: undefined,
      code: undefined,
    });
    const temporary = path.join(this.options.paths.models, `.${definition.id}.install-${this.randomId()}`);
    const unpack = path.join(temporary, 'unpack');
    const staged = path.join(temporary, 'ready');
    try {
      await mkdir(this.options.paths.models, { recursive: true, mode: 0o700 });
      await mkdir(this.options.paths.dir, { recursive: true, mode: 0o700 });
      await mkdir(temporary, { recursive: false, mode: 0o700 });
      if (definition.archive) {
        const archive = path.join(temporary, 'model.tar.bz2');
        await this.download(definition, definition.archive, archive, 0);
        this.updateInstall(definition.id, { phase: 'extracting' });
        await mkdir(unpack, { mode: 0o700 });
        const result = await this.runner([
          'tar',
          '-xjf',
          archive,
          '-C',
          unpack,
          '--no-same-owner',
          '--no-same-permissions',
        ]);
        if (result.code !== 0) {
          throw new SttError('install_failed', `model extraction failed: ${result.stderr.slice(0, 500)}`, 503);
        }
        const extracted = path.join(unpack, definition.archive.rootDirectory);
        if (!(await exists(extracted)))
          throw new SttError('install_failed', 'model archive has an unexpected layout', 503);
        await rename(extracted, staged);
      } else {
        await mkdir(staged, { mode: 0o700 });
        let received = 0;
        for (const file of definition.files) {
          if (!file.url) throw new SttError('install_failed', `no source URL for ${file.name}`, 503);
          const target = path.join(staged, file.name);
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await this.download(definition, { url: file.url, bytes: file.bytes, sha256: file.sha256 }, target, received);
          received += file.bytes;
        }
      }

      this.updateInstall(definition.id, { phase: 'verifying' });
      for (const file of definition.files) {
        const candidate = path.join(staged, file.name);
        const info = await lstat(candidate).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
          throw new SttError(
            'install_failed',
            `installed model file is missing or has the wrong size: ${file.name}`,
            503,
          );
        }
        if ((await sha256File(candidate)) !== file.sha256) {
          throw new SttError('install_failed', `installed model checksum mismatch: ${file.name}`, 503);
        }
      }

      const installedAt = this.now();
      const manifest: InstalledModelManifest = {
        schema: 1,
        modelId: definition.id,
        kind: definition.kind,
        installedAt,
        files: definition.files.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
      };
      await writeFile(path.join(staged, STT_MODEL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });

      const destination = sttModelDirectory(this.options.paths, definition.id);
      let quarantine: string | undefined;
      if (await exists(destination)) {
        quarantine = path.join(this.options.paths.models, `.${definition.id}.replaced-${this.randomId()}`);
        await rename(destination, quarantine);
      }
      try {
        await rename(staged, destination);
      } catch (error) {
        if (quarantine) await rename(quarantine, destination).catch(() => undefined);
        throw error;
      }
      if (quarantine) await rm(quarantine, { recursive: true, force: true });
      this.updateInstall(definition.id, {
        phase: 'ready',
        receivedBytes: definition.costs.downloadBytes,
        finishedAt: installedAt,
      });
      return await this.modelStatus(definition.id);
    } catch (error) {
      const failure =
        error instanceof SttError
          ? error
          : new SttError('install_failed', boundedMessage(error, 'model installation failed'), 503, { cause: error });
      this.updateInstall(definition.id, {
        phase: 'failed',
        finishedAt: this.now(),
        message: failure.message,
        code: failure.code,
      });
      throw failure;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async fileMatches(filePath: string, definition: SttModelFileDefinition): Promise<boolean> {
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== definition.bytes) return false;
    const signature = fileSignature(before);
    const cached = this.verifiedFiles.get(filePath);
    if (cached?.signature === signature && cached.sha256 === definition.sha256) return true;

    const verificationKey = `${filePath}\0${signature}\0${definition.sha256}`;
    const existing = this.verifyingFiles.get(verificationKey);
    if (existing) return await existing;
    const verification = (async () => {
      const digest = await sha256File(filePath);
      let after: Awaited<ReturnType<typeof lstat>>;
      try {
        after = await lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.size !== definition.bytes ||
        fileSignature(after) !== signature ||
        digest !== definition.sha256
      ) {
        this.verifiedFiles.delete(filePath);
        return false;
      }
      this.verifiedFiles.set(filePath, { signature, sha256: definition.sha256 });
      return true;
    })();
    this.verifyingFiles.set(verificationKey, verification);
    try {
      return await verification;
    } finally {
      if (this.verifyingFiles.get(verificationKey) === verification) this.verifyingFiles.delete(verificationKey);
    }
  }

  private async download(
    definition: SttModelDefinition,
    artifact: { url: string; bytes: number; sha256: string },
    target: string,
    receivedBefore: number,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(artifact.url, { redirect: 'follow' });
    } catch (error) {
      throw new SttError('install_failed', `model download failed: ${boundedMessage(error, 'network error')}`, 503, {
        cause: error,
      });
    }
    if (!response.ok || !response.body) {
      throw new SttError('install_failed', `model download failed with HTTP ${response.status}`, 503);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== artifact.bytes)) {
      await response.body.cancel().catch(() => undefined);
      throw new SttError('install_failed', 'model download size does not match the pinned manifest', 503);
    }

    const handle = await open(target, 'wx', 0o600);
    const digest = createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > artifact.bytes) {
          await reader.cancel().catch(() => undefined);
          throw new SttError('install_failed', 'model download exceeded its pinned size', 503);
        }
        digest.update(value);
        await writeAll(handle, value);
        this.updateInstall(definition.id, { receivedBytes: receivedBefore + received });
      }
    } finally {
      await handle.close();
    }
    if (received !== artifact.bytes) throw new SttError('install_failed', 'model download was incomplete', 503);
    if (digest.digest('hex') !== artifact.sha256) {
      throw new SttError('install_failed', 'model download checksum mismatch', 503);
    }
  }
}
