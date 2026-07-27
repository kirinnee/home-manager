import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createFilesProvider,
  createSkillsProvider,
  splitFileQuery,
  type ComposerSkillsResponse,
} from './composer-autocomplete-providers';
import type { ComposerTriggerMatch } from './composer-autocomplete-engine';

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

function match(trigger: '/' | '@', query: string): ComposerTriggerMatch {
  return { trigger, query, start: 0, end: query.length + 1, caret: query.length + 1 };
}

function context(trigger: '/' | '@', query: string, signal = new AbortController().signal) {
  return { query, match: match(trigger, query), signal };
}

describe('/ skills provider', () => {
  test('uses the session-scoped endpoint and inserts what CODEX understands', async () => {
    const body: ComposerSkillsResponse = {
      harness: 'codex',
      skills: [{ name: 'summary', description: 'Give a fast recap' }],
    };
    responder = () => Response.json(body);

    const result = await createSkillsProvider('session / one').candidates(context('/', 'sum'));
    expect(requests).toEqual(['/v1/sessions/session%20%2F%20one/skills']);
    expect(result.contextLabel).toBe('Codex · inserts $name');
    expect(result.candidates).toEqual([
      expect.objectContaining({
        kind: 'skill',
        label: 'summary',
        detail: 'Give a fast recap',
        // The reader pressed `/`. Codex browses with `/skills` and INVOKES with
        // `$name`, so `/summary` would be a command it does not have.
        replacement: '$summary',
        append: 'space',
      }),
    ]);
  });

  test('inserts what CLAUDE understands from the very same catalog', async () => {
    responder = () =>
      Response.json({
        harness: 'claude',
        skills: [{ name: 'summary', description: 'Give a fast recap' }],
      } satisfies ComposerSkillsResponse);
    const result = await createSkillsProvider('one').candidates(context('/', ''));
    expect(result.contextLabel).toBe('Claude · inserts /name');
    expect(result.candidates[0]).toMatchObject({ replacement: '/summary' });
  });

  test('an unrecognised harness falls back to the claude form rather than inserting undefined', async () => {
    responder = () => Response.json({ harness: 'zebra', skills: [{ name: 'floop', description: 'x' }] });
    const result = await createSkillsProvider('one').candidates(context('/', ''));
    expect(result.candidates[0]).toMatchObject({ replacement: '/floop' });
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
    expect(result.candidates.map(candidate => candidate.label)).toEqual(['apple', 'Zebra']);
  });

  test('turns version skew into a readable provider error', async () => {
    responder = () => Response.json({ error: 'no route GET /skills', code: 'unknown_route' }, { status: 404 });
    await expect(createSkillsProvider('old').candidates(context('/', ''))).rejects.toThrow('no route GET /skills');
  });
});

describe('@ files provider', () => {
  test('splits only the final path segment into the fuzzy query', () => {
    expect(splitFileQuery('')).toEqual({ directory: '', leaf: '' });
    expect(splitFileQuery('src')).toEqual({ directory: '', leaf: 'src' });
    expect(splitFileQuery('src/components/Com')).toEqual({ directory: 'src/components', leaf: 'Com' });
    expect(splitFileQuery('src/')).toEqual({ directory: 'src', leaf: '' });
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
