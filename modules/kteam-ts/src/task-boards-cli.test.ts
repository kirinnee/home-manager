import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPaths, sessionDir, taskBoardBindingFile, taskBoardSessionCapabilityFile } from './paths';
import {
  ownTaskBoardCapability,
  ownTaskBoardAdminCapability,
  ownTaskBoardInvitationCapability,
  ownTaskBoardSessionCapability,
  parseTaskBoardCli,
  renderTaskBoardCli,
  taskBoardCliRequest,
} from './task-boards-cli';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe('task-board CLI', () => {
  test('maps every operation without accepting a board id', () => {
    expect(taskBoardCliRequest(parseTaskBoardCli(['membership']))).toEqual({
      method: 'GET',
      path: '/v1/task-board/membership',
    });
    expect(
      taskBoardCliRequest(
        parseTaskBoardCli(['create', '--creator', 'ms-top', '--coordinator', 'ms-coord', '--mark-done']),
      ),
    ).toMatchObject({
      path: '/v1/task-board/create',
      body: { creatorSessionId: 'ms-top', coordinatorSessionId: 'ms-coord', creatorMarkDone: true },
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['grant-request', 'ms-child', '--role', 'worker']))).toMatchObject({
      path: '/v1/task-board/child-grants/request',
      body: { targetSessionId: 'ms-child', role: 'worker' },
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['grant-approve', 'request-1']))).toMatchObject({
      path: '/v1/task-board/child-grants/approve',
      body: { grantRequestId: 'request-1' },
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['invite', 'ms-outside']))).toMatchObject({
      path: '/v1/task-board/invitations/request',
      body: { targetSessionId: 'ms-outside' },
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['invite-approve', 'invite-1']))).toMatchObject({
      path: '/v1/task-board/invitations/approve',
      body: { invitationRequestId: 'invite-1' },
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['relinquish']))).toMatchObject({
      path: '/v1/task-board/membership/relinquish',
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['mark-done', 'ms-top', '--disable']))).toMatchObject({
      path: '/v1/task-board/mark-done',
      body: { sessionId: 'ms-top', enabled: false },
    });
    expect(taskBoardCliRequest(parseTaskBoardCli(['coordinator-replace', 'ms-top', 'ms-new']))).toMatchObject({
      path: '/v1/task-board/coordinator/replace',
      body: { sessionId: 'ms-top', replacementSessionId: 'ms-new' },
    });
    expect(
      taskBoardCliRequest(parseTaskBoardCli(['revoke', 'ms-top', 'ms-child', '--reason', 'finished'])),
    ).toMatchObject({
      path: '/v1/task-board/grants/revoke',
      body: { sessionId: 'ms-top', targetSessionId: 'ms-child', reason: 'finished' },
    });
    expect(() => parseTaskBoardCli(['membership', '--board-id', 'secret'])).toThrow(/board ids are never accepted/);
  });

  test('loads invitation acceptance only out of band and rejects credential argv', () => {
    const request = taskBoardCliRequest(parseTaskBoardCli(['invite-accept']));
    expect(request).toEqual({
      method: 'POST',
      path: '/v1/task-board/invitations/accept',
      body: {},
      requiresSessionCapability: true,
      requiresInvitationCapability: true,
    });
    expect(() => parseTaskBoardCli(['invite-accept', 'one-time-secret'])).toThrow(/takes no credential arguments/);
    expect(() => parseTaskBoardCli(['invite-accept', '--capability', 'one-time-secret'])).toThrow(
      /takes no credential arguments/,
    );
    expect(JSON.stringify(request)).not.toContain('one-time-secret');
  });

  test('loads only the invitee session capability and keeps it out of JSON', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kteam-task-board-session-capability-cli-'));
    homes.push(home);
    const paths = createPaths(home);
    await mkdir(sessionDir(paths, 'ms-invitee'), { recursive: true });
    const capability = 's'.repeat(48);
    await writeFile(
      taskBoardSessionCapabilityFile(paths, 'ms-invitee'),
      `${JSON.stringify({
        v: 1,
        sessionId: 'ms-invitee',
        sessionIncarnation: 'inc-ms-invitee',
        runtimeGeneration: 2,
        capability,
        invitationRequestId: 'invite-ms-invitee',
        invitationCapability: 'i'.repeat(48),
      })}\n`,
    );
    expect(await ownTaskBoardSessionCapability(paths, 'ms-invitee', undefined)).toBe(capability);
    expect(await ownTaskBoardSessionCapability(paths, 'ms-invitee', 'e'.repeat(48))).toBe('e'.repeat(48));
    expect(await ownTaskBoardSessionCapability(paths, undefined, 'e'.repeat(48))).toBeUndefined();
    expect(await ownTaskBoardInvitationCapability(paths, 'ms-invitee', undefined)).toBe('i'.repeat(48));
    expect(await ownTaskBoardInvitationCapability(paths, 'ms-invitee', 'j'.repeat(48))).toBe('j'.repeat(48));
    expect(await ownTaskBoardInvitationCapability(paths, undefined, 'j'.repeat(48))).toBeUndefined();

    await writeFile(
      taskBoardSessionCapabilityFile(paths, 'ms-invitee'),
      `${JSON.stringify({
        v: 1,
        sessionId: 'ms-other',
        sessionIncarnation: 'inc-ms-invitee',
        runtimeGeneration: 2,
        capability,
      })}\n`,
    );
    await expect(ownTaskBoardSessionCapability(paths, 'ms-invitee', undefined)).rejects.toThrow(
      /invalid task-board session capability/,
    );
  });

  test('loads only the caller binding and validates its claimed session', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kteam-task-board-cli-'));
    homes.push(home);
    const paths = createPaths(home);
    await mkdir(sessionDir(paths, 'ms-self'), { recursive: true });
    await writeFile(
      taskBoardBindingFile(paths, 'ms-self'),
      `${JSON.stringify({ sessionId: 'ms-self', capability: 'own-secret' })}\n`,
    );
    expect(await ownTaskBoardCapability(paths, 'ms-self', undefined)).toBe('own-secret');
    expect(await ownTaskBoardCapability(paths, 'ms-self', 'env-secret')).toBe('env-secret');
    expect(await ownTaskBoardCapability(paths, undefined, 'env-secret')).toBeUndefined();
    await writeFile(
      taskBoardBindingFile(paths, 'ms-self'),
      `${JSON.stringify({ sessionId: 'ms-other', capability: 'stolen-secret' })}\n`,
    );
    await expect(ownTaskBoardCapability(paths, 'ms-self', undefined)).rejects.toThrow(/invalid task-board binding/);
  });

  test('loads the distinct admin capability only outside a session pane', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kteam-task-board-admin-cli-'));
    homes.push(home);
    const paths = createPaths(home);
    await mkdir(path.dirname(paths.taskBoardAdminToken), { recursive: true });
    await writeFile(paths.taskBoardAdminToken, `${'a'.repeat(48)}\n`);
    expect(await ownTaskBoardAdminCapability(paths, undefined, undefined)).toBe('a'.repeat(48));
    expect(await ownTaskBoardAdminCapability(paths, undefined, 'b'.repeat(48))).toBe('b'.repeat(48));
    expect(await ownTaskBoardAdminCapability(paths, 'ms-peer', 'b'.repeat(48))).toBeUndefined();
  });

  test('renders only the already-sanitized transport response', () => {
    const rendered = renderTaskBoardCli({
      sessionId: 'ms-top',
      role: 'top_agent',
      acceptanceCapability: 'must-never-render',
      nested: { boardCapability: 'also-secret' },
    });
    expect(rendered).toContain('top_agent');
    expect(rendered).not.toContain('boardId');
    expect(rendered).not.toContain('must-never-render');
    expect(rendered).not.toContain('also-secret');
    expect(rendered).not.toContain('Capability');
  });
});
