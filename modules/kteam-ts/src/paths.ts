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
  /** Learning subsystem (mines terminal sessions into proposed fleet rules).
   *  Sibling of `daemon/warden/`, same 0700, "files authoritative" philosophy. */
  learningDir: string;
  learningState: string;
  learningObservations: string;
  learningProposals: string;
  learningTombstones: string;
  learningRuns: string;
  learningPatches: string;
  /** Fleet-global daemon-owned task records. */
  tasksDir: string;
  /** Stable central task boards. Session directories contain bindings only;
   * mutable shared task data lives below this daemon-owned root. */
  taskBoardsDir: string;
  /** Separate human-operator capability for board creation/ACL administration.
   * Never injected into teammate panes and never interchangeable with the
   * shared daemon bearer or a session board binding. */
  taskBoardAdminToken: string;
  /** State of the daemon-global human browser sign-in window: child pids, the
   *  loopback VNC port, and its timestamps — written 0600 so a crashed daemon
   *  can reconcile the orphans it left behind on the next boot.
   *
   *  NEVER the VNC password. That credential is minted per window, handed to
   *  x11vnc through a self-deleting 0600 file, returned only to a human-admin
   *  caller, and is gone the moment the window closes. Anything durable is a
   *  credential that outlives the window it belonged to. */
  browserLogin: string;
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
    learningDir: path.join(home, 'daemon', 'learning'),
    learningState: path.join(home, 'daemon', 'learning', 'state.json'),
    learningObservations: path.join(home, 'daemon', 'learning', 'observations.jsonl'),
    learningProposals: path.join(home, 'daemon', 'learning', 'proposals.json'),
    learningTombstones: path.join(home, 'daemon', 'learning', 'tombstones.json'),
    learningRuns: path.join(home, 'daemon', 'learning', 'runs'),
    learningPatches: path.join(home, 'daemon', 'learning', 'patches'),
    tasksDir: path.join(home, 'daemon', 'tasks'),
    taskBoardsDir: path.join(home, 'daemon', 'task-boards', 'boards'),
    taskBoardAdminToken: path.join(home, 'daemon', 'task-boards', 'admin.token'),
    browserLogin: path.join(home, 'daemon', 'browser', 'login.json'),
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
export const taskBoardFile = (paths: KTeamPaths, boardId: string) =>
  path.join(paths.taskBoardsDir, boardId, 'board.json');
export const taskBoardBindingFile = (paths: KTeamPaths, sessionId: string) =>
  path.join(sessionDir(paths, sessionId), 'board-binding.json');
/** Pre-membership proof used only when an explicitly invited external root
 * accepts. It is daemon-issued per session/incarnation/runtime and is not a
 * board grant. */
export const taskBoardSessionCapabilityFile = (paths: KTeamPaths, sessionId: string) =>
  path.join(sessionDir(paths, sessionId), 'board-session-capability.json');
