import { describe, expect, test } from 'bun:test';
import type { ProjectInfo, SessionView } from '../types';
import {
  filterSessions,
  groupByProject,
  isScopeResolvable,
  normalizeProjectPath,
  projectKeyFor,
  scopeSessions,
  sessionInScope,
} from './grouping';

/** Minimal SessionView: only the fields the grouping/scoping predicates read
 *  (cwd, mode, status, the search haystack). Everything else is filled to keep
 *  the type honest without pretending to matter here. */
function session(
  id: string,
  {
    cwd = '/repo',
    mode = 'auto',
    status = 'running',
    remoteControl = false,
    name = `task ${id}`,
    teammate,
  }: {
    cwd?: string;
    mode?: 'auto' | 'interactive';
    status?: string;
    remoteControl?: boolean;
    name?: string;
    teammate?: string;
  } = {},
): SessionView {
  return {
    config: {
      id,
      name,
      teammate,
      binary: 'codex',
      harness: 'codex',
      modelHint: 'gpt-5.6',
      mode,
      remoteControl,
      cwd,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      turn: 1,
      harnessSessionId: id,
      tmuxSession: id,
      watcherSession: id,
      intervalSeconds: 60,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 3,
      systemPromptFile: '',
      originalPromptFile: '',
    },
    state: {
      id,
      status: status as SessionView['state']['status'],
      turn: 1,
      lastActivityAt: '2026-07-25T00:00:00.000Z',
    },
    directory: cwd,
  };
}

const proj = (name: string, path: string): ProjectInfo => ({ name, path });

describe('projectKeyFor', () => {
  test('the LONGEST registered prefix wins (a worktree nested in a repo)', () => {
    const projects = [proj('repo', '/home/k/repo'), proj('worktree', '/home/k/repo/.wt/feature')];
    // A cwd inside the worktree files under the worktree, not the parent repo.
    expect(projectKeyFor('/home/k/repo/.wt/feature/src', projects)).toEqual({
      key: '/home/k/repo/.wt/feature',
      name: 'worktree',
    });
    // A cwd only under the repo files under the repo.
    expect(projectKeyFor('/home/k/repo/src', projects)).toEqual({ key: '/home/k/repo', name: 'repo' });
  });

  test('an exact cwd match resolves to that project', () => {
    const projects = [proj('repo', '/home/k/repo')];
    expect(projectKeyFor('/home/k/repo', projects)).toEqual({ key: '/home/k/repo', name: 'repo' });
  });

  test('a cwd under no known project falls back to its own basename', () => {
    expect(projectKeyFor('/tmp/scratch', [])).toEqual({ key: '/tmp/scratch', name: 'scratch' });
  });

  test('an empty cwd is grouped as "ungrouped"', () => {
    expect(projectKeyFor('', [])).toEqual({ key: '', name: 'ungrouped' });
  });

  test('a prefix must be a path segment boundary — /repo does not swallow /repository', () => {
    const projects = [proj('repo', '/home/k/repo')];
    expect(projectKeyFor('/home/k/repository/src', projects)).toEqual({
      key: '/home/k/repository/src',
      name: 'src',
    });
  });

  test('trailing-slash registration variance is normalised away on both sides', () => {
    const projects = [proj('repo', '/home/k/repo/')];
    // The registered path has a trailing slash; the cwd does not — they still
    // match, and the KEY is the normalised form so scope equality is stable.
    expect(projectKeyFor('/home/k/repo/src', projects)).toEqual({ key: '/home/k/repo', name: 'repo' });
    expect(projectKeyFor('/home/k/repo/', projects)).toEqual({ key: '/home/k/repo', name: 'repo' });
  });
});

describe('normalizeProjectPath', () => {
  test('strips trailing slashes but keeps a bare root', () => {
    expect(normalizeProjectPath('/a/b/')).toBe('/a/b');
    expect(normalizeProjectPath('/a/b///')).toBe('/a/b');
    expect(normalizeProjectPath('/a/b')).toBe('/a/b');
    expect(normalizeProjectPath('/')).toBe('/');
    expect(normalizeProjectPath('')).toBe('');
  });
});

describe('scopeSessions / sessionInScope', () => {
  const projects = [proj('nitroso', '/home/k/nitroso'), proj('alcohol', '/home/k/alcohol')];
  const a1 = session('a1', { cwd: '/home/k/nitroso' });
  const a2 = session('a2', { cwd: '/home/k/nitroso/src' });
  const b1 = session('b1', { cwd: '/home/k/alcohol' });
  const all = [a1, a2, b1];

  test('null scope is identity — folder mode off is today’s behaviour', () => {
    expect(scopeSessions(all, projects, null)).toEqual(all);
    expect(all.every(v => sessionInScope(v, projects, null))).toBe(true);
  });

  test('scoping to a project key keeps only that group', () => {
    expect(scopeSessions(all, projects, '/home/k/nitroso').map(v => v.config.id)).toEqual(['a1', 'a2']);
    expect(sessionInScope(a1, projects, '/home/k/nitroso')).toBe(true);
    expect(sessionInScope(b1, projects, '/home/k/nitroso')).toBe(false);
  });

  test('scope compares on the KEY, so a trailing-slash scope still matches', () => {
    expect(scopeSessions(all, projects, '/home/k/nitroso/').map(v => v.config.id)).toEqual(['a1', 'a2']);
  });

  test('duplicate display names with distinct paths never bleed into each other', () => {
    const dupProjects = [proj('web', '/home/k/one/web'), proj('web', '/home/k/two/web')];
    const one = session('one', { cwd: '/home/k/one/web' });
    const two = session('two', { cwd: '/home/k/two/web' });
    // Both groups are named "web" but scoping the first excludes the second.
    expect(scopeSessions([one, two], dupProjects, '/home/k/one/web').map(v => v.config.id)).toEqual(['one']);
  });
});

describe('scope composes BEFORE the four filters, replacing none of them', () => {
  const projects = [proj('nitroso', '/home/k/nitroso')];
  const scoped = '/home/k/nitroso';

  test('composes with the mode filter', () => {
    const auto = session('auto', { cwd: '/home/k/nitroso', mode: 'auto' });
    const inter = session('inter', { cwd: '/home/k/nitroso', mode: 'interactive' });
    const other = session('other', { cwd: '/home/k/elsewhere', mode: 'auto' });
    const pool = scopeSessions([auto, inter, other], projects, scoped);
    const out = filterSessions(pool, { query: '', mode: 'interactive', rcOnly: false, includeFinished: false });
    expect(out.map(v => v.config.id)).toEqual(['inter']);
  });

  test('composes with the query filter', () => {
    const hit = session('hit', { cwd: '/home/k/nitroso', name: 'fix transcript' });
    const miss = session('miss', { cwd: '/home/k/nitroso', name: 'other work' });
    const outside = session('outside', { cwd: '/home/k/elsewhere', name: 'fix transcript' });
    const pool = scopeSessions([hit, miss, outside], projects, scoped);
    const out = filterSessions(pool, { query: 'transcript', mode: 'all', rcOnly: false, includeFinished: false });
    expect(out.map(v => v.config.id)).toEqual(['hit']);
  });

  test('composes with rcOnly and includeFinished', () => {
    const rc = session('rc', { cwd: '/home/k/nitroso', remoteControl: true });
    const plain = session('plain', { cwd: '/home/k/nitroso', remoteControl: false });
    const done = session('done', { cwd: '/home/k/nitroso', status: 'completed' });
    const pool = scopeSessions([rc, plain, done], projects, scoped);
    expect(
      filterSessions(pool, { query: '', mode: 'all', rcOnly: true, includeFinished: false }).map(v => v.config.id),
    ).toEqual(['rc']);
    expect(
      filterSessions(pool, { query: '', mode: 'all', rcOnly: false, includeFinished: true })
        .map(v => v.config.id)
        .sort(),
    ).toEqual(['done', 'plain', 'rc']);
  });
});

describe('isScopeResolvable', () => {
  const projects = [proj('nitroso', '/home/k/nitroso')];

  test('a registered project path resolves even with zero sessions', () => {
    expect(isScopeResolvable('/home/k/nitroso', [], projects)).toBe(true);
  });

  test('a cwd-fallback group resolves while at least one session sits in it', () => {
    const s = session('s', { cwd: '/tmp/scratch' });
    expect(isScopeResolvable('/tmp/scratch', [s], [])).toBe(true);
  });

  test('a pruned/renamed folder with no registration and no sessions is unresolvable', () => {
    expect(isScopeResolvable('/home/k/gone', [], projects)).toBe(false);
  });

  test('normalises trailing slashes when resolving', () => {
    expect(isScopeResolvable('/home/k/nitroso/', [], projects)).toBe(true);
  });
});

describe('groupByProject still delegates to projectKeyFor', () => {
  test('a fallback group carries the normalised cwd as both key and path', () => {
    const s = session('s', { cwd: '/tmp/scratch/' });
    const groups = groupByProject([s], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.path).toBe('/tmp/scratch');
    expect(groups[0]!.name).toBe('scratch');
  });

  test('a group key matches what scopeSessions would filter on', () => {
    const projects = [proj('repo', '/home/k/repo/')];
    const s = session('s', { cwd: '/home/k/repo/src' });
    const [group] = groupByProject([s], projects);
    expect(scopeSessions([s], projects, group!.path).map(v => v.config.id)).toEqual(['s']);
  });
});
