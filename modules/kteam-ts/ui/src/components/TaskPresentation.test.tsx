import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  taskAskOrigin,
  taskCodeReferenceContext,
  taskCodeReferencesStayInSession,
  TaskDetail,
  TaskRow,
} from './TaskPresentation';
import type { TaskRecord, TaskSummary } from '../lib/tasks';
import { codeReferenceHref } from '../lib/code-references';

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
  assignee: 'ottis',
  repo: '/repo',
  links: { prs: ['https://github.com/acme/kteam/pull/42'], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  askChars: 12,
  askSource: 'https://chat.example/messages/1',
  clarificationCount: 1,
  createdBy: 'ms-creator-12345678',
  sessionId: 'ms-b7',
  files: ['src/api-server.ts'],
  live: {
    assigneeSessionId: 'ms4v5fu2-f2a89500',
    assigneeName: 'ottis',
    assigneeStatus: 'failed',
    assigneeHealth: 'dead',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: 'assignee-dead',
  },
};

describe('task-v2 presentation', () => {
  test('row exposes # references, primary blocked state, dependency blocking, and claimed files', () => {
    const html = renderToStaticMarkup(<TaskRow task={task} onOpen={() => undefined} />);
    expect(html).toContain('#B7');
    expect(html).toContain('Blocked');
    expect(html).toContain('Waiting for #F12');
    expect(html).toContain('Blocked by #F12');
    expect(html).toContain('kteam#42');
    expect(html).toContain('src/api-server.ts');
    expect(html).not.toContain('Agent-originated');
    expect(html).not.toContain('data-task-ask-origin');
    expect(html).toContain('href="/session/ms4v5fu2-f2a89500"');
    expect(html).toContain('>ottis<');
    expect(html).toContain('bg-warn');
    expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('href="/session/ms4v5fu2-f2a89500"'));
  });
  test('row makes the complete title dominant and allows it to wrap', () => {
    const title = 'Filter kanban without hiding context';
    const html = renderToStaticMarkup(<TaskRow task={{ ...task, title }} onOpen={() => undefined} />);
    const titleClass = html.match(/data-task-title="B7" class="([^"]+)"/)?.[1];
    expect(html).toContain(`>${title}</span>`);
    expect(titleClass).toContain('text-row');
    expect(titleClass).toContain('whitespace-normal');
    expect(titleClass).toContain('break-words');
    expect(titleClass).not.toContain('truncate');
  });
  test('row drops metadata already implied by its visible card group', () => {
    const html = renderToStaticMarkup(
      <TaskRow
        task={{
          ...task,
          title: 'Live peer status stays accurate',
          phase: 'live',
          status: 'live',
          blocked: false,
          blockedReason: null,
          blockedSince: null,
          blockedBy: [],
        }}
        impliedLane="live"
        showAssignee={false}
        showAskOriginMarker={false}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('Live peer status stays accurate');
    expect(html).not.toContain('data-task-status-badge');
    expect(html).not.toContain('data-task-assignee');
    expect(html).not.toContain('data-task-ask-origin');
    expect(html).not.toContain('Agent-originated');
  });
  test('blocked remains visible when the surrounding lane cannot imply it', () => {
    const html = renderToStaticMarkup(
      <TaskRow
        task={task}
        impliedLane="in_progress"
        showAssignee={false}
        showAskOriginMarker={false}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-task-status-badge');
    expect(html).toContain('>Blocked<');
  });
  test('active audit phases share the in-progress row state', () => {
    for (const [phase, status] of [
      ['research', 'researched'],
      ['design', 'designed'],
      ['build', 'in_progress'],
    ] as const) {
      const html = renderToStaticMarkup(
        <TaskRow
          task={{
            ...task,
            phase,
            status,
            blocked: false,
            blockedReason: null,
            blockedSince: null,
            blockedBy: [],
          }}
          onOpen={() => undefined}
        />,
      );
      expect(html).toContain('In progress');
      expect(html).not.toContain(`>${phase === 'research' ? 'Research' : phase === 'design' ? 'Design' : 'Build'}<`);
    }
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
  test('a backward-move reason stays visible on the row and detail without claiming the task is blocked', () => {
    const movedBack = {
      ...task,
      blocked: false,
      blockedReason: null,
      blockedSince: null,
      blockedBy: [],
      statusReason: 'The deployed browser still returns 404.',
    };
    const row = renderToStaticMarkup(<TaskRow task={movedBack} onOpen={() => undefined} />);
    const detail = renderToStaticMarkup(<TaskDetail task={movedBack} activity={[]} />);
    for (const html of [row, detail]) {
      expect(html).toContain('Phase note · The deployed browser still returns 404.');
      expect(html).not.toContain('>Blocked<');
    }
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
    expect(html).toContain('<strong>Dropped.</strong>');
    expect(html).not.toContain('Superseded by #F13');
  });
  test('ask provenance follows the original source rather than the session that recorded it', () => {
    const humanAsk = { ...task, createdBy: 'ms-agent-recorder', askChars: 24, askSource: 'chat 2026-07-28' };
    const agentAsk = {
      ...task,
      createdBy: null,
      askChars: 24,
      askSource: '/home/kirin/.kteam/ms-agent/turns/turn-001.md',
    };
    const legacyAsk = { ...task, askChars: 24, askSource: 'legacy:F12' };
    const referencedAsk = { ...task, askChars: 62, askSource: '#F77' };
    expect(taskAskOrigin(humanAsk)).toBe('human');
    expect(taskAskOrigin(agentAsk)).toBe('agent');
    expect(taskAskOrigin(legacyAsk)).toBe('unknown');
    expect(taskAskOrigin(referencedAsk)).toBe('unknown');

    const humanRow = renderToStaticMarkup(<TaskRow task={humanAsk} onOpen={() => undefined} />);
    const agentRow = renderToStaticMarkup(<TaskRow task={agentAsk} onOpen={() => undefined} />);
    expect(humanRow).not.toContain('Agent-originated');
    expect(agentRow).toContain('data-task-ask-origin="agent"');
    expect(agentRow).toContain('Agent-originated');
    expect(agentRow).toContain('Original ask came from an agent');

    expect(renderToStaticMarkup(<TaskDetail task={humanAsk} activity={[]} />)).toContain('Human-asked');
    expect(renderToStaticMarkup(<TaskDetail task={agentAsk} activity={[]} />)).toContain('Agent-originated');
  });
  test('quick summary leads with one proven outcome and keeps each fact on its own line', () => {
    const html = renderToStaticMarkup(<TaskDetail task={task} activity={[]} />);
    expect(html.indexOf('Quick summary')).toBeLessThan(html.indexOf('Assignee evidence'));
    expect(html).toContain('<strong>Blocked.</strong>');
    expect(html).toContain('<p>Questions reach UI</p>');
    expect(html).toContain('Waiting for #F12');
    expect(html).toContain('<p>Assigned to ottis.</p>');
    expect(html).toContain('<p>Depends on #F12.</p>');
    expect(html.match(/Waiting for #F12/g)).toHaveLength(1);
    expect(html.match(/<strong>/g)).toHaveLength(1);
  });
  test('detail renders verbatim ask, sources, clarifications, dependencies, and exact phase/claim history', () => {
    const record: TaskRecord = {
      ...task,
      description: '## Working **notes**\nFirst line\nSecond line\n\n```mystery\nopaque #F99 <tag>\n```',
      createdBy: 'lead',
      ask: {
        text: '**Keep** this original ask exactly. See #F12.\nThen preserve this line.',
        source: 'https://chat.example/messages/1',
      },
      clarifications: [
        {
          text: '- Add the source link too.\n- Keep newlines.',
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
        onOpenTask={() => undefined}
      />,
    );
    for (const text of [
      '#B7',
      'Research first',
      'Audit phase Build',
      'Original ask',
      'this original ask exactly. See',
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
    expect(html).toContain('<h2>Working <strong>notes</strong></h2>');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('<ul>');
    expect(html).toContain('opaque #F99 &lt;tag&gt;');
    expect(html).not.toContain('data-task-reference="F12"');
    expect(html).not.toContain('href="/tasks/F12"');
  });

  test('a same-session task receives the hosting Files resolution context', () => {
    const record: TaskRecord = {
      ...task,
      createdBy: task.createdBy ?? null,
      description: 'Inspect src/api-server.ts:890-912.',
      ask: { text: 'Keep the source jump.', source: 'https://chat.example/messages/1' },
      clarifications: [],
    };
    const html = renderToStaticMarkup(
      <TaskDetail
        task={record}
        activity={[]}
        surfaceSessionId="ms-b7"
        surfaceCwd="/host/worktree"
        onCodeReferenceOpen={() => undefined}
      />,
    );

    expect(taskCodeReferencesStayInSession('ms-b7', record.sessionId)).toBe(true);
    expect(taskCodeReferenceContext('ms-b7', '/host/worktree', record.sessionId)).toEqual({
      sessionId: 'ms-b7',
      cwd: '/host/worktree',
    });
    expect(taskCodeReferenceContext('ms-b7', '/host/worktree', 'ms-other')).toBeNull();
    expect(html).toContain('src/api-server.ts:890-912');
    expect(html).not.toContain('data-code-reference');
  });

  test('never resolves a cross-session task path into the hosting session Files pane', () => {
    expect(taskCodeReferencesStayInSession('ms-a', 'ms-a')).toBe(true);
    expect(taskCodeReferencesStayInSession('ms-a', 'ms-b')).toBe(false);
    expect(taskCodeReferencesStayInSession('ms-a', null)).toBe(false);

    const href = codeReferenceHref({ path: 'src/api-server.ts', line: 890 });
    const record: TaskRecord = {
      ...task,
      createdBy: task.createdBy ?? null,
      sessionId: 'ms-b',
      description: `Inspect [the handler](${href}).`,
      ask: { text: 'Keep the source jump.', source: 'https://chat.example/messages/1' },
      clarifications: [],
    };
    const html = renderToStaticMarkup(
      <TaskDetail task={record} activity={[]} surfaceSessionId="ms-a" onCodeReferenceOpen={() => undefined} />,
    );

    expect(html).toContain('the handler');
    expect(html).not.toContain('data-code-reference');
    expect(html).not.toContain('#kteam-code-reference');
  });
});
