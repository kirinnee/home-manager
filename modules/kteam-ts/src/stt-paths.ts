import path from 'node:path';
import type { KTeamPaths } from './paths';

/** Paths owned exclusively by the STT subsystem. */
export interface SttPaths {
  /** `~/.kteam/models` — shared weights, downloaded only by an explicit install. */
  models: string;
  /** `~/.kteam/daemon/stt` — small daemon state and diagnostics directory. */
  dir: string;
  /** `~/.kteam/daemon/stt/state.json` — cached native runtime discovery state. */
  state: string;
  workerLog: string;
}

export function deriveSttPaths(paths: KTeamPaths): SttPaths {
  const dir = path.join(paths.daemon, 'stt');
  return {
    models: path.join(paths.home, 'models'),
    dir,
    state: path.join(dir, 'state.json'),
    workerLog: path.join(dir, 'worker.log'),
  };
}

/** Short alias used by integration code. */
export const sttPaths = deriveSttPaths;

export function sttModelDirectory(paths: SttPaths, modelId: string): string {
  return path.join(paths.models, modelId);
}
