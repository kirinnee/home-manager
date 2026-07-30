import { readFile } from 'node:fs/promises';
import type { KTeamPaths } from './paths';
import { taskBoardBindingFile, taskBoardSessionCapabilityFile } from './paths';
import { TaskBoardError } from './task-boards-types';
import { TASK_BOARD_API_PREFIX, type TaskBoardChildAccess } from './task-boards-api';

export const TASK_BOARD_CLI_USAGE = `kteam task-board <command>

  membership
  create --creator <session> --coordinator <session> [--mark-done]
  grant-request <child> --role <read|worker|coordinator>
  grant-approve <request-id>
  invite <external-top-level-session>
  invite-approve <request-id>
  invite-accept
  relinquish
  mark-done <top-level-session> <--enable|--disable>
  coordinator-replace <current-board-member> <replacement-session>
  revoke <current-board-member> <target-session> --reason <why>

No command accepts or prints a board id. Peer commands authenticate with the
calling session's secret board binding; invitation acceptance uses its exact
daemon-delivered one-time capability. ACL commands are available only to the
human-admin CLI.`;

export type TaskBoardCliCommand =
  | { command: 'membership' }
  | { command: 'create'; creatorSessionId: string; coordinatorSessionId: string; creatorMarkDone: boolean }
  | { command: 'grant-request'; targetSessionId: string; role: TaskBoardChildAccess }
  | { command: 'grant-approve'; grantRequestId: string }
  | { command: 'invite'; targetSessionId: string }
  | { command: 'invite-approve'; invitationRequestId: string }
  | { command: 'invite-accept' }
  | { command: 'relinquish' }
  | { command: 'mark-done'; sessionId: string; enabled: boolean }
  | { command: 'coordinator-replace'; sessionId: string; replacementSessionId: string }
  | { command: 'revoke'; sessionId: string; targetSessionId: string; reason: string };

export interface TaskBoardCliRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** The invitation accept route also needs the daemon-issued credential for
   * the calling session's exact incarnation/runtime. The credential is loaded
   * out of band and never added to the request body. */
  requiresSessionCapability?: true;
  /** Load the coordinator-approved one-time invitation proof from the same
   * daemon-owned 0600 session record. It is never accepted through argv. */
  requiresInvitationCapability?: true;
}

const invalid = (message: string): never => {
  throw new TaskBoardError('invalid', `${message}\n\n${TASK_BOARD_CLI_USAGE}`);
};

const required = (value: string | undefined, label: string): string => {
  const normalized = value?.trim() ?? '';
  if (!normalized) return invalid(`${label} is required`);
  return normalized;
};

function split(argv: readonly string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (key: string, value: string): void => {
    flags.set(key, [...(flags.get(key) ?? []), value]);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    if (equal !== -1) {
      add(token.slice(2, equal), token.slice(equal + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) add(token.slice(2), '');
    else {
      add(token.slice(2), next);
      index += 1;
    }
  }
  return { positional, flags };
}

export function parseTaskBoardCli(argv: readonly string[]): TaskBoardCliCommand {
  const { positional, flags } = split(argv);
  if (flags.has('board') || flags.has('board-id')) return invalid('board ids are never accepted');
  const flag = (name: string): string | undefined => flags.get(name)?.at(-1);
  const command = positional[0];
  switch (command) {
    case 'membership':
      return { command };
    case 'create':
      return {
        command,
        creatorSessionId: required(flag('creator'), '--creator'),
        coordinatorSessionId: required(flag('coordinator'), '--coordinator'),
        creatorMarkDone: flags.has('mark-done'),
      };
    case 'grant-request': {
      const role = required(flag('role'), '--role');
      if (!(['read', 'worker', 'coordinator'] as const).includes(role as TaskBoardChildAccess)) {
        return invalid('--role must be read, worker, or coordinator');
      }
      return {
        command,
        targetSessionId: required(positional[1], 'child session'),
        role: role as TaskBoardChildAccess,
      };
    }
    case 'grant-approve':
      return { command, grantRequestId: required(positional[1], 'grant request id') };
    case 'invite':
      return { command, targetSessionId: required(positional[1], 'external session') };
    case 'invite-approve':
      return { command, invitationRequestId: required(positional[1], 'invitation request id') };
    case 'invite-accept':
      if (positional.length !== 1 || flags.size !== 0) {
        return invalid('invite-accept takes no credential arguments; the daemon delivers its proof out of band');
      }
      return { command };
    case 'relinquish':
      return { command };
    case 'mark-done': {
      if (flags.has('enable') === flags.has('disable'))
        return invalid('mark-done requires exactly one of --enable or --disable');
      return { command, sessionId: required(positional[1], 'top-level session'), enabled: flags.has('enable') };
    }
    case 'coordinator-replace':
      return {
        command,
        sessionId: required(positional[1], 'current board member'),
        replacementSessionId: required(positional[2], 'replacement session'),
      };
    case 'revoke':
      return {
        command,
        sessionId: required(positional[1], 'current board member'),
        targetSessionId: required(positional[2], 'target session'),
        reason: required(flag('reason'), '--reason'),
      };
    default:
      return invalid(`unknown task-board command ${command ?? '(none)'}`);
  }
}

export function taskBoardCliRequest(command: TaskBoardCliCommand): TaskBoardCliRequest {
  switch (command.command) {
    case 'membership':
      return { method: 'GET', path: `${TASK_BOARD_API_PREFIX}/membership` };
    case 'create':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/create`,
        body: {
          creatorSessionId: command.creatorSessionId,
          coordinatorSessionId: command.coordinatorSessionId,
          creatorMarkDone: command.creatorMarkDone,
        },
      };
    case 'grant-request':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/child-grants/request`,
        body: { targetSessionId: command.targetSessionId, role: command.role },
      };
    case 'grant-approve':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/child-grants/approve`,
        body: { grantRequestId: command.grantRequestId },
      };
    case 'invite':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/invitations/request`,
        body: { targetSessionId: command.targetSessionId },
      };
    case 'invite-approve':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/invitations/approve`,
        body: { invitationRequestId: command.invitationRequestId },
      };
    case 'invite-accept':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/invitations/accept`,
        body: {},
        requiresSessionCapability: true,
        requiresInvitationCapability: true,
      };
    case 'relinquish':
      return { method: 'POST', path: `${TASK_BOARD_API_PREFIX}/membership/relinquish`, body: {} };
    case 'mark-done':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/mark-done`,
        body: { sessionId: command.sessionId, enabled: command.enabled },
      };
    case 'coordinator-replace':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/coordinator/replace`,
        body: { sessionId: command.sessionId, replacementSessionId: command.replacementSessionId },
      };
    case 'revoke':
      return {
        method: 'POST',
        path: `${TASK_BOARD_API_PREFIX}/grants/revoke`,
        body: { sessionId: command.sessionId, targetSessionId: command.targetSessionId, reason: command.reason },
      };
  }
}

/** Load only the calling session's binding. The target of an operation never
 * influences this path, so `--session`/body/header spoofing cannot select
 * another member's secret. `KTEAM_BOARD_CAPABILITY` is the supervisor-injected
 * fast path; the daemon-written 0600 binding supports grants made after launch. */
export async function ownTaskBoardCapability(
  paths: KTeamPaths,
  sessionId: string | undefined,
  environmentCapability = process.env.KTEAM_BOARD_CAPABILITY,
): Promise<string | undefined> {
  const id = sessionId?.trim() ?? '';
  if (!id) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id === '.' || id === '..') {
    throw new TaskBoardError('invalid', 'KTEAM_SESSION_ID is not a safe session id');
  }
  const fromEnvironment = environmentCapability?.trim() ?? '';
  if (fromEnvironment) return fromEnvironment;
  const raw = await readFile(taskBoardBindingFile(paths, id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TaskBoardError('invalid', `session ${id} has a corrupt task-board binding`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)['sessionId'] !== id ||
    typeof (parsed as Record<string, unknown>)['capability'] !== 'string' ||
    !(parsed as Record<string, unknown>)['capability']
  ) {
    throw new TaskBoardError('invalid', `session ${id} has an invalid task-board binding`);
  }
  return (parsed as Record<string, string>)['capability']!.trim();
}

/** Load the invitee's pre-membership proof. This credential is deliberately
 * distinct from both the one-time invitation capability and a board binding:
 * it proves which live session accepted before that session has a binding. */
export async function ownTaskBoardSessionCapability(
  paths: KTeamPaths,
  sessionId: string | undefined,
  environmentCapability = process.env.KTEAM_SESSION_BOARD_CAPABILITY,
): Promise<string | undefined> {
  const id = sessionId?.trim() ?? '';
  if (!id) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id === '.' || id === '..') {
    throw new TaskBoardError('invalid', 'KTEAM_SESSION_ID is not a safe session id');
  }
  const fromEnvironment = environmentCapability?.trim() ?? '';
  if (fromEnvironment) return fromEnvironment;
  const raw = await readFile(taskBoardSessionCapabilityFile(paths, id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TaskBoardError('invalid', `session ${id} has a corrupt task-board session capability`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)['v'] !== 1 ||
    (parsed as Record<string, unknown>)['sessionId'] !== id ||
    typeof (parsed as Record<string, unknown>)['sessionIncarnation'] !== 'string' ||
    !Number.isSafeInteger((parsed as Record<string, unknown>)['runtimeGeneration']) ||
    typeof (parsed as Record<string, unknown>)['capability'] !== 'string' ||
    ((parsed as Record<string, unknown>)['capability'] as string).trim().length < 32
  ) {
    throw new TaskBoardError('invalid', `session ${id} has an invalid task-board session capability`);
  }
  return ((parsed as Record<string, unknown>)['capability'] as string).trim();
}

/** Load only the daemon-delivered one-time invitation proof for this session.
 * The proof never appears in argv, JSON, normal output, or another session's
 * binding lookup. The server still requires the distinct session proof. */
export async function ownTaskBoardInvitationCapability(
  paths: KTeamPaths,
  sessionId: string | undefined,
  environmentCapability = process.env.KTEAM_BOARD_INVITATION_CAPABILITY,
): Promise<string | undefined> {
  const id = sessionId?.trim() ?? '';
  if (!id) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id === '.' || id === '..') {
    throw new TaskBoardError('invalid', 'KTEAM_SESSION_ID is not a safe session id');
  }
  const fromEnvironment = environmentCapability?.trim() ?? '';
  if (fromEnvironment) return fromEnvironment;
  const raw = await readFile(taskBoardSessionCapabilityFile(paths, id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TaskBoardError('invalid', `session ${id} has a corrupt task-board invitation capability`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)['v'] !== 1 ||
    (parsed as Record<string, unknown>)['sessionId'] !== id ||
    typeof (parsed as Record<string, unknown>)['sessionIncarnation'] !== 'string' ||
    !Number.isSafeInteger((parsed as Record<string, unknown>)['runtimeGeneration']) ||
    typeof (parsed as Record<string, unknown>)['invitationRequestId'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['invitationCapability'] !== 'string' ||
    ((parsed as Record<string, unknown>)['invitationCapability'] as string).trim().length < 32
  ) {
    throw new TaskBoardError('invalid', `session ${id} has an invalid task-board invitation capability`);
  }
  return ((parsed as Record<string, unknown>)['invitationCapability'] as string).trim();
}

/** Human operator counterpart to `ownTaskBoardCapability`. It is deliberately
 * unavailable from inside a teammate pane; the daemon never injects this
 * secret, and peer commands continue to use only their own binding. */
export async function ownTaskBoardAdminCapability(
  paths: KTeamPaths,
  sessionId: string | undefined,
  environmentCapability = process.env.KTEAM_BOARD_ADMIN_CAPABILITY,
): Promise<string | undefined> {
  if (sessionId?.trim()) return undefined;
  const fromEnvironment = environmentCapability?.trim() ?? '';
  if (fromEnvironment) return fromEnvironment;
  const value = await readFile(paths.taskBoardAdminToken, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  const capability = value?.trim() ?? '';
  if (capability && capability.length < 32) {
    throw new TaskBoardError('invalid', 'task-board admin capability is malformed');
  }
  return capability || undefined;
}

export function renderTaskBoardCli(response: unknown): string {
  return `${JSON.stringify(withoutCapabilities(response), null, 2)}\n`;
}

function withoutCapabilities(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCapabilities);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.toLowerCase().includes('capability'))
      .map(([key, nested]) => [key, withoutCapabilities(nested)]),
  );
}
