import { describe, expect, test } from 'bun:test';
import { paneShowsStructuredQuestionMenu, pendingQuestionPaneAdvance, SessionManager } from './session-manager';
import type { SessionView } from './service';
import { StructuredQuestionDriveError } from './tmux-controller';
import type { TranscriptCursor } from './claude-transcript';

type Loose = Record<string, unknown>;

const pendingQuestion = {
  toolUseId: 'tool-current',
  questions: [
    {
      question: 'Which rollout should we use?',
      options: [{ label: 'Enable feature' }, { label: 'Enable feature flags' }],
      multiSelect: false,
    },
  ],
};

function fixture() {
  let view = {
    directory: '/tmp/kteam-question-test',
    config: {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness: 'claude',
      mode: 'interactive',
      turn: 1,
      maxSnapshots: 5,
    },
    state: {
      id: 's',
      status: 'awaiting_question',
      health: 'waiting',
      turn: 1,
      promptReady: false,
      pendingQuestion,
      openTools: ['tool-current'],
    },
  } as SessionView;
  const emitted: Array<{ type: string; data: unknown }> = [];
  const transitions: Array<{ type: string; data: unknown; patch: unknown }> = [];
  const manager = Object.create(SessionManager.prototype) as Loose;
  manager.resolveRef = (id: string) => id;
  manager.clearNeedsHuman = async () => undefined;
  manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
  manager.withAutoRevive = async (_id: string, _action: string, work: () => Promise<unknown>) => await work();
  manager.get = async () => view;
  manager.emit = async (_id: string, type: string, data: unknown) => {
    emitted.push({ type, data });
    return {};
  };
  manager.transition = async (_id: string, patch: Record<string, unknown>, type: string, data: unknown) => {
    transitions.push({ type, data, patch });
    view = { ...view, state: { ...view.state, ...patch } } as SessionView;
  };
  return { manager, emitted, transitions, getView: () => view };
}

type QuestionManager = {
  answer(id: string, toolUseId: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView>;
  interrupt(id: string, expectedToolUseId?: string): Promise<SessionView>;
  resume(id: string, message?: string): Promise<SessionView>;
  send(id: string, request: { message: string }): Promise<SessionView>;
};

describe('SessionManager structured-question control', () => {
  test('a stale form cannot drive its answer into a newer question', async () => {
    const { manager, emitted, transitions } = fixture();
    let drives = 0;
    manager.tmux = {
      answerQuestion: async () => {
        drives++;
      },
    };

    await expect((manager as unknown as QuestionManager).answer('s', 'tool-old', ['Enable feature'])).rejects.toThrow(
      /displayed question changed.*tool-old.*tool-current/,
    );
    expect(drives).toBe(0);
    expect(emitted).toEqual([]);
    expect(transitions).toEqual([]);
  });

  test('answer success is journalled only after pane confirmation and clears the exact question', async () => {
    const { manager, emitted, transitions, getView } = fixture();
    manager.tmux = {
      answerQuestion: async () => ({
        toolUseId: 'tool-current',
        startedAtQuestion: 0,
        answeredQuestions: 1,
        confirmedBy: 'turn-started',
      }),
    };

    const result = await (manager as unknown as QuestionManager).answer('s', 'tool-current', ['Enable feature']);
    expect(emitted).toEqual([]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: 'interaction.answer',
      patch: { status: 'running', pendingQuestion: undefined },
      data: {
        toolUseId: 'tool-current',
        labels: ['Enable feature'],
        pendingQuestion: null,
        confirmation: { confirmedBy: 'turn-started' },
      },
    });
    expect(result.state.pendingQuestion).toBeUndefined();
    expect(getView().state.status).toBe('running');
  });

  test('a refused/unconfirmed drive records diagnostics and leaves the question recoverable', async () => {
    const { manager, emitted, transitions, getView } = fixture();
    manager.tmux = {
      answerQuestion: async () => {
        throw new StructuredQuestionDriveError('pane did not advance', {
          phase: 'confirm',
          reason: 'question_missing',
        });
      },
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: false,
        pane: 'question pane',
        visiblePane: 'question pane',
      }),
      snapshot: async () => 'question pane',
    };

    await expect(
      (manager as unknown as QuestionManager).answer('s', 'tool-current', ['Enable feature']),
    ).rejects.toThrow('pane did not advance');
    expect(transitions).toEqual([]);
    expect(getView().state.status).toBe('awaiting_question');
    expect(getView().state.pendingQuestion?.toolUseId).toBe('tool-current');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'interaction.question_failed',
      data: {
        action: 'answer',
        toolUseId: 'tool-current',
        matcher: { phase: 'confirm', reason: 'question_missing' },
        snapshot: 'last-snapshot.txt',
      },
    });
  });

  test('interrupt is a verified abandon while a question is pending', async () => {
    const { manager, emitted, transitions, getView } = fixture();
    manager.tmux = {
      cancelQuestion: async () => ({
        confirmedBy: 'prompt-ready',
        pane: { alive: true, dead: false, promptReady: true, pane: '❯ ', visiblePane: '❯ ' },
      }),
      snapshot: async () => '❯ ',
    };

    const result = await (manager as unknown as QuestionManager).interrupt('s', 'tool-current');
    expect(emitted[0]).toMatchObject({
      type: 'interaction.question_cancel_requested',
      data: { toolUseId: 'tool-current' },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: 'interaction.question_cancelled',
      patch: { status: 'awaiting_user', pendingQuestion: undefined, openTools: [] },
      data: { toolUseId: 'tool-current', confirmedBy: 'prompt-ready', pendingQuestion: null },
    });
    expect(result.state.status).toBe('awaiting_user');
    expect(getView().state.pendingQuestion).toBeUndefined();
  });

  test('a stale bound abandon cannot cancel a newer or already-cleared question', async () => {
    const { manager, emitted, transitions } = fixture();
    let cancelDrives = 0;
    manager.tmux = {
      cancelQuestion: async () => {
        cancelDrives++;
        throw new Error('must not drive');
      },
    };

    await expect((manager as unknown as QuestionManager).interrupt('s', 'tool-old')).rejects.toThrow(
      /displayed question changed.*tool-old.*tool-current/,
    );
    expect(cancelDrives).toBe(0);
    expect(emitted).toEqual([]);
    expect(transitions).toEqual([]);

    await (
      manager.transition as (id: string, patch: Record<string, unknown>, type: string, data: unknown) => Promise<void>
    )('s', { status: 'running', pendingQuestion: undefined }, 'test.setup', {});
    transitions.length = 0;
    await expect((manager as unknown as QuestionManager).interrupt('s', 'tool-current')).rejects.toThrow(
      /tool-current is no longer pending/,
    );
    expect(cancelDrives).toBe(0);
    expect(emitted).toEqual([]);
    expect(transitions).toEqual([]);
  });

  test('resume with a message cannot bypass the structured-question send guard on a live pane', async () => {
    const { manager } = fixture();
    let directSends = 0;
    manager.launching = new Map();
    manager.cancelRetry = () => undefined;
    manager.tmux = {
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: false,
        pane: '? Which rollout should we use?',
        visiblePane: '? Which rollout should we use?',
      }),
    };
    manager.sendUnlocked = async () => {
      directSends++;
    };

    await expect((manager as unknown as QuestionManager).resume('s', 'continue')).rejects.toThrow(
      /answer or abandon the structured question/,
    );
    expect(directSends).toBe(0);
  });

  test('a drifted running status cannot let a plain send bypass a persisted question', async () => {
    const { manager, getView } = fixture();
    let paneDrives = 0;
    manager.launchingRecently = () => false;
    manager.get = async () => ({
      ...getView(),
      state: { ...getView().state, status: 'running' },
    });
    manager.tmux = {
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: false,
        pane: '? Which rollout should we use?',
        visiblePane: '? Which rollout should we use?',
      }),
      send: async () => {
        paneDrives++;
      },
    };

    await expect((manager as unknown as QuestionManager).send('s', { message: 'continue' })).rejects.toThrow(
      /answer the structured question/,
    );
    expect(paneDrives).toBe(0);
  });
});

describe('pending-question pane self-heal evidence', () => {
  const state = { pendingQuestion } as never;

  test('an idle prompt and a new active turn are strong advancement evidence', () => {
    expect(pendingQuestionPaneAdvance(state, { promptReady: true, visiblePane: '❯ ' })).toBe('prompt-ready');
    expect(
      pendingQuestionPaneAdvance(state, {
        promptReady: false,
        visiblePane: '• Working (2s • Esc to interrupt)',
      }),
    ).toBe('turn-started');
  });

  test('a visible menu or an ambiguous blank repaint is never auto-cleared', () => {
    expect(
      pendingQuestionPaneAdvance(state, {
        promptReady: false,
        visiblePane: '? Which rollout should we use?\n❯ 1. Enable feature',
      }),
    ).toBeUndefined();
    expect(
      pendingQuestionPaneAdvance(state, {
        promptReady: true,
        visiblePane: 'Which rollout should we use?\nType your answer\n❯ ',
      }),
    ).toBeUndefined();
    expect(pendingQuestionPaneAdvance(state, { promptReady: false, visiblePane: 'repainting…' })).toBeUndefined();
  });

  test('stale free-text scrollback cannot pin an already-idle session in awaiting_question', () => {
    // The old question and its "Other"-page hint remain in scrollback after the
    // interaction has closed. The final bare composer is the normal idle prompt,
    // not the question's live free-text editor. A pane-wide substring/glyph
    // probe treated this as presence forever, so self-heal could never clear it
    // even though every key-authorizing path correctly refused to drive it.
    const staleQuestionAtIdle = [
      'Which rollout should we use?',
      'Type your answer',
      'Use the guarded rollout.',
      '⏺ Answer recorded',
      '',
      '❯ ',
      '? for shortcuts',
    ].join('\n');
    expect(
      pendingQuestionPaneAdvance(state, {
        promptReady: true,
        visiblePane: staleQuestionAtIdle,
      }),
    ).toBe('prompt-ready');
  });

  test('native menu chrome is recognized only as reverse-divergence diagnostic evidence', () => {
    expect(
      paneShowsStructuredQuestionMenu(
        '? Which rollout should we use?\n❯ 1. Enable feature\n  2. Enable flags\nEnter to select · Esc to cancel',
      ),
    ).toBe(true);
    expect(paneShowsStructuredQuestionMenu('❯ continue')).toBe(false);
    expect(paneShowsStructuredQuestionMenu('docs say: Enter to select · Esc to cancel')).toBe(false);
  });

  test('an orphan native menu is journalled once without mutating or driving it', async () => {
    const { manager, emitted, transitions, getView } = fixture();
    await (
      manager.transition as (id: string, patch: Record<string, unknown>, type: string, data: unknown) => Promise<void>
    )('s', { status: 'running', pendingQuestion: undefined }, 'test.setup', {});
    transitions.length = 0;
    let snapshots = 0;
    manager.tmux = {
      snapshot: async () => {
        snapshots++;
        return '';
      },
    };
    const pane = {
      alive: true,
      dead: false,
      promptReady: false,
      pane: '? Which rollout?\n❯ 1. Enable\nEnter to select · Esc to cancel',
      visiblePane: '? Which rollout?\n❯ 1. Enable\nEnter to select · Esc to cancel',
    };
    const monitor = { advancedFrames: 0, missingFrames: 0 };
    const reconcile = manager as unknown as {
      reconcileStructuredQuestionFrame(
        id: string,
        paneState: {
          alive: boolean;
          dead: boolean;
          promptReady: boolean;
          pane: string;
          visiblePane: string;
        },
        paneHash: string,
        observedStatus: SessionView['state']['status'],
        observedToolUseId: string | undefined,
        monitorState: typeof monitor,
      ): Promise<SessionView>;
    };

    await reconcile.reconcileStructuredQuestionFrame('s', pane, 'orphan-pane', 'running', undefined, monitor);
    await reconcile.reconcileStructuredQuestionFrame('s', pane, 'orphan-pane', 'running', undefined, monitor);

    expect(transitions).toEqual([]);
    expect(getView().state.status).toBe('running');
    expect(snapshots).toBe(1);
    expect(emitted.filter(event => event.type === 'interaction.question_failed')).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'interaction.question_failed',
      data: { action: 'self-heal', status: 'running', snapshot: 'last-snapshot.txt' },
    });
  });

  test('two active-work frames clear with a cancellation lifecycle record, never reconciliation alone', async () => {
    const { manager, transitions, getView } = fixture();
    manager.tmux = { snapshot: async () => '' };
    const pane = {
      alive: true,
      dead: false,
      promptReady: false,
      pane: '• Working (2s • Esc to interrupt)',
      visiblePane: '• Working (2s • Esc to interrupt)',
    };
    const monitor = { advancedFrames: 0, missingFrames: 0 };
    const reconcile = manager as unknown as {
      reconcileStructuredQuestionFrame(
        id: string,
        paneState: typeof pane,
        paneHash: string,
        observedStatus: SessionView['state']['status'],
        observedToolUseId: string | undefined,
        monitorState: typeof monitor,
      ): Promise<SessionView>;
    };

    await reconcile.reconcileStructuredQuestionFrame(
      's',
      pane,
      'working-pane',
      'awaiting_question',
      'tool-current',
      monitor,
    );
    await reconcile.reconcileStructuredQuestionFrame(
      's',
      pane,
      'working-pane',
      'awaiting_question',
      'tool-current',
      monitor,
    );

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: 'interaction.question_cancelled',
      patch: { status: 'running', pendingQuestion: undefined },
      data: { toolUseId: 'tool-current', confirmedBy: 'turn-started', pendingQuestion: null },
    });
    expect(transitions.some(transition => transition.type === 'interaction.question_reconciled')).toBe(false);
    expect(getView().state.pendingQuestion).toBeUndefined();
  });

  test('a submitted answer wins the session queue before a stale self-heal frame can mutate lifecycle', async () => {
    const { manager, emitted, transitions, getView } = fixture();
    let answerStarted!: () => void;
    let releaseAnswer!: () => void;
    const started = new Promise<void>(resolve => {
      answerStarted = resolve;
    });
    const answerGate = new Promise<void>(resolve => {
      releaseAnswer = resolve;
    });
    manager.tmux = {
      answerQuestion: async () => {
        answerStarted();
        await answerGate;
        return {
          toolUseId: 'tool-current',
          startedAtQuestion: 0,
          answeredQuestions: 1,
          confirmedBy: 'turn-started',
        };
      },
      snapshot: async () => '❯ ',
    };

    // Use the production queue shape so the monitor observation is captured
    // while answer() owns the lock, then revalidated only after answer clears
    // the pending tool.
    let queue: Promise<unknown> = Promise.resolve();
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => {
      const result = queue.catch(() => undefined).then(work);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    };
    const monitor = {
      advancedTool: 'tool-current',
      advancedFrames: 1,
      missingTool: undefined,
      missingFrames: 0,
      missingReported: undefined,
    };

    const answer = (manager as unknown as QuestionManager).answer('s', 'tool-current', ['Enable feature']);
    await started;
    const selfHeal = (
      manager as unknown as {
        reconcileStructuredQuestionFrame(
          id: string,
          pane: {
            alive: boolean;
            dead: boolean;
            promptReady: boolean;
            pane: string;
            visiblePane: string;
          },
          paneHash: string,
          observedStatus: SessionView['state']['status'],
          observedToolUseId: string | undefined,
          monitorState: {
            advancedTool?: string;
            advancedFrames: number;
            missingTool?: string;
            missingFrames: number;
            missingReported?: string;
          },
        ): Promise<SessionView>;
      }
    ).reconcileStructuredQuestionFrame(
      's',
      { alive: true, dead: false, promptReady: true, pane: '❯ ', visiblePane: '❯ ' },
      'stale-pane',
      'awaiting_question',
      'tool-current',
      monitor,
    );

    releaseAnswer();
    await Promise.all([answer, selfHeal]);

    expect(transitions.map(transition => transition.type)).toEqual(['interaction.answer']);
    expect(emitted.some(event => event.type === 'interaction.question_cancelled')).toBe(false);
    expect(emitted.some(event => event.type === 'interaction.question_reconciled')).toBe(false);
    expect(getView().state.status).toBe('running');
    expect(getView().state.pendingQuestion).toBeUndefined();
    expect(monitor).toMatchObject({ advancedTool: undefined, advancedFrames: 0 });
  });
});

function transcriptFixture(harness: 'claude' | 'codex') {
  let view = {
    directory: '/tmp/kteam-question-reducer-test',
    config: {
      id: 's',
      tmuxSession: 'kteam-s-agent',
      harness,
      mode: 'interactive',
      turn: 1,
      maxSnapshots: 5,
    },
    state: {
      id: 's',
      status: 'awaiting_question',
      health: 'waiting',
      turn: 1,
      promptReady: false,
      pendingQuestion,
      openTools: ['tool-current', 'tool-unrelated'],
      turnCompleted: false,
      transcriptOffset: 0,
    },
  } as SessionView;
  const events: Array<{ type: string; data: unknown }> = [];
  const manager = Object.create(SessionManager.prototype) as Loose;
  manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
  manager.get = async () => view;
  manager.correlateNativeSends = async () => undefined;
  manager.indexChatRecords = () => undefined;
  manager.broadcastChat = () => undefined;
  manager.emit = async (_id: string, type: string, data: unknown) => {
    events.push({ type, data });
    return {};
  };
  manager.store = {
    updateState: async (_id: string, update: (state: SessionView['state']) => SessionView['state']) => {
      view = { ...view, state: update(view.state) };
      return view.state;
    },
  };
  return { manager, events, getView: () => view };
}

describe('structured-question transcript state stays internally consistent', () => {
  const cursor = { file: '/tmp/transcript.jsonl', startOffset: 0, endOffset: 10 };

  test('an unrelated Claude tool result cannot knock an open question back to running', async () => {
    const { manager, getView, events } = transcriptFixture('claude');
    await (
      manager as unknown as {
        handleClaudeEvents(id: string, events: unknown[], cursor: TranscriptCursor): Promise<void>;
      }
    ).handleClaudeEvents(
      's',
      [
        {
          source: 'claude',
          type: 'tool.result',
          data: { toolUseId: 'tool-unrelated', content: 'done', isError: false },
        },
      ],
      cursor,
    );
    expect(getView().state.status).toBe('awaiting_question');
    expect(getView().state.pendingQuestion?.toolUseId).toBe('tool-current');
    expect(events.some(event => event.type === 'interaction.question_cancelled')).toBe(false);
  });

  test('a matching harness result clears the question with a durable cancellation reason', async () => {
    const { manager, getView, events } = transcriptFixture('claude');
    await (
      manager as unknown as {
        handleClaudeEvents(id: string, events: unknown[], cursor: TranscriptCursor): Promise<void>;
      }
    ).handleClaudeEvents(
      's',
      [
        {
          source: 'claude',
          type: 'tool.result',
          data: { toolUseId: 'tool-current', content: 'cancelled', isError: true },
        },
      ],
      cursor,
    );
    expect(getView().state.pendingQuestion).toBeUndefined();
    expect(events).toContainEqual({
      type: 'interaction.question_cancelled',
      data: {
        toolUseId: 'tool-current',
        reason: 'harness produced a tool result without a daemon-confirmed answer',
        isError: true,
      },
    });
  });

  test('Codex turn abortion clears and explains the question instead of silently dropping it', async () => {
    const { manager, getView, events } = transcriptFixture('codex');
    await (
      manager as unknown as {
        handleCodexEvents(id: string, events: unknown[], cursor: TranscriptCursor): Promise<void>;
      }
    ).handleCodexEvents('s', [{ source: 'codex', type: 'turn.aborted', data: { turnId: 'turn-1' } }], cursor);
    expect(getView().state.pendingQuestion).toBeUndefined();
    expect(events).toContainEqual({
      type: 'interaction.question_cancelled',
      data: { toolUseId: 'tool-current', reason: 'turn aborted before a daemon-confirmed answer' },
    });
  });
});
