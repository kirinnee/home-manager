import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

describe('ps --tag matching (matchesTags)', () => {
  const { matchesTags } = require('../ps') as typeof import('../ps');

  it('matches a single word against any lpsm field', () => {
    const lpsm = { platform: 'nitrite', service: 'neon' };
    expect(matchesTags(lpsm, undefined, ['nitrite'])).toBe(true);
    expect(matchesTags(lpsm, undefined, ['neon'])).toBe(true);
    expect(matchesTags(lpsm, undefined, ['argon'])).toBe(false);
  });

  it('is case-insensitive', () => {
    const lpsm = { platform: 'Nitrite', service: 'Neon' };
    expect(matchesTags(lpsm, undefined, ['NITRITE'])).toBe(true);
    expect(matchesTags(lpsm, undefined, ['neon'])).toBe(true);
  });

  it('AND-matches when multiple tags are given', () => {
    const neon = { platform: 'nitrite', service: 'neon' };
    const carbon = { platform: 'nitrite', service: 'carbon' };
    expect(matchesTags(neon, undefined, ['nitrite', 'neon'])).toBe(true);
    expect(matchesTags(carbon, undefined, ['nitrite', 'neon'])).toBe(false);
    expect(matchesTags(neon, undefined, ['nitrite', 'carbon'])).toBe(false);
  });

  it('falls back to substring match when no exact match', () => {
    const lpsm = { platform: 'nitrite', service: 'neon' };
    expect(matchesTags(lpsm, undefined, ['nit'])).toBe(true);
    expect(matchesTags(lpsm, undefined, ['eon'])).toBe(true);
  });

  it('empty tag list matches everything', () => {
    expect(matchesTags(undefined, undefined, [])).toBe(true);
    expect(matchesTags({ platform: 'nitrite' }, undefined, [])).toBe(true);
  });

  it('never matches a session with no lpsm/tags when a tag is given', () => {
    expect(matchesTags(undefined, undefined, ['nitrite'])).toBe(false);
    expect(matchesTags({}, undefined, ['nitrite'])).toBe(false);
    expect(matchesTags({}, [], ['nitrite'])).toBe(false);
  });

  it('matches against free-form tags as well as lpsm fields', () => {
    const lpsm = { platform: 'nitrite' };
    const free = ['urgent', 'spike'];
    // free-form tag hit
    expect(matchesTags(lpsm, free, ['urgent'])).toBe(true);
    expect(matchesTags(lpsm, free, ['spike'])).toBe(true);
    // lpsm hit
    expect(matchesTags(lpsm, free, ['nitrite'])).toBe(true);
    // no hit anywhere
    expect(matchesTags(lpsm, free, ['nope'])).toBe(false);
    // free-form tags with no lpsm at all
    expect(matchesTags(undefined, free, ['urgent'])).toBe(true);
  });

  it('AND-matches across both free-form tags and lpsm fields', () => {
    const lpsm = { platform: 'nitrite' };
    const free = ['urgent', 'spike'];
    // one via free tag, one via lpsm → match
    expect(matchesTags(lpsm, free, ['urgent', 'nitrite'])).toBe(true);
    // only one hits → no match
    expect(matchesTags(lpsm, free, ['urgent', 'nope'])).toBe(false);
  });
});

describe('createSession persists lpsm + tags; ps tag filtering end-to-end', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('createSession stores lpsm when provided and omits it otherwise', () => {
    const { createSession } = require('../../core/session-create') as typeof import('../../core/session-create');
    const { readSessionMeta } = require('../../core/session-meta') as typeof import('../../core/session-meta');

    const withLpsm = createSession({
      ticketId: 'cu-abc123',
      org: 'atomicloud',
      repoPath: '/tmp/repo',
      worktree: '/tmp/repo',
      lpsm: { platform: 'nitrite', service: 'neon' },
    });
    const withoutLpsm = createSession({
      ticketId: 'PE-1234',
      org: 'liftoff',
      repoPath: '/tmp/repo2',
      worktree: '/tmp/repo2',
    });

    expect(readSessionMeta(withLpsm.sessionId)?.lpsm).toEqual({
      platform: 'nitrite',
      service: 'neon',
    });
    expect(readSessionMeta(withoutLpsm.sessionId)?.lpsm).toBeUndefined();
  });

  it('createSession stores free-form tags when non-empty and omits otherwise', () => {
    const { createSession } = require('../../core/session-create') as typeof import('../../core/session-create');
    const { readSessionMeta } = require('../../core/session-meta') as typeof import('../../core/session-meta');

    const tagged = createSession({
      ticketId: 'cu-tag001',
      org: 'atomicloud',
      repoPath: '/tmp/tagged',
      worktree: '/tmp/tagged',
      lpsm: { platform: 'nitrite' },
      tags: ['urgent', 'spike'],
    });
    const empty = createSession({
      ticketId: 'cu-empty1',
      org: 'atomicloud',
      repoPath: '/tmp/empty',
      worktree: '/tmp/empty',
      tags: [],
    });

    expect(readSessionMeta(tagged.sessionId)?.tags).toEqual(['urgent', 'spike']);
    expect(readSessionMeta(empty.sessionId)?.tags).toBeUndefined();
  });

  it('matchesTags over persisted sessions filters lpsm + free-form tags', () => {
    const { createSession } = require('../../core/session-create') as typeof import('../../core/session-create');
    const { readSessionMeta } = require('../../core/session-meta') as typeof import('../../core/session-meta');
    const { matchesTags } = require('../ps') as typeof import('../ps');

    const neon = createSession({
      ticketId: 'cu-neon01',
      org: 'atomicloud',
      repoPath: '/tmp/a',
      worktree: '/tmp/a',
      lpsm: { platform: 'nitrite', service: 'neon' },
    });
    const carbon = createSession({
      ticketId: 'cu-carb01',
      org: 'atomicloud',
      repoPath: '/tmp/b',
      worktree: '/tmp/b',
      lpsm: { platform: 'nitrite', service: 'carbon' },
    });
    const free = createSession({
      ticketId: 'cu-free01',
      org: 'atomicloud',
      repoPath: '/tmp/c',
      worktree: '/tmp/c',
      lpsm: { platform: 'nitrite' },
      tags: ['urgent', 'spike'],
    });

    const neonMeta = readSessionMeta(neon.sessionId);
    const carbonMeta = readSessionMeta(carbon.sessionId);
    const freeMeta = readSessionMeta(free.sessionId);

    // `--tag nitrite` → all three
    expect(matchesTags(neonMeta?.lpsm, neonMeta?.tags, ['nitrite'])).toBe(true);
    expect(matchesTags(carbonMeta?.lpsm, carbonMeta?.tags, ['nitrite'])).toBe(true);
    expect(matchesTags(freeMeta?.lpsm, freeMeta?.tags, ['nitrite'])).toBe(true);

    // `--tag nitrite --tag neon` → only neon
    expect(matchesTags(neonMeta?.lpsm, neonMeta?.tags, ['nitrite', 'neon'])).toBe(true);
    expect(matchesTags(carbonMeta?.lpsm, carbonMeta?.tags, ['nitrite', 'neon'])).toBe(false);

    // `--tag urgent` → only the free-form-tagged session
    expect(matchesTags(neonMeta?.lpsm, neonMeta?.tags, ['urgent'])).toBe(false);
    expect(matchesTags(freeMeta?.lpsm, freeMeta?.tags, ['urgent'])).toBe(true);

    // `--tag urgent --tag nitrite` → one via free tag, one via lpsm → match
    expect(matchesTags(freeMeta?.lpsm, freeMeta?.tags, ['urgent', 'nitrite'])).toBe(true);

    // non-matching tag → no match
    expect(matchesTags(freeMeta?.lpsm, freeMeta?.tags, ['nope'])).toBe(false);
  });
});
