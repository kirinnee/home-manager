import os from 'os';
import path from 'path';

export interface KTeamPaths {
  home: string;
  daemon: string;
  daemonConfig: string;
  token: string;
  database: string;
  pid: string;
  daemonLog: string;
  sessions: string;
  trash: string;
  kfleetBin: string;
}

export function createPaths(home = process.env.KTEAM_HOME ?? path.join(os.homedir(), '.kteam')): KTeamPaths {
  return {
    home,
    daemon: path.join(home, 'daemon'),
    daemonConfig: path.join(home, 'daemon', 'config.json'),
    token: path.join(home, 'daemon', 'token'),
    database: path.join(home, 'daemon', 'kteam.sqlite'),
    pid: path.join(home, 'daemon', 'kteamd.pid'),
    daemonLog: path.join(home, 'daemon', 'daemon.log'),
    sessions: home,
    trash: path.join(home, 'trash'),
    kfleetBin: path.join(os.homedir(), '.kfleet', 'bin'),
  };
}

export const sessionDir = (paths: KTeamPaths, id: string) => path.join(paths.sessions, id);
export const configFile = (paths: KTeamPaths, id: string) => path.join(sessionDir(paths, id), 'config.json');
export const stateFile = (paths: KTeamPaths, id: string) => path.join(sessionDir(paths, id), 'state.json');
export const markerFile = (paths: KTeamPaths, id: string, name: string) =>
  path.join(sessionDir(paths, id), 'markers', `${name}.json`);
export const turnLog = (paths: KTeamPaths, id: string, turn: number) =>
  path.join(sessionDir(paths, id), 'logs', `turn-${String(turn).padStart(3, '0')}.txt`);
export const turnPrompt = (paths: KTeamPaths, id: string, turn: number) =>
  path.join(sessionDir(paths, id), 'turns', `turn-${String(turn).padStart(3, '0')}.md`);
