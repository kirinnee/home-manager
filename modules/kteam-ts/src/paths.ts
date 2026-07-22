import os from 'os';
import path from 'path';

export interface KTeamPaths {
  home: string;
  daemon: string;
  daemonConfig: string;
  token: string;
  /** Second, capability-scoped bearer token the warden pane runs under. The
   *  api-server accepts it only for a read + safe-recovery allowlist (see
   *  api-server.ts), so a warden can never stop/remove/start or drive its own
   *  oversight routes even though it shares the box with the admin token. */
  wardenToken: string;
  database: string;
  pid: string;
  daemonLog: string;
  sessions: string;
  trash: string;
  kfleetBin: string;
  wardenDir: string;
  wardenAnomalies: string;
  wardenState: string;
  wardenReports: string;
}

export function createPaths(home = process.env.KTEAM_HOME ?? path.join(os.homedir(), '.kteam')): KTeamPaths {
  return {
    home,
    daemon: path.join(home, 'daemon'),
    daemonConfig: path.join(home, 'daemon', 'config.json'),
    token: path.join(home, 'daemon', 'token'),
    wardenToken: path.join(home, 'daemon', 'warden.token'),
    database: path.join(home, 'daemon', 'kteam.sqlite'),
    pid: path.join(home, 'daemon', 'kteamd.pid'),
    daemonLog: path.join(home, 'daemon', 'daemon.log'),
    sessions: home,
    trash: path.join(home, 'trash'),
    kfleetBin: path.join(os.homedir(), '.kfleet', 'bin'),
    wardenDir: path.join(home, 'daemon', 'warden'),
    wardenAnomalies: path.join(home, 'daemon', 'warden', 'anomalies.json'),
    wardenState: path.join(home, 'daemon', 'warden', 'state.json'),
    wardenReports: path.join(home, 'daemon', 'warden', 'reports'),
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
