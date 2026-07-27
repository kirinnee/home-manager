import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { KTeamPaths } from './paths';
import { deriveSttPaths, sttModelDirectory } from './stt-paths';

describe('STT paths', () => {
  test('derives only the isolated models and daemon/stt roots', () => {
    const base = {
      home: '/tmp/kteam-home',
      daemon: '/tmp/kteam-home/daemon',
    } as KTeamPaths;
    const paths = deriveSttPaths(base);
    expect(paths).toEqual({
      models: path.join(base.home, 'models'),
      dir: path.join(base.daemon, 'stt'),
      state: path.join(base.daemon, 'stt', 'state.json'),
      workerLog: path.join(base.daemon, 'stt', 'worker.log'),
    });
    expect(sttModelDirectory(paths, 'parakeet')).toBe(path.join(base.home, 'models', 'parakeet'));
  });
});
