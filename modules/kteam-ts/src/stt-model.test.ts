import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BROWSER_STT_MODEL_ID,
  DAEMON_STT_MODEL_ID,
  DEFAULT_STT_MODELS,
  SttModelStore,
  type SttFetch,
  type SttModelDefinition,
  type SttRun,
} from './stt-model';
import type { SttPaths } from './stt-paths';
import { SttError } from './stt-types';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const response = (bytes: Uint8Array) => new Response(Uint8Array.from(bytes).buffer);

function fixtureDefinitions(): {
  definitions: readonly SttModelDefinition[];
  archive: Uint8Array;
  daemonFile: Uint8Array;
  browserFiles: Record<string, Uint8Array>;
} {
  const archive = encoder.encode('trusted tiny archive');
  const daemonFile = encoder.encode('daemon model');
  const browserFiles = {
    'encoder-model.int8.onnx': encoder.encode('browser encoder'),
    'decoder_joint-model.int8.onnx': encoder.encode('browser decoder'),
    'vocab.txt': encoder.encode('hello 0\n'),
  };
  const definitions = [
    {
      id: 'daemon-fixture',
      kind: 'daemon',
      label: 'daemon fixture',
      languages: ['en'],
      costs: {
        downloadBytes: archive.length,
        diskBytes: daemonFile.length,
        ramBytesApprox: 100,
        summary: 'fixture',
      },
      archive: {
        url: 'https://example.invalid/daemon.tar.bz2',
        bytes: archive.length,
        sha256: sha(archive),
        rootDirectory: 'archive-root',
      },
      files: [
        {
          name: 'encoder.int8.onnx',
          bytes: daemonFile.length,
          sha256: sha(daemonFile),
          mime: 'application/octet-stream',
          public: false,
        },
      ],
    },
    {
      id: 'browser-fixture',
      kind: 'browser',
      label: 'browser fixture',
      languages: ['en'],
      costs: {
        downloadBytes: Object.values(browserFiles).reduce((total, bytes) => total + bytes.length, 0),
        diskBytes: Object.values(browserFiles).reduce((total, bytes) => total + bytes.length, 0),
        ramBytesApprox: 100,
        summary: 'fixture',
      },
      files: Object.entries(browserFiles).map(([name, bytes]) => ({
        name,
        bytes: bytes.length,
        sha256: sha(bytes),
        url: `https://example.invalid/${name}`,
        mime: name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        public: true,
      })),
    },
  ] as const satisfies readonly SttModelDefinition[];
  return { definitions, archive, daemonFile, browserFiles };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof SttError ? error.code : undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('STT model store', () => {
  let root: string;
  let paths: SttPaths;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kteam-stt-model-'));
    paths = {
      models: path.join(root, 'models'),
      dir: path.join(root, 'daemon', 'stt'),
      state: path.join(root, 'daemon', 'stt', 'state.json'),
      workerLog: path.join(root, 'daemon', 'stt', 'worker.log'),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('pins exact production archive and browser LFS metadata', () => {
    const daemon = DEFAULT_STT_MODELS.find(model => model.id === DAEMON_STT_MODEL_ID)!;
    const browser = DEFAULT_STT_MODELS.find(model => model.id === BROWSER_STT_MODEL_ID)!;
    expect(daemon.archive).toMatchObject({
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
      bytes: 482_468_385,
      sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    });
    expect(daemon.costs).toMatchObject({ downloadBytes: 482_468_385, diskBytes: 661_428_477 });
    expect(browser.costs.downloadBytes).toBe(670_488_135);
    const browserBase =
      'https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx/resolve/f88260fa0777fe0868dda6df85d1a98f012a4a7a';
    expect(browser.files.map(file => file.url)).toEqual([
      `${browserBase}/encoder-model.int8.onnx`,
      `${browserBase}/decoder_joint-model.int8.onnx`,
      `${browserBase}/vocab.txt`,
    ]);
    expect(browser.files.map(file => [file.name, file.bytes, file.sha256])).toEqual([
      ['encoder-model.int8.onnx', 652_183_999, '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09'],
      ['decoder_joint-model.int8.onnx', 18_202_004, 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70'],
      ['vocab.txt', 102_132, 'ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742'],
    ]);
    expect(browser.files.reduce((total, file) => total + file.bytes, 0)).toBe(browser.costs.downloadBytes);
  });

  test('empty inventory is cold and performs no implicit network or commands', async () => {
    const { definitions } = fixtureDefinitions();
    let fetches = 0;
    let commands = 0;
    const store = new SttModelStore({
      paths,
      definitions,
      fetch: async () => {
        fetches++;
        throw new Error('network must not run');
      },
      run: async () => {
        commands++;
        throw new Error('command must not run');
      },
    });
    const inventory = await store.inventory();
    expect(inventory.daemon.state).toBe('not-installed');
    expect(inventory.browser.state).toBe('not-installed');
    expect(fetches).toBe(0);
    expect(commands).toBe(0);
  });

  test('downloads, verifies, and atomically publishes the browser trio', async () => {
    const { definitions, browserFiles } = fixtureDefinitions();
    const seen: string[] = [];
    const fetcher: SttFetch = async input => {
      seen.push(input);
      const name = input.slice(input.lastIndexOf('/') + 1);
      const bytes = browserFiles[name];
      if (!bytes) return new Response('missing', { status: 404 });
      return response(bytes);
    };
    const store = new SttModelStore({ paths, definitions, fetch: fetcher, randomId: () => 'fixed' });
    const installed = await store.install('browser-fixture');
    expect(installed.state).toBe('ready');
    expect(installed.install.phase).toBe('ready');
    expect(seen).toHaveLength(3);
    expect(await store.verify('browser-fixture')).toBeDefined();
    expect(await readdir(paths.models)).toEqual(['browser-fixture']);
    expect(await readFile(path.join(paths.models, 'browser-fixture', 'vocab.txt'), 'utf8')).toBe('hello 0\n');
  });

  test('verifies the archive, extracts to a sibling temp directory, then publishes', async () => {
    const { definitions, archive, daemonFile } = fixtureDefinitions();
    const commands: string[][] = [];
    const runner: SttRun = async argv => {
      commands.push(argv);
      const output = argv[argv.indexOf('-C') + 1]!;
      const extracted = path.join(output, 'archive-root');
      await mkdir(extracted, { recursive: true });
      await writeFile(path.join(extracted, 'encoder.int8.onnx'), daemonFile);
      return { code: 0, stdout: '', stderr: '' };
    };
    const store = new SttModelStore({
      paths,
      definitions,
      fetch: async () => response(archive),
      run: runner,
      randomId: () => 'fixed',
    });
    expect((await store.install('daemon-fixture')).state).toBe('ready');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('tar');
    expect(await store.resolveDaemonModel()).toMatchObject({
      id: 'daemon-fixture',
      directory: path.join(paths.models, 'daemon-fixture'),
    });
  });

  test('a half-install, malformed manifest, or wrong-sized file never looks ready', async () => {
    const { definitions, browserFiles } = fixtureDefinitions();
    const directory = path.join(paths.models, 'browser-fixture');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'encoder-model.int8.onnx'), browserFiles['encoder-model.int8.onnx']);
    const store = new SttModelStore({ paths, definitions });
    expect(await store.inspect('browser-fixture')).toBeUndefined();

    await writeFile(path.join(directory, '.stt-model.json'), '{broken');
    expect(await store.inspect('browser-fixture')).toBeUndefined();
    for (const validButMalformed of ['null', '42', '"primitive"', '[]']) {
      await writeFile(path.join(directory, '.stt-model.json'), validButMalformed);
      expect(await store.inspect('browser-fixture')).toBeUndefined();
    }

    await rm(directory, { recursive: true });
    const installed = new SttModelStore({
      paths,
      definitions,
      fetch: async input => {
        const name = input.slice(input.lastIndexOf('/') + 1);
        return response(browserFiles[name]);
      },
    });
    await installed.install('browser-fixture');
    await writeFile(path.join(directory, 'vocab.txt'), 'wrong size');
    expect(await installed.inspect('browser-fixture')).toBeUndefined();
    expect((await installed.modelStatus('browser-fixture')).state).toBe('not-installed');
  });

  test('same-size corruption is neither ready nor public under the pinned digest', async () => {
    const { definitions, browserFiles } = fixtureDefinitions();
    const store = new SttModelStore({
      paths,
      definitions,
      fetch: async input => {
        const name = input.slice(input.lastIndexOf('/') + 1);
        return response(browserFiles[name]);
      },
    });
    await store.install('browser-fixture');
    const vocab = path.join(paths.models, 'browser-fixture', 'vocab.txt');
    const corrupted = Uint8Array.from(browserFiles['vocab.txt']);
    corrupted[0] = corrupted[0]! ^ 0xff;
    await writeFile(vocab, corrupted);
    expect(await store.inspect('browser-fixture')).toBeUndefined();
    expect((await store.modelStatus('browser-fixture')).state).not.toBe('ready');
    expect(await store.resolvePublicFile('browser-fixture', 'vocab.txt')).toBeUndefined();
  });

  test('checksum and extraction failures leave no final or temporary ready directory', async () => {
    const { definitions, archive } = fixtureDefinitions();
    const badChecksum = new SttModelStore({
      paths,
      definitions,
      fetch: async () => response(encoder.encode('same length maybe!')),
      randomId: () => 'checksum',
    });
    expect(errorCode(await badChecksum.install('daemon-fixture').catch(error => error))).toBe('install_failed');
    expect((await badChecksum.modelStatus('daemon-fixture')).state).toBe('error');

    const failedExtract = new SttModelStore({
      paths,
      definitions,
      fetch: async () => response(archive),
      run: async () => ({ code: 2, stdout: '', stderr: 'broken archive' }),
      randomId: () => 'extract',
    });
    expect(errorCode(await failedExtract.install('daemon-fixture').catch(error => error))).toBe('install_failed');
    const entries = await readdir(paths.models);
    expect(entries.some(name => name.includes('.install-'))).toBe(false);
    expect(entries.includes('daemon-fixture')).toBe(false);
  });

  test('setup filesystem failures become a terminal install_failed status', async () => {
    const { definitions } = fixtureDefinitions();
    await mkdir(path.dirname(paths.dir), { recursive: true });
    await writeFile(paths.dir, 'not a directory');
    let fetches = 0;
    const store = new SttModelStore({
      paths,
      definitions,
      fetch: async () => {
        fetches++;
        throw new Error('network must not run');
      },
      now: (() => {
        let tick = 0;
        return () => `2026-07-27T00:00:0${tick++}.000Z`;
      })(),
    });
    expect(errorCode(await store.install('browser-fixture').catch(error => error))).toBe('install_failed');
    const status = await store.modelStatus('browser-fixture');
    expect(status.state).toBe('error');
    expect(status.install).toMatchObject({ phase: 'failed', code: 'install_failed' });
    expect(status.install.finishedAt).toBeDefined();
    expect(fetches).toBe(0);
  });

  test('concurrent explicit installs share one operation and report installing', async () => {
    const { definitions, browserFiles } = fixtureDefinitions();
    const gate = deferred<Response>();
    let fetches = 0;
    const store = new SttModelStore({
      paths,
      definitions,
      fetch: async input => {
        fetches++;
        if (fetches === 1) return await gate.promise;
        const name = input.slice(input.lastIndexOf('/') + 1);
        return response(browserFiles[name]);
      },
    });
    const firstPromise = store.startInstall('browser-fixture');
    const secondPromise = store.startInstall('browser-fixture');
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.status.state).toBe('installing');
    gate.resolve(response(browserFiles['encoder-model.int8.onnx']));
    expect((await store.install('browser-fixture')).state).toBe('ready');
    expect(fetches).toBe(3);
  });

  test('serves only a validated regular public file and rejects a symlink escape', async () => {
    const { definitions, browserFiles } = fixtureDefinitions();
    const store = new SttModelStore({
      paths,
      definitions,
      fetch: async input => {
        const name = input.slice(input.lastIndexOf('/') + 1);
        return response(browserFiles[name]);
      },
    });
    await store.install('browser-fixture');
    expect(await store.resolvePublicFile('browser-fixture', 'vocab.txt')).toMatchObject({
      definition: { name: 'vocab.txt' },
    });
    expect(await store.resolvePublicFile('browser-fixture', '../vocab.txt')).toBeUndefined();
    expect(await store.resolvePublicFile('daemon-fixture', 'encoder.int8.onnx')).toBeUndefined();

    const publicPath = path.join(paths.models, 'browser-fixture', 'vocab.txt');
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, browserFiles['vocab.txt']);
    await rm(publicPath);
    await symlink(outside, publicPath);
    expect(await store.resolvePublicFile('browser-fixture', 'vocab.txt')).toBeUndefined();
  });

  test('rejects unknown model ids before any filesystem or network work', async () => {
    const { definitions } = fixtureDefinitions();
    const store = new SttModelStore({ paths, definitions });
    expect(errorCode(await store.install('../../escape').catch(error => error))).toBe('model_not_found');
  });
});
