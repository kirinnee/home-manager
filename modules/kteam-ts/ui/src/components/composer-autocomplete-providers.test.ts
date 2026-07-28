import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  builtinCommandsForHarness,
  createComposerAutocompleteProviders,
  createFilesProvider,
  createReferencesProvider,
  createSkillsProvider,
  isNamedReferenceQuery,
  loadSkillsCatalog,
  splitFileReferenceQuery,
  splitFileQuery,
  type ComposerTaskSummary,
  type ComposerSkillsResponse,
} from './composer-autocomplete-providers';
import {
  rankComposerCandidates,
  type ComposerTrigger,
  type ComposerTriggerMatch,
} from './composer-autocomplete-engine';
import type { SessionStatus, SessionView } from '../types';

const realFetch = globalThis.fetch;
let requests: string[];
let responder: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  requests = [];
  responder = () => Response.json({ error: 'unconfigured test request' }, { status: 500 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    return await responder(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function match(trigger: ComposerTrigger, query: string): ComposerTriggerMatch {
  return { trigger, query, start: 0, end: query.length + 1, caret: query.length + 1 };
}

function context(trigger: ComposerTrigger, query: string, signal = new AbortController().signal) {
  return { query, match: match(trigger, query), signal };
}

function agentSession({
  id,
  teammate,
  status = 'running',
  label = 'ui-work',
  task = 'Build the reference picker',
  activity = '2026-07-28T12:00:00.000Z',
  createdAt = '2026-07-28T10:00:00.000Z',
}: {
  id: string;
  teammate: string;
  status?: SessionStatus;
  label?: string;
  task?: string;
  activity?: string;
  createdAt?: string;
}): SessionView {
  return {
    config: {
      id,
      name: task,
      teammate,
      label,
      binary: 'codex-auto-loge',
      harness: 'codex',
      modelHint: 'gpt-5.6-sol',
      mode: 'auto',
      cwd: '/repo',
      createdAt,
      updatedAt: activity,
    } as SessionView['config'],
    state: { id, status, turn: 1, lastActivityAt: activity, observedModel: 'gpt-5.6-sol' },
    directory: `/fleet/${id}`,
  };
}

describe('/ skills provider', () => {
  test('exposes the same normalized catalog to the side-pane surface', async () => {
    responder = () =>
      Response.json({
        harness: 'codex',
        harnessHomeResolved: false,
        skills: [
          { name: 'Zebra', description: 'z' },
          { name: 'apple', description: 'a' },
        ],
      } satisfies ComposerSkillsResponse);

    await expect(loadSkillsCatalog('session / one', new AbortController().signal)).resolves.toEqual({
      harness: 'codex',
      harnessHomeResolved: false,
      skills: [
        { name: 'apple', description: 'a' },
        { name: 'Zebra', description: 'z' },
      ],
    });
    expect(requests).toEqual(['/v1/sessions/session%20%2F%20one/skills']);
  });

  test('uses the session-scoped endpoint and inserts what CODEX understands', async () => {
    const body: ComposerSkillsResponse = {
      harness: 'codex',
      skills: [{ name: 'summary', description: 'Give a fast recap' }],
    };
    responder = () => Response.json(body);

    const result = await createSkillsProvider('session / one').candidates(context('/', 'sum'));
    expect(requests).toEqual(['/v1/sessions/session%20%2F%20one/skills']);
    expect(result.contextLabel).toBe('Codex · inserts $name');
    expect(result.candidates.find(candidate => candidate.kind === 'skill')).toEqual(
      expect.objectContaining({
        kind: 'skill',
        label: 'summary',
        detail: 'Give a fast recap',
        // The reader pressed `/`. Codex browses with `/skills` and INVOKES with
        // `$name`, so `/summary` would be a command it does not have.
        replacement: '$summary',
        append: 'space',
      }),
    );
  });

  test('inserts what CLAUDE understands from the very same catalog', async () => {
    responder = () =>
      Response.json({
        harness: 'claude',
        skills: [{ name: 'summary', description: 'Give a fast recap' }],
      } satisfies ComposerSkillsResponse);
    const result = await createSkillsProvider('one').candidates(context('/', ''));
    expect(result.contextLabel).toBe('Claude · inserts /name');
    expect(result.candidates.find(candidate => candidate.kind === 'skill')).toMatchObject({ replacement: '/summary' });
  });

  test('an unrecognised harness falls back to the claude form rather than inserting undefined', async () => {
    responder = () => Response.json({ harness: 'zebra', skills: [{ name: 'floop', description: 'x' }] });
    const result = await createSkillsProvider('one').candidates(context('/', ''));
    expect(result.candidates.find(candidate => candidate.kind === 'skill')).toMatchObject({ replacement: '/floop' });
  });

  test('caches the catalog per mounted session provider', async () => {
    responder = () => Response.json({ harness: 'claude', skills: [] } satisfies ComposerSkillsResponse);
    const provider = createSkillsProvider('one');
    await provider.candidates(context('/', ''));
    await provider.candidates(context('/', 'sum'));
    expect(requests).toHaveLength(1);
  });

  test('sorts case-insensitively so the list order is not ASCII order', async () => {
    responder = () =>
      Response.json({
        harness: 'claude',
        skills: [
          { name: 'Zebra', description: 'z' },
          { name: 'apple', description: 'a' },
        ],
      } satisfies ComposerSkillsResponse);
    const result = await createSkillsProvider('one').candidates(context('/', ''));
    expect(result.candidates.filter(candidate => candidate.kind === 'skill').map(candidate => candidate.label)).toEqual(
      ['apple', 'Zebra'],
    );
  });

  test('merges first-class Commands above Skills and keeps harness support explicit', async () => {
    responder = () =>
      Response.json({
        harness: 'codex',
        skills: [{ name: 'compact', description: 'A skill with the same quality match' }],
      } satisfies ComposerSkillsResponse);

    const result = await createSkillsProvider('one').candidates(context('/', 'compact'));
    expect(result.candidates.slice(0, 2)).toEqual([
      expect.objectContaining({
        kind: 'command',
        label: 'compact',
        detail: 'Summarise the conversation so far and free up context',
        group: 'Commands',
        replacement: '/compact',
      }),
      expect.objectContaining({ kind: 'command', label: 'clear', group: 'Commands', replacement: '/clear' }),
    ]);
    expect(result.candidates.at(-1)).toMatchObject({ kind: 'skill', label: 'compact', group: 'Skills' });
    expect(rankComposerCandidates(result.candidates, 'compact').map(candidate => candidate.id)).toEqual([
      'command:compact',
      'skill:compact',
    ]);
    expect(builtinCommandsForHarness('claude').map(command => command.name)).toEqual(['compact', 'clear']);
    expect(builtinCommandsForHarness('codex').map(command => command.name)).toEqual(['compact', 'clear']);
  });

  test('shows harness-valid commands synchronously while the skills catalog warms', async () => {
    let release!: (response: Response) => void;
    responder = () =>
      new Promise<Response>(resolve => {
        release = resolve;
      });
    const provider = createSkillsProvider('slow', 'codex');

    expect(provider.initialCandidates?.(context('/', ''))).toMatchObject({
      candidates: [
        expect.objectContaining({ id: 'command:compact', replacement: '/compact' }),
        expect.objectContaining({ id: 'command:clear', replacement: '/clear' }),
      ],
      notice: 'Loading installed skills…',
    });
    expect(requests).toHaveLength(0);

    const pending = provider.candidates(context('/', ''));
    expect(requests).toEqual(['/v1/sessions/slow/skills']);
    release(Response.json({ harness: 'codex', skills: [{ name: 'summary', description: 'Recap' }] }));
    await expect(pending).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({ id: 'command:compact' }),
        expect.objectContaining({ id: 'command:clear' }),
        expect.objectContaining({ id: 'skill:summary', replacement: '$summary' }),
      ],
    });
  });

  test('keeps built-ins available when skills discovery fails', async () => {
    responder = () => Response.json({ error: 'no route GET /skills', code: 'unknown_route' }, { status: 404 });
    const result = await createSkillsProvider('old', 'claude').candidates(context('/', ''));
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['command:compact', 'command:clear']);
    expect(result.notice).toContain('no route GET /skills');
    expect(result.notice).toContain('Built-in commands still work');
  });
});

describe('store-backed reference providers', () => {
  test('@ rows keep canonical task references, titles, and live statuses without fetching named data', () => {
    let tasks: ComposerTaskSummary[] = [{ id: 'F38', title: 'Composer autocomplete', status: 'in_progress' }];
    const provider = createReferencesProvider({ sessionId: 'one', getTasks: () => tasks });

    const first = provider.initialCandidates!(context('@', 'F'))!;
    expect(first.candidates).toEqual([
      expect.objectContaining({
        kind: 'task',
        label: '#F38',
        detail: 'Composer autocomplete',
        badge: 'In progress',
        replacement: '#F38',
      }),
    ]);
    expect(requests).toHaveLength(0);

    tasks = [{ id: 'B7', title: 'New live snapshot', status: 'blocked' as const }];
    const updated = provider.initialCandidates!(context('@', 'B'))!;
    expect(updated.candidates[0]).toMatchObject({ label: '#B7', badge: 'Blocked' });
  });

  test('@ rows contain unresolved canonical attention references and identifying subjects', () => {
    const provider = createReferencesProvider({
      sessionId: 'one',
      getAttentionItems: () => [
        { id: 'A3', subject: 'Choose the rollout window', source: 'question' },
        { id: 'A8', subject: 'Approve production access', source: 'permission' },
      ],
    });
    const result = provider.initialCandidates!(context('@', 'A'))!;
    expect(result.candidates).toEqual([
      expect.objectContaining({
        kind: 'attention',
        label: '?A3',
        detail: 'Choose the rollout window',
        badge: 'question',
        replacement: '?A3',
      }),
      expect.objectContaining({ label: '?A8', replacement: '?A8' }),
    ]);
    expect(requests).toHaveLength(0);
  });

  test('reuses an in-flight warmup on the first keystroke, then reads the live snapshot', async () => {
    responder = () => Response.json({ entries: [] });
    let release!: () => void;
    const warmup = new Promise<void>(resolve => {
      release = resolve;
    });
    let tasks: Array<{ id: string; title: string; status: 'todo' }> = [];
    const provider = createReferencesProvider({
      sessionId: 'one',
      getTasks: () => tasks,
      waitForTasks: () => warmup,
    });
    const before = provider.snapshotKey;

    const result = provider.candidates(context('@', 'F'));
    tasks = [{ id: 'F12', title: 'Loaded by the existing warmup', status: 'todo' }];
    release();

    await expect(result).resolves.toMatchObject({
      candidates: [expect.objectContaining({ label: '#F12', detail: 'Loaded by the existing warmup' })],
    });
    expect(provider.snapshotKey).not.toBe(before);
    expect(requests).toEqual(['/v1/sessions/one/fs']);
  });

  test('the composer factory exposes one action trigger and one reference trigger', () => {
    expect(createComposerAutocompleteProviders({ sessionId: 'one' }).map(provider => provider.trigger)).toEqual([
      '/',
      '@',
    ]);
  });
});

describe('@ unified references provider', () => {
  test.each([
    ['', true],
    ['ott', true],
    ['F12', true],
    ['#F12', true],
    ['?A3', true],
    ['src/', false],
    ['src/app.ts', false],
    ['app.ts:12', false],
    ['someone@example.com', false],
  ] as const)('classifies %p as named=%p', (query, expected) => {
    expect(isNamedReferenceQuery(query)).toBe(expected);
  });

  test('groups live agents, tasks, and attention above Files and inserts a stable id-backed agent link', async () => {
    responder = () => Response.json({ entries: [{ name: 'ottis.ts', type: 'file' }] });
    const sessions = [
      agentSession({
        id: 'ms-finished',
        teammate: 'ottis',
        status: 'completed',
        label: 'old-label',
        task: 'Old Ottis work',
        activity: '2026-07-28T13:00:00.000Z',
      }),
      agentSession({
        id: 'ms-live',
        teammate: 'ottis',
        status: 'tool_running',
        label: 'browser-work',
        task: 'Make Browser Real',
        activity: '2026-07-28T11:00:00.000Z',
      }),
    ];
    const provider = createReferencesProvider({
      sessionId: 'one',
      getSessions: () => sessions,
      getTasks: () => [{ id: 'F77', title: 'Mention agents', status: 'in_progress' }],
      getAttentionItems: () => [{ id: 'A3', subject: 'Choose delivery semantics', source: 'question' }],
    });

    const initial = provider.initialCandidates?.(context('@', ''));
    expect(initial?.candidates.map(candidate => candidate.group)).toEqual(['Agents', 'Agents', 'Tasks', 'Attention']);
    expect(initial?.candidates[0]).toMatchObject({
      id: 'agent:ms-live',
      label: 'ottis',
      badge: 'tool running',
      replacement: '[@ottis](/session/ms-live#kteam-agent-mention)',
    });
    expect(initial?.candidates[0]?.detail).toContain('browser-work · Make Browser Real');
    expect(initial?.candidates[0]?.detail).toContain('gpt-5.6-sol · codex-auto-loge');
    expect(initial?.candidates[1]?.id).toBe('agent:ms-finished');
    expect(requests).toHaveLength(0);

    const result = await provider.candidates(context('@', 'ott'));
    expect(result.candidates.map(candidate => candidate.group)).toEqual([
      'Agents',
      'Agents',
      'Tasks',
      'Attention',
      'Files',
    ]);
    expect(result.candidates.at(-1)).toMatchObject({ label: 'ottis.ts', replacement: '@ottis.ts' });
    expect(requests).toEqual(['/v1/sessions/one/fs']);
  });

  test('a path-shaped @src/ query is Files-only even when named rows would match src', async () => {
    responder = url => {
      expect(url).toBe('/v1/sessions/one/fs?path=src');
      return Response.json({ path: 'src', entries: [{ name: 'core.ts', type: 'file' }] });
    };
    const provider = createReferencesProvider({
      sessionId: 'one',
      getSessions: () => [agentSession({ id: 'ms-src', teammate: 'src' })],
      getTasks: () => [{ id: 'F12', title: 'src migration', status: 'todo' }],
      getAttentionItems: () => [{ id: 'A3', subject: 'src approval', source: 'permission' }],
    });

    expect(provider.initialCandidates?.(context('@', 'src/'))).toBeUndefined();
    const result = await provider.candidates(context('@', 'src/'));
    expect(result.candidates).toEqual([
      expect.objectContaining({ kind: 'file', group: 'Files', label: 'core.ts', replacement: '@src/core.ts' }),
    ]);
  });

  test('a path-shaped query never waits for or warms unrelated named stores', async () => {
    responder = () => Response.json({ entries: [{ name: 'core.ts', type: 'file' }] });
    let taskWarmups = 0;
    let attentionWarmups = 0;
    const provider = createReferencesProvider({
      sessionId: 'one',
      waitForTasks: () => {
        taskWarmups += 1;
        return Promise.resolve();
      },
      waitForAttentionItems: () => {
        attentionWarmups += 1;
        return Promise.resolve();
      },
    });

    await expect(provider.candidates(context('@', 'src/'))).resolves.toMatchObject({
      candidates: [expect.objectContaining({ group: 'Files', replacement: '@src/core.ts' })],
    });
    expect({ taskWarmups, attentionWarmups }).toEqual({ taskWarmups: 0, attentionWarmups: 0 });
  });

  test('bare @ keeps every named group and Files discoverable under the global row cap', async () => {
    responder = () =>
      Response.json({
        entries: Array.from({ length: 10 }, (_, index) => ({ name: `file-${index}.ts`, type: 'file' })),
      });
    const provider = createReferencesProvider({
      sessionId: 'one',
      getSessions: () => [agentSession({ id: 'ms-ottis', teammate: 'ottis' })],
      getTasks: () =>
        Array.from({ length: 20 }, (_, index) => ({
          id: `F${index + 1}`,
          title: `Task ${index + 1}`,
          status: 'todo' as const,
        })),
      getAttentionItems: () =>
        Array.from({ length: 20 }, (_, index) => ({
          id: `A${index + 1}`,
          subject: `Attention ${index + 1}`,
          source: 'question',
        })),
    });

    expect(provider.initialCandidates?.(context('@', ''))?.candidates).toHaveLength(16);
    const result = await provider.candidates(context('@', ''));
    const visible = rankComposerCandidates(result.candidates, '');
    expect([...new Set(visible.map(candidate => candidate.group))]).toEqual(['Agents', 'Tasks', 'Attention', 'Files']);
    expect(visible.filter(candidate => candidate.group === 'Files')).toHaveLength(4);
    expect(visible.at(-1)?.group).toBe('Files');
  });

  test('keeps named references available when Files fails', async () => {
    responder = () => Response.json({ error: 'offline' }, { status: 503 });
    const provider = createReferencesProvider({
      sessionId: 'one',
      getSessions: () => [agentSession({ id: 'ms-ottis', teammate: 'ottis' })],
    });
    const result = await provider.candidates(context('@', 'ott'));
    expect(result.candidates).toEqual([expect.objectContaining({ id: 'agent:ms-ottis' })]);
    expect(result.notice).toContain('Files unavailable');
  });

  test('a Files failure still keeps every available named group visible on bare @', async () => {
    responder = () => Response.json({ error: 'offline' }, { status: 503 });
    const provider = createReferencesProvider({
      sessionId: 'one',
      getSessions: () => [agentSession({ id: 'ms-ottis', teammate: 'ottis' })],
      getTasks: () =>
        Array.from({ length: 20 }, (_, index) => ({
          id: `F${index + 1}`,
          title: `Task ${index + 1}`,
          status: 'todo' as const,
        })),
      getAttentionItems: () =>
        Array.from({ length: 20 }, (_, index) => ({
          id: `A${index + 1}`,
          subject: `Attention ${index + 1}`,
          source: 'question',
        })),
    });

    const result = await provider.candidates(context('@', ''));
    const visible = rankComposerCandidates(result.candidates, '');
    expect(visible).toHaveLength(20);
    expect([...new Set(visible.map(candidate => candidate.group))]).toEqual(['Agents', 'Tasks', 'Attention']);
    expect(result.notice).toContain('Files unavailable');
  });
});

describe('@ files provider', () => {
  test('splits only the final path segment into the fuzzy query', () => {
    expect(splitFileQuery('')).toEqual({ directory: '', leaf: '' });
    expect(splitFileQuery('src')).toEqual({ directory: '', leaf: 'src' });
    expect(splitFileQuery('src/components/Com')).toEqual({ directory: 'src/components', leaf: 'Com' });
    expect(splitFileQuery('src/')).toEqual({ directory: 'src', leaf: '' });
  });

  test('keeps optional line selectors out of the filesystem lookup and canonicalises GitHub ranges', () => {
    expect(splitFileReferenceQuery('src/components/App.tsx:12-20')).toEqual({
      directory: 'src/components',
      leaf: 'App.tsx',
      selector: { suffix: ':12-20', complete: true, valid: true },
    });
    expect(splitFileReferenceQuery('src/components/App.tsx:12:4')).toEqual({
      directory: 'src/components',
      leaf: 'App.tsx',
      selector: { suffix: ':12:4', complete: true, valid: true },
    });
    expect(splitFileReferenceQuery('src/components/App.tsx#L12-L20')).toEqual({
      directory: 'src/components',
      leaf: 'App.tsx',
      selector: { suffix: ':12-20', complete: true, valid: true },
    });
    expect(splitFileReferenceQuery('src/components/App.tsx#L12-20')).toEqual({
      directory: 'src/components',
      leaf: 'App.tsx',
      selector: { suffix: ':12-20', complete: true, valid: true },
    });
    expect(splitFileReferenceQuery('src/components/App.tsx:12-')).toEqual({
      directory: 'src/components',
      leaf: 'App.tsx',
      selector: { suffix: ':12-', complete: false, valid: true },
    });
    expect(splitFileReferenceQuery('src/components/App.tsx:20-12').selector.valid).toBe(false);
  });

  test('reuses GET :id/fs for the requested directory and keeps folders open', async () => {
    responder = url => {
      expect(url).toBe('/v1/sessions/s-1/fs?path=src');
      return Response.json({
        path: 'src',
        entries: [
          { name: 'components', type: 'dir' },
          { name: 'core.ts', type: 'file', size: 40 },
        ],
      });
    };
    const result = await createFilesProvider('s-1').candidates(context('@', 'src/co'));
    expect(result.filterQuery).toBe('co');
    expect(result.contextLabel).toBe('@src/');
    expect(result.candidates).toEqual([
      expect.objectContaining({
        label: 'components',
        kind: 'directory',
        replacement: '@src/components/',
        append: 'none',
      }),
      expect.objectContaining({
        label: 'core.ts',
        kind: 'file',
        replacement: '@src/core.ts',
        append: 'space',
      }),
    ]);
  });

  test('attaches a complete line/range to the picked file while leaving plain @path unchanged', async () => {
    responder = url => {
      expect(url).toBe('/v1/sessions/s-1/fs?path=src');
      return Response.json({ path: 'src', entries: [{ name: 'app.ts', type: 'file' }] });
    };
    const provider = createFilesProvider('s-1');
    const ranged = await provider.candidates(context('@', 'src/app.ts:12-20'));
    expect(ranged.filterQuery).toBe('app.ts');
    expect(ranged.candidates[0]).toMatchObject({
      label: 'app.ts:12-20',
      replacement: '@src/app.ts:12-20',
      append: 'space',
      disabled: false,
    });

    const plain = await provider.candidates(context('@', 'src/app'));
    expect(plain.candidates[0]).toMatchObject({
      label: 'app.ts',
      replacement: '@src/app.ts',
      append: 'space',
    });
    expect(plain.notice).toContain('Optional: add :LINE or :START-END');
    expect(requests).toHaveLength(1);
  });

  test('keeps an unfinished selector open and refuses an invalid descending range', async () => {
    responder = () => Response.json({ entries: [{ name: 'app.ts', type: 'file' }] });
    const provider = createFilesProvider('s-1');
    const unfinished = await provider.candidates(context('@', 'src/app.ts:'));
    expect(unfinished.candidates[0]).toMatchObject({ replacement: '@src/app.ts:', append: 'none', disabled: false });
    expect(unfinished.notice).toContain('Finish the optional line selection');

    const invalid = await provider.candidates(context('@', 'src/app.ts:20-12'));
    expect(invalid.candidates[0]).toMatchObject({ disabled: true });
    expect(invalid.candidates[0]?.disabledReason).toContain('end at or after');
  });

  test('caches visited directories for the page lifetime', async () => {
    responder = () => Response.json({ entries: [{ name: 'app.ts', type: 'file' }] });
    const provider = createFilesProvider('s-1');
    await provider.candidates(context('@', 'src/a'));
    await provider.candidates(context('@', 'src/ap'));
    expect(requests).toHaveLength(1);
  });

  test('keeps refused rows visible but makes them unselectable with the reason', async () => {
    responder = () =>
      Response.json({
        entries: [
          { name: '.env', type: 'file', denied: true },
          { name: 'ignored.log', type: 'file', ignored: true },
          { name: 'outside', type: 'symlink', escapes: true },
          { name: 'safe.ts', type: 'file' },
        ],
      });
    const result = await createFilesProvider('s-1').candidates(context('@', ''));
    expect(result.candidates.map(row => ({ label: row.label, disabled: row.disabled }))).toEqual([
      { label: '.env', disabled: true },
      { label: 'ignored.log', disabled: true },
      { label: 'outside', disabled: true },
      { label: 'safe.ts', disabled: false },
    ]);
    expect(result.candidates[0]!.disabledReason).toContain('secrets');
    expect(result.candidates[1]!.disabledReason).toContain('gitignored');
    expect(result.candidates[2]!.disabledReason).toContain('leaves');
  });

  test('reports a bounded listing honestly', async () => {
    responder = () => Response.json({ entries: [], truncated: true });
    const result = await createFilesProvider('s-1').candidates(context('@', ''));
    expect(result.notice).toContain('2,000 entries shown');
  });

  test('passes the request abort signal to fetch', async () => {
    const abort = new AbortController();
    responder = (_url, init) => {
      expect(init?.signal).toBe(abort.signal);
      return Response.json({ entries: [] });
    };
    await createFilesProvider('s-1').candidates(context('@', '', abort.signal));
  });
});
