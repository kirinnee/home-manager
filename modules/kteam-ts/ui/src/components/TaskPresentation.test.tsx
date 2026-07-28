import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDetail, TaskRow } from './TaskPresentation';
import type { TaskRecord, TaskSummary } from '../lib/tasks';

const task: TaskSummary = {
  id: 'B7',
  kind: 'bug',
  title: 'Questions reach UI',
  workflow: 'research-first',
  phase: 'build',
  dependsOn: ['F12'],
  status: 'in_progress',
  statusReason: null,
  blocked: true,
  blockedReason: 'Waiting for #F12',
  blockedSince: '2026-07-20T10:00:00.000Z',
  blockedBy: ['F12'],
  assignee: 'sasha',
  repo: '/repo',
  links: { prs: ['https://github.com/acme/kteam/pull/42'], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  askChars: 12,
  askSource: 'https://chat.example/messages/1',
  clarificationCount: 1,
  sessionId: 'ms-b7',
  files: ['src/api-server.ts'],
  live: {
    assigneeStatus: 'failed',
    assigneeHealth: 'dead',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: 'assignee-dead',
  },
};

describe('task-v2 presentation', () => {
  test('row exposes # references, phase, dependency blocking, and claimed files', () => {
    const html = renderToStaticMarkup(<TaskRow task={task} onOpen={() => undefined} />);
    expect(html).toContain('#B7');
    expect(html).toContain('Build');
    expect(html).toContain('Waiting for #F12');
    expect(html).toContain('Blocked by #F12');
    expect(html).toContain('kteam#42');
    expect(html).toContain('src/api-server.ts');
  });
  test('row surfaces an advisory file conflict without calling the task blocked', () => {
    const html = renderToStaticMarkup(
      <TaskRow
        task={task}
        conflicts={[{ taskId: 'F30', sessionId: 'ms-other', files: ['src/api-server.ts'], crossSession: true }]}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('Shares files with #F30');
  });
  test('detail lists files and links a cross-session file conflict to its owning session', () => {
    const html = renderToStaticMarkup(
      <TaskDetail
        task={task}
        activity={[]}
        conflicts={[{ taskId: 'F30', sessionId: 'ms-other', files: ['src/api-server.ts'], crossSession: true }]}
      />,
    );
    expect(html).toContain('src/api-server.ts');
    expect(html).toContain('#F30');
    expect(html).toContain('href="/session/ms-other"');
    expect(html).toContain('not a blocker'); // advisory framing, never a blocker
  });
  test('a dropped reason is not mislabeled as a current blocker', () => {
    const html = renderToStaticMarkup(
      <TaskDetail
        task={{
          ...task,
          phase: 'dropped',
          status: 'dropped',
          statusReason: 'Superseded by #F13',
          blocked: false,
          blockedReason: null,
          blockedSince: null,
          blockedBy: [],
        }}
        activity={[]}
      />,
    );
    expect(html).not.toContain('>Blocked<');
  });
  test('detail renders verbatim ask, sources, clarifications, dependencies, and exact phase/claim history', () => {
    const record: TaskRecord = {
      ...task,
      description: '## Working notes',
      createdBy: 'lead',
      ask: { text: 'Keep this original ask exactly.', source: 'https://chat.example/messages/1' },
      clarifications: [
        {
          text: 'Add the source link too.',
          source: 'https://chat.example/messages/2',
          at: '2026-07-21T01:02:03.000Z',
          by: 'user',
          byName: 'Kirin',
        },
      ],
    };
    const html = renderToStaticMarkup(
      <TaskDetail
        task={record}
        activity={[
          {
            v: 2,
            seq: 1,
            time: '2026-07-21T02:03:04.000Z',
            actor: 'user',
            actorName: 'Kirin',
            type: 'status',
            data: { phaseFrom: 'research', phaseTo: 'design', reason: 'approved design direction' },
          },
          {
            v: 2,
            seq: 2,
            time: '2026-07-22T02:03:04.000Z',
            actor: 'sasha',
            actorName: 'sasha',
            type: 'session',
            data: { event: 'completion-claim', session: 'ms-sasha', turn: 5, phase: 'build' },
          },
        ]}
      />,
    );
    for (const text of [
      '#B7',
      'Research first',
      'Original ask',
      'Keep this original ask exactly.',
      'Open ask source',
      'Add the source link too.',
      'Open clarification source',
      'Depends on',
      '#F12',
      'Blocked',
      'research → design: approved design direction',
      'Completion claim: ms-sasha',
    ])
      expect(html).toContain(text);
    expect(html).toContain('2026-07-21T02:03:04.000Z');
  });
});
